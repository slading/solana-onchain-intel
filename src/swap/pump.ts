/**
 * The authoritative pump_amm surface this layer is built from.
 *
 * Source: `pump-fun/pump-public-docs`, file `idl/pump_amm.json` — fetched and then
 * verified byte-for-byte against two real transactions during the Milestone 4
 * discovery (see the discovery report §C.2/§F.2 and its evidence pack). Nothing
 * here is transcribed from an observed transaction.
 *
 *   program id  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 *   sell        discriminator 33e685a4017f83ad  (= sha256("global:sell")[..8])
 *               args: base_amount_in u64 | min_quote_amount_out u64
 *               21 named accounts, then the caller's remaining accounts
 *
 * The direction is the instruction's own name: `sell` moves base in and quote out,
 * which is a statement about the pool, not a claim about the market. `buy`
 * (discriminator 66063d1201daebea) is deliberately **not** transcribed: pump buys
 * are out of scope for 4.2, and a discriminator this file does not contain can
 * never be mistaken for a sell.
 *
 * The tail accounts are counted and never named. In the two real calls they hold
 * `[BuybackVault, BuybackVault's quote ATA]` (direct) and
 * `[an address where no account exists at all, BuybackVault, its WSOL ATA]`
 * (routed) — the length and order are not stable, so no proof may depend on them.
 */

import { readU64LE, type Bytes } from '../decode/bytes.ts';

export const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** 8-byte instruction discriminator of `sell`, lower-case hex. */
export const PUMP_AMM_SELL_DISCRIMINATOR = '33e685a4017f83ad';

/** `buy` — recognized by nobody in this milestone; recorded here only as a guard. */
export const PUMP_AMM_BUY_DISCRIMINATOR = '66063d1201daebea';

/**
 * The 21 account roles of `sell`, in the order the IDL declares them.
 *
 * The first 21 slots were verified against both fixtures by name, owning program
 * and Anchor account discriminator (`Pool`, `GlobalConfig`, `FeeConfig`,
 * that pool's mints and vaults, the user's two token accounts, the event
 * authority PDA). Roles beyond these 21 exist only in the caller's remaining
 * accounts and are never used as evidence.
 */
export const PUMP_AMM_SELL_ACCOUNT_ROLES = [
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
] as const;

export type PumpSellRole = (typeof PUMP_AMM_SELL_ACCOUNT_ROLES)[number];

export interface PumpSellArgs {
  readonly baseAmountIn: bigint;
  readonly minQuoteAmountOut: bigint;
  /** Bytes consumed by the arguments; always the whole payload when `ok`. */
  readonly consumedBytes: number;
}

export type PumpSellArgParse =
  | { readonly ok: true; readonly args: PumpSellArgs }
  | { readonly ok: false; readonly detail: string };

/**
 * Parses a `sell` payload (everything after the 8-byte discriminator).
 *
 * Exact consumption is the point, exactly as for DLMM `swap2`: a truncated `u64`
 * or **any** trailing byte fails the parse instead of being partially read. A
 * future program version that adds an argument therefore degrades to "not
 * recognized", never to a wrong amount.
 */
export function parsePumpSellArgs(bytes: Bytes): PumpSellArgParse {
  const payloadLength = bytes.length - 8;
  const baseAmountIn = readU64LE(bytes, 8);
  if (baseAmountIn === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): base_amount_in (u64) is truncated` };
  }
  const minQuoteAmountOut = readU64LE(bytes, 16);
  if (minQuoteAmountOut === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): min_quote_amount_out (u64) is truncated` };
  }
  if (bytes.length > 24) {
    return { ok: false, detail: `${bytes.length - 24} trailing byte(s) after the arguments` };
  }
  return {
    ok: true,
    args: { baseAmountIn, minQuoteAmountOut, consumedBytes: bytes.length },
  };
}
