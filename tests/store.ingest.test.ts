/**
 * Ingestion: identity, idempotency, and the outcomes that are *not* a stored transaction.
 *
 * The store's contract is that a repeated ingest creates no second canonical or semantic
 * fact, and that a response which cannot be normalized, or which does not carry the
 * requested signature, leaves the corpus untouched. Both are asserted literally, by table
 * counts and by byte-comparing the stored evidence before and after.
 */

import { describe, expect, it } from 'vitest';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { encodeEvidence, sha256Hex } from '../src/store/codec.ts';
import { deriveArtifacts } from '../src/store/derive.ts';
import { STORE_FORMAT_VERSION } from '../src/store/version.ts';
import {
  api,
  artifactText,
  artifacts,
  createTempStore,
  FakeRpc,
  fetchRows,
  fixtureObservation,
  fixtureSignature,
  rawRow,
  sqliteAvailable,
  tableCounts,
  tableNames,
  withTempStore,
  withTempStoreAsync,
} from './helpers/store.ts';

const FAILED_FIXTURE = 'v0-failed-pump-buy-slippage';
const VOTE_FIXTURE = 'legacy-success-vote';
const PUMP_FIXTURE = 'v0-success-pump-buy-24b';

describe.skipIf(!sqliteAvailable)('corpus store: ingestion', () => {
  it('creates the schema in a fresh file and records the format version', () => {
    withTempStore((store, temp) => {
      expect(tableNames(store)).toEqual([
        'derived',
        'fetches',
        'ingest_cursors',
        'raw_responses',
        'store_meta',
        'transactions',
      ]);
      expect(store.formatVersion).toBe(STORE_FORMAT_VERSION);

      const meta = store.database.prepare('SELECT value FROM store_meta WHERE key = ?').get('format_version');
      expect(meta?.['value']).toBe(String(STORE_FORMAT_VERSION));

      // Opening the same file again is a no-op, not a second initialization.
      const reopened = api().openCorpusStore(temp.path);
      expect(tableCounts(reopened).transactions).toBe(0);
      reopened.close();
    });
  });

  it('stores one fixture as raw evidence plus four derived artifacts', () => {
    withTempStore(store => {
      const observation = fixtureObservation(PUMP_FIXTURE);
      const result = api().ingestRawResponse(store, observation);

      expect(result.outcome).toBe('stored');
      expect(result.stored).toBe(true);
      expect(result.replacedEvidence).toBe(false);
      expect(result.derivedLayers).toEqual(['normalized', 'effects', 'swaps', 'routes']);
      expect(result.quality?.commitment).toBe('finalized');
      expect(result.quality?.metaPresent).toBe(true);

      expect(tableCounts(store)).toEqual({
        transactions: 1,
        raw_responses: 1,
        fetches: 1,
        derived: 4,
        ingest_cursors: 0,
      });

      const rows = artifacts(store, observation.signature);
      expect(rows.map(row => row.layer)).toEqual(['effects', 'normalized', 'routes', 'swaps']);
      for (const row of rows) {
        expect(row.semantics_version).toBe(store.semanticsVersion);
        expect(row.artifact_sha256).toBe(sha256Hex(row.artifact_text));
        expect(row.artifact_text.length).toBeGreaterThan(0);
      }

      // The raw payload is stored exactly once, with the hash of its canonical text.
      const raw = rawRow(store, observation.signature);
      expect(raw?.raw_sha256).toBe(sha256Hex(raw?.raw_text ?? ''));
      expect(raw?.meta_present).toBe(1);
      expect(fetchRows(store, observation.signature).map(row => row.outcome)).toEqual(['stored']);
    });
  });

  it('stores the same transaction twice without creating a second fact', () => {
    withTempStore(store => {
      const observation = fixtureObservation(PUMP_FIXTURE);
      const first = api().ingestRawResponse(store, observation);
      expect(first.outcome).toBe('stored');

      const before = {
        counts: tableCounts(store),
        raw: rawRow(store, observation.signature),
        artifacts: artifacts(store, observation.signature),
      };

      const second = api().ingestRawResponse(store, observation);
      expect(second.outcome).toBe('unchanged-equal-quality');
      expect(second.stored).toBe(false);
      expect(second.replacedEvidence).toBe(false);
      expect(second.derivedLayers).toEqual([]);

      // One canonical row, one evidence row, four artifacts — only the fetch history grew.
      expect(tableCounts(store)).toEqual({ ...before.counts, fetches: 2 });

      expect(rawRow(store, observation.signature)?.raw_sha256).toBe(before.raw?.raw_sha256);
      expect(rawRow(store, observation.signature)?.raw_text).toBe(before.raw?.raw_text);
      expect(JSON.stringify(artifacts(store, observation.signature))).toBe(
        JSON.stringify(before.artifacts),
      );

      // Bookkeeping: the repetition is visible, the evidence is not rewritten.
      const stored = api().getStoredTransaction(store, observation.signature);
      expect(stored?.row.observationCount).toBe(2);
      expect(fetchRows(store, observation.signature).map(row => row.outcome)).toEqual([
        'stored',
        'unchanged-equal-quality',
      ]);
    });
  });

  it('takes the canonical row from the evidence, not from the caller', () => {
    withTempStore(store => {
      const observation = fixtureObservation(PUMP_FIXTURE, { commitment: 'confirmed' });
      api().ingestRawResponse(store, observation);
      const transaction = normalizeTransaction(observation.raw, { provenance: observation.provenance });
      const stored = api().getStoredTransaction(store, observation.signature);

      expect(stored?.row.signature).toBe(transaction.signature);
      expect(stored?.row.slot).toBe(transaction.slot.toString());
      expect(stored?.row.status).toBe(transaction.status);
      expect(stored?.row.feeLamports).toBe(transaction.feeLamports?.toString() ?? null);
      expect(stored?.row.feePayerAddress).toBe(transaction.feePayerAddress);
      expect(stored?.row.transactionVersion).toBe(
        transaction.version.kind === 'numbered'
          ? `numbered:${transaction.version.value}`
          : transaction.version.kind,
      );
      expect(stored?.row.instructionCount).toBe(transaction.instructions.length);
      expect(stored?.row.innerInstructionCount).toBe(
        transaction.innerInstructionGroups.reduce((total, group) => total + group.instructions.length, 0),
      );
      expect(stored?.row.accountCount).toBe(transaction.accounts.length);
      expect(stored?.row.logCount).toBe(transaction.logs?.length ?? null);
      // The commitment is evidence provenance, recorded next to the payload.
      expect(stored?.evidence.quality.commitment).toBe('confirmed');
      expect(stored?.staleVersions).toEqual([]);
      expect(stored?.derivedLayers).toEqual(['effects', 'normalized', 'routes', 'swaps']);
    });
  });

  it('stores a response that cannot be normalized as an attempt, not as a transaction', () => {
    withTempStore(store => {
      let liveMessage = '';
      try {
        normalizeTransaction({}, { provenance: fixtureObservation(PUMP_FIXTURE).provenance });
      } catch (error) {
        liveMessage = error instanceof Error ? error.message : String(error);
      }
      expect(liveMessage).not.toBe('');

      const result = api().ingestRawResponse(store, {
        raw: {},
        provenance: fixtureObservation(PUMP_FIXTURE).provenance,
        expectSignature: fixtureSignature(PUMP_FIXTURE),
      });

      expect(result.outcome).toBe('normalization-error');
      expect(result.stored).toBe(false);
      expect(result.quality).toBeNull();
      expect(result.detail).toBe(liveMessage);

      expect(tableCounts(store)).toEqual({
        transactions: 0,
        raw_responses: 0,
        fetches: 1,
        derived: 0,
        ingest_cursors: 0,
      });
      const history = fetchRows(store, fixtureSignature(PUMP_FIXTURE));
      expect(history.map(row => row.outcome)).toEqual(['normalization-error']);
      expect(history[0]?.retryable).toBe(0);
    });
  });

  it('never stores a response under a signature it does not carry', () => {
    withTempStore(store => {
      const observation = fixtureObservation(PUMP_FIXTURE);
      const otherSignature = fixtureSignature(VOTE_FIXTURE);

      const result = api().ingestRawResponse(store, {
        raw: observation.raw,
        provenance: observation.provenance,
        expectSignature: otherSignature,
      });

      expect(result.outcome).toBe('normalization-error');
      expect(result.signature).toBe(otherSignature);
      expect(result.detail).toContain(otherSignature);
      expect(result.detail).toContain(observation.signature);
      expect(tableCounts(store).transactions).toBe(0);
      expect(tableCounts(store).raw_responses).toBe(0);
      expect(fetchRows(store, otherSignature).map(row => row.outcome)).toEqual(['normalization-error']);
    });
  });

  it('stores a reverted transaction without ever promoting attempted movement', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FAILED_FIXTURE);
      const result = api().ingestRawResponse(store, observation);
      expect(result.outcome).toBe('stored');

      const live = normalizeTransaction(observation.raw, { provenance: observation.provenance });
      const effects = api().loadEffectsArtifact(store, observation.signature);
      const swaps = api().loadSwapsArtifact(store, observation.signature);
      const routes = api().loadRoutesArtifact(store, observation.signature);
      const stored = api().getStoredTransaction(store, observation.signature);
      expect(stored?.row.status).toBe('failed');

      // The frozen M3/M4 semantics survive storage: only the fee committed, and the
      // attempted movements stay in their own collections.
      expect(effects?.commitState).toBe('reverted');
      expect(effects?.solFlows.map(flow => flow.kind)).toEqual(['fee']);
      expect(effects?.tokenFlows).toEqual([]);
      expect(
        effects?.netTokenByAccountMint.every(net => net.netAmount === null || net.netAmount === 0n),
      ).toBe(true);

      // Exactly one account moved lamports — the fee payer, by the fee, and nothing else.
      const moved = (effects?.netSolByAccount ?? []).filter(net => net.netLamports !== 0n);
      expect(moved).toHaveLength(1);
      expect(moved[0]?.isFeePayer).toBe(true);
      expect(moved[0]?.netLamports).toBe(-(live.feeLamports ?? 0n));

      // No leg and no route is reported as having committed anything.
      expect(swaps?.legs.every(leg => leg.commitState !== 'committed')).toBe(true);
      expect(routes?.envelopes.every(envelope => envelope.commitState !== 'committed')).toBe(true);

      // And the stored artifact is exactly what the live pipeline derives, byte for byte.
      expect(artifactText(store, observation.signature, 'effects')).toBe(
        encodeEvidence(deriveArtifacts(live).effects),
      );
    });
  });

  it('keeps instructions it cannot decode unknown instead of guessing', () => {
    withTempStore(store => {
      const observation = fixtureObservation(VOTE_FIXTURE);
      api().ingestRawResponse(store, observation);

      const swaps = api().loadSwapsArtifact(store, observation.signature);
      const routes = api().loadRoutesArtifact(store, observation.signature);
      expect(swaps?.legs).toEqual([]);
      expect(routes?.envelopes).toEqual([]);

      // The normalized artifact is byte-identical to the live model minus its raw payload:
      // no instruction was silently dropped, renamed or interpreted by the store.
      const live = normalizeTransaction(observation.raw, { provenance: observation.provenance });
      expect(artifactText(store, observation.signature, 'normalized')).toBe(
        encodeEvidence(deriveArtifacts(live).normalized),
      );
    });
  });

  it('records a fetch that found nothing as history, and accepts a later success', async () => {
    const observation = fixtureObservation(PUMP_FIXTURE);
    const rpc = new FakeRpc();
    rpc.set(observation.signature, null);

    await withTempStoreAsync(async store => {
      const missing = await api().ingestSignature(store, {
        rpc,
        signature: observation.signature,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });
      expect(missing.outcome).toBe('not-found');
      expect(missing.retryable).toBe(false);
      expect(tableCounts(store)).toEqual({
        transactions: 0,
        raw_responses: 0,
        fetches: 1,
        derived: 0,
        ingest_cursors: 0,
      });

      // The same signature, now retained by the node: the earlier not-found does not block it.
      rpc.set(observation.signature, observation.raw);
      const success = await api().ingestSignature(store, {
        rpc,
        signature: observation.signature,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });
      expect(success.outcome).toBe('stored');
      expect(tableCounts(store)).toEqual({
        transactions: 1,
        raw_responses: 1,
        fetches: 2,
        derived: 4,
        ingest_cursors: 0,
      });
      expect(fetchRows(store, observation.signature).map(row => row.outcome)).toEqual(['not-found', 'stored']);
    });
  });

  it('writes each signature atomically: a failure part-way leaves no half-ingested transaction', () => {
    withTempStore(store => {
      const observation = fixtureObservation(PUMP_FIXTURE);

      // Force the last artifact write to fail, after the canonical row and the raw evidence
      // have already been inserted inside the same transaction.
      store.database.exec(`
        CREATE TRIGGER fail_routes BEFORE INSERT ON derived
        WHEN NEW.layer = 'routes'
        BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;
      `);

      expect(() => api().ingestRawResponse(store, observation)).toThrow(/simulated failure/);
      expect(tableCounts(store)).toEqual({
        transactions: 0,
        raw_responses: 0,
        fetches: 0,
        derived: 0,
        ingest_cursors: 0,
      });

      // With the fault removed the same store accepts the same observation normally.
      store.database.exec('DROP TRIGGER fail_routes');
      const retry = api().ingestRawResponse(store, observation);
      expect(retry.outcome).toBe('stored');
      expect(tableCounts(store)).toEqual({
        transactions: 1,
        raw_responses: 1,
        fetches: 1,
        derived: 4,
        ingest_cursors: 0,
      });
    });
  });

  it('creates the store file on demand and leaves it where it was asked to', () => {
    const temp = createTempStore();
    try {
      expect(temp.store.path).toBe(temp.path);
      api().ingestRawResponse(temp.store, fixtureObservation(PUMP_FIXTURE));
      temp.store.close();
      const reopened = api().openCorpusStore(temp.path, { readOnly: true });
      expect(tableCounts(reopened).transactions).toBe(1);
      reopened.close();
    } finally {
      temp.cleanup();
    }
  });
});
