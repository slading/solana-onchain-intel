/**
 * Milestone 4.4: recognizing a Jupiter `route_v2` **route envelope**.
 *
 * The algorithm, in order, and nothing else:
 *
 *   1. scan every instruction (top-level **and** CPI — a route was observed being
 *      invoked by another router, so nothing here assumes the top level);
 *   2. read its discriminator and require exactly `bb64facc31c4af14`;
 *   3. parse the header with exact bounds checks (`./jupiter.ts`); without a header
 *      there is no intent to claim, so the sighting is reported and left alone;
 *   4. read the plan step by step, each with its own `SwapType` variant width, and
 *      accept it only if every declared step decoded and every byte was consumed;
 *   5. map the ten declared account roles by **position**, and count the rest;
 *   6. take the instruction's own CPI subtree and split it into the instructions the
 *      route dispatched to other programs (its legs) and the plumbing (token/system/
 *      account instructions, and the calls it made to its own program);
 *   7. match each plan step to the dispatched instruction its variant was observed
 *      to invoke, in order — and report a *conflict* if a step's observed dispatch
 *      is missing, rather than quietly re-pairing the steps;
 *   8. mark each leg with the frozen swap recognizer that already recognized that
 *      same instruction, if any — by reference, never by restating its amounts;
 *   9. report one envelope per recognized instruction with every check, every
 *      conflict and every remaining unknown.
 *
 * What this deliberately does **not** do: read the route's own event records (a
 * reverted fixture emits a complete-looking one), read logs, size anything from
 * token deltas, or claim that any amount moved. The envelope owns intent only; the
 * legs and the Milestone 3 effects own movement. Consequently there is no code path
 * in this file that produces an executed amount, and no code path that can add a
 * route to a movement total.
 */

import { refLabel, type InstructionRef } from '../decode/actions.ts';
import { decodeBase58Data, takeAccountRoles, type Bytes } from '../decode/bytes.ts';
import type { NormalizedInstruction, NormalizedTransaction } from '../model/transaction.ts';
import type { SwapDiagnostic, SwapLeg, SwapReport } from '../swap/model.ts';
import type {
  JupiterRouteEnvelope,
  RouteAccounts,
  RouteCheck,
  RouteCommitState,
  RouteIntent,
  RouteLeg,
  RouteLegAccounting,
  RouteLegSwapReference,
  RoutePlan,
  RoutePlanAlignment,
  RouteReport,
  RouteState,
} from './model.ts';
import {
  MIN_OUT_COMPARISON_UNKNOWN,
  PLAN_INDEX_SPACE_UNKNOWN,
  PLAN_NOT_FULLY_DECODED,
  PLAN_VARIANT_NAMES_UNKNOWN,
  PLATFORM_FEE_AMOUNT_UNKNOWN,
  PLATFORM_FEE_RECIPIENT_UNKNOWN,
  POSITIVE_SLIPPAGE_UNKNOWN,
  SWAP_RECOGNITION_ABSENT,
} from './model.ts';
import {
  JUPITER_ROUTE_V2_DISCRIMINATOR,
  JUPITER_V6_PROGRAM_ID,
  ROUTE_INFRASTRUCTURE_PROGRAMS,
  ROUTE_V2_ACCOUNT_ROLES,
  ROUTE_V2_FIXED_ACCOUNT_COUNT,
  parseRouteV2Header,
  parseRouteV2Plan,
  provenLegInstructionName,
  routePlanVariant,
  type RouteV2Header,
  type RouteV2Role,
} from './jupiter.ts';
import {
  allInstructions,
  commitStateOf,
  cpiSubtree,
  fail,
  pass,
  refKey,
  refOf,
  resolveState,
  unchecked,
} from '../swap/recognize.ts';

const UNKNOWN = 'unknown';

/** Ten thousand basis points: `slippage_bps` is read against this. */
const BPS_DENOMINATOR = 10_000n;

export interface RecognizeRoutesOptions {
  /**
   * The swap report for the same transaction, if it was computed.
   *
   * Used **only** to mark which dispatched instructions a frozen M4 recognizer
   * already recognized, so the route can reference them. The route layer never
   * re-runs, copies or re-states a leg's evidence; when this is omitted the
   * coverage check is `not-checkable` and nothing else changes.
   */
  readonly swaps?: SwapReport | null;
}

/* ------------------------------------------------------------------ reading -- */

