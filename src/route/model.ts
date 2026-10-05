/**
 * Milestone 4.4: the route layer's model.
 *
 * A **route is an envelope, not a swap**. It owns the user's intent and the
 * aggregation structure — the declared input, the quote, the slippage tolerance,
 * the platform-fee rate, the decoded plan and the references to the instructions
 * the route dispatched — and it owns **no executed movement whatsoever**. Every
 * amount that actually moved stays owned by the inner legs (M4.1–4.3) and by the
 * Milestone 3 effects model, so a route can never be added to a swap or movement
 * total. That rule is enforced by this model's shape: there is no `input`/`output`
 * side, no `amount`, and no fee decomposition anywhere below.
 *
 * Design rules, inherited from 4.1–4.3 and applied to a different kind of claim:
 *
 * 1. **Intent is not movement.** `declaredInAmount` and `quotedOutAmount` are
 *    instruction data: they say what was authorized and what was quoted. They are
 *    never reported as a fill, and the derived `declaredMinOutAmount` is labelled as
 *    route policy — the discovery did **not** establish which balance, leg or
 *    account the program compares it against, so this layer never claims one.
 * 2. **Partial is a first-class outcome.** The deployed `SwapType` enum is larger
 *    than any public ABI, so a plan can stop decoding in the middle. The header
 *    facts survive, the steps that did decode are kept, and no step-level claim is
 *    made about the part that did not.
 * 3. **Alignment is checked, never assumed.** Steps are matched against the
 *    instructions the route *actually dispatched* (its own CPI subtree, its own
 *    depth). A step whose observed dispatch is missing from those instructions is a
 *    conflict, not something to paper over; a step whose variant has no observed
 *    dispatch at all is `not-checkable`.
 * 4. **Counts do not have to agree.** One step can dispatch more than one
 *    instruction (a pump cashback claim dispatches the swap *and* a cleanup), so
 *    `steps.length === legs.length` is never asserted. Leftover instructions are
 *    reported as not referenced by the plan.
 * 5. **Events are not facts.** JUP6 writes its own swap records *before* reverting
 *    in a real fixture. Nothing here reads them, and the instruction the route
 *    dispatched to its own program is counted and excluded — never a leg.
 * 6. **Commitment is inherited, never assumed.** A reverted transaction yields a
 *    route that describes an attempt.
 */

import type { InstructionRef } from '../decode/actions.ts';
import type {
  SwapCheck,
  SwapCheckOutcome,
  SwapCommitState,
  SwapDiagnostic,
  SwapProtocol,
  SwapState,
} from '../swap/model.ts';
import type { RoutePlanStepRead, RouteV2Header } from './jupiter.ts';

/** The four outcomes a recognized route can reach. Same vocabulary as M4.1–4.3. */
export type RouteState = SwapState;
export type RouteCommitState = SwapCommitState;
export type RouteCheck = SwapCheck;
export type RouteCheckOutcome = SwapCheckOutcome;
export type RouteDiagnostic = SwapDiagnostic;

/**
 * What the instruction declares, verbatim, in raw integer units.
 *
 * Every field is `null` only if the header itself could not be read — in which
 * case no envelope is produced at all, so in practice they are always present.
 */
export interface RouteIntent {
  /** `in_amount`: the input the route was authorized to take. Not proof it moved. */
  readonly declaredInAmount: bigint;
  /** `quoted_out_amount`: the quote at plan time. Not the fill, not the receipt. */
  readonly quotedOutAmount: bigint;
  /** `slippage_bps`: route-level tolerance. */
  readonly slippageBps: number;
  /** `platform_fee_bps`: an integrator fee **rate** — no recipient, no amount. */
  readonly platformFeeBps: number;
  /** `positive_slippage_bps`: declared metadata only; its purpose is not proven. */
  readonly positiveSlippageBps: number;
  /**
   * The route-level minimum output implied by the two fields above,
   * `floor(quoted_out_amount × (1 − slippage_bps / 10 000))`, or `null` when
   * `slippage_bps > 10 000` makes that expression meaningless.
   *
   * This is **declared policy**, not a tested bound: see `MIN_OUT_COMPARISON_UNKNOWN`.
   */
  readonly declaredMinOutAmount: bigint | null;
}

/**
 * The ten declared account slots, plus the counts that make the rest auditable.
 *
 * Roles are read positionally. No role beyond slot 9 is named, and nothing here is
 * ever resolved through a pubkey→slot lookup: the lists repeat pubkeys, so slot
 * identity is the only identity.
 */
export interface RouteAccounts {
  readonly userTransferAuthority: string | null;
  readonly userSourceTokenAccount: string | null;
  readonly userDestinationTokenAccount: string | null;
  readonly sourceMint: string | null;
  readonly destinationMint: string | null;
  readonly sourceTokenProgram: string | null;
  readonly destinationTokenProgram: string | null;
  /** Slot 7: `optional` in the ABI and observed filled with a filler value. */
  readonly destinationTokenAccount: string | null;
  readonly eventAuthority: string | null;
  /** Slot 9: the program itself, for the self-CPI. */
  readonly program: string | null;
  /** Slots beyond the ten declared roles. Counted only — no role is provable. */
  readonly remainingAccountCount: number;
  /** Total slots the instruction passed (`remainingAccountCount + 10`, or the raw length). */
  readonly accountSlotCount: number;
}

