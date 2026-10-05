/**
 * Milestone 4.4 — adversarial cases.
 *
 * Every case here is one the discovery named as a way to get a *wrong* answer out of
 * a route recognizer: a plan that disagrees with what ran, a variant whose width is
 * unknown, a reverted route that still wrote a swap record, a chain whose weights sum
 * past 10 000, a route that dispatches a cleanup next to its swap, a fee transfer in
 * the output mint, a nested route, and an unrelated sibling touching the same
 * accounts. The expected outcome is always the same shape: the header facts survive,
 * nothing is invented, and whatever could not be established is listed as unknown.
 *
 * The transactions are patched in memory — the fixtures on disk are never touched.
 */
import { describe, expect, it } from 'vitest';
import {
  JUP6,
  envelopeAt,
  onlyEnvelope,
  planStep,
  remainingAccountsInfo,
  routeFixture,
  routeOutcome,
  routeV2Data,
} from './helpers/routes.ts';
import { base58, dropInstruction, insertInnerInstruction, innerInstructionsOf, patchInstruction } from './helpers/swaps.ts';
import { decodeBase58Data } from '../src/decode/bytes.ts';
import { recognizeRoutes } from '../src/route/recognize-routes.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { recognizeSwaps } from '../src/swap/recognize-swaps.ts';
import { refKey } from '../src/swap/recognize.ts';
import type { NormalizedInstruction, NormalizedTransaction } from '../src/model/transaction.ts';

const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

function analyze(transaction: NormalizedTransaction) {
  const effects = transactionEffects(transaction);
  const swaps = recognizeSwaps(transaction, { effects });
  return { swaps, routes: recognizeRoutes(transaction, { swaps }) };
}

/** Fixture A's first dispatched instruction — reused as a template for insertions. */
function legTemplate(transaction: NormalizedTransaction): NormalizedInstruction {
  const leg = innerInstructionsOf(transaction, 3)[0];
  if (leg === undefined) throw new Error('fixture A no longer has a dispatched instruction at [3.0]');
  return leg;
}

/** Fixture A's route instruction, with a rebuilt payload. */
function withRouteData(transaction: NormalizedTransaction, data: string): NormalizedTransaction {
  return patchInstruction(transaction, null, 3, { data });
}

/** Every bigint a report carries, in the order a consumer would meet them. */
function bigintsIn(value: unknown, out: bigint[] = []): bigint[] {
  if (typeof value === 'bigint') out.push(value);
  else if (Array.isArray(value)) for (const entry of value) bigintsIn(entry, out);
  else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) bigintsIn(entry, out);
  }
  return out;
}

describe('1. the plan claims something the route did not dispatch', () => {
  it('refuses to re-pair the steps and reports a conflict', () => {
    const { transaction } = routeFixture('v0-success-swap');
    // Step 2 keeps its weight but claims a GoonFi swap, which this transaction
    // never invoked — the plan and the executed instructions now disagree.
    const patched = withRouteData(
      transaction,
      routeV2Data({
        declaredInAmount: 4_774_791_332_475n,
        quotedOutAmount: 15_234_269_261n,
        slippageBps: 774,
        platformFeeBps: 10,
        steps: [
          planStep(148, [], 5716, 0, 3),
          planStep(75, remainingAccountsInfo(), 1261, 0, 3),
          planStep(151, [1], 3023, 0, 3),
        ],
      }),
    );
    const { routes } = analyze(patched);
    const envelope = onlyEnvelope(routes);
    expect(envelope.state).toBe('conflicting');
    expect(envelope.conflicts).toEqual(['plan-leg-alignment']);
    expect(envelope.planAlignment.status).toBe('mismatched');
    expect(envelope.planAlignment.detail).toContain('goonuddt');
    // The two steps that did match keep their reference; the third gets none.
    expect(envelope.legs.map(leg => leg.planStepIndex)).toEqual([0, 1, null]);
    expect(envelope.diagnostics.map(note => note.code)).toContain('jupiter-route-v2-conflicting');
  });

  it('also refuses when the dispatched instruction is simply gone', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const patched = dropInstruction(transaction, 3, 13); // the third plan step's DLMM leg
    const { routes } = analyze(patched);
    const envelope = onlyEnvelope(routes);
    expect(envelope.state).toBe('conflicting');
    expect(envelope.planAlignment.status).toBe('mismatched');
    expect(envelope.planAlignment.detail).toContain('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
  });

  it('does not see an instruction the route dispatched two levels down as a leg', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const leg = legTemplate(transaction);
    // A grandchild: inside the route's subtree, but not dispatched by the route.
    const patched = insertInnerInstruction(transaction, 3, 1, { ...leg, index: 20, stackHeight: 3 });
    const { routes } = analyze(patched);
    const envelope = onlyEnvelope(routes);
    expect(envelope.legAccounting).toEqual({ legCount: 3, selfCallCount: 1, infrastructureCount: 1 });
    expect(envelope.legs.some(entry => entry.ref.index === 20)).toBe(false);
    expect(envelope.state).toBe('proven');
  });
});

