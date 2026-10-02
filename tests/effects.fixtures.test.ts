/**
 * Every recorded mainnet fixture, through the effects layer.
 *
 * These six transactions are the only real data in the repository, so they are
 * where the layer has to hold up: no unexplained movement, no violated invariant,
 * no invented counterparty — and the same answer every time it is asked.
 *
 * The fixture-level arithmetic is checked here *independently* of the layer's own
 * diagnostics: the deltas are summed by hand from the normalized model and
 * compared with the flows, so a bug in the checks cannot hide a bug in the data.
 */

import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { isNativeMint } from '../src/effects/native.ts';
import { allFixtureNames, normalizeFixture } from './helpers/fixtures.ts';

function effectsOfFixture(name: string) {
  const { transaction } = normalizeFixture(name);
  return { transaction, effects: transactionEffects(transaction) };
}

const FIXTURES = allFixtureNames();

describe.each(FIXTURES)('%s', name => {
  const { transaction, effects } = effectsOfFixture(name);

  it('is deterministic', () => {
    const { transaction: again } = normalizeFixture(name);
    expect(stringifyJson(transactionEffects(again))).toBe(stringifyJson(effects));
  });

  it('explains every account it says it explained, and leaves nothing unexplained', () => {
    expect(effects.unattributedEffects).toEqual([]);
    for (const net of effects.netSolByAccount) {
      if (net.netLamports === null || net.netLamports === 0n) continue;
      expect(net.residualLamports, `sol ${net.address ?? '(no address)'}`).toBe(0n);
      expect(net.reconciliation, `sol ${net.address ?? '(no address)'}`).toBe('exact');
    }
    for (const net of effects.netTokenByAccountMint) {
      if (net.netAmount === null || net.netAmount === 0n) continue;
      expect(net.residualAmount, `token ${net.tokenAccount ?? '(no address)'}`).toBe(0n);
      expect(net.reconciliation, `token ${net.tokenAccount ?? '(no address)'}`).toBe('exact');
    }
    for (const ownerNet of effects.netTokenByOwnerMint) {
      if (ownerNet.netAmount === 0n) continue;
      expect(ownerNet.reconciliation, `owner ${ownerNet.owner ?? '(unknown)'}`).toBe('exact');
    }
  });

  it('conserves lamports apart from the fee', () => {
    // Summed from the normalized model's own deltas, not from the layer's fields.
    const deltaSum = transaction.solBalanceChanges.reduce(
      (sum, change) => sum + (change.deltaLamports ?? 0n),
      0n,
    );
    expect(deltaSum).toBe(-(transaction.feeLamports ?? 0n));
    expect(effects.diagnostics.some(note => note.code === 'effects-lamport-conservation-violated')).toBe(false);
    expect(effects.diagnostics.some(note => note.code === 'effects-sol-bookkeeping-violated')).toBe(false);
  });

  it('conserves tokens per mint', () => {
    for (const net of effects.netTokenByAccountMint) {
      if (net.mint === null || isNativeMint(net.mint)) continue;
      const rows = effects.netTokenByAccountMint.filter(row => row.mint === net.mint);
      expect(rows.every(row => row.netAmount !== null)).toBe(true);
      const changes = rows.reduce((sum, row) => sum + (row.netAmount ?? 0n), 0n);
      const minted = effects.tokenFlows
        .filter(flow => flow.mint === net.mint && flow.kind === 'mint')
        .reduce((sum, flow) => sum + (flow.amount ?? 0n), 0n);
      const burned = effects.tokenFlows
        .filter(flow => flow.mint === net.mint && flow.kind === 'burn')
        .reduce((sum, flow) => sum + (flow.amount ?? 0n), 0n);
      expect(changes, `mint ${net.mint}`).toBe(minted - burned);
    }
    expect(effects.diagnostics.some(note => note.code === 'effects-token-conservation-violated')).toBe(false);
    expect(effects.diagnostics.some(note => note.code === 'effects-token-conservation-not-checkable')).toBe(false);
  });

  it('reports no violated invariant', () => {
    expect(effects.diagnostics.filter(note => note.code.endsWith('-violated'))).toEqual([]);
  });

  it('keeps the raw payload out of the model', () => {
    const text = stringifyJson(effects);
    expect(text).not.toContain('logMessages');
    expect(text).not.toContain('"raw"');
    expect(text).not.toContain('preBalances');
  });

  it('marks every effect with the commitment the transaction earned', () => {
    const committed = [...effects.solFlows, ...effects.tokenFlows, ...effects.accountLifecycleEffects];
    if (transaction.status === 'success') {
      expect(effects.commitState).toBe('committed');
      expect(committed.every(effect => effect.commitState === 'committed')).toBe(true);
      expect(effects.uncommittedSolFlows).toEqual([]);
      expect(effects.uncommittedTokenFlows).toEqual([]);
      expect(effects.uncommittedLifecycleEffects).toEqual([]);
    } else {
      expect(effects.commitState).toBe('reverted');
      const uncommitted = [
        ...effects.uncommittedSolFlows,
        ...effects.uncommittedTokenFlows,
        ...effects.uncommittedLifecycleEffects,
      ];
      expect(uncommitted.every(effect => effect.commitState === 'reverted')).toBe(true);
      // Only the fee committed, which is what a rolled-back transaction leaves behind.
      expect(effects.solFlows.map(flow => flow.kind)).toEqual(['fee']);
      expect(effects.tokenFlows).toEqual([]);
      expect(effects.accountLifecycleEffects).toEqual([]);
      const changed = effects.netSolByAccount.filter(net => (net.netLamports ?? 0n) !== 0n);
      expect(changed.map(net => net.address)).toEqual([transaction.feePayerAddress]);
      expect(changed[0]?.netLamports).toBe(-(transaction.feeLamports ?? 0n));
    }
  });
});

