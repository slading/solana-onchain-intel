/**
 * The canonical internal transaction model.
 *
 * Design rules (Milestone 1):
 *
 * 1. **Never invent.** Every field is either taken verbatim from the RPC response
 *    or is an explicitly documented derivation (see `feePayerAddress`).
 *    Data the RPC did not provide is `null` — never a default, never a guess.
 * 2. **Unknown stays unknown.** Instructions we do not understand are kept with
 *    their raw program id and raw base58 data, and are marked
 *    `decoding: 'rpc-partially-decoded'`. We never label an instruction's meaning
 *    ourselves.
 * 3. **Raw is always reachable.** `NormalizedTransaction.raw` holds the exact
 *    `getTransaction` result object this model was built from.
 * 4. **Semantics are derived, not re-read.** `decoded` holds the Milestone 2
 *    action layer, computed from the normalized instructions alone (see
 *    `src/decode/`). It is part of the model so that rendering and any later
 *    consumer share one interpretation, but it is always derived from
 *    `instructions` — never from balances, logs or the raw payload.
 * 5. **Deterministic output.** All collections have a defined order (see each
 *    field), so two runs over the same response render identical text.
 */

import type { DecodedTransaction } from '../decode/actions.ts';

/**
 * The transaction version as reported by the RPC.
 *
 * Kept as a discriminated union rather than a string so that a future version
 * (e.g. v2) is representable without us inventing behaviour for it.
 */
export type NormalizedTransactionVersion =
  | { readonly kind: 'legacy' }
  | { readonly kind: 'numbered'; readonly value: number }
  | { readonly kind: 'unknown' };

/** Where an account in the transaction's account list came from. */
export type AccountSource = 'transaction' | 'lookupTable';

/**
 * One entry of the transaction's ordered account list (`message.accountKeys`).
 *
 * The list is *ordered and index-aligned* with:
 *  - `signatures[i]` for signing accounts,
 *  - `meta.preBalances` / `meta.postBalances`,
 *  - `meta.preTokenBalances[].accountIndex` / `meta.postTokenBalances[].accountIndex`.
 *
 * `signer`, `writable` and `source` are `null` when the RPC did not report them
 * (they always are reported for the `jsonParsed` encoding we request).
 */
export interface NormalizedAccount {
  readonly index: number;
  readonly address: string;
  readonly signer: boolean | null;
  readonly writable: boolean | null;
  readonly source: AccountSource | null;
}

/** How much of an instruction we actually understand. */
export type InstructionDecoding =
  /** The RPC's program-specific parser recognised the instruction (`parsed` block present). */
  | 'rpc-parsed'
  /** The RPC returned accounts + raw data only. Meaning is UNKNOWN to us. */
  | 'rpc-partially-decoded'
  /** The RPC returned neither a parsed block nor accounts/data. */
  | 'unrecognized-shape';

/**
 * A single instruction, either top-level (`message.instructions`) or an inner
 * CPI instruction (`meta.innerInstructions[].instructions`).
 *
 * `data` is base58 because that is exactly what the RPC sends for non-parsed
 * instructions. We do not decode it: decoding is `getTransaction`'s job
 * (`jsonParsed`) and anything it declined to decode is left undecoded.
 */
export interface NormalizedInstruction {
  /** Position within its own list (top-level instruction index, or index within its group). */
  readonly index: number;
  /** For inner instructions: the top-level instruction that made the CPI. `null` for top-level. */
  readonly outerIndex: number | null;
  /** Always present: the program being invoked. */
  readonly programId: string | null;
  /** Program label reported by the RPC parser (e.g. `system`, `spl-token`). `null` when unparsed. */
  readonly programName: string | null;
  /** Instruction type reported by the RPC parser. `null` when unparsed — never inferred by us. */
  readonly parsedType: string | null;
  /** Parsed body exactly as returned by the RPC. Its shape is owned by the RPC's parser. */
  readonly parsedInfo: unknown | null;
  /** Resolved account addresses, when the RPC supplied them. `null` for parsed instructions. */
  readonly accounts: readonly string[] | null;
  /** Raw instruction data, base58, verbatim. `null` for parsed instructions. */
  readonly data: string | null;
  readonly dataEncoding: 'base58';
  /** CPI depth as reported by the RPC (1 = top level). */
  readonly stackHeight: number | null;
  readonly decoding: InstructionDecoding;
}

/** Inner instructions grouped by the top-level instruction that invoked them. */
export interface NormalizedInnerInstructionGroup {
  /** Index into `NormalizedTransaction.instructions` that made these CPIs. */
  readonly outerIndex: number;
  /** In the order the RPC reported them, which is execution order. */
  readonly instructions: readonly NormalizedInstruction[];
  /** `true` when `outerIndex` does not point at any top-level instruction (defensive check). */
  readonly outerIndexOutOfRange: boolean;
}

export interface NormalizedSolBalanceChange {
  readonly accountIndex: number;
  /** Address resolved through `accounts[accountIndex]`, or `null` when the index is out of range. */
  readonly address: string | null;
  readonly beforeLamports: bigint | null;
  readonly afterLamports: bigint | null;
  /** `after - before` in lamports, or `null` if either side is unknown. Includes fees. */
  readonly deltaLamports: bigint | null;
}

