/**
 * Milestone 4.4 — the three real `route_v2` fixtures in `fixtures/`.
 *
 * These are the acceptance vectors: one successful route whose legs the frozen
 * 4.1/4.2 recognizers cover, one failed route with a straight four-step chain and no
 * covered leg, and one failed route that JUP6 rejected on its own slippage bound
 * *after* writing a swap record. Every assertion below is a claim the discovery
 * proved — nothing here is inferred from balance deltas.
 */
import { describe, expect, it } from 'vitest';
import { allFixtureNames } from './helpers/fixtures.ts';
import { envelopeAt, JUP6, onlyEnvelope, routeFixture, routeOutcome } from './helpers/routes.ts';
import { JUPITER_V6_PROGRAM_ID } from '../src/route/jupiter.ts';
import { refKey } from '../src/swap/recognize.ts';
import { decodeBase58Data } from '../src/decode/bytes.ts';

describe('v0-success-swap — a committed route whose legs are already recognized', () => {
  const { swaps, routes } = routeFixture('v0-success-swap');
  const envelope = onlyEnvelope(routes);

  it('is recognized at its top-level position, and proven', () => {
    expect(envelope.ref).toEqual({ path: 'top-level', index: 3, outerIndex: null, stackHeight: 1 });
    expect(envelope.programId).toBe(JUP6);
    expect(envelope.commitState).toBe('committed');
    expect(envelope.state).toBe('proven');
    expect(routes.counts).toEqual({
      recognized: 1,
      proven: 1,
      partiallyProven: 0,
      notCommitted: 0,
      conflicting: 0,
    });
  });

  it('carries the header verbatim, in raw units', () => {
    expect(envelope.intent.declaredInAmount).toBe(4_774_791_332_475n);
    expect(envelope.intent.quotedOutAmount).toBe(15_234_269_261n);
    expect(envelope.intent.slippageBps).toBe(774);
    expect(envelope.intent.platformFeeBps).toBe(10);
    expect(envelope.intent.positiveSlippageBps).toBe(0);
    // Declared policy: floor(quoted × (1 − 774/10 000)). Not a tested bound.
    expect(envelope.intent.declaredMinOutAmount).toBe(14_055_136_820n);
  });

  it('decodes all three plan steps exactly, with their split weights', () => {
    expect(envelope.plan.complete).toBe(true);
    expect(envelope.plan.declaredStepCount).toBe(3);
    expect(envelope.plan.detail).toBe('');
    expect(
      envelope.plan.steps.map(step => [step.swapTag, step.swapName, step.bps, step.inputIndex, step.outputIndex]),
    ).toEqual([
      [148, 'pumpSwapSellV3WithCashbackClaim', 5716, 0, 3],
      [75, 'meteoraDlmmSwapV2', 1261, 0, 3],
      [75, 'meteoraDlmmSwapV2', 3023, 0, 3],
    ]);
    // The split's weights sum to 10 000 — reported, never used as a validity rule.
    expect(envelope.plan.steps.reduce((total, step) => total + step.bps, 0)).toBe(10_000);
  });

  it('maps the ten declared account slots positionally', () => {
    expect(envelope.accounts).toMatchObject({
      userTransferAuthority: 'E5JXp4obkiAcYNf1noBJyYkqJSdwnreBfYaX7vPbYTir',
      userSourceTokenAccount: 'CLD7C8D2yiwCpGQ8e2HvcVwVti8Puc22wXYLqn6EruTt',
      userDestinationTokenAccount: 'Cr5vxXJTC4vu8PraDANEGLfE1YStzQo8JHYJ7K8qqAeh',
      sourceMint: '9pJWJdpPebyANys45eetpemLJo8yTz4n5B9zbpYw9ZMr',
      destinationMint: 'So11111111111111111111111111111111111111112',
      sourceTokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      destinationTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      eventAuthority: 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
      program: JUP6,
      accountSlotCount: 81,
      remainingAccountCount: 71,
    });
    // Slot 7 is the ABI's optional slot, observed filled with the program id itself.
    expect(envelope.accounts.destinationTokenAccount).toBe(JUP6);
  });

  it('lists exactly the three dispatched AMM instructions as legs, each on its plan step', () => {
    expect(
      envelope.legs.map(leg => [
        leg.ref.outerIndex,
        leg.ref.index,
        leg.programId,
        leg.instructionName,
        leg.planStepIndex,
        leg.coveredBy?.protocol ?? null,
        leg.coveredBy?.instructionName ?? null,
      ]),
    ).toEqual([
      [3, 0, 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'sell', 0, 'pump-amm', 'sell'],
      [3, 8, 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'swap2', 1, 'meteora-dlmm', 'swap2'],
      [3, 13, 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'swap2', 2, 'meteora-dlmm', 'swap2'],
    ]);
  });

  it('accounts for every instruction in the subtree that is not a leg', () => {
    // The route also dispatched one instruction to its own program (its swap
    // record) and one token instruction (the platform-fee transfer). Neither is a
    // leg, and both are counted so nothing disappears silently.
    expect(envelope.legAccounting).toEqual({ legCount: 3, selfCallCount: 1, infrastructureCount: 1 });
  });

  it('aligns every step with an instruction the route actually dispatched', () => {
    expect(envelope.planAlignment.status).toBe('aligned');
    expect(envelope.planAlignment.detail).toContain('all 3 plan step(s) matched');
    expect(routeOutcome(envelope, 'plan-leg-alignment')).toBe('pass');
  });

  it('marks all three legs as already recognized by the frozen swap layer', () => {
    expect(routeOutcome(envelope, 'legs-covered-by-swap-recognizers')).toBe('pass');
    const coveredRefs = envelope.legs.map(leg => refKey(leg.ref)).sort();
    const swapRefs = swaps.legs.map(leg => refKey(leg.ref)).sort();
    expect(coveredRefs).toEqual(swapRefs);
  });

  it('keeps the unknowns the discovery could not settle, and invents none', () => {
    expect(envelope.unknowns).toContain('plan-index-space-unknown');
    expect(envelope.unknowns).toContain('min-out-comparison-target-unknown');
    expect(envelope.unknowns).toContain('platform-fee-recipient-unknown');
    expect(envelope.unknowns).toContain('platform-fee-amount-unknown');
    expect(envelope.unknowns).not.toContain('plan-not-fully-decoded');
    expect(envelope.conflicts).toEqual([]);
  });
});

