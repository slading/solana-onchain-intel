/**
 * Milestone 4.4 — the `route_v2` ABI surface, byte by byte.
 *
 * These are the tests that keep the *decoder* honest, independent of any
 * transaction: the header layout, the per-variant plan element widths, and every
 * way the payload can be malformed. A wrong width here would silently shift the
 * whole plan, so each variant the layer claims to support is exercised explicitly.
 */
import { describe, expect, it } from 'vitest';
import {
  ROUTE_PLAN_VARIANTS,
  parseRouteV2Header,
  parseRouteV2Plan,
  provenLegInstructionName,
  routePlanVariant,
} from '../src/route/jupiter.ts';
import { base58 } from './helpers/swaps.ts';
import { planStep, remainingAccountsInfo, routeV2Data } from './helpers/routes.ts';
import { getBase58Encoder, type ReadonlyUint8Array } from '@solana/kit';

/** Bytes of a payload built by the layout helper, with the discriminator included. */
function bytesOf(data: string): ReadonlyUint8Array {
  return getBase58Encoder().encode(data);
}

const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number): number[] => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  (value >> 24) & 0xff,
];

describe('route_v2 header', () => {
  it('reads every field at its declared offset', () => {
    const data = routeV2Data({
      declaredInAmount: 4_774_791_332_475n,
      quotedOutAmount: 15_234_269_261n,
      slippageBps: 774,
      platformFeeBps: 10,
      positiveSlippageBps: 100,
      steps: [],
    });
    const parsed = parseRouteV2Header(bytesOf(data));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.header).toEqual({
      declaredInAmount: 4_774_791_332_475n,
      quotedOutAmount: 15_234_269_261n,
      slippageBps: 774,
      platformFeeBps: 10,
      positiveSlippageBps: 100,
      routePlanStepCount: 0,
      consumedBytes: 34,
    });
  });

  it('is exactly 34 bytes including the discriminator', () => {
    const data = routeV2Data({
      declaredInAmount: 0n,
      quotedOutAmount: 0n,
      slippageBps: 0,
      steps: [],
    });
    expect(bytesOf(data).length).toBe(34);
  });

  it.each([
    ['in_amount', 8 + 4],
    ['quoted_out_amount', 8 + 12],
    ['slippage_bps', 8 + 16],
    ['platform_fee_bps', 8 + 18],
    ['positive_slippage_bps', 8 + 20],
    ['the plan length', 8 + 22],
  ])('refuses a payload truncated inside %s', (_field, length) => {
    const full = bytesOf(
      routeV2Data({ declaredInAmount: 1n, quotedOutAmount: 2n, slippageBps: 3, steps: [] }),
    );
    const parsed = parseRouteV2Header(full.subarray(0, length));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toMatch(/truncated/);
  });
});