describe('2. legs with no frozen recognizer', () => {
  it('keeps the route and leaves the leg semantics unknown', () => {
    const { routes } = routeFixture('v1-failed-custom11');
    const envelope = onlyEnvelope(routes);
    expect(envelope.legs).toHaveLength(4);
    expect(envelope.legs.every(leg => leg.coveredBy === null)).toBe(true);
    expect(routeOutcome(envelope, 'legs-covered-by-swap-recognizers')).toBe('not-checkable');
    // One leg's discriminator *is* nameable — naming it does not make it a swap.
    expect(envelope.legs[1]?.instructionName).toBe('swap');
    expect(envelope.legs[1]?.coveredBy).toBeNull();
  });
});

describe('3. a variant the deployed program uses but no ABI can size', () => {
  it('stops the plan, keeps the header facts, and claims no later step', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const patched = withRouteData(
      transaction,
      routeV2Data({
        declaredInAmount: 4_774_791_332_475n,
        quotedOutAmount: 15_234_269_261n,
        slippageBps: 774,
        platformFeeBps: 10,
        steps: [
          planStep(148, [], 5716, 0, 3),
          planStep(146, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 1261, 0, 3),
          planStep(75, remainingAccountsInfo(), 3023, 0, 3),
        ],
      }),
    );
    const { routes } = analyze(patched);
    const envelope = onlyEnvelope(routes);
    expect(envelope.plan.complete).toBe(false);
    expect(envelope.plan.steps).toHaveLength(1);
    expect(envelope.plan.detail).toContain('dynamicV2');
    expect(routeOutcome(envelope, 'plan-decode-complete')).toBe('not-checkable');
    // The header is untouched by the plan's failure.
    expect(envelope.intent.declaredInAmount).toBe(4_774_791_332_475n);
    expect(envelope.intent.slippageBps).toBe(774);
    expect(envelope.state).toBe('partially-proven');
    // Nothing is matched while the plan is incomplete.
    expect(envelope.legs.every(leg => leg.planStepIndex === null)).toBe(true);
    expect(routeOutcome(envelope, 'plan-leg-alignment')).toBe('not-checkable');
    expect(envelope.unknowns).toContain('plan-not-fully-decoded');
    expect(envelope.diagnostics.map(note => note.code)).toContain('jupiter-route-v2-plan-incomplete');
  });
});

