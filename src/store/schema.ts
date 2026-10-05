/**
 * The corpus store schema (Milestone 5.1).
 *
 * Five tables, and each one answers a question the others cannot:
 *
 * ```
 * transactions    canonical identity + evidence-derived metadata (one row per signature)
 * raw_responses   the durable raw evidence, exactly one preferred row per signature
 * fetches         append-only fetch history, including the fetches that found nothing
 * derived         versioned deterministic artifacts, one row per (signature, layer, version)
 * ingest_cursors  resume state for bounded address ingestion
 * ```
 *
 * Rules the DDL itself enforces:
 *
 *  - **`STRICT` on every table.** Two mistakes are possible here and only one of them can be
 *    caught by the schema, which is worth being precise about:
 *      * a REAL reaching an `INTEGER` column (a count, an evidence flag) is rejected
 *        outright — the default affinity would have stored it;
 *      * a JS `number` reaching a `TEXT` amount column is **not** rejected: SQLite coerces
 *        it (`2` becomes `'2.0'`, `1.5` becomes `'1.5'`). Exactness there is therefore a
 *        property of the code that binds the values (see `textOf`) and is pinned by
 *        `tests/store.integers.test.ts`, not by the schema.
 *  - **Amounts and slots are `TEXT`** holding exact canonical decimals (never INTEGER,
 *    never REAL): SQLite has no unsigned 64-bit integer, and Solana amounts exceed it.
 *  - **Foreign keys with `ON DELETE CASCADE`**, so derived artifacts can never outlive the
 *    transaction they describe.
 *  - **No protocol columns.** Nothing in the schema names pump, Meteora, Jupiter, a swap,
 *    a leg or a route: protocol semantics live inside the versioned JSON artifacts, where a
 *    new recognizer needs no migration. `tests/store.sqlite.test.ts` pins the column lists
 *    so this cannot creep.
 */

import { DatabaseSync } from 'node:sqlite';
import { CODEC_VERSION, STORE_FORMAT_VERSION } from './version.ts';

/** Key under which the format version is recorded inside `store_meta`. */
export const FORMAT_VERSION_KEY = 'format_version';

/** Key under which the evidence-codec version is recorded inside `store_meta`. */
export const CODEC_VERSION_KEY = 'codec_version';

