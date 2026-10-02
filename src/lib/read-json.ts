/**
 * Small, dependency-free helpers for reading an untrusted JSON value (an RPC
 * response) without casting and without inventing values.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Reads a JSON number.
 *
 * Must also accept `bigint`: `@solana/kit` upcasts every integer in a response to
 * `bigint` (see `@solana/rpc-transformers`), except for an allow-list of small
 * bounded fields such as `accountIndex`, `decimals` and `stackHeight`. So the
 * same field can legitimately arrive as `bigint` (blockTime) or `number`
 * (stackHeight) depending on where it sits in the tree.
 */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return null;
}

/**
 * Lamports and token amounts arrive as JSON numbers, which are exact only up to
 * 2^53. We accept strings as well and convert to `bigint` so no precision is
 * ever lost, and so two balances can be subtracted exactly.
 */
export function asBigIntLike(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    return Number.isInteger(value) && Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

/** Reads `record[key]` without going through an unchecked index signature. */
export function pick(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Index into a readonly array, returning `undefined` instead of lying. */
export function at<T>(items: readonly T[], index: number): T | undefined {
  return index >= 0 && index < items.length ? items[index] : undefined;
}
