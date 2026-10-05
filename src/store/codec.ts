/**
 * Canonical evidence codec (Milestone 5.1).
 *
 * The two things the corpus store persists — the raw `getTransaction` response and the
 * derived artifacts (normalized / effects / swaps / routes) — both contain `bigint` at
 * runtime (`@solana/kit` upcasts every integer; see `src/lib/read-json.ts`), and both
 * must survive a store round trip **exactly**:
 *
 *  - **the same numeric type**: a `bigint` must come back a `bigint`, a JSON number must
 *    come back a number. The layers read them differently — `asNumber` refuses strings,
 *    `asBigIntLike` accepts numbers, strings and bigints — so a codec that flattened
 *    both into one representation would change what the pipeline derives.
 *  - **the same precision**: Solana amounts exceed 2^53 and are never rounded or floated.
 *  - **the same key order**, so the encoded text is byte-stable and its hash is usable as
 *    an evidence identity (see `raw_sha256` in `src/store/schema.ts`).
 *
 * The rules, and nothing else:
 *
 * ```
 * bigint                      -> {"$solana-bigint":"<exact decimal>"}
 * array                       -> every element encoded, order preserved
 * object without a marker key -> every value encoded, keys in insertion order
 * object with a marker key    -> wrapped in {"$solana-object": …} so real data can
 *                                never be mistaken for a marker
 * string / number / bool/null -> unchanged
 * ```
 *
 * Decoding reverses this exactly and **fails loudly** on a malformed marker rather than
 * guessing: a corrupted artifact has to surface as an error, not as a plausible value.
 *
 * `JSON.stringify` is not used directly anywhere in the store — it throws on `bigint`,
 * and the project's existing `stringifyJson` (src/lib/format.ts) prints bigints as plain
 * decimal strings, which would be indistinguishable from real string data on the way back.
 */

import { createHash } from 'node:crypto';

/** Key that marks an encoded `bigint`. Reserved inside encoded evidence. */
export const BIGINT_MARKER = '$solana-bigint';
/** Key that escapes a real object which happens to use a reserved key. */
export const OBJECT_MARKER = '$solana-object';

/** Reserved keys that force an object to be escaped. */
export const RESERVED_KEYS: readonly string[] = [BIGINT_MARKER, OBJECT_MARKER];

const DECIMAL_PATTERN = /^-?\d+$/;

/** A stored artifact could not be decoded. Always names what was wrong. */
export class EvidenceCodecError extends Error {
  public override readonly name = 'EvidenceCodecError';

  constructor(message: string) {
    super(message);
  }
}

function encodeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { [BIGINT_MARKER]: value.toString() };
  if (value === undefined) {
    throw new EvidenceCodecError(
      'cannot encode undefined: JSON has no representation for it, so a round trip would ' +
        'silently drop the key. Evidence must be explicit.',
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new EvidenceCodecError(
      `cannot encode ${value}: JSON cannot represent it, and null would not round trip.`,
    );
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new EvidenceCodecError(`cannot encode ${typeof value}: only JSON values are storable evidence`);
  }
  if (Array.isArray(value)) return value.map(item => encodeValue(item));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const encoded: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) encoded[key] = encodeValue(entry);
    // A real object that uses a reserved key is escaped, so the marker form can only
    // ever describe what we put there ourselves.
    if (RESERVED_KEYS.some(key => Object.prototype.hasOwnProperty.call(encoded, key))) {
      return { [OBJECT_MARKER]: encoded };
    }
    return encoded;
  }
  return value;
}

/**
 * Encodes a value to canonical text.
 *
 * Deterministic: same value (same key insertion order) -> same bytes. Throws on values
 * JSON cannot represent in a stable way (`undefined`, functions, symbols, cycles).
 */
export function encodeEvidence(value: unknown): string {
  const text = JSON.stringify(encodeValue(value));
  if (text === undefined) {
    throw new EvidenceCodecError(
      `cannot encode ${typeof value}: only JSON-representable values are storable evidence`,
    );
  }
  return text;
}

function decodeValue(value: unknown, interpretMarkers: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => decodeValue(item, true));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (interpretMarkers && keys.length === 1) {
      const only = keys[0];
      if (only === BIGINT_MARKER) {
        const digits = record[BIGINT_MARKER];
        if (typeof digits !== 'string' || !DECIMAL_PATTERN.test(digits)) {
          throw new EvidenceCodecError(
            `${BIGINT_MARKER} must hold an exact decimal string, found ${JSON.stringify(digits)}`,
          );
        }
        return BigInt(digits);
      }
      if (only === OBJECT_MARKER) {
        const inner = record[OBJECT_MARKER];
        if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
          throw new EvidenceCodecError(
            `${OBJECT_MARKER} must hold an object, found ${JSON.stringify(inner)}`,
          );
        }
        // The escaped object's own keys are data again — its children are still decoded.
        return decodeValue(inner, false);
      }
    }
    const decoded: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) decoded[key] = decodeValue(entry, true);
    return decoded;
  }
  return value;
}

/** Decodes canonical text. Throws `EvidenceCodecError` on malformed input or markers. */
export function decodeEvidence(text: string): unknown {
  if (typeof text !== 'string') {
    throw new EvidenceCodecError(`stored evidence must be text, found ${typeof text}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new EvidenceCodecError(
      `stored evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return decodeValue(parsed, true);
}

/** SHA-256 of canonical text, lower-case hex. Used as an evidence identity, not a secret. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
