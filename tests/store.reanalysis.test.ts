/**
 * Re-analysis: the property that makes derivations replaceable.
 *
 * `reanalyze` reads the stored raw evidence, re-runs the derivation, and replaces the
 * artifacts — no network, no change to the evidence. That is what lets a new recognizer be
 * retroactive, and what makes "delete every derived row and rebuild" a safe operation. Each
 * test below asserts one half of it: the artifacts come back byte-identical when the engine
 * is the same, and new rows appear under a new version when it is not.
 */

import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import {
  api,
  artifactText,
  artifacts,
  createTempStore,
  FakeRpc,
  fetchRows,
  fixtureObservation,
  sqliteAvailable,
  tableCounts,
  withTempStore,
  withTempStoreAsync,
} from './helpers/store.ts';

const FIXTURE = 'v0-success-pump-buy-24b';
const FAILED_FIXTURE = 'v0-failed-pump-buy-slippage';
const VOTE_FIXTURE = 'legacy-success-vote';

describe.skipIf(!sqliteAvailable)('corpus store: re-analysis', () => {
  it('rebuilds every artifact from stored raw evidence, byte for byte, without any RPC', async () => {
    const observation = fixtureObservation(FIXTURE);
    const rpc = new FakeRpc();

    await withTempStoreAsync(async store => {
      api().ingestRawResponse(store, observation);
      const before = artifacts(store, observation.signature);

      // The worst case a corpus can suffer: every derivation is gone, the evidence is not.
      store.database.prepare('DELETE FROM derived WHERE signature = ?').run(observation.signature);
      expect(tableCounts(store).derived).toBe(0);
      expect(api().listSignaturesNeedingReanalysis(store)).toEqual([observation.signature]);

      const summary = api().reanalyzeAll(store);
      expect(summary.requested).toBe(1);
      expect(summary.reanalyzed).toBe(1);
      expect(summary.failed).toBe(0);

      // Byte-identical, hash and all.
      expect(JSON.stringify(artifacts(store, observation.signature))).toBe(JSON.stringify(before));

      // And the raw evidence was not touched, nor was a single request made.
      const stored = api().getStoredTransaction(store, observation.signature);
      expect(stored?.row.observationCount).toBe(1);
      expect(rpc.transactionCalls).toHaveLength(0);
      expect(rpc.pageCalls).toHaveLength(0);
      expect(fetchRows(store, observation.signature).map(row => row.outcome)).toEqual(['stored']);
    });
  });

  it('is idempotent: re-analysing twice changes nothing', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      api().ingestRawResponse(store, observation);
      const first = JSON.stringify(artifacts(store, observation.signature));
      const raw = store.database.prepare('SELECT raw_text, raw_sha256, observed_at FROM raw_responses WHERE signature = ?').get(observation.signature);

      expect(api().reanalyzeSignature(store, observation.signature).outcome).toBe('reanalyzed');
      expect(api().reanalyzeSignature(store, observation.signature).outcome).toBe('reanalyzed');

      expect(JSON.stringify(artifacts(store, observation.signature))).toBe(first);
      expect(
        store.database.prepare('SELECT raw_text, raw_sha256, observed_at FROM raw_responses WHERE signature = ?').get(observation.signature),
      ).toEqual(raw);
    });
  });

  it('lets an older and a newer semantics version coexist, and never serves the older', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      api().ingestRawResponse(store, observation);

      // An artifact set written by the engine as it was before this one.
      const planted = '{"written-by":"an-older-engine"}';
      store.database
        .prepare(
          `INSERT INTO derived (signature, layer, semantics_version, artifact_text, artifact_sha256, produced_at)
           VALUES (?, 'effects', 'm1+m2+m3', ?, ?, '2026-01-01T00:00:00.000Z')`,
        )
        .run(observation.signature, planted, 'deadbeef');
      const rawBefore = store.database.prepare('SELECT raw_text, raw_sha256 FROM raw_responses WHERE signature = ?').get(observation.signature);

      const stored = api().getStoredTransaction(store, observation.signature);
      expect(stored?.staleVersions).toEqual(['m1+m2+m3']);
      expect(stored?.derivedLayers).toEqual(['effects', 'normalized', 'routes', 'swaps']);

      // The stale row is reported, never returned as current.
      const effects = api().loadEffectsArtifact(store, observation.signature);
      expect(stringifyJson(effects)).not.toBe(planted);
      expect(typeof effects?.commitState).toBe('string');

      // Re-analysis writes the current version and leaves the raw evidence exactly as it was.
      expect(api().reanalyzeSignature(store, observation.signature).outcome).toBe('reanalyzed');
      expect(
        store.database.prepare('SELECT raw_text, raw_sha256 FROM raw_responses WHERE signature = ?').get(observation.signature),
      ).toEqual(rawBefore);
      expect(artifacts(store, observation.signature).filter(row => row.semantics_version === 'm1+m2+m3')).toHaveLength(1);

      // Pruning is explicit, and removes only the other versions.
      const pruned = api().reanalyzeSignature(store, observation.signature, { pruneOlderVersions: true });
      expect(pruned.prunedVersions).toEqual(['m1+m2+m3']);
      expect(artifacts(store, observation.signature)).toHaveLength(4);
      expect(
        store.database.prepare('SELECT raw_text FROM raw_responses WHERE signature = ?').get(observation.signature),
      ).toEqual({ raw_text: rawBefore?.['raw_text'] });
    });
  });

  it('re-derives a reverted transaction as reverted, from the stored evidence alone', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FAILED_FIXTURE);
      api().ingestRawResponse(store, observation);
      const before = artifacts(store, observation.signature);
      expect(api().loadEffectsArtifact(store, observation.signature)?.commitState).toBe('reverted');

      store.database.prepare('DELETE FROM derived WHERE signature = ?').run(observation.signature);
      expect(api().reanalyzeSignature(store, observation.signature).outcome).toBe('reanalyzed');

      expect(JSON.stringify(artifacts(store, observation.signature))).toBe(JSON.stringify(before));
      const effects = api().loadEffectsArtifact(store, observation.signature);
      expect(effects?.commitState).toBe('reverted');
      expect(effects?.solFlows.map(flow => flow.kind)).toEqual(['fee']);
      expect(effects?.tokenFlows).toEqual([]);
    });
  });

  it('leaves unknown protocol legs unknown after re-analysis', () => {
    withTempStore(store => {
      const observation = fixtureObservation(VOTE_FIXTURE);
      api().ingestRawResponse(store, observation);
      const before = artifacts(store, observation.signature);

      store.database.prepare('DELETE FROM derived WHERE signature = ?').run(observation.signature);
      api().reanalyzeSignature(store, observation.signature);

      expect(JSON.stringify(artifacts(store, observation.signature))).toBe(JSON.stringify(before));
      expect(api().loadSwapsArtifact(store, observation.signature)?.legs).toEqual([]);
      expect(api().loadRoutesArtifact(store, observation.signature)?.envelopes).toEqual([]);
    });
  });

  it('refreshes the canonical row from the evidence but never its bookkeeping', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      api().ingestRawResponse(store, observation);
      const before = api().getStoredTransaction(store, observation.signature)?.row;

      // Something drifted in the canonical row: the next re-analysis corrects it.
      store.database.prepare('UPDATE transactions SET status = ?, slot = ? WHERE signature = ?').run('failed', '1', observation.signature);
      expect(api().reanalyzeSignature(store, observation.signature).outcome).toBe('reanalyzed');

      const after = api().getStoredTransaction(store, observation.signature)?.row;
      expect(after?.status).toBe('success');
      expect(after?.slot).toBe(before?.slot);
      expect(after?.firstSeenAt).toBe(before?.firstSeenAt);
      expect(after?.lastSeenAt).toBe(before?.lastSeenAt);
      expect(after?.observationCount).toBe(before?.observationCount);
    });
  });

  it('reports what it did for a signature it cannot rebuild, and touches nothing', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      api().ingestRawResponse(store, observation);

      expect(api().reanalyzeSignature(store, 'not-in-this-store')).toEqual({
        signature: 'not-in-this-store',
        outcome: 'skipped-no-evidence',
        layers: [],
        detail: 'no raw evidence is stored for this signature',
        prunedVersions: [],
      });
      expect(tableCounts(store).transactions).toBe(1);
    });
  });

  it('re-analyzes a whole corpus, and only the signatures that need it', () => {
    const first = createTempStore();
    const second = createTempStore();
    try {
      const one = fixtureObservation(FIXTURE);
      api().ingestRawResponse(first.store, one);
      expect(api().reanalyzeAll(first.store).requested).toBe(0);

      api().ingestRawResponse(second.store, one);
      api().ingestRawResponse(second.store, fixtureObservation(VOTE_FIXTURE));
      second.store.database.prepare('DELETE FROM derived WHERE signature = ?').run(one.signature);

      const onlyStale = api().reanalyzeAll(second.store);
      expect(onlyStale.requested).toBe(1);
      expect(onlyStale.reanalyzed).toBe(1);
      expect(second.store.database.prepare('SELECT COUNT(*) AS n FROM derived').get()?.['n']).toBe(8);

      const everything = api().reanalyzeAll(second.store, { onlyStale: false });
      expect(everything.requested).toBe(2);
      expect(everything.reanalyzed).toBe(2);
      expect(artifactText(second.store, one.signature, 'normalized')).not.toBeNull();
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });
});
