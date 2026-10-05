/**
 * The version guard: a stored artifact must say which engine produced it, and that label
 * must change whenever the engine's output changes.
 *
 * Nothing can detect a *semantic* change automatically — but the derivation output over the
 * frozen corpus can be fingerprinted, and that fingerprint can be pinned here. The rule the
 * test enforces is therefore mechanical: **if this test fails, the engine's output over the
 * 13 recorded fixtures changed, so `DERIVED_SEMANTICS_VERSION` must be bumped in the same
 * commit** (and the new fingerprint recorded below). Older artifacts then stay in the store
 * as `staleVersions`, and re-analysis writes rows under the new version without touching a
 * single byte of raw evidence.
 *
 * Pure computation: no SQLite, no network, so this test runs on every Node the repository
 * supports.
 */

import { describe, expect, it } from 'vitest';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { encodeEvidence, sha256Hex } from '../src/store/codec.ts';
import { deriveArtifacts } from '../src/store/derive.ts';
import {
  CODEC_VERSION,
  DERIVED_LAYERS,
  DERIVED_SEMANTICS_VERSION,
  isDerivedLayer,
  STORE_FORMAT_VERSION,
} from '../src/store/version.ts';
import { allFixtureNames, loadFixture } from './helpers/fixtures.ts';

const BUMP_HINT =
  'The derivation output over the frozen fixtures changed. Bump DERIVED_SEMANTICS_VERSION in ' +
  'src/store/version.ts and record the new fingerprint here — do not just update the number.';

/** Fingerprint of the canonical artifacts of all four layers, over the whole corpus. */
const PINNED_FINGERPRINT = 'a13ee9921353cdf032f60e6b4b654de6d013488c79741a9b46aecad2bcb1ec8a';

/** The same, per layer, so a failure says which layer moved. */
const PINNED_LAYER_FINGERPRINTS = {
  normalized: '7ccbbdab9225575ae119b4b3341114c986132085d805fa45a69a6b4adee6082f',
  effects: '276528ef51976484ee10fb85db531db8e08f2a79bffd39705ec7b9383274f233',
  swaps: '92263a3a7d5d6175d567a2bc31c539dd179cdd0410054f4c65a7e92d7934932e',
  routes: 'fa40baafc4cc4c399cf26c7e940e786bfc89ac78a7a09d667dee98b52b4e02c0',
} as const;

interface Fingerprints {
  readonly overall: string;
  readonly layers: Readonly<Record<string, string>>;
}

/** Canonical text of every artifact of every fixture, hashed per layer and overall. */
function fingerprintCorpus(): Fingerprints {
  const parts: string[] = [];
  const perLayer: Record<string, string[]> = { normalized: [], effects: [], swaps: [], routes: [] };

  for (const name of allFixtureNames()) {
    const envelope = loadFixture(name);
    const transaction = normalizeTransaction(envelope.response, {
      provenance: {
        rpcEndpoint: envelope.provenance.source,
        encoding: 'jsonParsed',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 1,
      },
    });
    const artifacts = deriveArtifacts(transaction);
    parts.push(name);
    for (const layer of DERIVED_LAYERS) {
      const text = encodeEvidence(artifacts[layer]);
      parts.push(`${name}:${layer}:${text}`);
      perLayer[layer]?.push(`${name}:${layer}:${text}`);
    }
  }

  return {
    overall: sha256Hex(parts.join('\n')),
    layers: Object.fromEntries(
      Object.entries(perLayer).map(([layer, texts]) => [layer, sha256Hex(texts.join('\n'))]),
    ),
  };
}

describe('derivation versioning', () => {
  it('pins the format, codec and semantics versions the store writes', () => {
    expect(STORE_FORMAT_VERSION).toBe(1);
    expect(CODEC_VERSION).toBe(1);
    expect(DERIVED_SEMANTICS_VERSION).toBe('m1+m2+m3+m4.1+m4.2+m4.3+m4.4');
  });

  it('describes the four artifact layers in one place', () => {
    expect(DERIVED_LAYERS).toEqual(['normalized', 'effects', 'swaps', 'routes']);
    for (const layer of DERIVED_LAYERS) expect(isDerivedLayer(layer)).toBe(true);
    expect(isDerivedLayer('pump-sell')).toBe(false);
  });

  it('fingerprints the derivation over the whole corpus, so a semantics change cannot go unnoticed', () => {
    const fingerprints = fingerprintCorpus();
    expect(fingerprints.overall, BUMP_HINT).toBe(PINNED_FINGERPRINT);
  });

  it('fingerprints each layer separately', () => {
    const fingerprints = fingerprintCorpus();
    for (const layer of DERIVED_LAYERS) {
      expect(fingerprints.layers[layer], `${layer}: ${BUMP_HINT}`).toBe(PINNED_LAYER_FINGERPRINTS[layer]);
    }
  });

  it('is deterministic: the same evidence always fingerprints identically', () => {
    expect(fingerprintCorpus()).toEqual(fingerprintCorpus());
  });

  it('encodes every real artifact without loss: the codec refuses nothing the pipeline produces', () => {
    // The codec is strict by design (no `undefined`, no `NaN`, no functions); this proves the
    // strictness costs nothing over the real corpus.
    for (const name of allFixtureNames()) {
      const envelope = loadFixture(name);
      const transaction = normalizeTransaction(envelope.response, {
        provenance: {
          rpcEndpoint: envelope.provenance.source,
          encoding: 'jsonParsed',
          commitment: 'finalized',
          maxSupportedTransactionVersion: 1,
        },
      });
      const artifacts = deriveArtifacts(transaction);
      for (const layer of DERIVED_LAYERS) {
        const text = encodeEvidence(artifacts[layer]);
        expect(text.startsWith('{'), name).toBe(true);
        expect(text.includes(undefined as unknown as string)).toBe(false);
      }
    }
  });
});