describe('route_plan element widths', () => {
  it('covers every tag the accepted evidence supports, and no others', () => {
    // The deployed enum is larger than any public ABI: unobserved tags are absent
    // on purpose, because guessing one would shift every following step.
    expect(ROUTE_PLAN_VARIANTS.map(variant => variant.tag)).toEqual([
      17, 26, 38, 40, 46, 47, 75, 95, 99, 100, 104, 108, 116, 117, 141, 146, 147, 148, 151, 153, 154, 156, 178, 181, 187,
    ]);
  });

  it('leaves every payload-solved tag unnamed and every ABI tag named', () => {
    for (const variant of ROUTE_PLAN_VARIANTS) {
      if (variant.source === 'observed-bytes') expect(variant.name).toBeNull();
      else expect(variant.name).not.toBeNull();
    }
    expect(routePlanVariant(178)?.name).toBeNull();
    expect(routePlanVariant(181)?.name).toBeNull();
    expect(routePlanVariant(187)?.name).toBeNull();
  });

  it('marks dynamicV2 unsupported rather than giving it a width', () => {
    const variant = routePlanVariant(146);
    expect(variant?.field.kind).toBe('unsupported');
    expect(variant?.name).toBe('dynamicV2');
  });

  it('reads a mixed plan with each element at its own width', () => {
    const data = routeV2Data({
      declaredInAmount: 100n,
      quotedOutAmount: 200n,
      slippageBps: 50,
      steps: [
        planStep(148, [], 5716, 0, 3),
        planStep(75, remainingAccountsInfo(), 1261, 0, 3),
        planStep(47, [1, 1, ...remainingAccountsInfo([[6, 3]])], 3023, 0, 3),
      ],
    });
    const parsed = parseRouteV2Plan(bytesOf(data), 3);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.steps.map(step => [step.swapTag, step.swapFieldBytes, step.bps, step.inputIndex, step.outputIndex])).toEqual([
      [148, 0, 5716, 0, 3],
      [75, 4, 1261, 0, 3],
      [47, 8, 3023, 0, 3],
    ]);
    expect(parsed.steps.map(step => step.swapName)).toEqual([
      'pumpSwapSellV3WithCashbackClaim',
      'meteoraDlmmSwapV2',
      'whirlpoolSwapV2',
    ]);
  });

  it('reads the optional RemainingAccountsInfo in both of its forms', () => {
    const absent = parseRouteV2Plan(bytesOf(routeV2Data({
      declaredInAmount: 1n,
      quotedOutAmount: 2n,
      slippageBps: 0,
      steps: [planStep(47, [0, 0], 10_000, 0, 1)],
    })), 1);
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.steps[0]?.swapFieldBytes).toBe(2);

    const present = parseRouteV2Plan(bytesOf(routeV2Data({
      declaredInAmount: 1n,
      quotedOutAmount: 2n,
      slippageBps: 0,
      steps: [planStep(47, [1, 1, ...remainingAccountsInfo([[6, 3]])], 10_000, 0, 1)],
    })), 1);
    expect(present.ok).toBe(true);
    if (present.ok) expect(present.steps[0]?.swapFieldBytes).toBe(8);
  });

  it('reads the deployed tags no ABI names, using their payload-solved widths', () => {
    const data = routeV2Data({
      declaredInAmount: 1n,
      quotedOutAmount: 2n,
      slippageBps: 0,
      steps: [planStep(178, [1], 10_000, 0, 1), planStep(181, [0], 10_000, 1, 2), planStep(187, [1, 0], 10_000, 2, 3)],
    });
    const parsed = parseRouteV2Plan(bytesOf(data), 3);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.steps.map(step => [step.swapTag, step.swapName, step.swapFieldBytes])).toEqual([
      [178, null, 1],
      [181, null, 1],
      [187, null, 2],
    ]);
  });

  it('stops at an unsupported variant instead of guessing its width', () => {
    const data = routeV2Data({
      declaredInAmount: 1n,
      quotedOutAmount: 2n,
      slippageBps: 0,
      steps: [planStep(148, [], 10_000, 0, 1), planStep(146, [0, 0, 0, 0, 0, 0], 10_000, 1, 2)],
    });
    const parsed = parseRouteV2Plan(bytesOf(data), 2);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.detail).toContain('dynamicV2');
    expect(parsed.detail).toContain('not resolved');
  });

  it('stops at a tag no evidence covers at all', () => {
    const data = routeV2Data({
      declaredInAmount: 1n,
      quotedOutAmount: 2n,
      slippageBps: 0,
      steps: [planStep(5, [0, 0, 0, 0, 0, 0, 0, 0, 0], 10_000, 0, 1)],
    });
    const parsed = parseRouteV2Plan(bytesOf(data), 1);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain('no accepted evidence covers');
  });

  it('refuses a plan whose declared count leaves bytes unconsumed', () => {
    const data = routeV2Data({
      declaredInAmount: 1n,
      quotedOutAmount: 2n,
      slippageBps: 0,
      steps: [planStep(148, [], 10_000, 0, 1)],
      trailingBytes: [0xde, 0xad],
    });
    const parsed = parseRouteV2Plan(bytesOf(data), 1);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain('remain unconsumed');
    expect(parsed.steps).toHaveLength(1);
  });

  it('refuses an absurd step count rather than reading past the payload', () => {
    const data = routeV2Data({
      declaredInAmount: 1n,
      quotedOutAmount: 2n,
      slippageBps: 0,
      stepCountOverride: 0xffffffff,
      steps: [planStep(148, [], 10_000, 0, 1)],
    });
    const parsed = parseRouteV2Plan(bytesOf(data), 0xffffffff);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain('the payload ends after');
  });

  it('accepts a declared count of zero with an empty plan', () => {
    const parsed = parseRouteV2Plan(
      bytesOf(routeV2Data({ declaredInAmount: 1n, quotedOutAmount: 2n, slippageBps: 0, steps: [] })),
      0,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.steps).toEqual([]);
  });

  it('refuses a truncated variant payload', () => {
    const discriminator = 'bb64facc31c4af14'.match(/../g) ?? [];
    const truncated = base58([
      ...discriminator.map(byte => Number.parseInt(byte, 16)),
      ...u64leBytesOf(1n),
      ...u64leBytesOf(2n),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(1),
      75,
      0,
      0, // only 2 of the 4 RemainingAccountsInfo bytes
    ]);
    const parsed = parseRouteV2Plan(bytesOf(truncated), 1);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain('remaining_accounts_info');
  });

  it('refuses an invalid Option discriminant inside a variant', () => {
    const data = routeV2Data({
      declaredInAmount: 1n,
      quotedOutAmount: 2n,
      slippageBps: 0,
      steps: [planStep(47, [1, 2], 10_000, 0, 1)],
      trailingBytes: [0, 0],
    });
    const parsed = parseRouteV2Plan(bytesOf(data), 1);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain('Option discriminant');
  });
});

describe('proven leg instruction names', () => {
  it('names only the discriminators proven by preimage', () => {
    expect(provenLegInstructionName('414b3f4ceb5b5b88')).toBe('swap2');
    expect(provenLegInstructionName('33e685a4017f83ad')).toBe('sell');
    expect(provenLegInstructionName('66063d1201daebea')).toBe('buy');
    expect(provenLegInstructionName('c62e1552b4d9e870')).toBe('buy_exact_quote_in');
    expect(provenLegInstructionName('f945a4da9667548a')).toBe('close_user_volume_accumulator');
    expect(provenLegInstructionName('e52ed584692828e4')).toBeNull();
    expect(provenLegInstructionName(null)).toBeNull();
  });
});

function u64leBytesOf(value: bigint): number[] {
  const out: number[] = [];
  let rest = value;
  for (let index = 0; index < 8; index += 1) {
    out.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return out;
}
