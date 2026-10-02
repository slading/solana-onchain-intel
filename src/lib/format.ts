/**
 * Deterministic serialization.
 *
 * `JSON.stringify` throws on `bigint`, and locale-aware formatting varies
 * between machines, so both are handled here explicitly.
 */
const LAMPORTS_PER_SOL = 1_000_000_000n;

/** `JSON.stringify`, but `bigint` becomes an exact decimal string. */
export function stringifyJson(value: unknown, indent = 2): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
    indent,
  );
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Exact lamports -> SOL string via integer math (no floats).
 * `12345n` -> `"0.000012345"`, `1_000_000_000n` -> `"1"`.
 */
export function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const fraction = abs % LAMPORTS_PER_SOL;
  const sign = negative ? '-' : '';
  if (fraction === 0n) return `${sign}${whole}`;
  return `${sign}${whole}.${fraction.toString().padStart(9, '0').replace(/0+$/, '')}`;
}

/** Suffix helper so CLI output never shows an ambiguous bare number. */
export function formatLamportsWithSol(lamports: bigint): string {
  return `${formatSol(lamports)} SOL (${lamports} lamports)`;
}

export function formatSigned(value: bigint): string {
  return value >= 0n ? `+${value}` : `${value}`;
}

/** Unix seconds -> ISO-8601 in UTC, or `null` when unavailable. Never local time. */
export function formatUnixSeconds(seconds: number | null): string | null {
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Deterministic string ordering (no locale collation). */
export function compareStrings(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** Right-pads with spaces to a stable width. */
export function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}