/**
 * A token balance change for one (token account, mint) pair.
 *
 * `before`/`after` are raw integer amounts as decimal strings, which is exactly
 * what the RPC reports (`uiTokenAmount.amount`). `deltaAmount` is only computed
 * when both sides are known; a token account created during the transaction has
 * no `before` entry and therefore no delta. We do not assume it started at zero.
 */
export interface NormalizedTokenBalanceChange {
  readonly accountIndex: number;
  /** The token account address, or `null` when the index is out of range. */
  readonly address: string | null;
  readonly mint: string | null;
  readonly owner: string | null;
  readonly programId: string | null;
  readonly decimals: number | null;
  readonly beforeAmount: bigint | null;
  readonly afterAmount: bigint | null;
  readonly deltaAmount: bigint | null;
  /** As reported by the RPC; we do not reformat amounts ourselves. */
  readonly beforeUiAmountString: string | null;
  readonly afterUiAmountString: string | null;
  /** Which side(s) the RPC reported. `only-after` = token account created in this tx. */
  readonly presence: 'both' | 'only-before' | 'only-after';
}

export type DiagnosticLevel = 'info' | 'warning';

/**
 * A factual note about the response: something missing, out of range, or
 * inconsistent. Diagnostics are how "we don't know" becomes visible instead of
 * being silently defaulted.
 */
export interface NormalizedDiagnostic {
  readonly level: DiagnosticLevel;
  readonly code: string;
  readonly message: string;
}

/** How the transaction was requested; kept for reproducibility of a dump. */
export interface NormalizedProvenance {
  readonly rpcEndpoint: string;
  readonly encoding: 'jsonParsed';
  readonly commitment: 'processed' | 'confirmed' | 'finalized';
  readonly maxSupportedTransactionVersion: 0 | 1 | null;
}

export interface NormalizedTransaction {
  /** Transaction id: `transaction.signatures[0]`. */
  readonly signature: string;
  /** Every signature on the transaction, in wire order. */
  readonly signatures: readonly string[];
  readonly slot: bigint;
  /** Unix seconds, or `null` when the RPC has no block time for this slot. */
  readonly blockTimeUnix: number | null;
  readonly version: NormalizedTransactionVersion;
  /** `unknown` when metadata is absent, because success is derived from `meta.err`. */
  readonly status: 'success' | 'failed' | 'unknown';
  /** `meta.err` verbatim. `null` means success (when status is known). */
  readonly error: unknown | null;
  readonly feeLamports: bigint | null;
  /** `meta.computeUnitsConsumed`, or `null` when not reported. */
  readonly computeUnitsConsumed: bigint | null;
  /** `meta.costUnits` (newer Agave nodes), or `null` when not reported. */
  readonly costUnits: bigint | null;
  /** `null` only if the RPC omitted it; always present for real responses. */
  readonly recentBlockhash: string | null;
  /**
   * Positional per the Solana message format: the fee payer is always the first
   * account, which is also the first signer. Derived, not sent by the RPC.
   */
  readonly feePayerAddress: string | null;

  /** Account list order == on-chain index order. Never re-sorted. */
  readonly accounts: readonly NormalizedAccount[];
  /** Addresses with `signer === true`, in account order. `null` if the RPC omitted signer flags. */
  readonly signers: readonly string[] | null;

  /** Top-level instructions, in execution order. */
  readonly instructions: readonly NormalizedInstruction[];
  /** Inner instructions, ordered by `outerIndex` ascending as reported. */
  readonly innerInstructionGroups: readonly NormalizedInnerInstructionGroup[];
  /**
   * `false` when `meta.innerInstructions` was `null`, i.e. the node has CPI
   * recording disabled. An empty array then means "not recorded", not "no CPIs".
   */
  readonly innerInstructionsAvailable: boolean;

  /** Program logs. `null` = the RPC did not provide logs; `[]` = the program logged nothing. */
  readonly logs: readonly string[] | null;

  /** Ordered by `accountIndex` ascending. */
  readonly solBalanceChanges: readonly NormalizedSolBalanceChange[];
  /**
   * Ordered by (`accountIndex`, `mint`) so the output does not depend on the
   * order the RPC happened to use.
   */
  readonly tokenBalanceChanges: readonly NormalizedTokenBalanceChange[];
  /** `false` when the RPC omitted token balance data entirely — empty is not "no changes". */
  readonly tokenBalancesAvailable: boolean;

  /** v1-only message resource limits, preserved verbatim. `null` for legacy/v0. */
  readonly transactionConfig: unknown | null;

  readonly diagnostics: readonly NormalizedDiagnostic[];
  readonly provenance: NormalizedProvenance;

  /**
   * Semantic actions decoded from the instructions above (Milestone 2).
   * Derived purely from `instructions`; instructional data only, never balances.
   */
  readonly decoded: DecodedTransaction;

  /** The exact `getTransaction` result this model was built from. */
  readonly raw: unknown;
}