describe('what each recorded transaction proves', () => {
  it('reads the swap: one ATA created and closed, ten token movements, seven lamport legs', () => {
    const { effects } = effectsOfFixture('v0-success-swap');

    expect(effects.counts).toMatchObject({ proven: 20, reconciled: 3, unattributed: 0, amountNotObservable: 0 });
    expect(effects.solFlows.filter(flow => flow.kind === 'native-token-leg')).toHaveLength(7);
    expect(effects.tokenFlows.filter(flow => flow.kind === 'transfer')).toHaveLength(10);

    const created = effects.accountLifecycleEffects.find(effect => effect.kind === 'token-account-create');
    expect(created).toMatchObject({ outcome: 'created', lamportsDeposited: 1_488_440n });
    const closed = effects.accountLifecycleEffects.find(effect => effect.kind === 'token-account-closed');
    expect(closed).toMatchObject({
      lamportsReturned: 15_222_066_461n,
      unwrappedLamports: 15_220_578_021n,
      otherLamports: 1_488_440n,
      lamportsAtStart: 0n,
      returnComposition: 'in-transaction-lamports',
      confidence: 'reconciled',
    });
    // The fee payer ends the transaction up by exactly what the wrapped account
    // returned, minus the fee and the tokens they sent out — all reconciled.
    const payer = effects.netSolByAccount.find(net => net.isFeePayer);
    expect(payer).toMatchObject({ netLamports: 15_220_557_121n, reconciliation: 'exact' });

    // A wrapped-SOL transfer is one movement seen twice: the token delta and the
    // lamport delta agree exactly.
    const tokenNet = effects.netTokenByAccountMint.find(net => net.tokenAccount?.startsWith('GyY4VgEp') === true);
    const solNet = effects.netSolByAccount.find(net => net.address === tokenNet?.tokenAccount);
    expect(tokenNet?.netAmount).toBe(15_235_813n);
    expect(solNet?.netLamports).toBe(tokenNet?.netAmount);
  });

  it('reads the closing transaction: two no-op creates, one real change, one close', () => {
    const { effects } = effectsOfFixture('token-mixed-closeAccount');

    const creates = effects.accountLifecycleEffects.filter(effect => effect.kind === 'token-account-create');
    expect(creates.map(effect => effect.outcome)).toEqual(['created', 'no-op', 'no-op']);
    // A wrapped-SOL account closed after a `syncNative` cannot be split into
    // unwrapped balance and other lamports, and the layer says so instead of
    // dividing it up.
    const closed = effects.accountLifecycleEffects.find(effect => effect.kind === 'token-account-closed');
    expect(closed).toMatchObject({
      lamportsReturned: 1_488_440n,
      unwrappedLamports: null,
      otherLamports: null,
      lamportsCredited: 1_673_796n,
      lamportsSpent: 185_356n,
      returnComposition: 'in-transaction-lamports',
    });
    expect(effects.diagnostics.map(note => note.code)).toEqual([
      'effects-create-deposit-stated-elsewhere',
      'effects-close-composition-not-observable',
    ]);
    expect(effects.netSolByAccount.find(net => net.isFeePayer)?.netLamports).toBe(-190_356n);
  });

  it('reads the approve as a delegation and the movement beside it as a transfer', () => {
    const { effects } = effectsOfFixture('token-mixed-approve');

    const allowance = effects.accountLifecycleEffects.find(effect => effect.kind === 'allowance-set');
    expect(allowance).toMatchObject({ confidence: 'proven', tokenAccount: expect.any(String) });
    expect(effects.tokenFlows.map(flow => flow.kind)).toEqual(['transfer']);
    expect(effects.tokenFlows[0]?.amount).toBe(393n);
    // The delegation is a state change, not a value movement: it produces no flow.
    expect(effects.solFlows.map(flow => flow.kind)).toEqual(['fee']);
    expect(effects.netTokenByOwnerMint.map(net => net.netAmount).toSorted()).toEqual([-393n, 393n]);
  });

  it('reads the vote transaction as a fee and nothing else', () => {
    const { effects } = effectsOfFixture('legacy-success-vote');

    expect(effects.solFlows).toHaveLength(1);
    expect(effects.solFlows[0]).toMatchObject({ kind: 'fee', lamports: 5_000n, to: null });
    expect(effects.tokenFlows).toEqual([]);
    expect(effects.accountLifecycleEffects).toEqual([]);
    expect(effects.diagnostics).toEqual([]);
  });

  it('reads both failed transactions as a fee and a rollback', () => {
    const expected: Record<string, { fee: bigint; uncommitted: number }> = {
      'v1-failed-custom11': { fee: 6_632n, uncommitted: 9 },
      'v1-failed-custom6001': { fee: 5_056n, uncommitted: 4 },
    };
    for (const [name, numbers] of Object.entries(expected)) {
      const { effects } = effectsOfFixture(name);
      expect(effects.commitState, name).toBe('reverted');
      expect(effects.solFlows, name).toHaveLength(1);
      expect(effects.solFlows[0]?.lamports, name).toBe(numbers.fee);
      expect(effects.counts.uncommitted, name).toBe(numbers.uncommitted);
      expect(effects.diagnostics.map(note => note.code), name).toEqual([
        'effects-transaction-reverted',
        'effects-rollback-confirmed',
      ]);
    }
  });
});
