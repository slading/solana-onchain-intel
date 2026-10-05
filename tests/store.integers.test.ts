/**
 * Serialization: exact integers, and a codec that cannot lie quietly.
 *
 * Two different things are proved here:
 *
 *  - the **codec** round-trips a value exactly, preserving both the numeric *type*
 *    (`bigint` stays `bigint`, a JSON number stays a number) and the key order, so the
 *    encoded text is stable enough to serve as an evidence identity;
 *  - the **store** keeps u64-scale amounts exact. SQLite has no unsigned 64-bit integer, so
 *    amounts live in TEXT columns as canonical decimals and come back as `bigint` — never as
 *    a float, and never through `JSON.stringify(BigInt)`, which would throw.
 */

import { describe, expect, it } from 'vitest';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import {
  BIGINT_MARKER,
  OBJECT_MARKER,
  decodeEvidence,
  encodeEvidence,
  EvidenceCodecError,
  sha256Hex,
} from '../src/store/codec.ts';
import { deriveArtifacts } from '../src/store/derive.ts';
import type { NormalizedProvenance } from '../src/model/transaction.ts';
import {
  api,
  artifactText,
  fixtureObservation,
  fixtureRaw,
  sqliteAvailable,
  tableCounts,
  withTempStore,
} from './helpers/store.ts';

const U64_MAX = 18446744073709551615n;
const ABOVE_SAFE = 9007199254740993n; // 2^53 + 1: unrepresentable as a double
const FIXTURE = 'v0-success-pump-buy-24b';

const PROVENANCE: NormalizedProvenance = {
  rpcEndpoint: 'https://fixture.invalid',
  encoding: 'jsonParsed',
  commitment: 'finalized',
  maxSupportedTransactionVersion: 1,
};

/** The fixture with two amounts replaced by values a JSON number cannot hold. */
function extremeRaw(): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(fixtureRaw(FIXTURE))) as Record<string, unknown>;
  const meta = raw['meta'] as Record<string, unknown>;
  const pre = meta['preBalances'] as unknown[];
  const post = meta['postBalances'] as unknown[];
  // The fee payer pays the u64 maximum and its balances move accordingly, so the effects
  // layer's own reconciliation stays consistent with the amounts it reports.
  meta['fee'] = U64_MAX;
  meta['computeUnitsConsumed'] = ABOVE_SAFE;
  pre[0] = U64_MAX;
  post[0] = 0n;
  return raw;
}

