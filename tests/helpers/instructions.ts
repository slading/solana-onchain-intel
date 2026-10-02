/**
 * Spec-derived instruction vectors for the decoder tests.
 *
 * These are NOT harvested from mainnet (unlike `fixtures/*.json`): they are
 * constructed from the documented wire formats so that every target action can be
 * exercised, including the ones mainnet samples happened not to contain
 * (`mintTo`, `burnChecked`, …). See `src/decode/*.ts` for the source references.
 *
 *   SPL Token: u8 tag | u64 amount LE | (u8 decimals for *Checked)
 *   System:    u32 tag LE | u64 let me... (bincode) | owner[32]
 *   ATA:       u8 tag, or empty data for Create
 */
import { getBase58Decoder, getBase58Encoder } from '@solana/kit';
import type { NormalizedInstruction } from '../../src/model/transaction.ts';

export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** Distinct, checksum-free-but-realistic addresses for role assertions. */
export const ACC = {
  funding: 'E5JXp4obkiAcYNf1noBJyYkqJSdwnreBfYaX7vPbYTir',
  recipient: '9ZdioytXTTXK11dbvZK1Q3SzwDLrB9vFEEMKkaziXTgE',
  source: 'CLD7C8D2yiwCpGQ8e2HvcVwVti8Puc22wXYLqn6EruTt',
  destination: '7TfuBFyQimYhPbZLt8VAXaqhFXSzRqkscJHzXcamThcH',
  authority: '31eCTC8W3VcX7BiFwK2o5Ax41FPi2UyHcehcy2Gd3H5h',
  mint: '9pJWJdpPebyANys45eetpemLJo8yTz4n5B9zbpYw9ZMr',
  other: 'Cr5vxXJTC4vu8PraDANEGLfE1YStzQo8JHYJ7K8qqAeh',
} as const;

export function b58(bytes: readonly number[] | Uint8Array): string {
  return getBase58Decoder().decode(Uint8Array.from(bytes));
}

export function bytesOf(address: string): number[] {
  return [...getBase58Encoder().encode(address)];
}

/** u64 -> 8 little-endian bytes, exact. */
export function u64le(value: bigint): number[] {
  const out: number[] = [];
  let rest = value;
  for (let index = 0; index < 8; index += 1) {
    out.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return out;
}

/** u32 -> 4 little-endian bytes (bincode enum discriminant). */
export function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

/* ------------------------------------------------------------------ SPL Token */

export const splToken = {
  transfer: (amount: bigint): number[] => [3, ...u64le(amount)],
  approve: (amount: bigint): number[] => [4, ...u64le(amount)],
  revoke: (): number[] => [5],
  mintTo: (amount: bigint): number[] => [7, ...u64le(amount)],
  burn: (amount: bigint): number[] => [8, ...u64le(amount)],
  closeAccount: (): number[] => [9],
  transferChecked: (amount: bigint, decimals: number): number[] => [12, ...u64le(amount), decimals],
  mintToChecked: (amount: bigint, decimals: number): number[] => [14, ...u64le(amount), decimals],
  burnChecked: (amount: bigint, decimals: number): number[] => [15, ...u64le(amount), decimals],
  /** Recognized instruction we deliberately do not decode. */
  setAuthority: (): number[] => [6, 0, 0],
};

/* ------------------------------------------------------------------- System */

export const system = {
  transfer: (lamports: bigint): number[] => [...u32le(2), ...u64le(lamports)],
  createAccount: (lamports: bigint, space: bigint, owner: string): number[] => [
    ...u32le(0),
    ...u64le(lamports),
    ...u64le(space),
    ...bytesOf(owner),
  ],
  /** Recognized instruction we deliberately do not decode. */
  assign: (owner: string): number[] => [...u32le(1), ...bytesOf(owner)],
};

/* ------------------------------- Associated Token Account ---------------- */

export const ata = {
  create: (): number[] => [],
  createIdempotent: (): number[] => [1],
  /** Recognized instruction we deliberately do not decode. */
  recoverNested: (): number[] => [2],
};

/* ----------------------------------------------------- normalized instructions */

let position = 0;

/** An instruction as the RPC reports one it could not parse: accounts + base58 data. */
export function rawInstruction(
  programId: string | null,
  dataBytes: readonly number[],
  accounts: readonly string[] = [],
  overrides: Partial<NormalizedInstruction> = {},
): NormalizedInstruction {
  position += 1;
  return {
    index: overrides.index ?? 0,
    outerIndex: overrides.outerIndex ?? null,
    programId,
    programName: null,
    parsedType: null,
    parsedInfo: null,
    accounts,
    data: b58(dataBytes),
    dataEncoding: 'base58',
    stackHeight: overrides.stackHeight ?? 1,
    decoding: 'rpc-partially-decoded',
    ...overrides,
  };
}

/** An instruction as the RPC reports one it parsed. */
export function parsedInstruction(
  programId: string | null,
  programName: string | null,
  parsedType: string,
  parsedInfo: unknown,
  overrides: Partial<NormalizedInstruction> = {},
): NormalizedInstruction {
  position += 1;
  return {
    index: overrides.index ?? 0,
    outerIndex: overrides.outerIndex ?? null,
    programId,
    programName,
    parsedType,
    parsedInfo,
    accounts: null,
    data: null,
    dataEncoding: 'base58',
    stackHeight: overrides.stackHeight ?? 1,
    decoding: 'rpc-parsed',
    ...overrides,
  };
}

/** Unique-but-stable instruction counter, kept for debuggability only. */
export function instructionCounter(): number {
  return position;
}