describe('4. a payload that supports more than one reading', () => {
  it('never picks one of them: an out-of-table tag ends the plan', () => {
    const { transaction } = routeFixture('v0-success-swap');
    // Tag 172 is inside no accepted table. The bytes after it are chosen so that
    // several widths *could* describe a plausible step — the layer refuses all of
    // them rather than choosing.
    const patched = withRouteData(
      transaction,
      routeV2Data({
        declaredInAmount: 4_774_791_332_475n,
        quotedOutAmount: 15_234_269_261n,
        slippageBps: 774,
        platformFeeBps: 10,
        steps: [planStep(172, [0, 0, 0], 10_000, 0, 1)],
        trailingBytes: [0, 0],
      }),
    );
    const { routes } = analyze(patched);
    const envelope = onlyEnvelope(routes);
    expect(envelope.plan.complete).toBe(false);
    expect(envelope.plan.steps).toEqual([]);
    expect(envelope.plan.detail).toContain('tag 172');
    expect(envelope.plan.detail).toContain('no accepted evidence');
    expect(envelope.state).toBe('partially-proven');
  });

  it('treats unconsumed trailing bytes as an incomplete read, not as an extra step', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const patched = withRouteData(
      transaction,
      routeV2Data({
        declaredInAmount: 4_774_791_332_475n,
        quotedOutAmount: 15_234_269_261n,
        slippageBps: 774,
        platformFeeBps: 10,
        steps: [planStep(75, remainingAccountsInfo(), 10_000, 0, 3)],
        trailingBytes: [0x00, 0x00],
      }),
    );
    const { routes } = analyze(patched);
    const envelope = onlyEnvelope(routes);
    expect(envelope.plan.complete).toBe(false);
    expect(envelope.plan.steps).toHaveLength(1);
    expect(envelope.plan.detail).toContain('unconsumed');
    expect(envelope.state).toBe('partially-proven');
  });
});

describe('5. a reverted route that wrote a swap record first', () => {
  it('reports intent only, and never a committed movement', () => {
    const { routes } = routeFixture('v1-failed-custom6001');
    const envelope = onlyEnvelope(routes);
    expect(envelope.state).toBe('not-committed');
    expect(envelope.commitState).toBe('reverted');
    // The record it wrote is excluded from the legs and counted as a self-call.
    expect(envelope.legAccounting.selfCallCount).toBe(1);
    expect(envelope.legs).toHaveLength(2);
    // Nothing in the envelope claims a settled amount out.
    expect(bigintsIn(envelope)).toEqual([28_574_769n, 28_575_384n, 28_575_384n]);
  });
});

describe('6. a same-mint route', () => {
  it('is accepted; no source≠destination invariant is applied', () => {
    for (const name of ['v1-failed-custom11', 'v1-failed-custom6001']) {
      const envelope = onlyEnvelope(routeFixture(name).routes);
      expect(envelope.accounts.sourceMint, name).toBe(envelope.accounts.destinationMint);
      expect(envelope.conflicts, name).toEqual([]);
      expect(envelope.state, name).toBe('not-committed');
    }
  });
});

describe('7. in_amount equal to the quote', () => {
  it('is accepted as data, with no reading of "nothing happened"', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const patched = withRouteData(
      transaction,
      routeV2Data({
        declaredInAmount: 1_000_000n,
        quotedOutAmount: 1_000_000n,
        slippageBps: 0,
        steps: [
          planStep(148, [], 5716, 0, 3),
          planStep(75, remainingAccountsInfo(), 1261, 0, 3),
          planStep(75, remainingAccountsInfo(), 3023, 0, 3),
        ],
      }),
    );
    const { routes } = analyze(patched);
    const envelope = onlyEnvelope(routes);
    expect(envelope.intent.declaredInAmount).toBe(envelope.intent.quotedOutAmount);
    expect(envelope.intent.declaredMinOutAmount).toBe(1_000_000n);
    expect(envelope.state).toBe('proven');
    expect(envelope.conflicts).toEqual([]);
  });
});

describe('8. a chain whose weights sum past 10 000', () => {
  it('applies no global-sum rule at all', () => {
    const envelope = onlyEnvelope(routeFixture('v1-failed-custom11').routes);
    expect(envelope.plan.steps.map(step => step.bps)).toEqual([10_000, 10_000, 10_000, 10_000]);
    expect(envelope.plan.complete).toBe(true);
    expect(envelope.conflicts).toEqual([]);
    // There is no check that could reject a weight sum: the ids are fixed and none
    // of them is about arithmetic on the weights.
    expect(envelope.checks.map(entry => entry.id)).not.toContain('plan-leg-alignment'.replace('alignment', 'weights-sum'));
    expect(envelope.checks.some(entry => entry.id.includes('sum'))).toBe(false);
  });
});

