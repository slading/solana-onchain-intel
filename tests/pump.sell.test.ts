/**
 * The pump_amm surface itself: program id, discriminator, arguments, account roles.
 *
 * Bytes and tables only — the transaction-level claims live in
 * `pump.fixtures.test.ts` and `pump.adversarial.test.ts`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PUMP_AMM_BUY_DISCRIMINATOR,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SELL_ACCOUNT_ROLES,
  PUMP_AMM_SELL_DISCRIMINATOR,
  parsePumpSellArgs,
} from '../src/swap/pump.ts';
import { instructionDiscriminator } from '../src/swap/dlmm.ts';
import { bytesOfData } from './helpers/swaps.ts';
import { instructionAt, pumpFixture, pumpSellPayload } from './helpers/pump.ts';

/** The 21 roles exactly as `pump-fun/pump-public-docs` → `idl/pump_amm.json` declares them. */
const IDL_ROLES = [
  'pool',
  'user',
  'global_config',
  'base_mint',
  'quote_mint',
  'user_base_token_account',
  'user_quote_token_account',
  'pool_base_token_account',
  'pool_quote_token_account',
  'protocol_fee_recipient',
  'protocol_fee_recipient_token_account',
  'base_token_program',
  'quote_token_program',
  'system_program',
  'associated_token_program',
  'event_authority',
  'program',
  'coin_creator_vault_ata',
  'coin_creator_vault_authority',
  'fee_config',
  'fee_program',
];

describe('authoritative pump_amm surface', () => {
  it('matches the vendor program id', () => {
    expect(PUMP_AMM_PROGRAM_ID).toBe('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  });

  it('derives the sell discriminator from the program source, not from an observation', () => {
    const derived = createHash('sha256').update('global:sell').digest('hex').slice(0, 16);
    expect(derived).toBe(PUMP_AMM_SELL_DISCRIMINATOR);
    expect(PUMP_AMM_SELL_DISCRIMINATOR).toBe('33e685a4017f83ad');
  });

  it('records the buy discriminator without ever recognizing it', () => {
    // `sha256("global:buy")[..8]`, present only as a guard: the layer must not
    // accept a buy as a sell.
    expect(createHash('sha256').update('global:buy').digest('hex').slice(0, 16)).toBe(
      PUMP_AMM_BUY_DISCRIMINATOR,
    );
    expect(PUMP_AMM_BUY_DISCRIMINATOR).toBe('66063d1201daebea');
    expect(PUMP_AMM_BUY_DISCRIMINATOR).not.toBe(PUMP_AMM_SELL_DISCRIMINATOR);
  });

  it('lists the account roles in the IDL order', () => {
    expect([...PUMP_AMM_SELL_ACCOUNT_ROLES]).toEqual(IDL_ROLES);
    expect(PUMP_AMM_SELL_ACCOUNT_ROLES).toHaveLength(21);
  });
});

describe('sell argument parsing', () => {
  it('reads both real instructions with exact byte consumption', () => {
    const direct = pumpFixture('token-mixed-closeAccount');
    const routed = pumpFixture('v0-success-swap');
    const expectations: readonly (readonly [string, number | null, number, bigint, bigint])[] = [
      ['token-mixed-closeAccount', null, 7, 185_356n, 171_510_690n],
      ['v0-success-swap', 3, 0, 2_729_270_725_642n, 0n],
    ];
    for (const [name, outerIndex, index, baseAmountIn, minQuoteAmountOut] of expectations) {
      const fixture = name === 'token-mixed-closeAccount' ? direct : routed;
      const instruction = instructionAt(fixture.transaction, outerIndex, index);
      expect(instruction, `${name} [${outerIndex ?? 'top'}.${index}]`).toBeDefined();
      const bytes = bytesOfData(instruction?.data ?? '');
      expect(bytes.length).toBe(24);
      expect(instructionDiscriminator(bytes)).toBe(PUMP_AMM_SELL_DISCRIMINATOR);

      const parsed = parsePumpSellArgs(bytes);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('unreachable');
      expect(parsed.args.baseAmountIn).toBe(baseAmountIn);
      expect(parsed.args.minQuoteAmountOut).toBe(minQuoteAmountOut);
      expect(parsed.args.consumedBytes).toBe(bytes.length);
    }
  });

  it('rejects a truncated argument', () => {
    const parsed = parsePumpSellArgs(Uint8Array.from(pumpSellPayload(10n, 20n).slice(0, 20)));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.detail).toContain('min_quote_amount_out (u64) is truncated');
  });

  it('rejects a payload that stops after the discriminator', () => {
    const parsed = parsePumpSellArgs(Uint8Array.from(pumpSellPayload(10n, 20n).slice(0, 8)));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.detail).toContain('base_amount_in (u64) is truncated');
  });

  it('rejects any trailing byte instead of ignoring it', () => {
    const parsed = parsePumpSellArgs(Uint8Array.from([...pumpSellPayload(10n, 20n), 0x00]));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.detail).toContain('trailing');
  });

  it('carries the u64 range without losing a unit', () => {
    const max = parsePumpSellArgs(Uint8Array.from(pumpSellPayload(18_446_744_073_709_551_615n, 18_446_744_073_709_551_615n)));
    expect(max.ok).toBe(true);
    if (!max.ok) throw new Error('unreachable');
    expect(max.args.baseAmountIn).toBe(18_446_744_073_709_551_615n);
    expect(max.args.minQuoteAmountOut).toBe(18_446_744_073_709_551_615n);
    const zero = parsePumpSellArgs(Uint8Array.from(pumpSellPayload(0n, 0n)));
    expect(zero.ok).toBe(true);
    if (!zero.ok) throw new Error('unreachable');
    expect(zero.args.baseAmountIn).toBe(0n);
  });
});