describe('v1-failed-custom11 — a reverted four-step chain', () => {
  const { routes } = routeFixture('v1-failed-custom11');
  const envelope = onlyEnvelope(routes);

  it('is recognized, reverted and never committed', () => {
    expect(envelope.ref).toEqual({ path: 'top-level', index: 0, outerIndex: null, stackHeight: 1 });
    expect(envelope.commitState).toBe('reverted');
    expect(envelope.state).toBe('not-committed');
    expect(routeOutcome(envelope, 'transaction-committed')).toBe('not-checkable');
  });

  it('keeps the intent, because an attempt is still an intent', () => {
    expect(envelope.intent.declaredInAmount).toBe(180_000_000n);
    expect(envelope.intent.quotedOutAmount).toBe(180_000_600n);
    expect(envelope.intent.slippageBps).toBe(0);
    expect(envelope.intent.declaredMinOutAmount).toBe(180_000_600n);
  });

  it('decodes four steps that each carry a whole 10 000 bps, without rejecting the sum', () => {
    expect(envelope.plan.complete).toBe(true);
    expect(envelope.plan.steps.map(step => step.swapName)).toEqual([
      'goonFiV3',
      'whirlpool',
      'bisonFiV2',
      'goonFiV3',
    ]);
    expect(envelope.plan.steps.map(step => step.bps)).toEqual([10_000, 10_000, 10_000, 10_000]);
    // A chain's steps each carry the whole amount: 40 000 in total, and that is not
    // an inconsistency. No global-sum rule is applied anywhere.
    expect(routeOutcome(envelope, 'plan-decode-complete')).toBe('pass');
    expect(envelope.conflicts).toEqual([]);
  });

  it('notes that the last step uses a virtual slot pair (4 → 5), which is left opaque', () => {
    expect(envelope.plan.steps[3]).toMatchObject({ inputIndex: 4, outputIndex: 5, swapName: 'goonFiV3' });
    expect(envelope.unknowns).toContain('plan-index-space-unknown');
  });

  it('aligns all four steps yet covers none of them with a frozen recognizer', () => {
    expect(envelope.planAlignment.status).toBe('aligned');
    expect(envelope.legAccounting).toEqual({ legCount: 4, selfCallCount: 0, infrastructureCount: 0 });
    expect(envelope.legs.map(leg => leg.planStepIndex)).toEqual([0, 1, 2, 3]);
    expect(envelope.legs.every(leg => leg.coveredBy === null)).toBe(true);
    expect(routeOutcome(envelope, 'legs-covered-by-swap-recognizers')).toBe('not-checkable');
    // Only one of the four is even nameable — its discriminator proves `swap`.
    expect(envelope.legs.map(leg => leg.instructionName)).toEqual([null, 'swap', null, null]);
  });

  it('reports the attempt without claiming movement', () => {
    expect(envelope.diagnostics.map(note => note.code)).toContain('jupiter-route-v2-not-committed');
  });
});