describe('9. the same pubkey in two account slots', () => {
  it('reads roles positionally and collapses nothing', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const route = transaction.instructions[3];
    const accounts = [...(route?.accounts ?? [])];
    accounts[1] = accounts[2] as string; // same account for source and destination
    const patched = patchInstruction(transaction, null, 3, { accounts });
    const envelope = onlyEnvelope(analyze(patched).routes);
    expect(envelope.accounts.userSourceTokenAccount).toBe(envelope.accounts.userDestinationTokenAccount);
    expect(envelope.accounts.accountSlotCount).toBe(81);
    expect(envelope.accounts.remainingAccountCount).toBe(71);
    expect(envelope.state).toBe('proven');
  });

  it('keeps the optional slot 7 even though it holds the program id', () => {
    const envelope = onlyEnvelope(routeFixture('v0-success-swap').routes);
    expect(envelope.accounts.destinationTokenAccount).toBe(JUP6);
    expect(envelope.accounts.program).toBe(JUP6);
  });
});

describe('10. one plan step dispatching two inner instructions', () => {
  it('is not treated as a step/leg count agreement', () => {
    const { transaction } = routeFixture('v0-success-swap');
    // One step, but the route still dispatched three AMM instructions: the extras
    // are leftovers, not an error.
    const patched = withRouteData(
      transaction,
      routeV2Data({
        declaredInAmount: 4_774_791_332_475n,
        quotedOutAmount: 15_234_269_261n,
        slippageBps: 774,
        platformFeeBps: 10,
        steps: [planStep(148, [], 10_000, 0, 3)],
      }),
    );
    const { routes } = analyze(patched);
    const envelope = onlyEnvelope(routes);
    expect(envelope.plan.steps).toHaveLength(1);
    expect(envelope.legs).toHaveLength(3);
    expect(envelope.planAlignment.status).toBe('partial');
    expect(routeOutcome(envelope, 'plan-leg-alignment')).toBe('pass');
    expect(envelope.planAlignment.detail).toContain('not referenced by the plan');
    expect(envelope.legs.map(leg => leg.planStepIndex)).toEqual([0, null, null]);
    expect(envelope.state).toBe('proven');
  });
});

describe('11. a fee transfer in the destination mint', () => {
  it('is infrastructure, never a leg and never a route amount', () => {
    const { transaction, effects } = routeFixture('v0-success-swap');
    const envelope = onlyEnvelope(analyze(transaction).routes);
    // The last instruction of the subtree is the token move the route paid: counted
    // as infrastructure, absent from the legs.
    expect(envelope.legAccounting).toEqual({ legCount: 3, selfCallCount: 1, infrastructureCount: 1 });
    expect(envelope.legs.some(leg => leg.ref.index === 19)).toBe(false);

    // The route model carries exactly three bigints: the two declared values plus the
    // derived route-level minimum. No movement the transaction performed appears.
    expect(new Set(bigintsIn(envelope).map(String))).toEqual(
      new Set(['4774791332475', '15234269261', '14055136820']),
    );
    // …including the user's own receipt in the destination mint.
    const destinationMint = envelope.accounts.destinationMint;
    const receipt = effects.tokenFlows
      .filter(flow => flow.mint === destinationMint)
      .map(flow => flow.amount)
      .filter((amount): amount is bigint => amount !== null);
    expect(receipt.length).toBeGreaterThan(0);
    for (const amount of receipt) {
      expect(bigintsIn(envelope).map(String)).not.toContain(amount.toString());
    }
  });
});

