/**
 * The corpus store (Milestone 5.1): idempotent ingestion, versioned derivations,
 * reproducible re-analysis.
 *
 * The ownership rule, in one line: **raw evidence is the source of truth; everything else
 * is a deterministic, versioned derivation of it.**
 *
 * ```
 * ingest      raw response  -> raw_responses (once, preferred evidence)
 *                           -> transactions  (identity + evidence-derived metadata)
 *                           -> derived       (normalized/effects/swaps/routes @ version)
 *                           -> fetches       (append-only outcome history)
 *
 * reanalyze   raw_responses -> derive -> replace derived rows @ current version
 *                                        (raw is never touched)
 * ```
 *
 * Consequences worth stating because they are enforced, not assumed:
 *
 *  - **Nothing derived is authoritative.** Deleting every `derived` row and re-running
 *    `reanalyze` reproduces byte-identical artifacts (`artifact_text` is the canonical
 *    codec text, so equality is exact and hashable).
 *  - **Evidence never regresses.** A weaker observation cannot overwrite a stronger one;
 *    the rule is `compareEvidenceQuality` in `./quality.ts`, and it is total and
 *    deterministic, so storage order cannot change what is stored.
 *  - **A failed ingest changes nothing.** Each signature is written inside one SQLite
 *    transaction: either the evidence, the canonical row, the four artifacts and the fetch
 *    record all land, or none of them do.
 *  - **A reverted transaction is ordinary corpus data.** Its artifacts are the frozen M3/M4
 *    ones, where committed fee/state and attempted-but-rolled-back instructions stay
 *    distinct; storage never promotes attempted movement to committed movement.
 */

import type { DatabaseSync } from 'node:sqlite';
import { EvidenceCodecError, decodeEvidence, encodeEvidence, sha256Hex } from './codec.ts';
import {
  deriveArtifacts,
  normalizeAndDerive,
  rehydrateNormalized,
  type DerivedArtifacts,
  type StoredNormalizedTransaction,
} from './derive.ts';
import {
  compareEvidenceQuality,
  describeEvidenceQuality,
  evidenceQualityOf,
  type EvidenceQuality,
} from './quality.ts';
import { openDatabase, ensureSchema, StoreSchemaError } from './schema.ts';
import {
  CODEC_VERSION,
  DERIVED_LAYERS,
  DERIVED_SEMANTICS_VERSION,
  isDerivedLayer,
  type DerivedLayer,
} from './version.ts';
import {
  fetchSignaturePage,
  isRetryableFetchError,
  type CorpusRpcLike,
  type TransactionRpcLike,
} from './rpc.ts';
import { fetchTransaction, TransactionFetchError } from '../rpc/fetch-transaction.ts';
import { normalizeTransaction, NormalizationError } from '../normalize/transaction.ts';
import type { CommitmentLevel } from '../rpc/client.ts';
import type { NormalizedProvenance, NormalizedTransaction } from '../model/transaction.ts';
import type { TransactionEffects } from '../effects/model.ts';
import type { SwapReport } from '../swap/model.ts';
import type { RouteReport } from '../route/model.ts';

/* ------------------------------------------------------------------ the store -- */

export interface CorpusStore {
  readonly path: string;
  /** The underlying connection. Exposed so a corpus can be inspected directly. */
  readonly database: DatabaseSync;
  readonly formatVersion: number;
  readonly semanticsVersion: string;
  /** Injected clock, so bookkeeping timestamps are deterministic in tests. */
  now(): string;
  /** Closes the connection. Idempotent: closing an already-closed store is a no-op. */
  close(): void;
}

export interface OpenCorpusStoreOptions {
  readonly readOnly?: boolean;
  readonly now?: () => string;
}

/** The caller handed the store something it cannot persist as evidence. */
export class StoreInputError extends Error {
  public override readonly name = 'StoreInputError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Checks the provenance before anything is written.
 *
 * Provenance is part of the evidence — it decides what `normalizeTransaction` records — so a
 * half-filled one has to fail here with a readable message, not as a SQLite binding error
 * three layers down (which is exactly what happened the first time the fixture path was
 * wired up: `encoding` was `undefined`).
 */
function assertProvenance(provenance: NormalizedProvenance): void {
  const record = provenance as unknown as Record<string, unknown>;
  const missing = (['rpcEndpoint', 'encoding', 'commitment', 'maxSupportedTransactionVersion'] as const).filter(
    key => record[key] === undefined,
  );
  if (missing.length > 0) {
    throw new StoreInputError(
      `provenance is incomplete: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. ` +
        'Every observation carries the endpoint, encoding, commitment and max supported version it was made with.',
    );
  }
  if (typeof record['rpcEndpoint'] !== 'string' || record['rpcEndpoint'].trim() === '') {
    throw new StoreInputError('provenance.rpcEndpoint must be a non-empty string');
  }
  const commitment = record['commitment'];
  if (commitment !== 'processed' && commitment !== 'confirmed' && commitment !== 'finalized') {
    throw new StoreInputError(
      `provenance.commitment must be processed | confirmed | finalized, got ${JSON.stringify(commitment)}`,
    );
  }
}

/** Opens (creating if needed) a corpus store file. */
export function openCorpusStore(path: string, options: OpenCorpusStoreOptions = {}): CorpusStore {
  const database = openDatabase(path, options.readOnly === true ? { readOnly: true } : {});
  ensureSchema(database);
  const clock = options.now ?? ((): string => new Date().toISOString());
  let open = true;
  return {
    path,
    database,
    formatVersion: readFormatVersion(database),
    semanticsVersion: DERIVED_SEMANTICS_VERSION,
    now: clock,
    close: () => {
      if (!open) return;
      open = false;
      database.close();
    },
  };
}

function readFormatVersion(database: DatabaseSync): number {
  const row = database.prepare('SELECT value FROM store_meta WHERE key = ?').get('format_version');
  const value = row === undefined ? null : Number(row['value']);
  if (value === null || !Number.isInteger(value)) {
    throw new StoreSchemaError('the store does not record a usable format version');
  }
  return value;
}

/* ------------------------------------------------------------- value binding ---- */

/**
 * Binds an exact integer as canonical decimal TEXT.
 *
 * Never as a JS number: SQLite would accept a `number` into a TEXT column and coerce it,
 * silently losing precision above 2^53. Every amount and slot goes through here.
 */
function textOf(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

/** Binds a small exact integer (a block time, a count) as TEXT for the same reason. */
function numberTextOf(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isInteger(value)) throw new StoreSchemaError(`refusing to store non-integer ${value}`);
  return value.toString();
}

function bitOf(value: boolean): number {
  return value ? 1 : 0;
}

type Row = Record<string, unknown>;

function rowText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new StoreSchemaError(`column ${key} should be TEXT, found ${typeof value}`);
  }
  return value;
}

function rowTextOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return rowText(row, key);
}

function rowInt(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new StoreSchemaError(`column ${key} should be INTEGER, found ${typeof value}`);
}

function rowBit(row: Row, key: string): boolean {
  return rowInt(row, key) !== 0;
}

/* ------------------------------------------------------------ fetch history ----- */

export type FetchOutcome =
  | 'stored'
  | 'stored-upgraded'
  | 'unchanged-equal-quality'
  | 'skipped-lower-quality'
  | 'not-found'
  | 'rpc-error'
  | 'normalization-error';

export interface FetchOutcomeRecord {
  readonly signature: string;
  readonly endpoint: string;
  readonly commitment: CommitmentLevel;
  readonly outcome: FetchOutcome;
  readonly retryable: boolean;
  readonly detail: string | null;
  /** Defaults to the store clock. */
  readonly at?: string;
}

/**
 * Appends one fetch outcome. History is append-only on purpose: it is the record of what
 * was *attempted*, including attempts that found nothing, and it is never the source of any
 * derived artifact.
 */
export function recordFetchOutcome(store: CorpusStore, record: FetchOutcomeRecord): void {
  store.database
    .prepare(
      `INSERT INTO fetches (signature, endpoint, commitment, outcome, retryable, detail, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.signature,
      record.endpoint,
      record.commitment,
      record.outcome,
      bitOf(record.retryable),
      record.detail,
      record.at ?? store.now(),
    );
}

/* ------------------------------------------------------------------ ingestion --- */

export interface RawObservationInput {
  readonly raw: unknown;
  readonly provenance: NormalizedProvenance;
  /** When the caller asked for a specific signature it is cross-checked, like the CLI does. */
  readonly expectSignature?: string;
}

export interface IngestResult {
  readonly signature: string;
  readonly outcome: FetchOutcome;
  /** True when evidence for this signature is present now as a result of this call. */
  readonly stored: boolean;
  /** True when this call replaced previously stored evidence with stronger evidence. */
  readonly replacedEvidence: boolean;
  /** Layers written by this call (empty when nothing was derived). */
  readonly derivedLayers: readonly DerivedLayer[];
  /** Only a fetch failure can be retryable; stored/not-found/normalization outcomes never are. */
  readonly retryable: boolean;
  /** Quality of the observation (null only when it could not be normalized at all). */
  readonly quality: EvidenceQuality | null;
  readonly detail: string;
}

interface StoredEvidence {
  readonly rawSha256: string;
  /** The codec that produced the stored text: hashes are only comparable within one codec. */
  readonly rawCodecVersion: number;
  readonly quality: EvidenceQuality;
  readonly observedAt: string;
}

/**
 * Ingests one raw response.
 *
 * Order of operations matters and is deliberate: normalize and derive **first** (pure, in
 * memory), then write everything in a single SQLite transaction. A crash therefore cannot
 * leave a transaction that looks ingested but has no artifacts, and a response that cannot
 * be normalized never creates a canonical row at all.
 */
export function ingestRawResponse(store: CorpusStore, input: RawObservationInput): IngestResult {
  const { raw, provenance } = input;
  assertProvenance(provenance);

  let transaction: NormalizedTransaction;
  try {
    transaction = normalizeTransaction(raw, { provenance });
  } catch (error) {
    const detail =
      error instanceof NormalizationError
        ? error.message
        : `the response could not be normalized: ${error instanceof Error ? error.message : String(error)}`;
    const signature = input.expectSignature ?? '(unknown)';
    recordFetchOutcome(store, {
      signature,
      endpoint: provenance.rpcEndpoint,
      commitment: provenance.commitment,
      outcome: 'normalization-error',
      retryable: false,
      detail,
    });
    return {
      signature,
      outcome: 'normalization-error',
      stored: false,
      replacedEvidence: false,
      derivedLayers: [],
      quality: null,
      detail,
      retryable: false,
    };
  }

  if (input.expectSignature !== undefined && transaction.signature !== input.expectSignature) {
    // Defensive, exactly like `inspect`: the RPC answered with a different transaction.
    const detail =
      `the response carries signature ${transaction.signature}, not the requested ` +
      `${input.expectSignature}; it is not stored under the requested identity`;
    recordFetchOutcome(store, {
      signature: input.expectSignature,
      endpoint: provenance.rpcEndpoint,
      commitment: provenance.commitment,
      outcome: 'normalization-error',
      retryable: false,
      detail,
    });
    return {
      signature: input.expectSignature,
      outcome: 'normalization-error',
      stored: false,
      replacedEvidence: false,
      derivedLayers: [],
      quality: null,
      detail,
      retryable: false,
    };
  }

  const signature = transaction.signature;
  const quality = evidenceQualityOf(transaction, provenance.commitment);
  const rawText = encodeEvidence(raw);
  const rawSha = sha256Hex(rawText);
  const stored = readStoredEvidence(store, signature);

  let outcome: FetchOutcome;
  let detail: string;
  let artifacts: DerivedArtifacts | null = null;
  let replacedEvidence = false;

  if (stored === null) {
    outcome = 'stored';
    detail = `stored raw evidence (${describeEvidenceQuality(quality)})`;
    artifacts = deriveArtifacts(transaction);
  } else {
    const comparison = compareEvidenceQuality(quality, stored.quality);
    if (comparison === 'stronger') {
      outcome = 'stored-upgraded';
      replacedEvidence = true;
      detail =
        `replaced the stored evidence (${describeEvidenceQuality(stored.quality)}) with this stronger ` +
        `observation (${describeEvidenceQuality(quality)})`;
      artifacts = deriveArtifacts(transaction);
    } else if (comparison === 'equal') {
      outcome = 'unchanged-equal-quality';
      detail =
        stored.rawCodecVersion !== CODEC_VERSION
          ? `the stored evidence is of equal quality and was kept; it was written by codec version ` +
            `${stored.rawCodecVersion}, so its bytes are not comparable to this observation`
          : rawSha === stored.rawSha256
            ? `the stored evidence is byte-identical to this observation (${describeEvidenceQuality(quality)})`
            : `the stored evidence is of equal quality and was kept (${describeEvidenceQuality(stored.quality)})`;
    } else {
      outcome = 'skipped-lower-quality';
      detail =
        `kept the stronger stored evidence (${describeEvidenceQuality(stored.quality)}); this observation ` +
        `is weaker (${describeEvidenceQuality(quality)})`;
    }
  }

  const at = store.now();
  const database = store.database;
  database.exec('BEGIN IMMEDIATE');
  try {
    if (artifacts !== null) {
      writeCanonicalRow(database, transaction, at, { countObservation: true });
      writeRawEvidence(database, {
        signature,
        rawText,
        rawSha256: rawSha,
        provenance,
        quality,
        observedAt: at,
      });
      // Every artifact for this signature was derived from the evidence being replaced,
      // so none of them survive — regardless of which semantics version produced them.
      database.prepare('DELETE FROM derived WHERE signature = ?').run(signature);
      writeArtifacts(database, signature, artifacts, at);
    } else {
      database
        .prepare('UPDATE transactions SET observation_count = observation_count + 1, last_seen_at = ? WHERE signature = ?')
        .run(at, signature);
    }
    recordFetchOutcome(store, {
      signature,
      endpoint: provenance.rpcEndpoint,
      commitment: provenance.commitment,
      outcome,
      retryable: false,
      detail,
      at,
    });
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Nothing useful to add: the original error is the one that matters.
    }
    throw error;
  }

  return {
    signature,
    outcome,
    stored: artifacts !== null,
    replacedEvidence,
    derivedLayers: artifacts === null ? [] : DERIVED_LAYERS,
    quality,
    detail,
    retryable: false,
  };
}

function readStoredEvidence(store: CorpusStore, signature: string): StoredEvidence | null {
  const row = store.database
    .prepare(
      `SELECT raw_sha256, raw_codec_version, commitment, meta_present, inner_instructions_available,
              token_balances_available, block_time_available, logs_present, observed_at
       FROM raw_responses WHERE signature = ?`,
    )
    .get(signature);
  if (row === undefined) return null;
  return {
    rawSha256: rowText(row, 'raw_sha256'),
    rawCodecVersion: rowInt(row, 'raw_codec_version'),
    observedAt: rowText(row, 'observed_at'),
    quality: {
      commitment: rowText(row, 'commitment') as CommitmentLevel,
      metaPresent: rowBit(row, 'meta_present'),
      innerInstructionsAvailable: rowBit(row, 'inner_instructions_available'),
      tokenBalancesAvailable: rowBit(row, 'token_balances_available'),
      blockTimeAvailable: rowBit(row, 'block_time_available'),
      logsPresent: rowBit(row, 'logs_present'),
    },
  };
}

function transactionVersionText(transaction: NormalizedTransaction): string {
  const version = transaction.version;
  switch (version.kind) {
    case 'legacy':
      return 'legacy';
    case 'numbered':
      return `numbered:${version.value}`;
    case 'unknown':
      return 'unknown';
  }
}

/**
 * One row per signature, written from the evidence that is currently preferred.
 *
 * On conflict every evidence-derived column is refreshed but `first_seen_at` is kept; only
 * `observation_count` / `last_seen_at` are bookkeeping, and only this function moves them.
 */
function writeCanonicalRow(
  database: DatabaseSync,
  transaction: NormalizedTransaction,
  at: string,
  options: { readonly countObservation: boolean },
): void {
  // Ordered as the INSERT lists them: signature first, and the observation timestamp last.
  const values = [
    transaction.signature,
    textOf(transaction.slot),
    numberTextOf(transaction.blockTimeUnix),
    transaction.status,
    transactionVersionText(transaction),
    textOf(transaction.feeLamports),
    textOf(transaction.computeUnitsConsumed),
    textOf(transaction.costUnits),
    transaction.recentBlockhash,
    transaction.feePayerAddress,
    transaction.instructions.length,
    transaction.innerInstructionGroups.reduce((total, group) => total + group.instructions.length, 0),
    transaction.accounts.length,
    transaction.logs === null ? null : transaction.logs.length,
    transaction.error === null ? null : encodeEvidence(transaction.error),
    at,
  ];

  if (!options.countObservation) {
    // Re-analysis refreshes the metadata but not the bookkeeping: `first_seen_at`,
    // `last_seen_at` and `observation_count` describe *observations*, and re-deriving from
    // evidence we already have is not one.
    const evidenceValues = values.slice(1, values.length - 1);
    database
      .prepare(
        `UPDATE transactions SET
           slot = ?, block_time_unix = ?, status = ?, transaction_version = ?, fee_lamports = ?,
           compute_units_consumed = ?, cost_units = ?, recent_blockhash = ?, fee_payer_address = ?,
           instruction_count = ?, inner_instruction_count = ?, account_count = ?, log_count = ?,
           error_evidence = ?
         WHERE signature = ?`,
      )
      .run(...evidenceValues, transaction.signature);
    return;
  }

  database
    .prepare(
      `INSERT INTO transactions (
         signature, slot, block_time_unix, status, transaction_version, fee_lamports,
         compute_units_consumed, cost_units, recent_blockhash, fee_payer_address,
         instruction_count, inner_instruction_count, account_count, log_count, error_evidence,
         first_seen_at, last_seen_at, observation_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(signature) DO UPDATE SET
         slot = excluded.slot, block_time_unix = excluded.block_time_unix, status = excluded.status,
         transaction_version = excluded.transaction_version, fee_lamports = excluded.fee_lamports,
         compute_units_consumed = excluded.compute_units_consumed, cost_units = excluded.cost_units,
         recent_blockhash = excluded.recent_blockhash, fee_payer_address = excluded.fee_payer_address,
         instruction_count = excluded.instruction_count,
         inner_instruction_count = excluded.inner_instruction_count,
         account_count = excluded.account_count, log_count = excluded.log_count,
         error_evidence = excluded.error_evidence, last_seen_at = excluded.last_seen_at,
         observation_count = transactions.observation_count + 1`,
    )
    .run(...values, at);
}

function writeRawEvidence(
  database: DatabaseSync,
  input: {
    readonly signature: string;
    readonly rawText: string;
    readonly rawSha256: string;
    readonly provenance: NormalizedProvenance;
    readonly quality: EvidenceQuality;
    readonly observedAt: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO raw_responses (
         signature, raw_text, raw_sha256, raw_codec_version, encoding, commitment, rpc_endpoint,
         max_supported_tx_version, meta_present, inner_instructions_available,
         token_balances_available, block_time_available, logs_present, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signature) DO UPDATE SET
         raw_text = excluded.raw_text, raw_sha256 = excluded.raw_sha256,
         raw_codec_version = excluded.raw_codec_version, encoding = excluded.encoding,
         commitment = excluded.commitment, rpc_endpoint = excluded.rpc_endpoint,
         max_supported_tx_version = excluded.max_supported_tx_version, meta_present = excluded.meta_present,
         inner_instructions_available = excluded.inner_instructions_available,
         token_balances_available = excluded.token_balances_available,
         block_time_available = excluded.block_time_available, logs_present = excluded.logs_present,
         observed_at = excluded.observed_at`,
    )
    .run(
      input.signature,
      input.rawText,
      input.rawSha256,
      CODEC_VERSION,
      input.provenance.encoding,
      input.provenance.commitment,
      input.provenance.rpcEndpoint,
      String(input.provenance.maxSupportedTransactionVersion),
      bitOf(input.quality.metaPresent),
      bitOf(input.quality.innerInstructionsAvailable),
      bitOf(input.quality.tokenBalancesAvailable),
      bitOf(input.quality.blockTimeAvailable),
      bitOf(input.quality.logsPresent),
      input.observedAt,
    );
}

/** Upserts the four artifacts for the current semantics version. */
function writeArtifacts(
  database: DatabaseSync,
  signature: string,
  artifacts: DerivedArtifacts,
  at: string,
  version: string = DERIVED_SEMANTICS_VERSION,
): readonly DerivedLayer[] {
  const byLayer: Readonly<Record<DerivedLayer, unknown>> = {
    normalized: artifacts.normalized,
    effects: artifacts.effects,
    swaps: artifacts.swaps,
    routes: artifacts.routes,
  };
  const statement = database.prepare(
    `INSERT INTO derived (signature, layer, semantics_version, artifact_text, artifact_sha256, produced_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(signature, layer, semantics_version) DO UPDATE SET
       artifact_text = excluded.artifact_text,
       artifact_sha256 = excluded.artifact_sha256,
       produced_at = excluded.produced_at`,
  );
  for (const layer of DERIVED_LAYERS) {
    const text = encodeEvidence(byLayer[layer]);
    statement.run(signature, layer, version, text, sha256Hex(text), at);
  }
  return DERIVED_LAYERS;
}

/* ------------------------------------------------------- ingest by signature ----- */

export interface IngestSignatureOptions {
  readonly rpc: TransactionRpcLike;
  readonly signature: string;
  readonly rpcEndpoint: string;
  readonly commitment: CommitmentLevel;
}

/**
 * Fetches one signature and ingests it.
 *
 * A `null` result is stored as a `not-found` outcome, never as a statement that the
 * transaction does not exist: an unknown signature, one pruned from the ledger and one this
 * node does not retain are indistinguishable from the response, so they stay indistinguishable
 * here too — and a later success is accepted normally.
 */
export async function ingestSignature(
  store: CorpusStore,
  options: IngestSignatureOptions,
): Promise<IngestResult> {
  let fetched;
  try {
    fetched = await fetchTransaction(options.rpc, options.signature, {
      rpcEndpoint: options.rpcEndpoint,
      commitment: options.commitment,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = error instanceof TransactionFetchError ? error.hint : null;
    const retryable = isRetryableFetchError(error);
    recordFetchOutcome(store, {
      signature: options.signature,
      endpoint: options.rpcEndpoint,
      commitment: options.commitment,
      outcome: 'rpc-error',
      retryable,
      detail: hint === null ? detail : `${detail} — ${hint}`,
    });
    return {
      signature: options.signature,
      outcome: 'rpc-error',
      stored: false,
      replacedEvidence: false,
      derivedLayers: [],
      quality: null,
      detail,
      retryable,
    };
  }

  if (fetched === null) {
    const detail =
      'the node returned null: the signature may not exist, may have been pruned, or may not be retained by this node';
    recordFetchOutcome(store, {
      signature: options.signature,
      endpoint: options.rpcEndpoint,
      commitment: options.commitment,
      outcome: 'not-found',
      retryable: false,
      detail,
    });
    return {
      signature: options.signature,
      outcome: 'not-found',
      stored: false,
      replacedEvidence: false,
      derivedLayers: [],
      quality: null,
      detail,
      retryable: false,
    };
  }

  return ingestRawResponse(store, {
    raw: fetched.raw,
    provenance: fetched.provenance,
    expectSignature: options.signature,
  });
}

/* --------------------------------------------------- bounded address ingestion --- */

export interface AddressIngestOptions {
  readonly rpc: CorpusRpcLike;
  readonly address: string;
  /** Upper bound on signatures examined by this run. */
  readonly max: number;
  readonly rpcEndpoint: string;
  readonly commitment: CommitmentLevel;
  /** Signatures requested per page. Defaults to 50. */
  readonly pageLimit?: number;
  readonly onEvent?: (event: AddressIngestEvent) => void;
}

export interface AddressIngestEvent {
  readonly kind: 'page' | 'signature' | 'skipped-present' | 'duplicate' | 'halted';
  readonly message: string;
}

export interface AddressIngestResult {
  readonly address: string;
  readonly examined: number;
  readonly stored: number;
  readonly upgraded: number;
  readonly alreadyPresent: number;
  readonly skippedPresent: number;
  readonly notFound: number;
  readonly errors: number;
  readonly pages: number;
  /** The run stopped early (a page request or a fetch failed). */
  readonly halted: boolean;
  /** The failure that stopped it was retryable, so re-running the same command should resume. */
  readonly retryable: boolean;
  readonly detail: string | null;
  readonly complete: boolean;
  readonly cursor: string | null;
}

const DEFAULT_PAGE_LIMIT = 50;

/**
 * Ingests up to `max` signatures of an address, newest first, resumably.
 *
 * Three rules make this safe to interrupt:
 *
 *  1. Signatures already stored are skipped **without** an RPC call (so a sweep over a
 *     known range costs no `getTransaction` calls) and are not counted as fetches.
 *  2. The cursor advances to the newest signature whose outcome was *definitive* (stored,
 *     already present, or not found). A retryable failure stops the run and leaves the
 *     cursor before that signature, so the next run returns to it — nothing is skipped.
 *  3. A duplicate signature across pages, or within one, is examined once per run.
 *
 * A completed cursor (`complete = 1`) means the address was swept to the end of its history;
 * the next run starts a fresh sweep from the newest signature rather than resuming into
 * nothing.
 */
export async function ingestAddress(
  store: CorpusStore,
  options: AddressIngestOptions,
): Promise<AddressIngestResult> {
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const emit = options.onEvent ?? ((): void => {});
  const cursor = readCursor(store, options.address);

  let before = cursor !== null && !cursor.complete ? cursor.beforeSignature : null;
  let pagesFetched = cursor?.pagesFetched ?? 0;
  let signaturesSeen = cursor?.signaturesSeen ?? 0;

  const seenThisRun = new Set<string>();
  let examined = 0;
  let stored = 0;
  let upgraded = 0;
  let alreadyPresent = 0;
  let skippedPresent = 0;
  let notFound = 0;
  let errors = 0;
  let pages = 0;
  let halted = false;
  let retryable = false;
  let complete = false;
  let detail: string | null = null;
  // Whether this run learned anything about the address. A run that dies before handling a
  // single signature must not rewrite (or clear) the resume state of an earlier one.
  let touched = false;

  while (examined < options.max) {
    const limit = Math.max(1, Math.min(pageLimit, options.max - examined));
    let page: Awaited<ReturnType<typeof fetchSignaturePage>>;
    try {
      page = await fetchSignaturePage(options.rpc, options.address, { limit, before });
    } catch (error) {
      // The run-level failure is reported, not persisted: `fetches` is keyed by signature,
      // and no signature was reached. The cursor is untouched, so nothing is skipped.
      halted = true;
      retryable = true;
      detail = `page request failed: ${error instanceof Error ? error.message : String(error)}`;
      emit({ kind: 'halted', message: detail });
      break;
    }

    pages += 1;
    pagesFetched += 1;
    emit({ kind: 'page', message: `page ${pages}: ${page.length} signature(s)` });
    if (page.length === 0) {
      complete = true;
      touched = true;
      break;
    }

    let lastHandled: string | null = null;
    for (const entry of page) {
      if (examined >= options.max) break;
      if (seenThisRun.has(entry.signature)) {
        emit({ kind: 'duplicate', message: `duplicate signature ${entry.signature} ignored` });
        continue;
      }
      seenThisRun.add(entry.signature);
      examined += 1;
      signaturesSeen += 1;

      if (hasTransaction(store, entry.signature)) {
        skippedPresent += 1;
        lastHandled = entry.signature;
        emit({ kind: 'skipped-present', message: `${entry.signature} already stored` });
        continue;
      }

      const result = await ingestSignature(store, {
        rpc: options.rpc,
        signature: entry.signature,
        rpcEndpoint: options.rpcEndpoint,
        commitment: options.commitment,
      });
      emit({ kind: 'signature', message: `${entry.signature} ${result.outcome}` });

      if (result.outcome === 'rpc-error') {
        errors += 1;
        halted = true;
        retryable = result.retryable;
        detail = `stopped at ${entry.signature}: ${result.detail}`;
        emit({ kind: 'halted', message: detail });
        break;
      }
      if (result.outcome === 'not-found') notFound += 1;
      else if (result.outcome === 'stored') stored += 1;
      else if (result.outcome === 'stored-upgraded') upgraded += 1;
      else alreadyPresent += 1;
      lastHandled = entry.signature;
    }

    if (lastHandled !== null) {
      before = lastHandled;
      touched = true;
      writeCursor(store, {
        address: options.address,
        beforeSignature: before,
        pagesFetched,
        signaturesSeen,
        complete: false,
        updatedAt: store.now(),
      });
    }
    if (halted) break;
    if (page.length < limit) {
      complete = true;
      touched = true;
      break;
    }
  }

  if (touched) {
    writeCursor(store, {
      address: options.address,
      beforeSignature: before,
      pagesFetched,
      signaturesSeen,
      complete,
      updatedAt: store.now(),
    });
  }

  return {
    address: options.address,
    examined,
    stored,
    upgraded,
    alreadyPresent,
    skippedPresent,
    notFound,
    errors,
    pages,
    halted,
    retryable,
    detail,
    complete,
    cursor: readCursor(store, options.address)?.beforeSignature ?? before,
  };
}

export interface IngestCursor {
  readonly address: string;
  readonly beforeSignature: string | null;
  readonly pagesFetched: number;
  readonly signaturesSeen: number;
  readonly complete: boolean;
  readonly updatedAt: string;
}

export function readCursor(store: CorpusStore, address: string): IngestCursor | null {
  const row = store.database
    .prepare(
      `SELECT address, before_signature, pages_fetched, signatures_seen, complete, updated_at
       FROM ingest_cursors WHERE address = ?`,
    )
    .get(address);
  if (row === undefined) return null;
  return {
    address: rowText(row, 'address'),
    beforeSignature: rowTextOrNull(row, 'before_signature'),
    pagesFetched: rowInt(row, 'pages_fetched'),
    signaturesSeen: rowInt(row, 'signatures_seen'),
    complete: rowBit(row, 'complete'),
    updatedAt: rowText(row, 'updated_at'),
  };
}

function writeCursor(store: CorpusStore, cursor: IngestCursor): void {
  store.database
    .prepare(
      `INSERT INTO ingest_cursors (address, before_signature, pages_fetched, signatures_seen, complete, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         before_signature = excluded.before_signature, pages_fetched = excluded.pages_fetched,
         signatures_seen = excluded.signatures_seen, complete = excluded.complete,
         updated_at = excluded.updated_at`,
    )
    .run(
      cursor.address,
      cursor.beforeSignature,
      cursor.pagesFetched,
      cursor.signaturesSeen,
      bitOf(cursor.complete),
      cursor.updatedAt,
    );
}

export function hasTransaction(store: CorpusStore, signature: string): boolean {
  const row = store.database.prepare('SELECT 1 AS present FROM transactions WHERE signature = ?').get(signature);
  return row !== undefined;
}

/* ---------------------------------------------------------------------- reads --- */

export interface StoredRawEvidence {
  readonly raw: unknown;
  readonly provenance: NormalizedProvenance;
  readonly rawSha256: string;
  /** Codec version that produced the stored text (see `CODEC_VERSION`). */
  readonly rawCodecVersion: number;
  readonly observedAt: string;
}

/**
 * Loads the preferred raw evidence and the provenance it was observed with.
 *
 * The provenance is stored alongside the payload because it is part of the evidence: the
 * commitment decides what `normalizeTransaction` records, so re-deriving without it would
 * not reproduce the original artifact.
 */
export function loadRawEvidence(store: CorpusStore, signature: string): StoredRawEvidence | null {
  const row = store.database
    .prepare(
      `SELECT raw_text, raw_sha256, raw_codec_version, encoding, commitment, rpc_endpoint,
              max_supported_tx_version, observed_at
       FROM raw_responses WHERE signature = ?`,
    )
    .get(signature);
  if (row === undefined) return null;
  const versionText = rowText(row, 'max_supported_tx_version');
  const raw = decodeEvidence(rowText(row, 'raw_text'));
  return {
    raw,
    rawSha256: rowText(row, 'raw_sha256'),
    rawCodecVersion: rowInt(row, 'raw_codec_version'),
    observedAt: rowText(row, 'observed_at'),
    provenance: {
      rpcEndpoint: rowText(row, 'rpc_endpoint'),
      encoding: 'jsonParsed',
      commitment: rowText(row, 'commitment') as CommitmentLevel,
      maxSupportedTransactionVersion: parseVersion(versionText),
    },
  };
}

function parseVersion(value: string): 0 | 1 | null {
  if (value === 'null') return null;
  const parsed = Number(value);
  if (parsed === 0 || parsed === 1) return parsed;
  throw new StoreSchemaError(`stored max_supported_tx_version "${value}" is not 0, 1 or null`);
}

export interface StoredTransactionRow {
  readonly signature: string;
  readonly slot: string;
  readonly blockTimeUnix: string | null;
  readonly status: string;
  readonly transactionVersion: string;
  readonly feeLamports: string | null;
  readonly feePayerAddress: string | null;
  readonly instructionCount: number;
  readonly innerInstructionCount: number;
  readonly accountCount: number;
  readonly logCount: number | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly observationCount: number;
}

export interface StoredTransaction {
  readonly row: StoredTransactionRow;
  readonly evidence: StoredEvidence;
  /** Layers present at the current semantics version. */
  readonly derivedLayers: readonly DerivedLayer[];
  /** Semantics versions present for this signature other than the current one. */
  readonly staleVersions: readonly string[];
}

export function getStoredTransaction(store: CorpusStore, signature: string): StoredTransaction | null {
  const row = store.database.prepare('SELECT * FROM transactions WHERE signature = ?').get(signature);
  if (row === undefined) return null;
  const evidence = readStoredEvidence(store, signature);
  if (evidence === null) {
    throw new StoreSchemaError(`transaction ${signature} has no raw evidence; the store is inconsistent`);
  }
  const versions = store.database
    .prepare('SELECT DISTINCT semantics_version AS version FROM derived WHERE signature = ?')
    .all(signature)
    .map(entry => rowText(entry, 'version'))
    .sort();
  const layers = store.database
    .prepare('SELECT layer FROM derived WHERE signature = ? AND semantics_version = ?')
    .all(signature, store.semanticsVersion)
    .map(entry => rowText(entry, 'layer'))
    .filter(isDerivedLayer)
    .sort();
  return {
    row: {
      signature: rowText(row, 'signature'),
      slot: rowText(row, 'slot'),
      blockTimeUnix: rowTextOrNull(row, 'block_time_unix'),
      status: rowText(row, 'status'),
      transactionVersion: rowText(row, 'transaction_version'),
      feeLamports: rowTextOrNull(row, 'fee_lamports'),
      feePayerAddress: rowTextOrNull(row, 'fee_payer_address'),
      instructionCount: rowInt(row, 'instruction_count'),
      innerInstructionCount: rowInt(row, 'inner_instruction_count'),
      accountCount: rowInt(row, 'account_count'),
      logCount: row['log_count'] === null ? null : rowInt(row, 'log_count'),
      firstSeenAt: rowText(row, 'first_seen_at'),
      lastSeenAt: rowText(row, 'last_seen_at'),
      observationCount: rowInt(row, 'observation_count'),
    },
    evidence,
    derivedLayers: layers,
    staleVersions: versions.filter(version => version !== store.semanticsVersion),
  };
}

/**
 * Loads one stored artifact, decoded.
 *
 * Only artifacts at the *current* semantics version are ever returned: rows from an older
 * engine are reported as stale (see `StoredTransaction.staleVersions`) and never served as
 * if they were current.
 */
function loadArtifact(store: CorpusStore, signature: string, layer: DerivedLayer): unknown | null {
  const row = store.database
    .prepare('SELECT artifact_text FROM derived WHERE signature = ? AND layer = ? AND semantics_version = ?')
    .get(signature, layer, store.semanticsVersion);
  if (row === undefined) return null;
  return decodeEvidence(rowText(row, 'artifact_text'));
}

/** The stored normalized model, without its raw payload. */
export function loadNormalizedArtifact(
  store: CorpusStore,
  signature: string,
): StoredNormalizedTransaction | null {
  const value = loadArtifact(store, signature, 'normalized');
  return value === null ? null : (value as StoredNormalizedTransaction);
}

/** The rehydrated normalized model: the stored artifact with its raw evidence re-attached. */
export function loadTransactionModel(store: CorpusStore, signature: string): NormalizedTransaction | null {
  const stored = loadNormalizedArtifact(store, signature);
  if (stored === null) return null;
  const evidence = loadRawEvidence(store, signature);
  if (evidence === null) {
    throw new StoreSchemaError(`transaction ${signature} has a normalized artifact but no raw evidence`);
  }
  return rehydrateNormalized(stored, evidence.raw);
}

export function loadEffectsArtifact(store: CorpusStore, signature: string): TransactionEffects | null {
  const value = loadArtifact(store, signature, 'effects');
  return value === null ? null : (value as TransactionEffects);
}

export function loadSwapsArtifact(store: CorpusStore, signature: string): SwapReport | null {
  const value = loadArtifact(store, signature, 'swaps');
  return value === null ? null : (value as SwapReport);
}

export function loadRoutesArtifact(store: CorpusStore, signature: string): RouteReport | null {
  const value = loadArtifact(store, signature, 'routes');
  return value === null ? null : (value as RouteReport);
}

/* ------------------------------------------------------------------ reanalysis -- */

export type ReanalyzeOutcome = 'reanalyzed' | 'skipped-no-evidence' | 'failed';

export interface ReanalyzeResult {
  readonly signature: string;
  readonly outcome: ReanalyzeOutcome;
  readonly layers: readonly DerivedLayer[];
  readonly detail: string;
  readonly prunedVersions: readonly string[];
}

export interface ReanalyzeOptions {
  readonly pruneOlderVersions?: boolean;
}

/**
 * Recomputes every artifact for one signature **from the stored raw evidence**.
 *
 * No RPC request is made, and the raw evidence is never written to: this is the operation
 * that makes a new recognizer retroactive. If the stored evidence cannot be decoded or
 * re-normalized, the function reports `failed` and touches nothing — a corpus keeps its last
 * good artifacts rather than losing them to a corrupt row.
 */
export function reanalyzeSignature(
  store: CorpusStore,
  signature: string,
  options: ReanalyzeOptions = {},
): ReanalyzeResult {
  let evidence: StoredRawEvidence | null;
  try {
    evidence = loadRawEvidence(store, signature);
  } catch (error) {
    return {
      signature,
      outcome: 'failed',
      layers: [],
      detail: `stored raw evidence could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
      prunedVersions: [],
    };
  }
  if (evidence === null) {
    return {
      signature,
      outcome: 'skipped-no-evidence',
      layers: [],
      detail: 'no raw evidence is stored for this signature',
      prunedVersions: [],
    };
  }

  let transaction: NormalizedTransaction;
  let artifacts: DerivedArtifacts;
  try {
    const derived = normalizeAndDerive(evidence.raw, evidence.provenance);
    transaction = derived.transaction;
    artifacts = derived.artifacts;
  } catch (error) {
    return {
      signature,
      outcome: 'failed',
      layers: [],
      detail:
        error instanceof EvidenceCodecError
          ? `stored raw evidence could not be decoded: ${error.message}`
          : `the stored raw evidence could not be re-processed: ${error instanceof Error ? error.message : String(error)}`,
      prunedVersions: [],
    };
  }

  const at = store.now();
  const database = store.database;
  const olderVersions = database
    .prepare('SELECT DISTINCT semantics_version AS version FROM derived WHERE signature = ? AND semantics_version <> ?')
    .all(signature, store.semanticsVersion)
    .map(entry => rowText(entry, 'version'));
  const prunedVersions = options.pruneOlderVersions === true ? olderVersions : [];

  database.exec('BEGIN IMMEDIATE');
  try {
    // The canonical row is metadata *derived from* the preferred evidence, so re-analysis
    // refreshes it too — bookkeeping columns (observation count, first/last seen) untouched.
    writeCanonicalRow(database, transaction, at, { countObservation: false });
    writeArtifacts(database, signature, artifacts, at);
    if (prunedVersions.length > 0) {
      database
        .prepare('DELETE FROM derived WHERE signature = ? AND semantics_version <> ?')
        .run(signature, store.semanticsVersion);
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The original error is the one that matters.
    }
    throw error;
  }

  return {
    signature,
    outcome: 'reanalyzed',
    layers: DERIVED_LAYERS,
    detail: `re-derived ${DERIVED_LAYERS.length} artifact(s) from the stored raw evidence at ${store.semanticsVersion}`,
    prunedVersions,
  };
}

export interface ReanalyzeSummary {
  readonly requested: number;
  readonly reanalyzed: number;
  readonly skippedNoEvidence: number;
  readonly failed: number;
  readonly results: readonly ReanalyzeResult[];
}

/** Signatures that have no complete set of artifacts at the current semantics version. */
export function listSignaturesNeedingReanalysis(store: CorpusStore): readonly string[] {
  return store.database
    .prepare(
      `SELECT t.signature AS signature FROM transactions t
       WHERE NOT EXISTS (
         SELECT 1 FROM derived d
         WHERE d.signature = t.signature AND d.semantics_version = ?
       )
       ORDER BY t.signature`,
    )
    .all(store.semanticsVersion)
    .map(row => rowText(row, 'signature'));
}

export function listAllSignatures(store: CorpusStore): readonly string[] {
  return store.database
    .prepare('SELECT signature FROM transactions ORDER BY signature')
    .all()
    .map(row => rowText(row, 'signature'));
}

/**
 * Re-derives artifacts for every stored transaction (or only those whose artifacts are
 * missing/from another version when `onlyStale` is true, which is the default).
 */
export function reanalyzeAll(
  store: CorpusStore,
  options: ReanalyzeOptions & { readonly onlyStale?: boolean } = {},
): ReanalyzeSummary {
  const onlyStale = options.onlyStale ?? true;
  const signatures = onlyStale ? listSignaturesNeedingReanalysis(store) : listAllSignatures(store);
  const results = signatures.map(signature =>
    reanalyzeSignature(store, signature, { pruneOlderVersions: options.pruneOlderVersions === true }),
  );
  return {
    requested: signatures.length,
    reanalyzed: results.filter(result => result.outcome === 'reanalyzed').length,
    skippedNoEvidence: results.filter(result => result.outcome === 'skipped-no-evidence').length,
    failed: results.filter(result => result.outcome === 'failed').length,
    results,
  };
}

/* ----------------------------------------------------------------------- stats -- */

export interface StoreStats {
  readonly path: string;
  readonly formatVersion: number;
  readonly semanticsVersion: string;
  readonly transactions: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly evidence: {
    readonly metaPresent: number;
    readonly innerInstructionsAvailable: number;
    readonly tokenBalancesAvailable: number;
    readonly blockTimeAvailable: number;
  };
  readonly fetches: {
    readonly total: number;
    readonly byOutcome: Readonly<Record<string, number>>;
  };
  readonly derived: {
    readonly rows: number;
    readonly currentVersionRows: number;
    readonly staleRows: number;
    readonly signaturesNeedingReanalysis: number;
  };
  readonly cursors: readonly IngestCursor[];
}

export function storeStats(store: CorpusStore): StoreStats {
  const database = store.database;
  const count = (sql: string, ...params: readonly (string | number)[]): number => {
    const row = database.prepare(sql).get(...params);
    return row === undefined ? 0 : rowInt(row, 'n');
  };

  const byStatus: Record<string, number> = {};
  for (const entry of database.prepare('SELECT status, COUNT(*) AS n FROM transactions GROUP BY status ORDER BY status').all()) {
    byStatus[rowText(entry, 'status')] = rowInt(entry, 'n');
  }
  const byOutcome: Record<string, number> = {};
  for (const entry of database.prepare('SELECT outcome, COUNT(*) AS n FROM fetches GROUP BY outcome ORDER BY outcome').all()) {
    byOutcome[rowText(entry, 'outcome')] = rowInt(entry, 'n');
  }

  return {
    path: store.path,
    formatVersion: store.formatVersion,
    semanticsVersion: store.semanticsVersion,
    transactions: count('SELECT COUNT(*) AS n FROM transactions'),
    byStatus,
    evidence: {
      metaPresent: count('SELECT COUNT(*) AS n FROM raw_responses WHERE meta_present = 1'),
      innerInstructionsAvailable: count(
        'SELECT COUNT(*) AS n FROM raw_responses WHERE inner_instructions_available = 1',
      ),
      tokenBalancesAvailable: count('SELECT COUNT(*) AS n FROM raw_responses WHERE token_balances_available = 1'),
      blockTimeAvailable: count('SELECT COUNT(*) AS n FROM raw_responses WHERE block_time_available = 1'),
    },
    fetches: { total: count('SELECT COUNT(*) AS n FROM fetches'), byOutcome },
    derived: {
      rows: count('SELECT COUNT(*) AS n FROM derived'),
      currentVersionRows: count('SELECT COUNT(*) AS n FROM derived WHERE semantics_version = ?', store.semanticsVersion),
      staleRows: count('SELECT COUNT(*) AS n FROM derived WHERE semantics_version <> ?', store.semanticsVersion),
      signaturesNeedingReanalysis: listSignaturesNeedingReanalysis(store).length,
    },
    cursors: database
      .prepare('SELECT address FROM ingest_cursors ORDER BY address')
      .all()
      .map(row => readCursor(store, rowText(row, 'address')))
      .filter((cursor): cursor is IngestCursor => cursor !== null),
  };
}
