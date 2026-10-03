/**
 * Milestone 4.1: the swap layer's model.
 *
 * A swap is a claim about *intent*, and this milestone makes that claim only when
 * a program's own instruction semantics prove it. In 4.1 the only recognized
 * program is Meteora DLMM (`lb_clmm`) and the only recognized instruction is
 * `swap2`; the authoritative surface it is matched against lives in `./dlmm.ts`
 * and nothing else is recognized (see the Milestone 4 discovery report for why
 * this target was first and what is deliberately deferred).
 *
 * Design rules:
 *
 * 1. **Semantics, not patterns.** A leg exists because the program id and the
 *    8-byte discriminator match the vendor IDL, the arguments parse with *exact*
 *    byte consumption, the named account roles map onto the IDL's declared order,
 *    and the token movements the AMM itself performs sit inside that
 *    instruction's CPI subtree. One token leaving and another arriving is never
 *    enough — by construction, not by convention.
 * 2. **The effects layer reconciles; it never recognizes.** Transfers are read
 *    from the Milestone 2 actions; the Milestone 3 effects model is then required
 *    to contain *the same* movement, sized by instruction data. Without an
 *    effects model those checks are `not-checkable` and no leg can reach
 *    `proven`.
 * 3. **Nothing is guessed.** Two candidate transfers on one side, a mint that
 *    disagrees with a named role, an argument that disagrees with the transfer —
 *    each is a `conflicting` leg with both values printed, never a silent pick.
 * 4. **`min_amount_out = 0` is not a pass.** The argument is carried verbatim; a
 *    zero floor means "this instruction states no protection", which is reported
 *    as `not-checkable` and never as a satisfied slippage bound.
 * 5. **Commitment is inherited, never assumed.** A failed transaction commits
 *    nothing, so a recognized leg is `not-committed` and its amounts are labelled
 *    as attempted movement.
 * 6. **Deterministic.** Legs in execution order, checks in a fixed order, every
 *    amount an exact `bigint` or `null`, no clock, no I/O, no locale.
 *
 * Nothing here changes `NormalizedInstruction`, `DecodedAction` or
 * `TransactionEffects`: this model refers to them by reference and adds no fields
 * to them.
 */

import type { ActionKind, InstructionRef } from '../decode/actions.ts';

/** How the transaction committed, as reported to this layer. */
export type DlmmCommitState = 'committed' | 'reverted' | 'unknown';

/**
 * The four outcomes of a recognized leg.
 *
 * `partially-proven` is the honest middle: the instruction is definitely a
 * `swap2` and its amounts are instruction data, but at least one required
 * condition could not be evaluated (typically because no effects model was
 * supplied, or a transfer could not be attributed).
 */
export type DlmmSwapState =
  /** Every required proof condition passed and the transaction committed. */
  | 'proven'
  /** Recognized, but at least one required condition could not be evaluated. */
  | 'partially-proven'
  /** Recognized, but the transaction did not commit (failed, or metadata absent). */
  | 'not-committed'
  /** Recognized, but two pieces of evidence disagree. Surfaced, never resolved. */
  | 'conflicting';

export type DlmmCheckOutcome = 'pass' | 'fail' | 'not-checkable';

/**
 * One proof condition.
 *
 * `required` separates the conditions that gate `proven` from the informational
 * ones: a required condition that cannot be checked yields `partially-proven`,
 * and a required condition that *fails* yields `conflicting`.
 */
export interface DlmmSwapCheck {
  /** Stable machine id, e.g. `input-amount-matches-amount-in`. */
  readonly id: string;
  readonly required: boolean;
  readonly outcome: DlmmCheckOutcome;
  /** Factual detail naming the compared values. Never a guess, never prose filler. */
  readonly detail: string;
}

/** Where an amount in this model came from. */
export type DlmmAmountEvidence =
  /** The instruction's own argument bytes (`amount_in` / `min_amount_out`). */
  | 'instruction-arg'
  /** The token instruction the AMM executed inside its own CPI subtree. */
  | 'transfer-leg'
  /** Not observably stated. */
  | 'not-observable';