describe('12. positive_slippage_bps is not zero', () => {
  it('is raw metadata: the unknown is recorded and nothing is claimed about it', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const patched = withRouteData(
      transaction,
      routeV2Data({
        declaredInAmount: 4_774_791_332_475n,
        quotedOutAmount: 15_234_269_261n,
        slippageBps: 774,
        platformFeeBps: 10,
        positiveSlippageBps: 100,
        steps: [
          planStep(148, [], 5716, 0, 3),
          planStep(75, remainingAccountsInfo(), 1261, 0, 3),
          planStep(75, remainingAccountsInfo(), 3023, 0, 3),
        ],
      }),
    );
    const envelope = onlyEnvelope(analyze(patched).routes);
    expect(envelope.intent.positiveSlippageBps).toBe(100);
    expect(envelope.unknowns).toContain('positive-slippage-purpose-unknown');
    expect(envelope.state).toBe('proven');
    expect(envelope.conflicts).toEqual([]);
  });
});

describe('13. a nested route_v2', () => {
  it('is recognized where it sits and is listed as a dispatched instruction of the outer route', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const nestedPayload = routeV2Data({
      declaredInAmount: 5n,
      quotedOutAmount: 6n,
      slippageBps: 0,
      steps: [planStep(148, [], 10_000, 0, 1)],
    });
    // The nested route sits one level below the outer one and dispatches its own
    // instruction one level below that.
    const withNested = insertInnerInstruction(transaction, 3, 19, {
      index: 20,
      outerIndex: 3,
      programId: JUP6,
      programName: null,
      parsedType: null,
      parsedInfo: null,
      accounts: transaction.instructions[3]?.accounts ?? [],
      data: nestedPayload,
      dataEncoding: 'base58',
      stackHeight: 2,
      decoding: 'rpc-partially-decoded',
    });
    const inserted = insertInnerInstruction(withNested, 3, 20, {
      ...legTemplate(transaction),
      index: 21,
      stackHeight: 3,
    });
    const { routes } = analyze(inserted);
    expect(routes.counts.recognized).toBe(2);

    const nested = envelopeAt(routes, 3, 20);
    expect(nested.ref.path).toBe('inner');
    expect(nested.intent.declaredInAmount).toBe(5n);
    expect(nested.legs.map(leg => leg.ref.index)).toEqual([21]);
    expect(nested.planAlignment.status).toBe('aligned');

    const outer = envelopeAt(routes, null, 3);
    const nestedLeg = outer.legs.find(leg => leg.ref.index === 20);
    expect(nestedLeg?.instructionName).toBe('route_v2');
    expect(nestedLeg?.programId).toBe(JUP6);
    expect(nestedLeg?.coveredBy).toBeNull();
    // The grandchild is not the outer route's leg, and the nested route is one more
    // dispatched instruction the outer plan does not mention.
    expect(outer.legAccounting).toEqual({ legCount: 4, selfCallCount: 1, infrastructureCount: 1 });
    expect(outer.planAlignment.status).toBe('partial');
    expect(outer.legs.filter(leg => leg.instructionName !== 'route_v2')).toHaveLength(3);
  });
});

describe('14. an unrelated sibling touching the same accounts', () => {
  it('does not contaminate the route’s legs', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const before = onlyEnvelope(analyze(transaction).routes).legs.map(leg => refKey(leg.ref));

    // The same AMM program, with the same accounts, invoked from a *different*
    // top-level instruction's subtree (the ATA instruction's CPIs).
    const inserted = insertInnerInstruction(transaction, 2, 3, {
      ...legTemplate(transaction),
      index: 4,
      outerIndex: 2,
    });
    const { routes } = analyze(inserted);
    const envelope = envelopeAt(routes, null, 3);
    expect(envelope.legs.map(leg => refKey(leg.ref))).toEqual(before);
    expect(envelope.legs.every(leg => leg.ref.outerIndex === 3)).toBe(true);
    expect(envelope.legAccounting.legCount).toBe(3);
    expect(envelope.state).toBe('proven');
  });

  it('does not treat an instruction from another top-level call as a leg either', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const sameProgramElsewhere = insertInnerInstruction(transaction, 2, 3, {
      ...legTemplate(transaction),
      index: 4,
      outerIndex: 2,
    });
    const routes = recognizeRoutes(sameProgramElsewhere, {
      swaps: recognizeSwaps(sameProgramElsewhere, { effects: transactionEffects(sameProgramElsewhere) }),
    });
    const envelope = onlyEnvelope(routes);
    expect(envelope.legs.map(leg => leg.programId)).not.toContain(undefined);
    expect(envelope.legs.every(leg => leg.programId !== PUMP_AMM || leg.ref.outerIndex === 3)).toBe(true);
  });
});

