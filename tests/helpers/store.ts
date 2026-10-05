/**
 * Test helpers for the corpus store (Milestone 5.1).
 *
 * Three things every storage test needs, and none of them touch the network:
 *
 *  - a throwaway store file per test,
 *  - a scriptable `CorpusRpcLike` fake (so ingestion, not-found, rate limits and paging can
 *    all be exercised deterministically),
 *  - the ability to *degrade* a recorded response, which is what the evidence-quality rules
 *    are about: the same transaction, reported less completely by a different node.
 *
 * `node:sqlite` only exists from Node 22.5 (`engines` says so), so the store module is
 * imported **conditionally**: on an older Node the storage suites are skipped instead of
 * failing at collection time, and the rest of the repository's tests still run.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedProvenance } from '../../src/model/transaction.ts';
import type { CorpusRpcLike } from '../../src/store/rpc.ts';
import { loadFixture } from './fixtures.ts';

/** The store module's public surface, as the storage tests use it. */
export type StoreModule = typeof import('../../src/store/store.ts');

/** `node:sqlite` exists from Node 22.5; without it the storage suites cannot run at all. */
export const sqliteAvailable: boolean = (() => {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

/**
 * The store module, or `null` on a Node without `node:sqlite`.
 *
 * Loaded with a conditional top-level `await` so that an unsupported Node never even
 * attempts the import — which is what would otherwise fail the whole test file.
 */
export const storeModule: StoreModule | null = sqliteAvailable
  ? await import('../../src/store/store.ts')
  : null;

/** The store module, for use inside a suite guarded by `sqliteAvailable`. */
export function api(): StoreModule {
  if (storeModule === null) {
    throw new Error('node:sqlite is unavailable: this storage test should have been skipped');
  }
  return storeModule;
}

/** The endpoint stamped onto fixture-derived observations. Never contacted. */
export const FIXTURE_ENDPOINT = 'https://fixture.invalid';

export function fixtureProvenance(overrides: Partial<NormalizedProvenance> = {}): NormalizedProvenance {
  return {
    rpcEndpoint: FIXTURE_ENDPOINT,
    encoding: 'jsonParsed',
    commitment: 'finalized',
    maxSupportedTransactionVersion: 1,
    ...overrides,
  };
}

/** One fixture as an ingestable observation: the raw response plus its provenance. */
export function fixtureObservation(
  name: string,
  overrides: Partial<NormalizedProvenance> = {},
): { readonly raw: unknown; readonly provenance: NormalizedProvenance; readonly signature: string } {
  const envelope = loadFixture(name);
  return {
    raw: envelope.response,
    provenance: fixtureProvenance(overrides),
    signature: envelope.request.signature,
  };
}

export function fixtureRaw(name: string): Record<string, unknown> {
  return loadFixture(name).response as Record<string, unknown>;
}

export function fixtureSignature(name: string): string {
  return loadFixture(name).request.signature;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface DegradeOptions {
  /** Replace `meta` with `null`: no status, no fee, no balances, no CPIs. */
  readonly dropMeta?: boolean;
  /** Report `innerInstructions: null`, as a node that did not record the CPI tree does. */
  readonly dropInnerInstructions?: boolean;
  /** Omit `pre/postTokenBalances`, as a node that reports no token movement does. */
  readonly dropTokenBalances?: boolean;
  /** Omit `blockTime`. */
  readonly dropBlockTime?: boolean;
  /** Report `logMessages: null`, as a node that sent no logs does. */
  readonly dropLogs?: boolean;
}

/**
 * Returns a copy of a raw response with evidence removed — never added or altered.
 *
 * This is how the tests produce a *weaker* observation of the same transaction, which is
 * the only honest way to exercise the evidence-quality rule.
 */
export function degrade(raw: unknown, options: DegradeOptions): Record<string, unknown> {
  const copy = clone(raw) as Record<string, unknown>;
  if (options.dropMeta === true) {
    copy['meta'] = null;
    return copy;
  }
  const meta = copy['meta'];
  if (meta === null || typeof meta !== 'object') return copy;
  const record = meta as Record<string, unknown>;
  if (options.dropInnerInstructions === true) record['innerInstructions'] = null;
  if (options.dropTokenBalances === true) {
    record['preTokenBalances'] = null;
    record['postTokenBalances'] = null;
  }
  if (options.dropLogs === true) record['logMessages'] = null;
  if (options.dropBlockTime === true) copy['blockTime'] = null;
  return copy;
}

/* ------------------------------------------------------------------ temp stores -- */

export interface TempStore {
  readonly store: import('../../src/store/store.ts').CorpusStore;
  readonly path: string;
  /** Closes the store and removes its directory. Safe to call more than once. */
  cleanup(): void;
}

/** Creates a store in its own temp directory, so tests never share a corpus file. */
export function createTempStore(options: { readonly now?: () => string } = {}): TempStore {
  const directory = mkdtempSync(join(tmpdir(), 'solana-corpus-'));
  const path = join(directory, 'corpus.db');
  const module = api();
  let store: import('../../src/store/store.ts').CorpusStore | null = options.now
    ? module.openCorpusStore(path, { now: options.now })
    : module.openCorpusStore(path);
  return {
    path,
    get store(): import('../../src/store/store.ts').CorpusStore {
      if (store === null) throw new Error('the store is closed');
      return store;
    },
    cleanup(): void {
      store?.close();
      store = null;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Runs `body` against a fresh store and always cleans up, even when it throws. */
export function withTempStore<T>(
  body: (
    store: import('../../src/store/store.ts').CorpusStore,
    temp: TempStore,
  ) => T,
): T {
  const temp = createTempStore();
  try {
    return body(temp.store, temp);
  } finally {
    temp.cleanup();
  }
}

/** `withTempStore` for an asynchronous body. */
export async function withTempStoreAsync<T>(
  body: (
    store: import('../../src/store/store.ts').CorpusStore,
    temp: TempStore,
  ) => Promise<T>,
): Promise<T> {
  const temp = createTempStore();
  try {
    return await body(temp.store, temp);
  } finally {
    temp.cleanup();
  }
}

/* -------------------------------------------------------------------- fake RPC --- */

export interface TransactionCall {
  readonly signature: string;
  readonly config: Record<string, unknown>;
}

export interface PageCall {
  readonly address: string;
  readonly config: Record<string, unknown>;
}

export type TransactionScript = unknown | null | Error;
export type SignaturePageScript = readonly { readonly signature: string; readonly slot: number }[] | Error;

/**
 * A deterministic `CorpusRpcLike`.
 *
 * `transactions` maps a signature to the response to return (`null` = not found, an `Error`
 * = a transport or rate-limit failure). `pages` is consumed in order, so a paged run can be
 * interrupted mid-history and resumed exactly as a real one would be.
 */
export class FakeRpc implements CorpusRpcLike {
  public readonly transactionCalls: TransactionCall[] = [];
  public readonly pageCalls: PageCall[] = [];
  private pageIndex = 0;

  public constructor(
    private readonly transactions: Map<string, TransactionScript> = new Map(),
    private readonly pages: readonly SignaturePageScript[] = [],
  ) {}

  public set(signature: string, response: TransactionScript): void {
    this.transactions.set(signature, response);
  }

  public getTransaction(signature: string, config: Record<string, unknown>): { send(): Promise<unknown> } {
    this.transactionCalls.push({ signature, config });
    const value = this.transactions.get(signature) ?? null;
    return {
      send: async (): Promise<unknown> => {
        if (value instanceof Error) throw value;
        return value;
      },
    };
  }

  public getSignaturesForAddress(
    address: string,
    config: Record<string, unknown>,
  ): { send(): Promise<unknown> } {
    this.pageCalls.push({ address, config });
    const script = this.pages[this.pageIndex];
    this.pageIndex += 1;
    return {
      send: async (): Promise<unknown> => {
        if (script === undefined) return [];
        if (script instanceof Error) throw script;
        return script;
      },
    };
  }
}

/** An error shaped like a public-endpoint rate limit. */
export function rateLimitError(): Error {
  return new Error('429 Too Many Requests: rate limit exceeded');
}

/** An error shaped like a transport failure. */
export function transportError(): Error {
  return new Error('fetch failed: socket hang up ECONNRESET');
}

/* ------------------------------------------------------------------- assertions --- */

export interface TableCounts {
  readonly transactions: number;
  readonly raw_responses: number;
  readonly fetches: number;
  readonly derived: number;
  readonly ingest_cursors: number;
}

/** Row counts of every table, for asserting that "nothing changed" is literal. */
export function tableCounts(store: import('../../src/store/store.ts').CorpusStore): TableCounts {
  const one = (table: string): number => {
    const row = store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return row === undefined ? -1 : Number(row['n']);
  };
  return {
    transactions: one('transactions'),
    raw_responses: one('raw_responses'),
    fetches: one('fetches'),
    derived: one('derived'),
    ingest_cursors: one('ingest_cursors'),
  };
}

export interface RawRowSnapshot {
  readonly raw_sha256: string;
  readonly raw_text: string;
  readonly commitment: string;
  readonly meta_present: number;
  readonly inner_instructions_available: number;
  readonly token_balances_available: number;
  readonly block_time_available: number;
  readonly logs_present: number;
  readonly observed_at: string;
}

export function rawRow(
  store: import('../../src/store/store.ts').CorpusStore,
  signature: string,
): RawRowSnapshot | null {
  const row = store.database.prepare('SELECT * FROM raw_responses WHERE signature = ?').get(signature);
  if (row === undefined) return null;
  const text = (key: string): string => String(row[key]);
  const num = (key: string): number => Number(row[key]);
  return {
    raw_sha256: text('raw_sha256'),
    raw_text: text('raw_text'),
    commitment: text('commitment'),
    meta_present: num('meta_present'),
    inner_instructions_available: num('inner_instructions_available'),
    token_balances_available: num('token_balances_available'),
    block_time_available: num('block_time_available'),
    logs_present: num('logs_present'),
    observed_at: text('observed_at'),
  };
}

export interface ArtifactSnapshot {
  readonly layer: string;
  readonly semantics_version: string;
  readonly artifact_text: string;
  readonly artifact_sha256: string;
}

export function artifacts(
  store: import('../../src/store/store.ts').CorpusStore,
  signature: string,
): readonly ArtifactSnapshot[] {
  return store.database
    .prepare(
      'SELECT layer, semantics_version, artifact_text, artifact_sha256 FROM derived WHERE signature = ? ORDER BY layer, semantics_version',
    )
    .all(signature)
    .map(row => ({
      layer: String(row['layer']),
      semantics_version: String(row['semantics_version']),
      artifact_text: String(row['artifact_text']),
      artifact_sha256: String(row['artifact_sha256']),
    }));
}

export interface FetchRowSnapshot {
  readonly id: number;
  readonly outcome: string;
  readonly retryable: number;
  readonly detail: string | null;
}

export function fetchRows(
  store: import('../../src/store/store.ts').CorpusStore,
  signature: string,
): readonly FetchRowSnapshot[] {
  return store.database
    .prepare('SELECT id, outcome, retryable, detail FROM fetches WHERE signature = ? ORDER BY id')
    .all(signature)
    .map(row => ({
      id: Number(row['id']),
      outcome: String(row['outcome']),
      retryable: Number(row['retryable']),
      detail: row['detail'] === null ? null : String(row['detail']),
    }));
}

/** The `derived` artifact text for one layer at the current semantics version. */
export function artifactText(
  store: import('../../src/store/store.ts').CorpusStore,
  signature: string,
  layer: string,
): string | null {
  const row = store.database
    .prepare('SELECT artifact_text FROM derived WHERE signature = ? AND layer = ? AND semantics_version = ?')
    .get(signature, layer, store.semanticsVersion);
  return row === undefined ? null : String(row['artifact_text']);
}

export function columnNames(
  store: import('../../src/store/store.ts').CorpusStore,
  table: string,
): readonly string[] {
  return store.database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(row => String(row['name']));
}

export function tableNames(store: import('../../src/store/store.ts').CorpusStore): readonly string[] {
  return store.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(row => String(row['name']));
}

/** Path of a tracked fixture file, for the "ingest --fixture" CLI test. */
export function fixtureFilePath(name: string): string {
  return join(process.cwd(), 'fixtures', `${name}.json`);
}

export function readFixtureFile(name: string): { request: { signature: string } } {
  return JSON.parse(readFileSync(fixtureFilePath(name), 'utf8')) as { request: { signature: string } };
}
