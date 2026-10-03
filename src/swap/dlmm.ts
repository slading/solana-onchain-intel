/**
 * The authoritative Meteora DLMM surface this layer is built from.
 *
 * Source: the vendor's own repository `MeteoraAg/dlmm-sdk`, file `idls/dlmm.json`
 * (the `idls/` copy — the `ts-client` copy may carry localnet-adjusted field
 * offsets). It was fetched and verified against real transaction bytes during the
 * Milestone 4 discovery (see the discovery report's evidence pack); nothing here
 * is transcribed from an observed transaction.
 *
 *   program id  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
 *   swap2       discriminator 414b3f4ceb5b5b88  (= sha256("global:swap2")[..8])
 *               args: amount_in u64 | min_amount_out u64 | remaining_accounts_info
 *               16 named accounts, then the caller's remaining accounts (bin arrays)
 *
 * Only the pieces 4.1 needs are transcribed: the discriminator, the argument
 * order, the account role order, and the `RemainingAccountsInfo` shape (which is
 * what makes "exact byte consumption" checkable). The swap *events* are
 * deliberately not used: they are optional for recognition, and a leg must be
 * provable without them.
 */

import { readU32LE, readU64LE, type Bytes } from '../decode/bytes.ts';

export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

/** 8-byte instruction discriminator, lower-case hex. */
export const DLMM_SWAP2_DISCRIMINATOR = '414b3f4ceb5b5b88';

/**
 * The 16 account roles of `swap2`, in the order the IDL declares them.
 *
 * `bin_array_bitmap_extension` and `host_fee_in` are `optional` in the IDL; when
 * the caller passes `null`, the slot holds the DLMM program id itself (observed in
 * both fixture legs). That convention is *not* relied upon for proof — an optional
 * role is simply never used as evidence.
 */
export const DLMM_SWAP2_ACCOUNT_ROLES = [
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
] as const;

export type DlmmSwap2Role = (typeof DLMM_SWAP2_ACCOUNT_ROLES)[number];

export interface DlmmSwap2Args {
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  /** `remaining_accounts_info.slices.length`; the slices themselves are not read. */
  readonly hookSliceCount: number;
  /** Bytes consumed by the arguments; always the whole payload when `ok`. */
  readonly consumedBytes: number;
}

export type DlmmSwap2ArgParse =
  | { readonly ok: true; readonly args: DlmmSwap2Args }
  | { readonly ok: false; readonly detail: string };

/**
 * Parses a `swap2` payload (everything after the 8-byte discriminator).
 *
 * Exact consumption is the point: a truncated `u64`, a slice list that does not
 * fit, or **any** trailing byte fails the parse instead of being partially read.
 * A future program version that adds an argument therefore degrades to "not
 * recognized", never to a wrong amount.
 */
export function parseDlmmSwap2Args(bytes: Bytes): DlmmSwap2ArgParse {
  const payloadLength = bytes.length - 8;
  const amountIn = readU64LE(bytes, 8);
  if (amountIn === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): amount_in (u64) is truncated` };
  }
  const minAmountOut = readU64LE(bytes, 16);
  if (minAmountOut === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): min_amount_out (u64) is truncated` };
  }
  const sliceCount = readU32LE(bytes, 24);
  if (sliceCount === null) {
    return {
      ok: false,
      detail: `${payloadLength} payload byte(s): remaining_accounts_info.slices length (u32) is truncated`,
    };
  }
  // RemainingAccountsSlice = { accounts_type: AccountsType (u8), length: u8 }.
  const SLICE_BYTES = 2;
  const afterSlices = 28 + sliceCount * SLICE_BYTES;
  if (afterSlices > bytes.length) {
    return {
      ok: false,
      detail:
        `remaining_accounts_info declares ${sliceCount} slice(s) (${sliceCount * SLICE_BYTES} byte(s)) ` +
        `but only ${bytes.length - 28} byte(s) remain`,
    };
  }
  if (afterSlices !== bytes.length) {
    return {
      ok: false,
      detail: `${bytes.length - afterSlices} trailing byte(s) after the arguments`,
    };
  }
  return {
    ok: true,
    args: { amountIn, minAmountOut, hookSliceCount: sliceCount, consumedBytes: bytes.length },
  };
}

/** Lower-case hex of the first 8 bytes (the discriminator), or `null` if absent. */
export function instructionDiscriminator(bytes: Bytes): string | null {
  if (bytes.length < 8) return null;
  let hex = '';
  for (let index = 0; index < 8; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) return null;
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
