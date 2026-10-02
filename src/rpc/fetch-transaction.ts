import { assertIsSignature, isSolanaError } from '@solana/kit';
import type { NormalizedProvenance } from '../model/transaction.ts';
import { TRANSACTION_REQUEST, type CommitmentLevel } from './client.ts';

export class TransactionFetchError extends Error {
  public override readonly name = 'TransactionFetchError';
  public readonly hint: string | null;

  constructor(message: string, hint: string | null = null) {
    super(message);
    this.hint = hint;
  }
}

export interface FetchedTransaction {
  /** The exact `getTransaction` result object. */
  readonly raw: unknown;
  /** What we asked for, so a saved dump can be reproduced. */
  readonly provenance: NormalizedProvenance;
}

interface RpcLike {
  getTransaction(
    signature: string,
    config: Record<string, unknown>,
  ): { send(): Promise<unknown> };
}

/**
 * Fetches a transaction by signature.
 *
 * Returns `null` when the RPC knows nothing about the signature. That is a real
 * outcome, not an error: an unknown signature, a transaction dropped from the
 * ledger, or one older than what the node retains all look the same from here —
 * so we report "not found" and never guess which of those it was.
 */
export async function fetchTransaction(
  rpc: RpcLike,
  signature: string,
  options: { readonly rpcEndpoint: string; readonly commitment: CommitmentLevel },
): Promise<FetchedTransaction | null> {
  assertIsSignature(signature);

  const provenance: NormalizedProvenance = {
    rpcEndpoint: options.rpcEndpoint,
    encoding: TRANSACTION_REQUEST.encoding,
    commitment: options.commitment,
    maxSupportedTransactionVersion: TRANSACTION_REQUEST.maxSupportedTransactionVersion,
  };

  let result: unknown;
  try {
    result = await rpc
      .getTransaction(signature, {
        commitment: options.commitment,
        encoding: TRANSACTION_REQUEST.encoding,
        maxSupportedTransactionVersion: TRANSACTION_REQUEST.maxSupportedTransactionVersion,
      })
      .send();
  } catch (error) {
    throw toFetchError(error, options.rpcEndpoint);
  }

  if (result === null || result === undefined) return null;
  return { raw: result, provenance };
}

function toFetchError(error: unknown, endpoint: string): TransactionFetchError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('429')) {
    return new TransactionFetchError(
      `RPC endpoint rate limited the request (429).`,
      `${endpoint} throttles getTransaction aggressively. Point --rpc / SOLANA_RPC_URL at your own node.`,
    );
  }
  if (isSolanaError(error)) {
    const code = (error as { context?: { __code?: number } }).context?.__code;
    return new TransactionFetchError(
      `Solana RPC error${code === undefined ? '' : ` (code ${code})`}: ${message}`,
      'If this mentions an unsupported transaction version, the node cannot serve v1 transactions.',
    );
  }
  return new TransactionFetchError(`Failed to fetch the transaction: ${message}`);
}