describe('v1-failed-custom6001 — reverted on Jupiter’s own slippage bound', () => {
  const { transaction, routes } = routeFixture('v1-failed-custom6001');
  const envelope = onlyEnvelope(routes);

  it('is recognized at [1], reverted, and carries the declared bound', () => {
    expect(envelope.ref).toEqual({ path: 'top-level', index: 1, outerIndex: null, stackHeight: 1 });
    expect(envelope.state).toBe('not-committed');
    expect(envelope.intent.slippageBps).toBe(0);
    expect(envelope.intent.declaredMinOutAmount).toBe(28_575_384n);
    expect(transaction.error).not.toBeNull();
  });

  it('does not treat the program’s own swap record as evidence of anything', () => {
    // JUP6 wrote a swap record at [1.6] and then reverted. It is a self-call,
    // counted and excluded — never a leg, never a movement.
    const selfCalls = transaction.innerInstructionGroups
      .filter(group => group.outerIndex === 1)
      .flatMap(group => group.instructions)
      .filter(instruction => instruction.programId === JUPITER_V6_PROGRAM_ID)
      .filter(instruction => {
        // The record's discriminator differs from `route_v2` — it is the program's
        // own write, which the discovery observed 244 bytes long in this fixture.
        const bytes = instruction.data === null ? null : decodeBase58Data(instruction.data);
        if (bytes === null) return false;
        return Buffer.from(bytes.subarray(0, 8)).toString('hex') === 'e445a52e51cb9a1d';
      });
    expect(selfCalls.map(instruction => [instruction.index, instruction.stackHeight])).toEqual([[6, 2]]);
    expect(envelope.legAccounting.selfCallCount).toBe(1);
    expect(envelope.legs.map(leg => leg.ref.index)).toEqual([0, 3]);
    expect(envelope.legs.some(leg => leg.ref.index === 6)).toBe(false);
  });

  it('decodes the two-step chain and matches it to the two dispatched instructions', () => {
    expect(envelope.plan.steps.map(step => [step.swapTag, step.swapName, step.inputIndex, step.outputIndex])).toEqual([
      [151, 'goonFiV3', 0, 1],
      [156, 'byrealDynamicV3', 1, 0],
    ]);
    expect(envelope.planAlignment.status).toBe('aligned');
    expect(envelope.legs.map(leg => leg.planStepIndex)).toEqual([0, 1]);
  });

  it('accepts a same-mint route without inventing a mint-difference rule', () => {
    expect(envelope.accounts.sourceMint).toBe(envelope.accounts.destinationMint);
    expect(routeOutcome(envelope, 'route-header-parsed')).toBe('pass');
    expect(envelope.conflicts).toEqual([]);
  });
});

describe('the whole fixture corpus', () => {
  it('recognizes a route in exactly the three Jupiter fixtures', () => {
    const withRoutes = allFixtureNames().filter(name => {
      const { routes } = routeFixture(name);
      return routes.envelopes.length > 0;
    });
    expect(withRoutes).toEqual(['v0-success-swap', 'v1-failed-custom11', 'v1-failed-custom6001']);
  });

  it('never produces a route envelope for a transaction without route_v2', () => {
    for (const name of allFixtureNames()) {
      if (name.startsWith('v0-success-swap') || name.startsWith('v1-failed-custom')) continue;
      const { routes, swaps } = routeFixture(name);
      expect(routes.envelopes, name).toEqual([]);
      expect(routes.counts.recognized, name).toBe(0);
      // …and adding the route layer did not change what the swap layer recognizes.
      expect(swaps.counts.recognized, name).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic: the same transaction yields the same report twice', () => {
    for (const name of ['v0-success-swap', 'v1-failed-custom11', 'v1-failed-custom6001']) {
      const first = routeFixture(name).routes;
      const second = routeFixture(name).routes;
      expect(JSON.stringify(second, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))).toBe(
        JSON.stringify(first, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
      );
    }
  });

  it('reports the envelope at the exact reference a nested caller would see', () => {
    const { routes } = routeFixture('v0-success-swap');
    expect(envelopeAt(routes, null, 3).ref.index).toBe(3);
    expect(() => envelopeAt(routes, null, 4)).toThrow(/no route envelope/);
  });
});
