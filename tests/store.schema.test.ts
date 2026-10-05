/**
 * The schema itself: its shape, its invariants, and the columns it must never grow.
 *
 * Two things are pinned here that nothing else can pin:
 *
 *  - **the column lists, exactly.** Protocol semantics live inside versioned JSON artifacts,
 *    not in SQL columns, so that a new recognizer needs no migration. Pinning the lists is
 *    how that stays true: a `pump_amm_legs` table (or a `route_plan_steps` column) cannot be
 *    added without this test failing.
 *  - **the referential rules.** Derived artifacts may not outlive their transaction, and a
 *    fetch history row must be recordable for a signature that was *not* found.
 */

import { describe, expect, it } from 'vitest';
import { DERIVED_LAYERS, isDerivedLayer } from '../src/store/version.ts';
import {
  api,
  columnNames,
  createTempStore,
  fixtureObservation,
  sqliteAvailable,
  tableCounts,
  tableNames,
  withTempStore,
} from './helpers/store.ts';

const FIXTURE = 'v0-success-pump-buy-24b';

/**
 * Column names that would mean protocol semantics had leaked into the schema.
 *
 * `token_balances_available` is deliberately not matched: it is an evidence-quality flag
 * about the *response*, not a claim about what a program did.
 */
const FORBIDDEN_COLUMN_PATTERN =
  /pump|meteora|jupiter|dlmm|raydium|swap|route|plan|leg|discriminator|mint|amount_in|amount_out|pool|fee_bps/i;

describe.skipIf(!sqliteAvailable)('corpus store: schema', () => {
  it('has exactly the columns it documents, and no place to hide semantics', () => {
    withTempStore(store => {
      expect(tableNames(store)).toEqual([
        'derived',
        'fetches',
        'ingest_cursors',
        'raw_responses',
        'store_meta',
        'transactions',
      ]);

      expect(columnNames(store, 'store_meta')).toEqual(['key', 'value']);
      expect(columnNames(store, 'transactions')).toEqual([
        'signature',
        'slot',
        'block_time_unix',
        'status',
        'transaction_version',
        'fee_lamports',
        'compute_units_consumed',
        'cost_units',
        'recent_blockhash',
        'fee_payer_address',
        'instruction_count',
        'inner_instruction_count',
        'account_count',
        'log_count',
        'error_evidence',
        'first_seen_at',
        'last_seen_at',
        'observation_count',
      ]);
      expect(columnNames(store, 'raw_responses')).toEqual([
        'signature',
        'raw_text',
        'raw_sha256',
        'raw_codec_version',
        'encoding',
        'commitment',
        'rpc_endpoint',
        'max_supported_tx_version',
        'meta_present',
        'inner_instructions_available',
        'token_balances_available',
        'block_time_available',
        'logs_present',
        'observed_at',
      ]);
      expect(columnNames(store, 'fetches')).toEqual([
        'id',
        'signature',
        'endpoint',
        'commitment',
        'outcome',
        'retryable',
        'detail',
        'observed_at',
      ]);
      expect(columnNames(store, 'derived')).toEqual([
        'signature',
        'layer',
        'semantics_version',
        'artifact_text',
        'artifact_sha256',
        'produced_at',
      ]);
      expect(columnNames(store, 'ingest_cursors')).toEqual([
        'address',
        'before_signature',
        'pages_fetched',
        'signatures_seen',
        'complete',
        'updated_at',
      ]);

      for (const table of tableNames(store)) {
        for (const column of columnNames(store, table)) {
          expect(column, `${table}.${column}`).not.toMatch(FORBIDDEN_COLUMN_PATTERN);
        }
      }

      // The layers the store may hold, stated once, in the versioning module.
      expect(DERIVED_LAYERS).toEqual(['normalized', 'effects', 'swaps', 'routes']);
      expect(isDerivedLayer('swaps')).toBe(true);
      expect(isDerivedLayer('pump-amm')).toBe(false);
    });
  });

  it('refuses to open a store written by another format version', () => {
    const temp = createTempStore();
    try {
      temp.store.database.prepare('UPDATE store_meta SET value = ? WHERE key = ?').run('99', 'format_version');
      temp.store.close();
      expect(() => api().openCorpusStore(temp.path)).toThrow(/format version 99/);
    } finally {
      temp.cleanup();
    }
  });

  it('refuses to open a store written by another evidence codec', () => {
    const temp = createTempStore();
    try {
      temp.store.database.prepare('UPDATE store_meta SET value = ? WHERE key = ?').run('99', 'codec_version');
      temp.store.close();
      expect(() => api().openCorpusStore(temp.path)).toThrow(/codec version 99/);
    } finally {
      temp.cleanup();
    }
  });

  it('records the versions it was created with', () => {
    withTempStore(store => {
      const rows = store.database.prepare('SELECT key, value FROM store_meta ORDER BY key').all();
      expect(rows).toEqual([
        { key: 'codec_version', value: '1' },
        { key: 'format_version', value: String(store.formatVersion) },
      ]);
      expect(store.formatVersion).toBe(1);
    });
  });

  it('rejects a REAL in an INTEGER column, so counts cannot silently become floats', () => {
    withTempStore(store => {
      expect(() =>
        store.database
          .prepare(
            `INSERT INTO ingest_cursors (address, before_signature, pages_fetched, signatures_seen, complete, updated_at)
             VALUES (?, NULL, ?, 0, 0, '2026-01-01T00:00:00.000Z')`,
          )
          .run('some-address', 1.5),
      ).toThrow(/INTEGER column/);
    });
  });

  it('keeps derived artifacts from outliving their transaction, and history independent of it', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      api().ingestRawResponse(store, observation);

      // A fetch history row may exist for a signature with no transaction — that is how a
      // not-found attempt is recorded — but a derived artifact may not.
      expect(() => {
        store.database
          .prepare(
            `INSERT INTO derived (signature, layer, semantics_version, artifact_text, artifact_sha256, produced_at)
             VALUES ('never-seen', 'effects', 'x', '{}', 'x', 'now')`,
          )
          .run();
      }).toThrow(/FOREIGN KEY/i);

      store.database.prepare('INSERT INTO fetches (signature, endpoint, commitment, outcome, retryable, detail, observed_at) VALUES (?, ?, ?, ?, 0, NULL, ?)').run(
        'never-seen',
        'https://fixture.invalid',
        'finalized',
        'not-found',
        'now',
      );

      // Deleting the transaction takes its evidence and artifacts with it, and nothing else.
      store.database.prepare('DELETE FROM transactions WHERE signature = ?').run(observation.signature);
      expect(tableCounts(store)).toEqual({
        transactions: 0,
        raw_responses: 0,
        fetches: 2,
        derived: 0,
        ingest_cursors: 0,
      });
    });
  });

  it('enforces the foreign keys it declares', () => {
    withTempStore(store => {
      const pragma = store.database.prepare('PRAGMA foreign_keys').get();
      expect(Number(pragma?.['foreign_keys'])).toBe(1);
      expect(() => store.database.prepare('DELETE FROM transactions WHERE signature = ?').run('absent')).not.toThrow();
    });
  });

  it('keeps the evidence one row per signature, whatever the observation count', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      api().ingestRawResponse(store, observation);
      api().ingestRawResponse(store, observation);
      api().ingestRawResponse(store, observation);
      expect(tableCounts(store)).toEqual({
        transactions: 1,
        raw_responses: 1,
        fetches: 3,
        derived: 4,
        ingest_cursors: 0,
      });
    });
  });
});