describe('evidence codec: exact serialization', () => {
  it('hashes canonical text with sha256, as documented', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('round-trips 64-bit integers as bigint, including values a double cannot hold', () => {
    const value = {
      u64Max: U64_MAX,
      aboveSafe: ABOVE_SAFE,
      negative: -U64_MAX,
      small: 1n,
      zero: 0n,
    };
    const decoded = decodeEvidence(encodeEvidence(value)) as Record<string, bigint>;
    expect(decoded['u64Max']).toBe(U64_MAX);
    expect(decoded['aboveSafe']).toBe(ABOVE_SAFE);
    expect(decoded['negative']).toBe(-U64_MAX);
    expect(decoded['small']).toBe(1n);
    expect(decoded['zero']).toBe(0n);
    for (const entry of Object.values(decoded)) expect(typeof entry).toBe('bigint');

    // The encoded text is plain JSON with an explicit marker, so it stays inspectable.
    expect(encodeEvidence({ amount: U64_MAX })).toBe(
      `{"amount":{"${BIGINT_MARKER}":"18446744073709551615"}}`,
    );
  });

  it('never turns a JSON number into a bigint, or the other way round', () => {
    const value = { count: 3, ratio: 1.5, token: 18446744073709551615n };
    const decoded = decodeEvidence(encodeEvidence(value)) as Record<string, unknown>;
    expect(decoded['count']).toBe(3);
    expect(typeof decoded['count']).toBe('number');
    expect(decoded['ratio']).toBe(1.5);
    expect(typeof decoded['ratio']).toBe('number');
    expect(decoded['token']).toBe(U64_MAX);
    expect(typeof decoded['token']).toBe('bigint');
  });

  it('preserves key order, so the same value always encodes to the same bytes', () => {
    const first = { b: 1, a: 2, c: 3 };
    const second = { a: 2, b: 1, c: 3 };
    expect(encodeEvidence(first)).toBe('{"b":1,"a":2,"c":3}');
    expect(encodeEvidence(first)).not.toBe(encodeEvidence(second));

    const roundTripped = decodeEvidence(encodeEvidence(first)) as Record<string, number>;
    expect(Object.keys(roundTripped)).toEqual(['b', 'a', 'c']);

    // Re-encoding what was decoded is a fixed point: a stable evidence identity.
    expect(encodeEvidence(decodeEvidence(encodeEvidence(first)))).toBe(encodeEvidence(first));
  });

  it('escapes objects that use a reserved key, so data can never be read as a marker', () => {
    const hostile = { [BIGINT_MARKER]: 'not a number', nested: { [OBJECT_MARKER]: true } };
    const text = encodeEvidence(hostile);
    expect(text).toContain(OBJECT_MARKER);

    const decoded = decodeEvidence(text) as Record<string, unknown>;
    expect(decoded[BIGINT_MARKER]).toBe('not a number');
    expect((decoded['nested'] as Record<string, unknown>)[OBJECT_MARKER]).toBe(true);

    // A real object may carry a reserved key as *data* while still holding a bigint.
    const mixed = { [OBJECT_MARKER]: { deep: 123456789012345678901234567890n } };
    const roundTripped = decodeEvidence(encodeEvidence(mixed)) as Record<string, Record<string, bigint>>;
    expect(roundTripped[OBJECT_MARKER]?.['deep']).toBe(123456789012345678901234567890n);
  });

  it('preserves arrays and their order, and null against absent', () => {
    const value = { list: [1n, 'two', null, { three: 3 }], explicitlyNull: null };
    const decoded = decodeEvidence(encodeEvidence(value)) as Record<string, unknown>;
    expect(decoded['list']).toEqual([1n, 'two', null, { three: 3 }]);
    expect(decoded['explicitlyNull']).toBeNull();
    expect('missing' in decoded).toBe(false);
  });

  it('fails loudly on a malformed marker instead of guessing', () => {
    expect(() => decodeEvidence('not json at all')).toThrow(EvidenceCodecError);
    expect(() => decodeEvidence(`{"amount":{"${BIGINT_MARKER}":"12.5"}}`)).toThrow(/exact decimal/);
    expect(() => decodeEvidence(`{"amount":{"${BIGINT_MARKER}":12}}`)).toThrow(/exact decimal/);
    expect(() => decodeEvidence(`{"${OBJECT_MARKER}":[1,2]}`)).toThrow(/must hold an object/);
    expect(() => decodeEvidence(`{"${OBJECT_MARKER}":"text"}`)).toThrow(/must hold an object/);
  });

  it('refuses values JSON cannot represent, rather than dropping them', () => {
    expect(() => encodeEvidence({ missing: undefined })).toThrow(/undefined/);
    expect(() => encodeEvidence({ infinite: Number.POSITIVE_INFINITY })).toThrow(/cannot represent/);
    expect(() => encodeEvidence({ nan: Number.NaN })).toThrow(/cannot represent/);
    expect(() => encodeEvidence({ fn: (): void => undefined })).toThrow(/function/);
  });
});

describe.skipIf(!sqliteAvailable)('corpus store: exact integers', () => {
  it('stores u64-scale and above-2^53 amounts exactly, as TEXT, and restores bigint', () => {
    withTempStore(store => {
      const raw = extremeRaw();
      const signature = normalizeTransaction(raw, { provenance: PROVENANCE }).signature;

      const result = api().ingestRawResponse(store, { raw, provenance: PROVENANCE });
      expect(result.outcome).toBe('stored');

      // The canonical row holds exact decimals in TEXT columns — never a REAL, never rounded.
      const row = store.database
        .prepare(
          'SELECT typeof(slot) AS slot, typeof(fee_lamports) AS fee, typeof(compute_units_consumed) AS cu, fee_lamports, compute_units_consumed FROM transactions WHERE signature = ?',
        )
        .get(signature);
      expect(row?.['slot']).toBe('text');
      expect(row?.['fee']).toBe('text');
      expect(row?.['cu']).toBe('text');
      expect(row?.['fee_lamports']).toBe('18446744073709551615');
      expect(row?.['compute_units_consumed']).toBe('9007199254740993');

      // Every stored artifact is canonical text, so amounts survive as exact decimals.
      const effectsText = artifactText(store, signature, 'effects');
      expect(effectsText).toContain('18446744073709551615');
      expect(effectsText).not.toContain('1.8446744073709552e+19');

      // Loading restores the numeric type: bigint, exact.
      const evidence = api().loadRawEvidence(store, signature);
      const meta = (evidence?.raw as Record<string, unknown>)['meta'] as Record<string, unknown>;
      expect(typeof meta['fee']).toBe('bigint');
      expect(meta['fee']).toBe(U64_MAX);

      const effects = api().loadEffectsArtifact(store, signature);
      const feeFlow = effects?.solFlows.find(flow => flow.kind === 'fee');
      expect(typeof feeFlow?.lamports).toBe('bigint');
      expect(feeFlow?.lamports).toBe(U64_MAX);
      const payerNet = effects?.netSolByAccount.find(net => net.isFeePayer);
      expect(payerNet?.netLamports).toBe(-U64_MAX);

      // Re-deriving from the stored evidence reproduces the same exact values.
      const before = effectsText;
      expect(api().reanalyzeSignature(store, signature).outcome).toBe('reanalyzed');
      expect(artifactText(store, signature, 'effects')).toBe(before);
    });
  });

  it('binds integers so SQLite cannot coerce them behind the store’s back', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      expect(api().ingestRawResponse(store, observation).outcome).toBe('stored');

      // `STRICT` refuses a REAL in an INTEGER column — which is what protects the counts and
      // the evidence-quality flags. (SQLite's default affinity would store it.)
      expect(() =>
        store.database
          .prepare(
            `UPDATE transactions SET observation_count = ? WHERE signature = ?`,
          )
          .run(1.5, observation.signature),
      ).toThrow(/INTEGER column/);

      // But `STRICT` does *not* protect a TEXT amount column: binding a number there is
      // silently coerced (2 becomes '2.0'). This is exactly why the store binds canonical
      // decimal strings and never numbers.
      store.database.prepare('UPDATE transactions SET fee_lamports = ? WHERE signature = ?').run(2, observation.signature);
      const coerced = store.database
        .prepare('SELECT fee_lamports, typeof(fee_lamports) AS t FROM transactions WHERE signature = ?')
        .get(observation.signature);
      expect(coerced?.['fee_lamports']).toBe('2.0');
      expect(coerced?.['t']).toBe('text');

      // The store's own path is unaffected: re-deriving restores the exact value from the
      // raw evidence, because the raw evidence — not the column — is the source of truth.
      const live = normalizeTransaction(observation.raw, { provenance: observation.provenance });
      expect(api().reanalyzeSignature(store, observation.signature).outcome).toBe('reanalyzed');
      const restored = store.database
        .prepare('SELECT fee_lamports FROM transactions WHERE signature = ?')
        .get(observation.signature);
      expect(restored?.['fee_lamports']).toBe((live.feeLamports ?? 0n).toString());
    });
  });

  it('stores amounts as canonical decimals, with no float anywhere it could hide', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      expect(api().ingestRawResponse(store, observation).outcome).toBe('stored');

      // Amounts: TEXT holding exact decimals (an INTEGER column could not hold u64, and a
      // REAL would round). NULL means "this observation did not report it".
      const amountColumns = ['slot', 'block_time_unix', 'fee_lamports', 'compute_units_consumed', 'cost_units'];
      const row = store.database.prepare(`SELECT ${amountColumns.join(', ')} FROM transactions`).get();
      expect(row).toBeDefined();
      for (const column of amountColumns) {
        const value = row?.[column];
        if (value === null) continue;
        expect(typeof value).toBe('string');
        expect(String(value)).toMatch(/^-?\d+$/);
      }
      expect(row?.['slot']).toBe(normalizeTransaction(observation.raw, { provenance: observation.provenance }).slot.toString());

      // Counts: real integers, never text.
      const integerColumns = [
        'instruction_count',
        'inner_instruction_count',
        'account_count',
        'log_count',
        'observation_count',
      ];
      const counts = store.database.prepare(`SELECT ${integerColumns.join(', ')} FROM transactions`).get();
      for (const column of integerColumns) {
        const value = counts?.[column];
        if (value === null) continue;
        expect(typeof value).toBe('number');
        expect(Number.isInteger(value)).toBe(true);
      }

      // The same shape in the other tables that hold numbers: the evidence flags are
      // integers, and the size of the payload is derived by SQLite rather than stored.
      const raw = store.database
        .prepare('SELECT length(raw_text) AS chars, meta_present, logs_present FROM raw_responses')
        .get();
      expect(typeof raw?.['chars']).toBe('number');
      expect(Number(raw?.['chars'])).toBeGreaterThan(0);
      expect(raw?.['meta_present']).toBe(1);
      expect(raw?.['logs_present']).toBe(1);
      const fetch = store.database.prepare('SELECT retryable FROM fetches').get();
      expect(fetch?.['retryable']).toBe(0);
      expect(tableCounts(store).transactions).toBe(1);
    });
  });

  it('repairs a corrupted artifact from the raw evidence, byte for byte', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      api().ingestRawResponse(store, observation);
      const good = artifactText(store, observation.signature, 'effects');

      store.database
        .prepare(
          "UPDATE derived SET artifact_text = '{\"truncated\":', artifact_sha256 = 'x' WHERE signature = ? AND layer = 'effects'",
        )
        .run(observation.signature);
      expect(() => api().loadEffectsArtifact(store, observation.signature)).toThrow(EvidenceCodecError);

      // The raw evidence is untouched, and it is enough to rebuild the artifact exactly.
      expect(api().reanalyzeSignature(store, observation.signature).outcome).toBe('reanalyzed');
      expect(artifactText(store, observation.signature, 'effects')).toBe(good);

      // For completeness: the rebuilt artifact is what the live pipeline derives from the
      // same evidence, so the repair invented nothing.
      const live = normalizeTransaction(observation.raw, { provenance: observation.provenance });
      expect(artifactText(store, observation.signature, 'effects')).toBe(
        encodeEvidence(deriveArtifacts(live).effects),
      );
    });
  });

  it('refuses to re-derive from corrupted raw evidence, and keeps the last good artifacts', () => {
    withTempStore(store => {
      const observation = fixtureObservation(FIXTURE);
      api().ingestRawResponse(store, observation);
      const before = artifactText(store, observation.signature, 'normalized');

      store.database
        .prepare('UPDATE raw_responses SET raw_text = ? WHERE signature = ?')
        .run('{ not json', observation.signature);

      const result = api().reanalyzeSignature(store, observation.signature);
      expect(result.outcome).toBe('failed');
      expect(result.detail).toContain('could not be decoded');
      expect(result.layers).toEqual([]);

      // Nothing was destroyed: a corpus keeps its last good artifacts.
      expect(artifactText(store, observation.signature, 'normalized')).toBe(before);
      expect(api().loadNormalizedArtifact(store, observation.signature)).not.toBeNull();
    });
  });
});