/** Where a side's owner was established. */
export type DlmmOwnerEvidence =
  /** The RPC's own token balance rows report the account and its owner. */
  | 'account-metadata'
  /**
   * An Associated Token Account `create` instruction in this transaction named
   * this account as the one it created, so its mint and owner are proven by that
   * instruction. Needed because an account created and closed inside one
   * transaction is absent from the RPC's token balance rows entirely.
   */
  | 'ata-create-instruction'
  /** Not establishable. */
  | 'none';

/** One side of a swap: the token account the AMM named, and what moved through it. */
export interface DlmmSwapSide {
  /** The account the IDL names for this side (`user_token_in` / `user_token_out`). */
  readonly tokenAccount: string | null;
  /**
   * Owner reported for that token account by the RPC's token balance rows
   * (`account-metadata`). `null` when the rows do not mention the account — this
   * layer never derives an owner from an authority field.
   */
  readonly owner: string | null;
  readonly ownerEvidence: DlmmOwnerEvidence;
  readonly mint: string | null;
  /** Exact raw units, or `null` when not observable. */
  readonly amount: bigint | null;
  readonly amountEvidence: DlmmAmountEvidence;
  /** The transfer this side was proven from; `null` when no single leg was found. */
  readonly legRef: InstructionRef | null;
  readonly legKind: ActionKind | null;
}

/**
 * The DLMM account roles this layer relies on for proof, exactly as the IDL names
 * them. Roles that are not needed for the claim are deliberately absent.
 */
export interface DlmmSwapRoles {
  /** `lb_pair`: the pool the swap executed against. */
  readonly pool: string | null;
  /** `reserve_x` / `reserve_y`: the pool vaults the two transfers must touch. */
  readonly reserveX: string | null;
  readonly reserveY: string | null;
  readonly tokenXMint: string | null;
  readonly tokenYMint: string | null;
  /** Accounts passed beyond the 16 named roles (bin arrays). Counted, never named. */
  readonly tailAccountCount: number;
  /** `RemainingAccountsInfo.slices.length` (Token-2022 transfer hooks). Counted only. */
  readonly hookSliceCount: number;
}

/** One recognized `swap2` instruction, with everything it was proven from. */
export interface DlmmSwapLeg {
  readonly protocol: 'meteora-dlmm';
  readonly programId: string;
  readonly instructionName: 'swap2';
  /** Where the instruction sits: `[3.8]` for the first leg of the fixture. */
  readonly ref: InstructionRef;
  readonly commitState: DlmmCommitState;
  readonly state: DlmmSwapState;
  readonly input: DlmmSwapSide;
  readonly output: DlmmSwapSide;
  /** The instruction's `amount_in` argument, verbatim. */
  readonly amountIn: bigint | null;
  /** The instruction's `min_amount_out` argument, verbatim (`0` = no floor stated). */
  readonly minAmountOut: bigint | null;
  /**
   * `true` when the input side is the pool's token X (`token_x_mint`), `false`
   * when it is token Y, `null` when the pairing could not be established.
   */
  readonly xToY: boolean | null;
  readonly roles: DlmmSwapRoles;
  /** Every condition that was evaluated, in a fixed order. */
  readonly checks: readonly DlmmSwapCheck[];
  /** Ids of the checks that failed. Non-empty ⇒ `state === 'conflicting'`. */
  readonly conflicts: readonly string[];
  /** Machine ids for things that could not be established at all. */
  readonly unknowns: readonly string[];
  readonly diagnostics: readonly DlmmSwapDiagnostic[];
}

export interface DlmmSwapDiagnostic {
  readonly level: 'info' | 'warning';
  readonly code: string;
  readonly message: string;
  /** The instruction this note is about, or `null` for transaction-level notes. */
  readonly ref: InstructionRef | null;
}

export interface DlmmSwapCounts {
  readonly recognized: number;
  readonly proven: number;
  readonly partiallyProven: number;
  readonly notCommitted: number;
  readonly conflicting: number;
}

/** Everything the swap layer concluded about one transaction. */
export interface TransactionSwaps {
  /** Recognized legs, in execution order. */
  readonly legs: readonly DlmmSwapLeg[];
  readonly diagnostics: readonly DlmmSwapDiagnostic[];
  readonly counts: DlmmSwapCounts;
}
