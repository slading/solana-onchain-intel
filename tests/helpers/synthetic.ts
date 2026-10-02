/**
 * Builder for hand-written `getTransaction` results.
 *
 * Real fixtures cover the common shapes; these synthetic payloads cover the
 * awkward ones (missing metadata, unrecorded inner instructions, token accounts
 * created or closed mid-transaction, indices out of range) that are hard to find
 * on mainnet and trivial to construct.
 */
export interface SyntheticParts {
  slot?: unknown;
  blockTime?: unknown;
  version?: unknown;
  signatures?: readonly string[];
  accountKeys?: readonly unknown[];
  instructions?: readonly unknown[];
  recentBlockhash?: unknown;
  meta?: unknown;
  transactionConfig?: unknown;
}

const DEFAULT_META = {
  err: null,
  fee: 5000,
  computeUnitsConsumed: 1500,
  preBalances: [1_000_000_000, 0],
  postBalances: [999_995_000, 0],
  preTokenBalances: [],
  postTokenBalances: [],
  innerInstructions: [],
  logMessages: ['Program 11111111111111111111111111111111 invoke [1]'],
};

export const ACCOUNT_A = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ACCOUNT_B = 'So11111111111111111111111111111111111111112';

export function syntheticTransaction(parts: SyntheticParts = {}): Record<string, unknown> {
  const message: Record<string, unknown> = {
    accountKeys:
      parts.accountKeys ??
      [
        { pubkey: ACCOUNT_A, signer: true, writable: true, source: 'transaction' },
        { pubkey: ACCOUNT_B, signer: false, writable: true, source: 'transaction' },
      ],
    instructions: parts.instructions ?? [],
    recentBlockhash: parts.recentBlockhash ?? 'BH1111111111111111111111111111111111111111',
  };
  if (parts.transactionConfig !== undefined) message['transactionConfig'] = parts.transactionConfig;

  return {
    slot: parts.slot ?? 100,
    blockTime: parts.blockTime === undefined ? 1_700_000_000 : parts.blockTime,
    version: parts.version === undefined ? 'legacy' : parts.version,
    transaction: {
      signatures: parts.signatures ?? ['5' + 'x'.repeat(63)],
      message,
    },
    meta: parts.meta === undefined ? DEFAULT_META : parts.meta,
  };
}

/** A partially-decoded (undecoded) instruction: accounts + raw base58 data. */
export function rawInstruction(programId: string, data = 'AAAA', accounts: readonly string[] = []) {
  return { programId, data, accounts };
}

/** An RPC-parsed instruction. */
export function parsedInstruction(
  programId: string,
  program: string,
  type: string,
  info: Record<string, unknown> = {},
) {
  return { programId, program, parsed: { type, info } };
}

export function meta(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...DEFAULT_META, ...overrides };
}