function intentFrom(header: RouteV2Header): RouteIntent {
  const denominator = BigInt(header.slippageBps);
  return {
    declaredInAmount: header.declaredInAmount,
    quotedOutAmount: header.quotedOutAmount,
    slippageBps: header.slippageBps,
    platformFeeBps: header.platformFeeBps,
    positiveSlippageBps: header.positiveSlippageBps,
    declaredMinOutAmount:
      header.slippageBps > 10_000
        ? null
        : (header.quotedOutAmount * (BPS_DENOMINATOR - denominator)) / BPS_DENOMINATOR,
  };
}

function accountsFrom(accounts: readonly string[] | null, notes: string[]): RouteAccounts {
  if (accounts === null) {
    const empty = Object.fromEntries(ROUTE_V2_ACCOUNT_ROLES.map(role => [role, null])) as Record<
      RouteV2Role,
      string | null
    >;
    return { ...empty, remainingAccountCount: 0, accountSlotCount: 0 };
  }
  const roles = takeAccountRoles(accounts, ROUTE_V2_ACCOUNT_ROLES, notes);
  return {
    userTransferAuthority: roles.userTransferAuthority,
    userSourceTokenAccount: roles.userSourceTokenAccount,
    userDestinationTokenAccount: roles.userDestinationTokenAccount,
    sourceMint: roles.sourceMint,
    destinationMint: roles.destinationMint,
    sourceTokenProgram: roles.sourceTokenProgram,
    destinationTokenProgram: roles.destinationTokenProgram,
    destinationTokenAccount: roles.destinationTokenAccount,
    eventAuthority: roles.eventAuthority,
    program: roles.program,
    remainingAccountCount: Math.max(0, accounts.length - ROUTE_V2_FIXED_ACCOUNT_COUNT),
    accountSlotCount: accounts.length,
  };
}

/** Dispatch depth of an instruction: the RPC's CPI depth, with 1 for a top-level call. */
function depthOf(instruction: NormalizedInstruction): number | null {
  return instruction.stackHeight ?? (instruction.outerIndex === null ? 1 : null);
}