/** JSON replacer for `expect` messages: bigints are not serializable. */
function bigintToText(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

describe('recognizer-level truncation and malformed plans', () => {
  function patchedFixture(
    stepCountOverride: number,
    steps: readonly (readonly number[])[],
    trailingBytes: readonly number[] = [],
  ) {
    const { transaction } = routeFixture('v0-success-swap');
    return analyze(
      withRouteData(
        transaction,
        routeV2Data({
          declaredInAmount: 4_774_791_332_475n,
          quotedOutAmount: 15_234_269_261n,
          slippageBps: 774,
          platformFeeBps: 10,
          stepCountOverride,
          steps,
          trailingBytes,
        }),
      ),
    );
  }

  it('reads an absurd declared count as an incomplete plan without allocating for it', () => {
    const { routes } = patchedFixture(1_000_000_000, [planStep(148, [], 5716, 0, 3)]);
    const envelope = onlyEnvelope(routes);
    expect(envelope.plan.declaredStepCount).toBe(1_000_000_000);
    expect(envelope.plan.steps).toHaveLength(1);
    expect(envelope.plan.complete).toBe(false);
    expect(envelope.plan.detail).toContain('the payload ends after 1');
    expect(envelope.state).toBe('partially-proven');
    expect(envelope.legs.every(leg => leg.planStepIndex === null)).toBe(true);
  });

  it('reads a declared count of zero as a complete, empty plan', () => {
    const { routes } = patchedFixture(0, []);
    const envelope = onlyEnvelope(routes);
    expect(envelope.plan).toMatchObject({ declaredStepCount: 0, complete: true, steps: [] });
    // Nothing claims the dispatched instructions belong to the plan.
    expect(envelope.legAccounting.legCount).toBe(3);
    expect(envelope.legs.every(leg => leg.planStepIndex === null)).toBe(true);
    // With no step declared there is nothing to align, so the route stays short of
    // a clean proof — and says so rather than treating "no steps" as success.
    expect(envelope.planAlignment.status).toBe('not-checkable');
    expect(envelope.planAlignment.detail).toContain('declares no step');
    expect(envelope.state).toBe('partially-proven');
  });

  it('stops at a truncated known variant and keeps the steps it did read', () => {
    // Tag 75 needs four payload bytes; the second step is cut off before them.
    const { routes } = patchedFixture(3, [
      planStep(148, [], 5716, 0, 3),
      planStep(75, [], 1261, 0, 3),
      planStep(75, [0], 3023, 0, 3),
    ]);
    const envelope = onlyEnvelope(routes);
    expect(envelope.plan.declaredStepCount).toBe(3);
    expect(envelope.plan.steps.map(step => step.swapTag)).toEqual([148]);
    expect(envelope.plan.complete).toBe(false);
    expect(envelope.plan.detail).toContain('step 1 (tag 75)');
    expect(envelope.state).toBe('partially-proven');
    expect(envelope.intent.declaredInAmount).toBe(4_774_791_332_475n);
    expect(envelope.unknowns).toContain('plan-not-fully-decoded');
  });

  it('keeps every header field when the plan is unreadable, and never invents a step', () => {
    const { routes } = patchedFixture(2, [planStep(146, [0, 0], 5716, 0, 3)]);
    const envelope = onlyEnvelope(routes);
    expect(envelope.intent).toMatchObject({
      declaredInAmount: 4_774_791_332_475n,
      quotedOutAmount: 15_234_269_261n,
      slippageBps: 774,
      platformFeeBps: 10,
      positiveSlippageBps: 0,
    });
    expect(envelope.plan.steps).toEqual([]);
    expect(envelope.plan.detail).toContain('dynamicV2');
    expect(envelope.plan.detail).toContain('item encoding is not resolved');
  });
});

describe('a route owns no movement, so it can never be double-counted', () => {
  it('is unchanged when the route layer is not applied at all', () => {
    for (const name of ['v0-success-swap', 'v1-failed-custom11', 'v1-failed-custom6001']) {
      const { transaction, effects } = routeFixture(name);
      const swapsAlone = recognizeSwaps(transaction, { effects });
      const { swaps } = analyze(transaction);
      expect(JSON.stringify(swaps, bigintToText), name).toBe(JSON.stringify(swapsAlone, bigintToText));
      // The route layer consumes a swap report; it never contributes to one.
      expect(swaps.legs.every(leg => leg.ref.path === 'inner' || leg.ref.path === 'top-level'), name).toBe(true);
    }
  });

  it('carries no amount-shaped field outside the declared intent', () => {
    const envelope = onlyEnvelope(routeFixture('v0-success-swap').routes);
    const offending: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        const here = `${path}.${key}`;
        if (
          typeof entry === 'bigint' &&
          !/^\.intent\.(declaredInAmount|quotedOutAmount|declaredMinOutAmount)$/.test(here)
        ) {
          offending.push(here);
        }
        walk(entry, here);
      }
    };
    walk(envelope, '');
    expect(offending).toEqual([]);
  });

  it('has no field named after a movement, in either the model or the JSON', () => {
    const envelope = onlyEnvelope(routeFixture('v0-success-swap').routes);
    const names: string[] = [];
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        names.push(key);
        walk(entry);
      }
    };
    walk(envelope);
    for (const name of ['amountIn', 'amountOut', 'inAmount', 'outAmount', 'received', 'spent', 'delta', 'executed', 'realized']) {
      expect(names, name).not.toContain(name);
    }
  });
});


