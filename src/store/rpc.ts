/**
 * The RPC boundary of the corpus store (Milestone 5.1).
 *
 * The store reuses the frozen single-transaction fetch (`src/rpc/fetch-transaction.ts`)
 * and adds exactly one thing: the signature *page* call that bounded address ingestion
 * needs. Both are expressed as the same injectable `{ method(...): { send() } }` shape the
 * existing layer uses, so every storage test runs against a fake with no network at all.
 */

import { asBigIntLike, asRecord, asString } from '../lib/read-json.ts';

/** The `getTransaction` half of an RPC client (structurally matches the frozen interface). */
export interface TransactionRpcLike {
  getTransaction(
    signature: string,
    config: Record<string, unknown>,
  ): { send(): Promise<unknown> };
}

/** The `getSignaturesForAddress` half. */
export interface SignaturesRpcLike {
  getSignaturesForAddress(
    address: string,
    config: Record<string, unknown>,
  ): { send(): Promise<unknown> };
}

/** What address ingestion needs: both halves. */
export interface CorpusRpcLike extends TransactionRpcLike, SignaturesRpcLike {}

/** The page call returned a shape we do not recognize. */
export class SignaturePageError extends Error {
  public override readonly name = 'SignaturePageError';
}

/** One entry of a signature page, reduced to what the store uses. */
export interface SignaturePageEntry {
  readonly signature: string;
  /** Slot the signature was observed in, exact. `null` when the node omitted it. */
  readonly slot: bigint | null;
}

/**
 * Fetches one page of signatures, newest first.
 *
 * `before` is exclusive (the RPC returns history strictly older than that signature), which
 * is what makes the cursor in `ingest_cursors` safe to advance one handled signature at a
 * time: a signature we did not persist is never stepped over.
 *
 * An unrecognized response shape is an error rather than an empty page — "no history" and
 * "the node answered something else" must never look the same to an ingestion loop.
 */
export async function fetchSignaturePage(
  rpc: SignaturesRpcLike,
  address: string,
  options: { readonly limit: number; readonly before: string | null },
): Promise<readonly SignaturePageEntry[]> {
  const config: Record<string, unknown> = { limit: options.limit };
  if (options.before !== null) config['before'] = options.before;

  const response = await rpc.getSignaturesForAddress(address, config).send();
  if (!Array.isArray(response)) {
    throw new SignaturePageError(
      `getSignaturesForAddress returned ${response === null ? 'null' : typeof response} instead of a list of signatures`,
    );
  }

  const entries: SignaturePageEntry[] = [];
  for (const item of response) {
    const record = asRecord(item);
    const signature = record === null ? null : asString(record['signature']);
    if (record === null || signature === null) {
      throw new SignaturePageError('a signature page entry has no signature');
    }
    entries.push({ signature, slot: asBigIntLike(record['slot']) });
  }
  return entries;
}

/**
 * Whether re-issuing the same request could plausibly succeed.
 *
 * The frozen fetch layer already classifies its own failures; this only decides whether the
 * classification is "try again later" (rate limits, transport) or "this request itself is
 * wrong" (an unsupported transaction version). An unrecognized error is treated as
 * retryable, because losing a transaction to an unknown error would be worse than
 * re-fetching one.
 */
export function isRetryableFetchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const hint = (error as { hint?: unknown }).hint;
  const text = `${message} ${typeof hint === 'string' ? hint : ''}`;
  return /429|rate.?limit|too many requests|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(
    text,
  );
}