function discriminatorOf(data: string | null): string | null {
  if (data === null) return null;
  const bytes = decodeBase58Data(data);
  if (bytes === null || bytes.length < 8) return null;
  let hex = '';
  for (let index = 0; index < 8; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) return null;
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/* ----------------------------------------------------------------- the legs -- */

interface DispatchedInstructions {
  readonly legs: readonly RouteLeg[];
  readonly accounting: RouteLegAccounting;
}

/**
 * Splits the route's CPI subtree into legs, self-calls and infrastructure.
 *
 * `cpiSubtree` gives the frames the instruction executed (contiguous, strictly
 * deeper). Only the frames at exactly one level below the route were dispatched by
 * the route itself, so only those are considered — and that is also what keeps an
 * unrelated sibling instruction, or a sibling group, from contaminating the list.
 *
 * Self-calls are the instructions the route sent to **its own program** (its event
 * writes) — except a nested `route_v2`, which is a real dispatch and is kept as a
 * leg. Infrastructure is the plumbing: token moves, account creation, compute
 * budget. Both exclusions are counted, so `legCount + selfCallCount +
 * infrastructureCount` always equals the subtree size.
 */
function dispatchedInstructions(
  transaction: NormalizedTransaction,
  instruction: NormalizedInstruction,
): { readonly ok: boolean; readonly detail: string; readonly dispatched: DispatchedInstructions } {
  const empty: DispatchedInstructions = {
    legs: [],
    accounting: { legCount: 0, selfCallCount: 0, infrastructureCount: 0 },
  };
  const depth = depthOf(instruction);
  const subtree = cpiSubtree(transaction, instruction);
  if (!subtree.ok || depth === null) {
    return { ok: false, detail: subtree.detail, dispatched: empty };
  }

  const legs: RouteLeg[] = [];
  let selfCallCount = 0;
  let infrastructureCount = 0;
  for (const frame of subtree.instructions) {
    if (frame.stackHeight !== depth + 1) continue;
    const discriminated = discriminatorOf(frame.data);
    if (frame.programId === JUPITER_V6_PROGRAM_ID) {
      if (discriminated === JUPITER_ROUTE_V2_DISCRIMINATOR) {
        // A nested route is an instruction the route dispatched *to another
        // service*: it belongs in the leg list, unlike an event write.
        legs.push({
          ref: refOf(frame),
          programId: frame.programId,
          discriminator: discriminated,
          instructionName: 'route_v2',
          planStepIndex: null,
          coveredBy: null,
        });
      } else {
        selfCallCount += 1;
      }
      continue;
    }
    if (frame.programId !== null && ROUTE_INFRASTRUCTURE_PROGRAMS.includes(frame.programId)) {
      infrastructureCount += 1;
      continue;
    }
    legs.push({
      ref: refOf(frame),
      programId: frame.programId,
      discriminator: discriminated,
      instructionName: provenLegInstructionName(discriminated),
      planStepIndex: null,
      coveredBy: null,
    });
  }

  return {
    ok: true,
    detail: subtree.detail,
    dispatched: {
      legs,
      accounting: { legCount: legs.length, selfCallCount, infrastructureCount },
    },
  };
}

/* -------------------------------------------------------------- alignment ---- */

/**
 * Matches plan steps to dispatched instructions, in order.
 *
 * The matching rests on one piece of evidence: the program a variant was *observed*
 * to invoke (`RoutePlanVariant.dispatchesTo`). A step whose variant has no observed
 * dispatch cannot be matched at all, so the whole alignment degrades to
 * `not-checkable` — the layer says nothing rather than pairing by hand.
 *
 * A step whose observed dispatch is missing from the legs is a **mismatch**: the
 * plan and the executed instructions disagree, and that is surfaced as a conflict.
 * Steps may be matched while instructions are left over (one step can dispatch a
 * swap *and* a cleanup) → `partial`, which is still a proven ordering.
 */
function alignPlan(
  plan: RoutePlan,
  legs: readonly RouteLeg[],
  subtreeKnown: boolean,
  subtreeDetail: string,
  commitState: RouteCommitState,
): { readonly alignment: RoutePlanAlignment; readonly legs: readonly RouteLeg[] } {
  if (!plan.complete) {
    return {
      alignment: {
        status: 'not-checkable',
        detail: `the plan did not decode completely (${plan.detail}), so no step is matched to an instruction`,
      },
      legs,
    };
  }
  if (!subtreeKnown) {
    return {
      alignment: { status: 'not-checkable', detail: `the dispatched instructions are not visible: ${subtreeDetail}` },
      legs,
    };
  }
  if (plan.steps.length === 0) {
    return {
      alignment: { status: 'not-checkable', detail: 'the plan declares no step, so there is nothing to match' },
      legs,
    };
  }
  const unmapped = plan.steps.filter(step => (routePlanVariant(step.swapTag)?.dispatchesTo ?? null) === null);
  if (unmapped.length > 0) {
    return {
      alignment: {
        status: 'not-checkable',
        detail:
          `step(s) ${unmapped.map(step => step.index).join(', ')} use a variant with no observed dispatch, ` +
          'so the plan cannot be matched against what the route executed',
      },
      legs,
    };
  }

  const consumed = new Set<number>();
  const matched = new Map<number, number>();
  const assign = (): RouteLeg[] =>
    legs.map((leg, index) => {
      const stepIndex = [...matched.entries()].find(([, legIndex]) => legIndex === index)?.[0] ?? null;
      return stepIndex === null ? leg : { ...leg, planStepIndex: stepIndex };
    });

  for (const step of plan.steps) {
    const expected = routePlanVariant(step.swapTag)?.dispatchesTo ?? null;
    const found = legs.findIndex(
      (leg, index) => !consumed.has(index) && leg.programId !== null && leg.programId === expected,
    );
    if (found < 0) {
      const remaining = legs
        .filter((_leg, index) => !consumed.has(index))
        .map(leg => `${refLabel(leg.ref)} ${leg.programId ?? UNKNOWN}`)
        .join(', ');
      const described =
        `step ${step.index} (swap tag ${step.swapTag}` +
        `${step.swapName === null ? '' : ` ${step.swapName}`}) was observed to dispatch to ` +
        `${expected ?? UNKNOWN}, but no unconsumed dispatched instruction is that program` +
        `${remaining === '' ? '' : ` (unmatched: ${remaining})`}`;
      // A route that did not commit may simply not have reached this step, so an
      // unmatched step is only a *disagreement* when the route actually ran to
      // completion. Everything matched so far keeps its step reference either way.
      return commitState === 'committed'
        ? { alignment: { status: 'mismatched', detail: described }, legs: assign() }
        : {
            alignment: {
              status: 'not-checkable',
              detail:
                `${described}; the transaction did not commit, so a step that was never reached cannot be ` +
                'told apart from one that disagrees with the instructions that ran',
            },
            legs: assign(),
          };
    }
    consumed.add(found);
    matched.set(step.index, found);
  }

  const withStep = assign();

  const leftover = legs.filter((_leg, index) => !consumed.has(index));
  if (leftover.length === 0) {
    return {
      alignment: {
        status: 'aligned',
        detail: `all ${plan.steps.length} plan step(s) matched a dispatched instruction, in order, with none left over`,
      },
      legs: withStep,
    };
  }
  return {
    alignment: {
      status: 'partial',
      detail:
        `all ${plan.steps.length} plan step(s) matched a dispatched instruction, in order; ` +
        `${leftover.length} dispatched instruction(s) are not referenced by the plan ` +
        `(${leftover.map(leg => `${refLabel(leg.ref)} ${leg.programId ?? UNKNOWN}`).join(', ')}) — ` +
        'one step can dispatch more than one instruction, so the counts are not required to agree',
    },
    legs: withStep,
  };
}

/* ---------------------------------------------------------------- coverage --- */

/** The frozen swap leg that recognized the *same* instruction, if any. */
function coverageOf(ref: InstructionRef, swaps: SwapReport | null): RouteLegSwapReference | null {
  if (swaps === null) return null;
  const key = refKey(ref);
  const leg: SwapLeg | undefined = swaps.legs.find(entry => refKey(entry.ref) === key);
  return leg === undefined ? null : { protocol: leg.protocol, instructionName: leg.instructionName };
}

/* --------------------------------------------------------------- one route --- */

function recognizeRoute(input: {
  readonly transaction: NormalizedTransaction;
  readonly instruction: NormalizedInstruction;
  readonly ref: InstructionRef;
  /** The instruction's payload, already proven to carry a readable header. */
  readonly bytes: Bytes;
  readonly legs: readonly RouteLeg[];
  readonly accounting: RouteLegAccounting;
  readonly subtreeKnown: boolean;
  readonly subtreeDetail: string;
  readonly swaps: SwapReport | null;
}): JupiterRouteEnvelope {
  const { transaction, instruction, ref, bytes, legs, accounting, subtreeKnown, subtreeDetail, swaps } = input;
  const commitState = commitStateOf(transaction.status);
  const checks: RouteCheck[] = [];
  const unknowns: string[] = [];
  const diagnostics: SwapDiagnostic[] = [];

  // Steps 3 and 4 already happened in the scanner: the scanner only calls this
  // function once the header parsed, so the payload handed over is a readable one.
  const header = parseRouteV2Header(bytes);
  if (!header.ok) throw new Error(`route_v2 header was not readable: ${header.detail}`);
  const intent = intentFrom(header.header);

  const roleNotes: string[] = [];
  const accounts = accountsFrom(instruction.accounts, roleNotes);

  const planParse = parseRouteV2Plan(bytes, header.header.routePlanStepCount);
  const plan: RoutePlan = {
    declaredStepCount: header.header.routePlanStepCount,
    complete: planParse.ok,
    steps: planParse.steps,
    detail: planParse.ok ? '' : planParse.detail,
  };

  const aligned = alignPlan(plan, legs, subtreeKnown, subtreeDetail, commitState);

  /* 1: the header. Reaching here means it parsed with exact bounds checks. */
  checks.push(
    pass(
      'route-header-parsed',
      `in_amount ${intent.declaredInAmount}, quoted_out_amount ${intent.quotedOutAmount}, ` +
        `slippage_bps ${intent.slippageBps}, platform_fee_bps ${intent.platformFeeBps}, ` +
        `positive_slippage_bps ${intent.positiveSlippageBps}, ${plan.declaredStepCount} plan step(s) declared`,
    ),
  );

  /* 2: the plan. */
  checks.push(
    plan.complete
      ? pass(
          'plan-decode-complete',
          `${plan.steps.length} step(s) decoded, every payload byte consumed (no trailing byte)`,
        )
      : unchecked(
          'plan-decode-complete',
          `${plan.steps.length} of ${plan.declaredStepCount} step(s) decoded: ${plan.detail}`,
        ),
  );
  if (!plan.complete) unknowns.push(PLAN_NOT_FULLY_DECODED);

  /* 3: are the step variants named? Informational — an unnamed tag is still decoded. */
  const unnamed = plan.steps.filter(step => step.swapName === null);
  checks.push(
    unnamed.length === 0
      ? pass(
          'plan-variants-named',
          `every step names its SwapType variant (${plan.steps.map(step => step.swapName).join(', ')})`,
          false,
        )
      : unchecked(
          'plan-variants-named',
          `step tag(s) ${unnamed.map(step => step.swapTag).join(', ')} have no name in any available ABI ` +
            '(the deployed enum is larger than the public ones); their byte widths are recorded from real payloads',
          false,
        ),
  );
  if (unnamed.length > 0) unknowns.push(PLAN_VARIANT_NAMES_UNKNOWN);

  /* 4: do the steps agree with the instructions the route dispatched? */
  checks.push(
    aligned.alignment.status === 'mismatched'
      ? fail('plan-leg-alignment', aligned.alignment.detail)
      : aligned.alignment.status === 'not-checkable'
        ? unchecked('plan-leg-alignment', aligned.alignment.detail)
        : pass('plan-leg-alignment', aligned.alignment.detail),
  );

  /* 5: are the dispatched instructions already recognized by a frozen M4 model? */
  const covered = aligned.legs.filter(leg => leg.coveredBy !== null);
  if (aligned.legs.length === 0) {
    checks.push(
      unchecked('legs-covered-by-swap-recognizers', 'the route dispatched no instruction to another program', false),
    );
  } else if (covered.length === aligned.legs.length) {
    checks.push(
      pass(
        'legs-covered-by-swap-recognizers',
        `every dispatched instruction was recognized by the swap layer (${covered
          .map(leg => `${refLabel(leg.ref)} ${leg.coveredBy?.protocol} ${leg.coveredBy?.instructionName}`)
          .join(', ')})`,
        false,
      ),
    );
  } else {
    checks.push(
      unchecked(
        'legs-covered-by-swap-recognizers',
        `${covered.length} of ${aligned.legs.length} dispatched instruction(s) were recognized by the swap layer; ` +
          `the rest stay unrecognized and keep their meaning unknown ` +
          `(${aligned.legs
            .filter(leg => leg.coveredBy === null)
            .map(leg => `${refLabel(leg.ref)} ${leg.programId ?? UNKNOWN}`)
            .join(', ')})`,
        false,
      ),
    );
  }

  /* 6: commitment. */
  checks.push(
    commitState === 'committed'
      ? pass('transaction-committed', 'the transaction succeeded, so the instruction committed')
      : unchecked(
          'transaction-committed',
          commitState === 'reverted'
            ? 'the transaction failed: Solana rolls every state change back, so this route describes ' +
              'an attempt, not state'
            : 'the response carries no meta, so commitment is unknown',
        ),
  );

  const conflicts = checks.filter(entry => entry.outcome === 'fail').map(entry => entry.id);
  const state: RouteState = resolveState(commitState, checks, conflicts);

  /* Unknowns the discovery could not settle. Recorded, never guessed away. */
  unknowns.push(PLAN_INDEX_SPACE_UNKNOWN, MIN_OUT_COMPARISON_UNKNOWN);
  if (intent.platformFeeBps > 0) unknowns.push(PLATFORM_FEE_RECIPIENT_UNKNOWN, PLATFORM_FEE_AMOUNT_UNKNOWN);
  if (intent.positiveSlippageBps > 0) unknowns.push(POSITIVE_SLIPPAGE_UNKNOWN);
  if (swaps === null) unknowns.push(SWAP_RECOGNITION_ABSENT);

  if (state === 'conflicting') {
    diagnostics.push({
      level: 'warning',
      code: 'jupiter-route-v2-conflicting',
      message:
        `${refLabel(ref)} is a recognized route_v2 but two pieces of evidence disagree ` +
        `(${conflicts.join(', ')}); both are reported and nothing is re-paired or guessed.`,
      ref,
    });
  }
  if (state === 'not-committed') {
    diagnostics.push({
      level: 'warning',
      code: 'jupiter-route-v2-not-committed',
      message:
        `${refLabel(ref)} is a recognized route_v2 but the transaction did not commit; the intent below is ` +
        'an attempt, and no route-level movement is claimed.',
      ref,
    });
  }
  if (!plan.complete) {
    diagnostics.push({
      level: 'warning',
      code: 'jupiter-route-v2-plan-incomplete',
      message:
        `${refLabel(ref)}: ${plan.detail}. The route-level facts above survive; no step-level claim is made ` +
        'about the part of the plan that could not be read.',
      ref,
    });
  }
  for (const note of roleNotes) {
    diagnostics.push({
      level: 'warning',
      code: 'jupiter-route-v2-named-accounts-incomplete',
      message: `${refLabel(ref)}: ${note}`,
      ref,
    });
  }

  return {
    protocol: 'jupiter-route',
    programId: JUPITER_V6_PROGRAM_ID,
    instructionName: 'route_v2',
    ref,
    commitState,
    state,
    intent,
    accounts,
    plan,
    legs: aligned.legs,
    legAccounting: accounting,
    planAlignment: aligned.alignment,
    checks,
    conflicts,
    unknowns,
    diagnostics,
  };
}

/* ---------------------------------------------------------------- the layer -- */

export function recognizeRoutes(
  transaction: NormalizedTransaction,
  options: RecognizeRoutesOptions = {},
): RouteReport {
  const swaps = options.swaps ?? null;
  const envelopes: JupiterRouteEnvelope[] = [];
  const diagnostics: SwapDiagnostic[] = [];

  for (const instruction of allInstructions(transaction)) {
    if (instruction.programId !== JUPITER_V6_PROGRAM_ID) continue;
    const bytes = instruction.data === null ? null : decodeBase58Data(instruction.data);
    if (bytes === null) continue;
    if (discriminatorOf(instruction.data) !== JUPITER_ROUTE_V2_DISCRIMINATOR) {
      // Another Jupiter instruction (a swap record write, a v1 `route`, …): silently
      // out of scope. Meaning is never inferred from what it is not.
      continue;
    }

    const ref = refOf(instruction);
    const headerParse = parseRouteV2Header(bytes);
    if (!headerParse.ok) {
      diagnostics.push({
        level: 'warning',
        code: 'jupiter-route-v2-header-not-recognized',
        message:
          `${refLabel(ref)} has the route_v2 discriminator but its header does not parse ` +
          `(${headerParse.detail}); it is left unrecognized rather than partially read.`,
        ref,
      });
      continue;
    }

    const dispatched = dispatchedInstructions(transaction, instruction);
    // Coverage is attached here rather than inside the leg builder: the swap report
    // is a different layer's evidence, referenced — never copied.
    const legs: RouteLeg[] = dispatched.dispatched.legs.map(leg => ({
      ...leg,
      coveredBy: coverageOf(leg.ref, swaps),
    }));

    envelopes.push(
      recognizeRoute({
        transaction,
        instruction,
        ref,
        bytes,
        legs,
        accounting: dispatched.dispatched.accounting,
        subtreeKnown: dispatched.ok,
        subtreeDetail: dispatched.detail,
        swaps,
      }),
    );
  }

  // `--no-swaps`-style callers may compute routes without a swap report; say so,
  // because the absence weakens the coverage check only.
  if (swaps === null && envelopes.length > 0) {
    diagnostics.push({
      level: 'info',
      code: 'route-swap-report-absent',
      message:
        'No swap report was supplied, so the dispatched instructions could not be cross-referenced against the ' +
        'frozen swap recognizers; that check is not-checkable and no leg is marked as recognized.',
      ref: null,
    });
  }

  if (!transaction.innerInstructionsAvailable && envelopes.length > 0) {
    diagnostics.push({
      level: 'warning',
      code: 'route-inner-instructions-unavailable',
      message:
        'This node did not record CPI instructions, so the instructions a route dispatched cannot be seen at ' +
        'all: absence of legs here is not evidence that the route executed nothing.',
      ref: null,
    });
  }

  return {
    envelopes,
    diagnostics,
    counts: {
      recognized: envelopes.length,
      proven: envelopes.filter(envelope => envelope.state === 'proven').length,
      partiallyProven: envelopes.filter(envelope => envelope.state === 'partially-proven').length,
      notCommitted: envelopes.filter(envelope => envelope.state === 'not-committed').length,
      conflicting: envelopes.filter(envelope => envelope.state === 'conflicting').length,
    },
  };
}
