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
 *   buy         discriminator 66063d1201daebea  (= sha256("global:buy")[..8])
 *               args: base_amount_out u64 | max_quote_amount_in u64 | track_volume OptionBool
 *               23 named accounts, then the caller's remaining accounts
 *
 * The direction is the instruction's own name: `sell` moves base in and quote out,
 * `buy` moves quote in and base out — statements about the pool, not claims about
 * the market.
 *
 * `buy`'s third argument is the one place the real chain disagrees with a flat
 * reading of the IDL: **both** a 24-byte payload (no third argument) and a 25-byte
 * payload (trailing `OptionBool` byte, `0x00` or `0x01`) are accepted by the live
 * program, in the same slot (M4.3 discovery §1.4). The two forms are therefore one
 * instruction with a recorded variant, not two instructions, and *why* the byte may
 * be absent is unknown — so the absence is never given meaning here.
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

/** `buy` — recognized by Milestone 4.3 (see `PUMP_AMM_BUY_ACCOUNT_ROLES` below). */
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

/**
 * The 23 account roles of `buy`, in the order the IDL declares them.
 *
 * `buy` is `sell`'s first 19 roles verbatim, followed by the two volume
 * accumulators and then `fee_config`/`fee_program` — nothing is reordered and
 * nothing is dropped. The recognizer reads the slots it needs by name; the two
 * fee destinations are named only so an outflow can be classified as something
 * other than the payment into the pool's quote vault.
 */
export const PUMP_AMM_BUY_ACCOUNT_ROLES = [
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
  'global_volume_accumulator',
  'user_volume_accumulator',
  'fee_config',
  'fee_program',
] as const;

export type PumpBuyRole = (typeof PUMP_AMM_BUY_ACCOUNT_ROLES)[number];

/**
 * The trailing `OptionBool` byte of a `buy` payload, recorded verbatim.
 *
 * `'absent'` is the 24-byte form. The byte is *recorded* and never used as
 * evidence: the program accepts both forms (M4.3 discovery §1.4), so the wire
 * shape is a variant of one instruction, not a semantic flag this layer can read.
 */
export type PumpBuyTrackVolume = 'absent' | '0x00' | '0x01';

export interface PumpBuyArgs {
  readonly baseAmountOut: bigint;
  readonly maxQuoteAmountIn: bigint;
  readonly trackVolumeByte: PumpBuyTrackVolume;
  /** Bytes consumed by the arguments; always the whole payload when `ok`. */
  readonly consumedBytes: number;
}

export type PumpBuyArgParse =
  | { readonly ok: true; readonly args: PumpBuyArgs }
  | { readonly ok: false; readonly detail: string };

/**
 * Parses a `buy` payload (everything after the 8-byte discriminator).
 *
 * Exact consumption is enforced as the two forms the chain actually carries:
 *
 *   * 24 bytes — the two `u64` arguments, no third argument;
 *   * 25 bytes — the two `u64` arguments plus a trailing byte that must be
 *     `0x00` or `0x01` (the IDL's `OptionBool`);
 *
 * and nothing else. A truncated `u64`, an invalid trailing byte, or any further
 * byte fails the parse instead of being partially read, so a future program
 * version degrades to "not recognized", never to a wrong amount.
 */
export function parsePumpBuyArgs(bytes: Bytes): PumpBuyArgParse {
  const payloadLength = bytes.length - 8;
  const baseAmountOut = readU64LE(bytes, 8);
  if (baseAmountOut === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): base_amount_out (u64) is truncated` };
  }
  const maxQuoteAmountIn = readU64LE(bytes, 16);
  if (maxQuoteAmountIn === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): max_quote_amount_in (u64) is truncated` };
  }
  if (bytes.length === 24) {
    return {
      ok: true,
      args: { baseAmountOut, maxQuoteAmountIn, trackVolumeByte: 'absent', consumedBytes: bytes.length },
    };
  }
  if (bytes.length === 25) {
    const trailing = bytes[24] ?? null;
    if (trailing !== 0x00 && trailing !== 0x01) {
      return {
        ok: false,
        detail:
          `25 payload byte(s): the trailing OptionBool byte is ` +
          `${trailing === null ? 'missing' : `0x${trailing.toString(16).padStart(2, '0')}`}, not 0x00 or 0x01`,
      };
    }
    return {
      ok: true,
      args: {
        baseAmountOut,
        maxQuoteAmountIn,
        trackVolumeByte: trailing === 0x00 ? '0x00' : '0x01',
        consumedBytes: bytes.length,
      },
    };
  }
  return bytes.length > 25
    ? { ok: false, detail: `${bytes.length - 24} trailing byte(s) after the arguments` }
    : { ok: false, detail: `${payloadLength} payload byte(s): the arguments need 24` };
}
