/**
 * The DLMM surface itself: program id, discriminator, arguments, account roles.
 *
 * These tests are deliberately about *bytes and tables* — they are the part of the
 * layer that must be right before any transaction can be judged. The transaction
 * level lives in `swap.fixtures.test.ts` and `swap.adversarial.test.ts`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DLMM_PROGRAM_ID,
  DLMM_SWAP2_ACCOUNT_ROLES,
  DLMM_SWAP2_DISCRIMINATOR,
  instructionDiscriminator,
  parseDlmmSwap2Args,
} from '../src/swap/dlmm.ts';
import { bytesOfData, innerInstructionsOf, swap2Payload, swapFixture } from './helpers/swaps.ts';

/** The 16 roles exactly as `MeteoraAg/dlmm-sdk` → `idls/dlmm.json` declares them. */
const IDL_ROLES = [
  'lb_pair',
  'bin_array_bitmap_extension',
  'reserve_x',
  'reserve_y',
  'user_token_in',
  'user_token_out',
  'token_x_mint',
  'token_y_mint',
  'oracle',
  'host_fee_in',
  'user',
  'token_x_program',
  'token_y_program',
  'memo_program',
  'event_authority',
  'program',
];

describe('authoritative DLMM surface', () => {
  it('matches the vendor program id', () => {
    expect(DLMM_PROGRAM_ID).toBe('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  });

  it('derives the swap2 discriminator from the program source, not from an observation', () => {
    const derived = createHash('sha256').update('global:swap2').digest('hex').slice(0, 16);
    expect(derived).toBe(DLMM_SWAP2_DISCRIMINATOR);
    expect(DLMM_SWAP2_DISCRIMINATOR).toBe('414b3f4ceb5b5b88');
  });

  it('lists the account roles in the IDL order', () => {
    expect([...DLMM_SWAP2_ACCOUNT_ROLES]).toEqual(IDL_ROLES);
  });
});

describe('swap2 argument parsing', () => {
  it('reads both real legs with exact byte consumption', () => {
    const { transaction } = swapFixture('v0-success-swap');
    const expectations: readonly (readonly [number, bigint, bigint])[] = [
      [8, 602_101_187_025n, 0n],
      [13, 1_443_419_419_808n, 0n],
    ];
    for (const [index, amountIn, minAmountOut] of expectations) {
      const instruction = innerInstructionsOf(transaction, 3)[index];
      expect(instruction?.data).not.toBeNull();
      const bytes = bytesOfData(instruction?.data ?? '');
      expect(bytes.length).toBe(28);
      expect(instructionDiscriminator(bytes)).toBe(DLMM_SWAP2_DISCRIMINATOR);

      const parsed = parseDlmmSwap2Args(bytes);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('unreachable');
      expect(parsed.args.amountIn).toBe(amountIn);
      expect(parsed.args.minAmountOut).toBe(minAmountOut);
      expect(parsed.args.hookSliceCount).toBe(0);
      expect(parsed.args.consumedBytes).toBe(bytes.length);
    }
  });

  it('reads the real non-zero floor', () => {
    const { transaction } = swapFixture('v0-success-dlmm-minout');
    const instruction = innerInstructionsOf(transaction, 3)[1];
    const parsed = parseDlmmSwap2Args(Uint8Array.from(bytesOfData(instruction?.data ?? '')));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.args.minAmountOut).toBe(1n);
    expect(parsed.args.amountIn).toBe(250_000_000n);
  });

  it('accepts a slice list and counts it', () => {
    const parsed = parseDlmmSwap2Args(Uint8Array.from(swap2Payload(10n, 20n, [[0, 2], [4, 1]])));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.args.hookSliceCount).toBe(2);
    expect(parsed.args.consumedBytes).toBe(28 + 2 * 2);
  });

  it('rejects a truncated argument', () => {
    const payload = swap2Payload(10n, 20n).slice(0, 27);
    const parsed = parseDlmmSwap2Args(Uint8Array.from(payload));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.detail).toContain('truncated');
  });

  it('rejects any trailing byte instead of ignoring it', () => {
    const parsed = parseDlmmSwap2Args(Uint8Array.from([...swap2Payload(10n, 20n), 0x00]));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.detail).toContain('trailing');
  });

  it('rejects a slice list that does not fit', () => {
    const withSliceCount: number[] = [...swap2Payload(10n, 20n)];
    withSliceCount[24] = 1; // one slice declared, no slice bytes present
    const parsed = parseDlmmSwap2Args(Uint8Array.from(withSliceCount));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.detail).toContain('only 0 byte(s) remain');
  });

  it('has no discriminator when there are fewer than 8 bytes', () => {
    expect(instructionDiscriminator(Uint8Array.from([1, 2, 3]))).toBeNull();
    expect(instructionDiscriminator(Uint8Array.from([]))).toBeNull();
  });
});