describe('malformed payloads', () => {
  it('leaves a route whose header is truncated unrecognized, and says why', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const original = decodeBase58Data(transaction.instructions[3]?.data ?? '');
    expect(original).not.toBeNull();
    // Truncate the payload's bytes (not its base58 text) inside the header.
    const patched = withRouteData(transaction, base58([...(original ?? []).slice(0, 28)]));
    const { routes } = analyze(patched);
    expect(routes.envelopes).toEqual([]);
    expect(routes.counts.recognized).toBe(0);
    const note = routes.diagnostics.find(entry => entry.code === 'jupiter-route-v2-header-not-recognized');
    expect(note).toBeDefined();
    expect(note?.ref?.index).toBe(3);
    expect(note?.message).toContain('truncated');
  });

  it('keeps a route whose plan is shorter than its declared count', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const patched = withRouteData(
      transaction,
      routeV2Data({
        declaredInAmount: 4_774_791_332_475n,
        quotedOutAmount: 15_234_269_261n,
        slippageBps: 774,
        platformFeeBps: 10,
        stepCountOverride: 4,
        steps: [planStep(148, [], 5716, 0, 3)],
      }),
    );
    const { routes } = analyze(patched);
    const envelope = onlyEnvelope(routes);
    expect(envelope.plan.declaredStepCount).toBe(4);
    expect(envelope.plan.steps).toHaveLength(1);
    expect(envelope.plan.detail).toContain('the payload ends after 1');
    expect(envelope.state).toBe('partially-proven');
  });

  it('reads the envelope without a swap report, and records what that costs', () => {
    const { transaction } = routeFixture('v0-success-swap');
    const routes = recognizeRoutes(transaction, {});
    const envelope = onlyEnvelope(routes);
    expect(envelope.legs.every(leg => leg.coveredBy === null)).toBe(true);
    expect(envelope.unknowns).toContain('swap-recognition-absent');
    expect(routes.diagnostics.map(note => note.code)).toContain('route-swap-report-absent');
    // The route itself is unaffected: intent and plan are instruction data.
    expect(envelope.plan.complete).toBe(true);
    expect(envelope.planAlignment.status).toBe('aligned');
  });
});
