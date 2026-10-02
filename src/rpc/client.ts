import { createSolanaRpc } from '@solana/kit';

export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

export type CommitmentLevel = 'processed' | 'confirmed' | 'finalized';

/**
 * Request configuration used for every inspection.
 *
 * - `jsonParsed` is the only encoding that returns (a) resolved account lists
 *   with signer/writable/source flags and (b) inner instructions as first-class
 *   objects, while still preserving raw base58 data for instructions the RPC
 *   cannot decode. That combination is what lets us stay honest about unknowns.
 * - `maxSupportedTransactionVersion: 1` accepts legacy, v0 and v1 transactions.
 *   It must be the integer 1: omitting it, or passing 0, makes the node reject
 *   v1 transactions outright (`-32015`), and passing the string "1" fails
 *   request validation on every call.
 */
export const TRANSACTION_REQUEST = {
  encoding: 'jsonParsed',
  maxSupportedTransactionVersion: 1,
} as const;

export function resolveRpcUrl(explicit?: string): string {
  const url = explicit ?? process.env['SOLANA_RPC_URL'] ?? DEFAULT_RPC_URL;
  if (url.trim() === '') throw new Error('RPC URL is empty.');
  return url;
}

export function createRpc(url: string) {
  return createSolanaRpc(url);
}

export function resolveCommitment(explicit?: string): CommitmentLevel {
  const value = explicit ?? process.env['SOLANA_COMMITMENT'] ?? 'confirmed';
  if (value !== 'processed' && value !== 'confirmed' && value !== 'finalized') {
    throw new Error(`Invalid commitment "${value}". Expected processed | confirmed | finalized.`);
  }
  return value;
}
