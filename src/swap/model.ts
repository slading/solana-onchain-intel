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

/* ------------------------------------------- the aggregate over all protocols */

/**
 * The protocols the swap layer can recognize.
 *
 * 4.1 added `meteora-dlmm` (`swap2`); 4.2 adds `pump-amm` (`sell`). The list is an
 * enumeration of implemented targets, not a registry: nothing generic dispatches
 * on it, and adding a protocol means adding recognition code and tests for it.
 */
export type SwapProtocol = 'meteora-dlmm' | 'pump-amm';

/**
 * The shared vocabulary of a leg. These aliases exist so the pump model can reuse
 * the 4.1 types *by identity* instead of redeclaring them — renaming a frozen type
 * for symmetry would be a refactor with no behavioural gain.
 */
export type SwapState = DlmmSwapState;
export type SwapCommitState = DlmmCommitState;
export type SwapCheckOutcome = DlmmCheckOutcome;
export type SwapCheck = DlmmSwapCheck;
export type SwapSide = DlmmSwapSide;
export type SwapOwnerEvidence = DlmmOwnerEvidence;
export type SwapAmountEvidence = DlmmAmountEvidence;
export type SwapDiagnostic = DlmmSwapDiagnostic;

/** Any recognized AMM leg (M4.1 DLMM or M4.2 pump). Discriminated by `protocol`. */
export type SwapLeg = DlmmSwapLeg | PumpSellLeg;

/**
 * Everything the swap layer concluded about one transaction, across protocols.
 *
 * `scannedProtocols` names the protocols the scan that produced this report
 * **covers** — not the legs it happened to find. It is optional **on purpose**:
 * the 4.1 `TransactionSwaps` (returned by `recognizeDlmmSwaps`, which does not
 * carry it) stays assignable, and its absence means "the 4.1 scan, i.e. Meteora
 * DLMM only" to every consumer, including the renderer's section wording.
 */
export interface SwapReport {
  readonly scannedProtocols?: readonly SwapProtocol[];
  readonly legs: readonly SwapLeg[];
  readonly diagnostics: readonly SwapDiagnostic[];
  readonly counts: DlmmSwapCounts;
}

/* ------------------------------------------------------------- pump_amm sell */

/**
 * The named account roles of `sell` this layer relies on for proof, in the IDL's
 * names. Slots that are not needed for the claim (programs, system accounts,
 * `fee_config`, `fee_program`) are deliberately absent — except the two fee
 * destinations, which are named *only* so a fee transfer can be identified as
 * something other than the user's output.
 */
export interface PumpSellRoles {
  /** `pool`: the pump AMM pool the sell executed against. */
  readonly pool: string | null;
  /** `user`: the account the instruction declares as the seller. */
  readonly user: string | null;
  readonly globalConfig: string | null;
  readonly baseMint: string | null;
  readonly quoteMint: string | null;
  readonly userBaseTokenAccount: string | null;
  readonly userQuoteTokenAccount: string | null;
  readonly poolBaseTokenAccount: string | null;
  readonly poolQuoteTokenAccount: string | null;
  /** `protocol_fee_recipient_token_account`: a named destination, never the user's. */
  readonly protocolFeeRecipientTokenAccount: string | null;
  /** `coin_creator_vault_ata`: a named destination, never the user's. */
  readonly coinCreatorVaultAta: string | null;
  /** Accounts beyond the 21 named roles. Counted, never named, never used. */
  readonly tailAccountCount: number;
}

/** Where a quote-vault transfer went, on the evidence available. */
export type PumpFeeTransferRole =
  /** The destination is the IDL's `protocol_fee_recipient_token_account`. */
  | 'protocol-fee-recipient'
  /** The destination is the IDL's `coin_creator_vault_ata`. */
  | 'coin-creator-vault'
  /** Not one of the named fee slots: something else the pool paid. */
  | 'other';

/**
 * A quote-vault transfer that is **not** the user's output.
 *
 * These are reported as evidence, never as a claim about intent: the layer says
 * where the units went and which named slot (if any) that destination is. It does
 * not decompose the pool's fee structure, and the amounts are never summed into
 * anything.
 */
export interface PumpSellFeeTransfer {
  /** The transfer instruction itself. */
  readonly ref: InstructionRef;
  readonly destTokenAccount: string | null;
  readonly destOwner: string | null;
  readonly destOwnerEvidence: SwapOwnerEvidence;
  readonly amount: bigint | null;
  readonly mint: string | null;
  readonly role: PumpFeeTransferRole;
}

/** One recognized pump_amm `sell`, with everything it was proven from. */
export interface PumpSellLeg {
  readonly protocol: 'pump-amm';
  readonly programId: string;
  readonly instructionName: 'sell';
  readonly ref: InstructionRef;
  readonly commitState: SwapCommitState;
  readonly state: SwapState;
  /** The base leg: the user's base account paying the pool's base vault. */
  readonly input: SwapSide;
  /** The quote leg: the pool's quote vault paying the user's quote account. */
  readonly output: SwapSide;
  /** The instruction's `base_amount_in` argument, verbatim. */
  readonly baseAmountIn: bigint | null;
  /** The instruction's `min_quote_amount_out` argument, verbatim (`0` = no floor). */
  readonly minQuoteAmountOut: bigint | null;
  readonly roles: PumpSellRoles;
  /** Every quote-vault transfer that is not the user's output, in execution order. */
  readonly feeTransfers: readonly PumpSellFeeTransfer[];
  /** Every condition that was evaluated, in a fixed order. */
  readonly checks: readonly SwapCheck[];
  /** Ids of the checks that failed. Non-empty ⇒ `state === 'conflicting'`. */
  readonly conflicts: readonly string[];
  /** Machine ids for things that could not be established at all. */
  readonly unknowns: readonly string[];
  readonly diagnostics: readonly SwapDiagnostic[];
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
