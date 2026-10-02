import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import type { NormalizedTransaction } from '../src/model/transaction.ts';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { allFixtureNames, loadFixture, normalizeFixture } from './helpers/fixtures.ts';

/**
 * `@solana/kit` post-processes every RPC response through
 * `@solana/rpc-transformers`, which upcasts **integers to `bigint`** except at an
 * allow-list of small bounded key paths (`accountIndex`, `decimals`, `stackHeight`,
 * message header counts, …).
 *
 * So the object our normalizer receives on the real CLI path is not the raw JSON
 * recorded in ./fixtures: `blockTime`, `meta.fee`, `preBalances[]` and friends are
 * `bigint` at runtime. This was found by running the CLI for real — the fixture
 * tests passed while the live path silently lost the block time.
 *
 * These tests push both shapes through the normalizer and require identical
 * models, so the two paths can never drift apart again.
 */

/** Key names kit keeps as `number` (mirrors `allowedNumericKeyPaths`). */
const NUMERIC_KEY_ALLOWLIST = new Set([
  'accountIndex',
  'decimals',
  'uiAmount',
  'stackHeight',
  'programIdIndex',
  'numRequiredSignatures',
  'numReadonlySignedAccounts',
  'numReadonlyUnsignedAccounts',
  'version',
  'computeUnitLimit',
  'heapSize',
  'loadedAccountsDataSizeLimit',
  'writableIndexes',
  'readonlyIndexes',
]);

/** Simulates kit's bigint upcast over a recorded JSON response. */
function toKitLike(value: unknown, key?: string): unknown {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return key !== undefined && NUMERIC_KEY_ALLOWLIST.has(key) ? value : BigInt(value);
  }
  if (Array.isArray(value)) return value.map(item => toKitLike(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toKitLike(v, k)]),
    );
  }
  return value;
}

/** Same provenance `normalizeFixture` uses, so models are comparable field by field. */
function provenanceFor(name: string) {
  return {
    rpcEndpoint: loadFixture(name).provenance.source,
    encoding: 'jsonParsed',
    commitment: 'finalized',
    maxSupportedTransactionVersion: 1,
  } as const;
}

/** Normalizes the fixture the way the CLI would: through kit's transformed view. */
function normalizeKitView(name: string): NormalizedTransaction {
  return normalizeTransaction(toKitLike(loadFixture(name).response), {
    provenance: provenanceFor(name),
  });
}

/** The model without the verbatim payload, whose shape legitimately differs. */
function withoutRaw(normalized: NormalizedTransaction): unknown {
  const { raw: _raw, ...rest } = normalized;
  return rest;
}

/**
 * Compares *values* rather than runtime types.
 *
 * `parsedInfo` is stored verbatim, so an integer the RPC sent as `12` stays `12`
 * while the kit view holds `12n`. Both are the same value and neither is rewritten
 * by us, so the comparison unwraps bigint where it is lossless. Fields we
 * genuinely promise as `bigint` are asserted directly in the tests below.
 */
function toComparableValues(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (Array.isArray(value)) return value.map(toComparableValues);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toComparableValues(v)]),
    );
  }
  return value;
}

describe('responses transformed by @solana/kit normalize identically to raw JSON', () => {
  it.each(allFixtureNames())('%s', name => {
    const fromRawJson = normalizeFixture(name).transaction;
    const fromKitView = normalizeKitView(name);

    // Same values, same ordering, same diagnostics — only the input types differ,
    // and only inside the verbatim `parsedInfo` passthrough.
    expect(stringifyJson(toComparableValues(withoutRaw(fromKitView)))).toBe(
      stringifyJson(toComparableValues(withoutRaw(fromRawJson))),
    );
  });

  it.each(allFixtureNames())('%s keeps bigint-sourced fields readable', name => {
    const transaction = normalizeKitView(name);

    // These arrive as bigint through kit; a number-only reader would drop them.
    expect(transaction.slot).toBeGreaterThan(0n);
    expect(transaction.feeLamports).not.toBeNull();
    expect(transaction.blockTimeUnix).not.toBeNull();
    expect(transaction.status).not.toBe('unknown');

    for (const change of transaction.solBalanceChanges) {
      expect(change.beforeLamports === null || typeof change.beforeLamports === 'bigint').toBe(true);
    }
    for (const change of transaction.tokenBalanceChanges) {
      for (const amount of [change.beforeAmount, change.afterAmount]) {
        expect(amount === null || typeof amount === 'bigint').toBe(true);
      }
    }
  });

  it('keeps a bigint-valued error verbatim', () => {
    const transformed = toKitLike(loadFixture('v1-failed-custom11').response) as {
      meta: { err: unknown };
    };
    const transaction = normalizeTransaction(transformed, {
      provenance: provenanceFor('v1-failed-custom11'),
    });

    // The error is copied, never re-typed or translated: same structure, bigint codes.
    expect(transaction.error).toEqual(transformed.meta.err);
    expect(transaction.status).toBe('failed');
  });

  it('serializes bigints losslessly as decimal strings', () => {
    // JSON.stringify throws on bigint; our serializer must convert them.
    const json = stringifyJson(normalizeKitView('v0-success-swap'));
    expect(json).toContain('"slot":');
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json) as { slot: string; feeLamports: string };
    expect(parsed.slot).toMatch(/^\d+$/);
    expect(parsed.feeLamports).toMatch(/^\d+$/);
  });
});