/** The plan, as far as the bytes allow it to be read. */
export interface RoutePlan {
  /** What the header declared. */
  readonly declaredStepCount: number;
  /** `true` only when all declared steps decoded *and* every payload byte was consumed. */
  readonly complete: boolean;
  /** The steps that decoded, in order. Empty when the first step could not be read. */
  readonly steps: readonly RoutePlanStepRead[];
  /** Why the plan is incomplete, phrased for a human. Empty when `complete`. */
  readonly detail: string;
}

/** The result of matching plan steps against the instructions the route dispatched. */
export type RoutePlanAlignmentStatus =
  /** Every step matched a dispatched instruction, in order, and none was left over. */
  | 'aligned'
  /** Every step matched, but the route dispatched further instructions the plan does not mention. */
  | 'partial'
  /** A step's observed dispatch does not appear among the dispatched instructions. */
  | 'mismatched'
  /** Not decidable: an incomplete plan, an unknown variant, or no recorded CPIs. */
  | 'not-checkable';

export interface RoutePlanAlignment {
  readonly status: RoutePlanAlignmentStatus;
  readonly detail: string;
}

/**
 * An instruction the route dispatched.
 *
 * "Dispatched" is the whole claim: the program was invoked from the route's own CPI
 * subtree at the route's own depth. Whether it is a *swap* is a different question,
 * answered only by whether a frozen recognizer already recognized it (`coveredBy`).
 * No amount is carried here, deliberately — the movement belongs to the leg.
 */
export interface RouteLeg {
  readonly ref: InstructionRef;
  readonly programId: string | null;
  /** First 8 bytes of the instruction data, lower-case hex, or `null` if shorter. */
  readonly discriminator: string | null;
  /** Anchor name proven by discriminator preimage, or `null` when none was proven. */
  readonly instructionName: string | null;
  /** Which plan step this instruction was matched to, or `null` when unmatched. */
  readonly planStepIndex: number | null;
  /**
   * The frozen swap recognizer that recognized **this same instruction**, if any.
   * A reference, never a copy: the leg's amounts stay with the leg's own model.
   */
  readonly coveredBy: RouteLegSwapReference | null;
}

export interface RouteLegSwapReference {
  readonly protocol: SwapProtocol;
  readonly instructionName: string;
}

/**
 * How the route's CPI subtree decomposes. The three counts always add up to the
 * size of the subtree, so an exclusion is never a silent loss.
 */
export interface RouteLegAccounting {
  readonly legCount: number;
  /** Instructions the route dispatched to its **own** program (event writes, …). */
  readonly selfCallCount: number;
  /** Instructions dispatched to token/system/account/compute-budget programs. */
  readonly infrastructureCount: number;
}

/** One recognized `route_v2` instruction, with everything it was read from. */
export interface JupiterRouteEnvelope {
  readonly protocol: 'jupiter-route';
  readonly programId: string;
  readonly instructionName: 'route_v2';
  readonly ref: InstructionRef;
  readonly commitState: RouteCommitState;
  readonly state: RouteState;
  readonly intent: RouteIntent;
  readonly accounts: RouteAccounts;
  readonly plan: RoutePlan;
  readonly legs: readonly RouteLeg[];
  readonly legAccounting: RouteLegAccounting;
  readonly planAlignment: RoutePlanAlignment;
  /** Every condition that was evaluated, in a fixed order. */
  readonly checks: readonly RouteCheck[];
  /** Ids of the checks that failed. Non-empty ⇒ `state === 'conflicting'`. */
  readonly conflicts: readonly string[];
  /** Machine ids for things that could not be established at all. */
  readonly unknowns: readonly string[];
  readonly diagnostics: readonly RouteDiagnostic[];
}

export interface RouteCounts {
  readonly recognized: number;
  readonly proven: number;
  readonly partiallyProven: number;
  readonly notCommitted: number;
  readonly conflicting: number;
}

/** Everything the route layer concluded about one transaction. */
export interface RouteReport {
  readonly envelopes: readonly JupiterRouteEnvelope[];
  readonly diagnostics: readonly RouteDiagnostic[];
  readonly counts: RouteCounts;
}

/* --------------------------------------------------------- permanent unknowns */

/**
 * Unknowns this layer records because the discovery could not settle them — they
 * are *reported*, never resolved by guessing.
 */
export const PLAN_INDEX_SPACE_UNKNOWN = 'plan-index-space-unknown';
export const MIN_OUT_COMPARISON_UNKNOWN = 'min-out-comparison-target-unknown';
export const PLATFORM_FEE_RECIPIENT_UNKNOWN = 'platform-fee-recipient-unknown';
export const PLATFORM_FEE_AMOUNT_UNKNOWN = 'platform-fee-amount-unknown';
export const POSITIVE_SLIPPAGE_UNKNOWN = 'positive-slippage-purpose-unknown';
export const PLAN_NOT_FULLY_DECODED = 'plan-not-fully-decoded';
export const PLAN_VARIANT_NAMES_UNKNOWN = 'plan-variant-names-unknown';
export const SWAP_RECOGNITION_ABSENT = 'swap-recognition-absent';

/** Re-exported so a consumer can talk about a parsed header without the parser module. */
export type { RoutePlanStepRead, RouteV2Header };
