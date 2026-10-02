/**
 * Byte-level readers for instruction data.
 *
 * Everything is bounds-checked: a reader returns `null` rather than throwing or
 * reading past the end, because a truncated payload is a normal outcome for
 * untrusted input and must stay *reportable* rather than fatal.
 */
import { getBase58Decoder, getBase58Encoder, type ReadonlyUint8Array } from '@solana/kit';

/**
 * kit's codecs expose `ReadonlyUint8Array`; we only ever read, so we keep that
 * type rather than copying into a mutable buffer.
 */
export type Bytes = ReadonlyUint8Array;

/**
 * base58 -> bytes. Returns `null` for input that is not valid base58, rather
 * than throwing: the caller turns that into a diagnostic.
 *
 * (`NormalizedInstruction.data` is base58 because that is what the RPC sends for
 * instructions it did not decode; this is the only place it becomes bytes.)
 */
export function decodeBase58Data(data: string): Bytes | null {
  try {
    return getBase58Encoder().encode(data);
  } catch {
    return null;
  }
}

/** 32 bytes -> base58 address. `null` if fewer than 32 bytes remain. */
export function encodeAddress(bytes: Bytes, offset: number): string | null {
  if (offset < 0 || bytes.length - offset < 32) return null;
  try {
    return getBase58Decoder().decode(bytes.subarray(offset, offset + 32));
  } catch {
    return null;
  }
}

/** Unsigned 8-bit integer. */
export function readU8(bytes: Bytes, offset: number): number | null {
  const value = bytes[offset];
  return value === undefined ? null : value;
}

/** Unsigned 32-bit little-endian integer (bincode's enum discriminant width). */
export function readU32LE(bytes: Bytes, offset: number): number | null {
  if (offset < 0 || bytes.length - offset < 4) return null;
  let value = 0;
  for (let index = 3; index >= 0; index -= 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) return null;
    value = value * 256 + byte;
  }
  return value;
}

/** Unsigned 64-bit little-endian integer, exact (no float involved). */
export function readU64LE(bytes: Bytes, offset: number): bigint | null {
  if (offset < 0 || bytes.length - offset < 8) return null;
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) return null;
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * Reads the accounts an instruction documents as positional roles.
 *
 * Missing roles come back as `null` and produce a note — the instruction's
 * *kind* is still proven by its discriminator, so we keep the kind and leave the
 * unreadable roles empty rather than discarding the whole decode.
 *
 * Returns an object keyed by role name so callers can destructure without
 * `undefined` creeping in.
 */
export function takeAccountRoles<K extends string>(
  accounts: readonly string[],
  roleNames: readonly K[],
  notes: string[],
): Record<K, string | null> {
  const roles = {} as Record<K, string | null>;
  roleNames.forEach((name, index) => {
    roles[name] = accounts[index] ?? null;
  });
  if (accounts.length < roleNames.length) {
    notes.push(
      `expected at least ${roleNames.length} account(s) (${roleNames.join(', ')}), ` +
        `found ${accounts.length}; the missing roles are null.`,
    );
  }
  return roles;
}
