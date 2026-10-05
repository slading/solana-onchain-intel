/**
 * Ingestion order must not decide what the corpus holds.
 *
 * The same transaction is observed by different nodes with different amounts of evidence
 * recorded, and the store has to end up with the *best* observation regardless of the order
 * they arrive in — without ever overwriting good evidence with worse. These tests exercise
 * both directions, and assert the outcome by byte-comparing what is stored.
 */

import { describe, expect, it } from 'vitest';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { encodeEvidence } from '../src/store/codec.ts';
import { deriveArtifacts } from '../src/store/derive.ts';
import {
  api,
  artifactText,
  artifacts,
  createTempStore,
  degrade,
  fetchRows,
  fixtureObservation,
  fixtureRaw,
  rawRow,
  sqliteAvailable,
  tableCounts,
  withTempStore,
} from './helpers/store.ts';

const FIXTURE = 'v0-success-pump-buy-24b';

describe.skipIf(!sqliteAvailable)('corpus store: evidence quality', () => {
  it('replaces weaker stored evidence with stronger evidence and re-derives from it', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      const weak = degrade(observation.raw, { dropInnerInstructions: true, dropTokenBalances: true });

      const first = api().ingestRawResponse(store, { raw: weak, provenance: observation.provenance });
      expect(first.outcome).toBe('stored');
      expect(first.quality?.innerInstructionsAvailable).toBe(false);
      const weakRaw = rawRow(store, observation.signature);
      const weakArtifacts = JSON.stringify(artifacts(store, observation.signature));

      const second = api().ingestRawResponse(store, observation);
      expect(second.outcome).toBe('stored-upgraded');
      expect(second.replacedEvidence).toBe(true);
      expect(second.derivedLayers).toEqual(['normalized', 'effects', 'swaps', 'routes']);

      // The evidence was replaced, and only once.
      const strongRaw = rawRow(store, observation.signature);
      expect(strongRaw?.raw_sha256).not.toBe(weakRaw?.raw_sha256);
      expect(strongRaw?.inner_instructions_available).toBe(1);
      expect(strongRaw?.token_balances_available).toBe(1);
      expect(tableCounts(store)).toEqual({
        transactions: 1,
        raw_responses: 1,
        fetches: 2,
        derived: 4,
        ingest_cursors: 0,
      });

      // The artifacts are now exactly those of the stronger observation, with no leftovers
      // from the weaker one: re-deriving from the stored raw reproduces them byte for byte.
      const live = normalizeTransaction(observation.raw, { provenance: observation.provenance });
      const strong = deriveArtifacts(live);
      expect(artifactText(store, observation.signature, 'normalized')).toBe(encodeEvidence(strong.normalized));
      expect(artifactText(store, observation.signature, 'effects')).toBe(encodeEvidence(strong.effects));
      expect(artifactText(store, observation.signature, 'swaps')).toBe(encodeEvidence(strong.swaps));
      expect(artifactText(store, observation.signature, 'routes')).toBe(encodeEvidence(strong.routes));
      expect(JSON.stringify(artifacts(store, observation.signature))).not.toBe(weakArtifacts);

      expect(fetchRows(store, observation.signature).map(row => row.outcome)).toEqual([
        'stored',
        'stored-upgraded',
      ]);
    });
  });

  it('never overwrites stronger stored evidence with a weaker observation', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      api().ingestRawResponse(store, observation);
      const strongRaw = rawRow(store, observation.signature);
      const strongArtifacts = JSON.stringify(artifacts(store, observation.signature));

      const weak = degrade(observation.raw, {
        dropInnerInstructions: true,
        dropTokenBalances: true,
        dropLogs: true,
        dropBlockTime: true,
      });
      const result = api().ingestRawResponse(store, { raw: weak, provenance: observation.provenance });

      expect(result.outcome).toBe('skipped-lower-quality');
      expect(result.stored).toBe(false);
      expect(result.replacedEvidence).toBe(false);
      expect(result.derivedLayers).toEqual([]);
      expect(result.detail).toContain('kept the stronger stored evidence');

      // Byte-for-byte identical: the weaker observation changed nothing but the history.
      expect(rawRow(store, observation.signature)?.raw_sha256).toBe(strongRaw?.raw_sha256);
      expect(rawRow(store, observation.signature)?.raw_text).toBe(strongRaw?.raw_text);
      expect(JSON.stringify(artifacts(store, observation.signature))).toBe(strongArtifacts);
      expect(tableCounts(store)).toEqual({
        transactions: 1,
        raw_responses: 1,
        fetches: 2,
        derived: 4,
        ingest_cursors: 0,
      });

      // An observation so poor that it carries no meta does not even reach the comparison
      // as a candidate to replace anything.
      const meta = api().ingestRawResponse(store, {
        raw: degrade(observation.raw, { dropMeta: true }),
        provenance: observation.provenance,
      });
      expect(meta.outcome).toBe('skipped-lower-quality');
      expect(meta.quality?.metaPresent).toBe(false);
      expect(rawRow(store, observation.signature)?.raw_text).toBe(strongRaw?.raw_text);
    });
  });

  it('keeps evidence that is equal in quality, whichever bytes arrived first', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      api().ingestRawResponse(store, observation);
      const storedRaw = rawRow(store, observation.signature);

      // Same quality by every dimension, different bytes: a field the pipeline ignores.
      const tweaked = { ...(observation.raw as Record<string, unknown>), ignoredExtraField: 'arrived second' };
      const result = api().ingestRawResponse(store, { raw: tweaked, provenance: observation.provenance });

      expect(result.outcome).toBe('unchanged-equal-quality');
      expect(result.detail).toContain('equal quality and was kept');
      expect(rawRow(store, observation.signature)?.raw_text).toBe(storedRaw?.raw_text);
      expect(api().getStoredTransaction(store, observation.signature)?.row.observationCount).toBe(2);
    });
  });

  it('lets commitment break a tie, but never override completeness', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE, { commitment: 'processed' });
      api().ingestRawResponse(store, observation);

      const finalized = api().ingestRawResponse(store, {
        raw: observation.raw,
        provenance: fixtureObservation(FIXTURE, { commitment: 'finalized' }).provenance,
      });
      expect(finalized.outcome).toBe('stored-upgraded');
      expect(finalized.quality?.commitment).toBe('finalized');
      expect(api().getStoredTransaction(store, observation.signature)?.evidence.quality.commitment).toBe(
        'finalized',
      );

      // A `processed` observation of the same payload is not an upgrade.
      const processed = api().ingestRawResponse(store, {
        raw: observation.raw,
        provenance: fixtureObservation(FIXTURE, { commitment: 'processed' }).provenance,
      });
      expect(processed.outcome).toBe('skipped-lower-quality');

    });

    // A richer payload reported at `processed` *is* an upgrade over a poorer `finalized` one:
    // completeness is compared before commitment, on purpose.
    const poorFinalizedStore = createTempStore();
    try {
      api().ingestRawResponse(poorFinalizedStore.store, {
        raw: degrade(fixtureRaw(FIXTURE), { dropInnerInstructions: true }),
        provenance: fixtureObservation(FIXTURE, { commitment: 'finalized' }).provenance,
      });
      const richer = api().ingestRawResponse(poorFinalizedStore.store, {
        raw: fixtureRaw(FIXTURE),
        provenance: fixtureObservation(FIXTURE, { commitment: 'processed' }).provenance,
      });
      expect(richer.outcome).toBe('stored-upgraded');
      expect(richer.quality?.commitment).toBe('processed');
      expect(rawRow(poorFinalizedStore.store, fixtureObservation(FIXTURE).signature)?.commitment).toBe(
        'processed',
      );
    } finally {
      poorFinalizedStore.cleanup();
    }
  });

  it('produces the same corpus whichever order the observations arrive in', () => {
    const observation = fixtureObservation(FIXTURE);
    const weak = degrade(observation.raw, { dropTokenBalances: true, dropLogs: true });

    const strongFirst = createTempStore();
    const weakFirst = createTempStore();
    try {
      api().ingestRawResponse(strongFirst.store, observation);
      api().ingestRawResponse(strongFirst.store, { raw: weak, provenance: observation.provenance });

      api().ingestRawResponse(weakFirst.store, { raw: weak, provenance: observation.provenance });
      api().ingestRawResponse(weakFirst.store, observation);

      const left = {
        raw: rawRow(strongFirst.store, observation.signature),
        artifacts: artifacts(strongFirst.store, observation.signature),
        row: api().getStoredTransaction(strongFirst.store, observation.signature)?.row,
      };
      const right = {
        raw: rawRow(weakFirst.store, observation.signature),
        artifacts: artifacts(weakFirst.store, observation.signature),
        row: api().getStoredTransaction(weakFirst.store, observation.signature)?.row,
      };

      expect(right.raw?.raw_sha256).toBe(left.raw?.raw_sha256);
      expect(right.raw?.raw_text).toBe(left.raw?.raw_text);
      expect(JSON.stringify(right.artifacts)).toBe(JSON.stringify(left.artifacts));
      expect(right.row?.observationCount).toBe(2);
      expect(left.row?.observationCount).toBe(2);

      // The histories differ (that is the point of an append-only fetch log) while the
      // stored evidence does not.
      expect(fetchRows(strongFirst.store, observation.signature).map(row => row.outcome)).toEqual([
        'stored',
        'skipped-lower-quality',
      ]);
      expect(fetchRows(weakFirst.store, observation.signature).map(row => row.outcome)).toEqual([
        'stored',
        'stored-upgraded',
      ]);
    } finally {
      strongFirst.cleanup();
      weakFirst.cleanup();
    }
  });

  it('drops artifacts of every semantics version when the evidence they came from is replaced', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      const weak = degrade(observation.raw, { dropInnerInstructions: true });
      api().ingestRawResponse(store, { raw: weak, provenance: observation.provenance });

      // Simulate a corpus written by an older engine, then a newer one.
      store.database
        .prepare(
          `INSERT INTO derived (signature, layer, semantics_version, artifact_text, artifact_sha256, produced_at)
           VALUES (?, 'effects', 'engine-before-this-one', '{"stale":true}', 'deadbeef', ?)`,
        )
        .run(observation.signature, '2026-01-01T00:00:00.000Z');
      expect(artifacts(store, observation.signature)).toHaveLength(5);

      api().ingestRawResponse(store, observation);
      const rows = artifacts(store, observation.signature);
      expect(rows).toHaveLength(4);
      expect(rows.every(row => row.semantics_version === store.semanticsVersion)).toBe(true);
    });
  });

  it('records why an observation was kept or replaced, in the fetch history', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      api().ingestRawResponse(store, observation);
      api().ingestRawResponse(store, {
        raw: degrade(observation.raw, { dropBlockTime: true, dropLogs: true }),
        provenance: observation.provenance,
      });

      const history = fetchRows(store, observation.signature);
      expect(history.map(row => row.outcome)).toEqual(['stored', 'skipped-lower-quality']);
      expect(history[1]?.detail).toContain('finalized');
      expect(history[1]?.detail).toContain('missing');
      expect(history.every(row => row.retryable === 0)).toBe(true);
    });
  });
});