/** The store file was written by an incompatible format, or is not a corpus store. */
export class StoreSchemaError extends Error {
  public override readonly name = 'StoreSchemaError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Full DDL. Executed on every open; every statement is `IF NOT EXISTS`, so opening an
 * existing store is a no-op and creating a new one is a single call.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS transactions (
  -- Identity: the transaction id, verbatim.
  signature                     TEXT PRIMARY KEY,
  -- Exact decimals, never INTEGER: slot and lamport values exceed 2^53.
  slot                          TEXT NOT NULL,
  block_time_unix               TEXT,
  -- 'success' | 'failed' | 'unknown' (unknown = the response carried no meta).
  status                        TEXT NOT NULL,
  -- 'legacy' | 'numbered:<n>' | 'unknown'.
  transaction_version           TEXT NOT NULL,
  fee_lamports                  TEXT,
  compute_units_consumed        TEXT,
  cost_units                    TEXT,
  recent_blockhash              TEXT,
  fee_payer_address             TEXT,
  -- Structural counts, for querying a corpus without decoding JSON.
  instruction_count             INTEGER NOT NULL,
  inner_instruction_count       INTEGER NOT NULL,
  account_count                 INTEGER NOT NULL,
  -- NULL when the response reported no logs at all.
  log_count                     INTEGER,
  -- The failure reason as reported, codec-encoded verbatim (never interpreted).
  error_evidence                TEXT,
  -- Bookkeeping: updated on every observation, and the only mutable columns here.
  first_seen_at                 TEXT NOT NULL,
  last_seen_at                  TEXT NOT NULL,
  observation_count             INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS raw_responses (
  signature                     TEXT PRIMARY KEY REFERENCES transactions(signature) ON DELETE CASCADE,
  -- Canonical codec text of the exact getTransaction result.
  raw_text                      TEXT NOT NULL,
  raw_sha256                    TEXT NOT NULL,
  -- The codec that produced raw_text: raw_sha256 only means "unchanged" within one codec.
  raw_codec_version             INTEGER NOT NULL,
  encoding                      TEXT NOT NULL,
  commitment                    TEXT NOT NULL,
  rpc_endpoint                  TEXT NOT NULL,
  max_supported_tx_version      TEXT NOT NULL,
  -- Quality dimensions of *this* observation, so evidence can be compared without decoding.
  meta_present                  INTEGER NOT NULL,
  inner_instructions_available  INTEGER NOT NULL,
  token_balances_available      INTEGER NOT NULL,
  block_time_available          INTEGER NOT NULL,
  logs_present                  INTEGER NOT NULL,
  observed_at                   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS fetches (
  id          INTEGER PRIMARY KEY,
  -- The *requested* signature: a not-found has no transaction row to point at.
  signature   TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  commitment  TEXT NOT NULL,
  -- 'stored' | 'stored-upgraded' | 'unchanged-equal-quality' | 'skipped-lower-quality'
  -- | 'not-found' | 'rpc-error' | 'normalization-error'
  outcome     TEXT NOT NULL,
  -- 1 when retrying the same request could plausibly succeed (rate limit, transport).
  retryable   INTEGER NOT NULL,
  detail      TEXT,
  observed_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS fetches_by_signature ON fetches (signature, id);

CREATE TABLE IF NOT EXISTS derived (
  signature          TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  layer              TEXT NOT NULL,
  semantics_version  TEXT NOT NULL,
  artifact_text      TEXT NOT NULL,
  artifact_sha256    TEXT NOT NULL,
  produced_at        TEXT NOT NULL,
  PRIMARY KEY (signature, layer, semantics_version)
) STRICT;

CREATE INDEX IF NOT EXISTS derived_by_version ON derived (semantics_version);

CREATE TABLE IF NOT EXISTS ingest_cursors (
  address           TEXT PRIMARY KEY,
  -- Newest signature already handled; the next page is requested strictly older than this.
  before_signature  TEXT,
  pages_fetched     INTEGER NOT NULL,
  signatures_seen   INTEGER NOT NULL,
  complete          INTEGER NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;
`;

export interface OpenDatabaseOptions {
  readonly readOnly?: boolean;
}

/**
 * Opens a SQLite file and prepares it for use as a corpus store.
 *
 * `journal_mode = WAL` is attempted (better crash behaviour while a corpus is being built)
 * and falls back to the default journal if the filesystem refuses it — the store works
 * either way, and no data depends on which mode was selected.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    readOnly: options.readOnly === true,
  });
  if (options.readOnly !== true) {
    try {
      database.exec('PRAGMA journal_mode = WAL');
    } catch {
      // WAL unsupported on this filesystem: the default journal is fine for one writer.
    }
  }
  return database;
}

/**
 * Creates the schema if needed and checks the recorded format version.
 *
 * A store written by a different format version is refused outright: M5.1 has no migration
 * framework, and opening it "best effort" would be the one failure mode that silently
 * corrupts a corpus.
 */
export function ensureSchema(database: DatabaseSync): void {
  database.exec(SCHEMA_SQL);

  const row = database.prepare('SELECT value FROM store_meta WHERE key = ?').get(FORMAT_VERSION_KEY);
  const recorded = row === undefined ? null : String(row['value']);

  if (recorded === null) {
    database
      .prepare('INSERT INTO store_meta (key, value) VALUES (?, ?)')
      .run(FORMAT_VERSION_KEY, String(STORE_FORMAT_VERSION));
    database
      .prepare('INSERT INTO store_meta (key, value) VALUES (?, ?)')
      .run(CODEC_VERSION_KEY, String(CODEC_VERSION));
    return;
  }
  if (recorded !== String(STORE_FORMAT_VERSION)) {
    throw new StoreSchemaError(
      `this store records format version ${recorded}, but this build writes version ${STORE_FORMAT_VERSION}. ` +
        'M5.1 has no automatic migration: point --store at a new file, or migrate the old one deliberately.',
    );
  }

  const codec = database.prepare('SELECT value FROM store_meta WHERE key = ?').get(CODEC_VERSION_KEY);
  const recordedCodec = codec === undefined ? null : String(codec['value']);
  if (recordedCodec !== null && recordedCodec !== String(CODEC_VERSION)) {
    throw new StoreSchemaError(
      `this store was written with evidence codec version ${recordedCodec}, but this build writes version ` +
        `${CODEC_VERSION}. Stored hashes are not comparable across codecs; re-ingest into a new store rather ` +
        'than mixing the two.',
    );
  }
}
