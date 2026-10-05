/**
 * The whole recorded corpus, through the store and back.
 *
 * For every fixture in `fixtures/`, this asserts the two claims the store makes about its
 * derived artifacts:
 *
 *  1. what comes back out of SQLite is what the live pipeline produced — the same
 *     serialization, byte for byte, for all four layers; and
 *  2. `print` has nothing of its own to add: the payload the storage CLI renders is
 *     byte-identical to the payload `inspect` renders (the one `--json` prints), which is
 *     the structural half of the print ≡ inspect equivalence. The exact-CLI half is
 *     `scripts/verify-store-print.sh`.
 */

import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { recognizeSwaps } from '../src/swap/recognize-swaps.ts';
import { recognizeRoutes } from '../src/route/recognize-routes.ts';
import { encodeEvidence } from '../src/store/codec.ts';
import { deriveArtifacts, rehydrateNormalized, withoutRaw } from '../src/store/derive.ts';
import { allFixtureNames, loadFixture } from './helpers/fixtures.ts';
import { api, artifactText, sqliteAvailable, tableCounts, withTempStore } from './helpers/store.ts';
import type { NormalizedProvenance } from '../src/model/transaction.ts';

/** The provenance `tests/helpers/fixtures.ts` uses, so a stored model matches the live one. */
function fixtureProvenance(name: string): NormalizedProvenance {
  return {
    rpcEndpoint: loadFixture(name).provenance.source,
    encoding: 'jsonParsed',
    commitment: 'finalized',
    maxSupportedTransactionVersion: 1,
  };
}

describe.skipIf(!sqliteAvailable)('corpus store: fixture round trip', () => {
  it('stores every fixture so that stored artifacts equal the live derivation', () => {
    const names = allFixtureNames();
    expect(names).toHaveLength(13);

    withTempStore(store => {
      for (const name of names) {
        const envelope = loadFixture(name);
        const provenance = fixtureProvenance(name);
        const live = normalizeTransaction(envelope.response, { provenance });

        const result = api().ingestRawResponse(store, {
          raw: envelope.response,
          provenance,
          expectSignature: envelope.request.signature,
        });
        expect(result.outcome, name).toBe('stored');
        expect(result.derivedLayers, name).toEqual(['normalized', 'effects', 'swaps', 'routes']);

        const derived = deriveArtifacts(live);
        for (const layer of ['normalized', 'effects', 'swaps', 'routes'] as const) {
          expect(artifactText(store, live.signature, layer), `${name}:${layer}`).toBe(
            encodeEvidence(derived[layer]),
          );
        }

        // The canonical row follows the evidence.
        const stored = api().getStoredTransaction(store, live.signature);
        expect(stored?.row.status, name).toBe(live.status);
        expect(stored?.row.feeLamports, name).toBe(live.feeLamports?.toString() ?? null);
        expect(stored?.row.observationCount, name).toBe(1);
      }

      // 13 transactions, 13 evidence rows, 13 fetch records, 52 artifacts — nothing extra.
      expect(tableCounts(store)).toEqual({
        transactions: 13,
        raw_responses: 13,
        fetches: 13,
        derived: 52,
        ingest_cursors: 0,
      });
    });
  });

  it('rehydrates the normalized model into the exact object the pipeline built', () => {
    withTempStore(store => {
      for (const name of allFixtureNames()) {
        const envelope = loadFixture(name);
        const provenance = fixtureProvenance(name);
        const live = normalizeTransaction(envelope.response, { provenance });
        api().ingestRawResponse(store, { raw: envelope.response, provenance });

        const stored = api().loadNormalizedArtifact(store, live.signature);
        expect(stored, name).not.toBeNull();
        expect('raw' in (stored as object), name).toBe(false);

        const rehydrated = api().loadTransactionModel(store, live.signature);
        expect(rehydrated, name).not.toBeNull();

        // Byte-identical under the project's own serializer (bigints as exact decimals) …
        expect(stringifyJson(rehydrated), name).toBe(stringifyJson(live));
        // … and structurally identical, key order included: `raw` is appended last, exactly
        // where `normalizeTransaction` puts it.
        expect(Object.keys(rehydrated as object), name).toEqual(Object.keys(live));
        expect(stringifyJson(rehydrateNormalized(withoutRaw(live), envelope.response)), name).toBe(
          stringifyJson(live),
        );
      }
    });
  });

  it('renders the same JSON payload the inspect CLI renders, for every fixture', () => {
    withTempStore(store => {
      for (const name of allFixtureNames()) {
        const envelope = loadFixture(name);
        const provenance = fixtureProvenance(name);
        const live = normalizeTransaction(envelope.response, { provenance });
        api().ingestRawResponse(store, { raw: envelope.response, provenance });

        // What `npm run inspect -- <sig> --json` prints …
        const effects = transactionEffects(live);
        const swaps = recognizeSwaps(live, { effects });
        const livePayload = { ...live, effects, swaps, routes: recognizeRoutes(live, { swaps }) };

        // … is what `npm run store -- print <sig> --json` prints, byte for byte.
        const storedModel = api().loadTransactionModel(store, live.signature);
        const storedPayload = {
          ...(storedModel as object),
          effects: api().loadEffectsArtifact(store, live.signature),
          swaps: api().loadSwapsArtifact(store, live.signature),
          routes: api().loadRoutesArtifact(store, live.signature),
        };

        expect(stringifyJson(storedPayload), name).toBe(stringifyJson(livePayload));
      }
    });
  });

  it('is idempotent over the whole corpus: a second pass adds nothing but history', () => {
    withTempStore(store => {
      for (const name of allFixtureNames()) {
        const envelope = loadFixture(name);
        api().ingestRawResponse(store, { raw: envelope.response, provenance: fixtureProvenance(name) });
      }
      const counts = tableCounts(store);

      for (const name of allFixtureNames()) {
        const envelope = loadFixture(name);
        const result = api().ingestRawResponse(store, {
          raw: envelope.response,
          provenance: fixtureProvenance(name),
        });
        expect(result.outcome, name).toBe('unchanged-equal-quality');
        expect(result.stored, name).toBe(false);
      }

      expect(tableCounts(store)).toEqual({ ...counts, fetches: counts.fetches * 2 });
    });
  });
});
