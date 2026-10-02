/**
 * Effects: lamport movement, net SOL per account, and what happens when an
 * amount or a balance is not readable.
 *
 * Every balance row in these tests is written out by hand, and the expected
 * numbers are derived from conservation (what leaves one account arrives at
 * another, minus the fee) rather than from the implementation.
 */

import { describe, expect, it } from 'vitest';
import { buildTransactionEffects } from '../src/effects/build.ts';
import { stringifyJson } from '../src/lib/format.ts';
import { ACC, SYSTEM, rawInstruction, system } from './helpers/instructions.ts';
import { account, effectsOf, scenario, type Scenario } from './helpers/effects.ts';

const FEES = { payer: ACC.funding, recipient: ACC.recipient } as const;

/** Payer sends `lamports` to the recipient and pays a 5000 lamport fee. */
function transferScenario(lamports: bigint, extra: Record<string, unknown> = {}) {
  const fee = 5000n;
  return effectsOf({
    fee,
    accounts: [
      account(0, FEES.payer, { signer: true, before: 1_000_000_000n, after: 1_000_000_000n - lamports - fee }),
      account(1, FEES.recipient, { before: 0n, after: lamports }),
    ],
    instructions: [rawInstruction(SYSTEM, system.transfer(lamports), [FEES.payer, FEES.recipient])],
    ...extra,
  });
}

describe('direct SOL movement', () => {
  it('reports the fee and the transfer as proven, and reconciles both accounts exactly', () => {
    const effects = transferScenario(500_000_000n);

    expect(effects.solFlows.map(flow => [flow.kind, flow.lamports, flow.confidence, flow.amountSource])).toEqual([
      ['fee', 5000n, 'proven', 'transaction-metadata'],
      ['transfer', 500_000_000n, 'proven', 'instruction-data'],
    ]);

    const payer = effects.netSolByAccount.find(net => net.address === FEES.payer);
    const recipient = effects.netSolByAccount.find(net => net.address === FEES.recipient);
    expect(payer?.netLamports).toBe(-500_005_000n);
    expect(payer?.residualLamports).toBe(0n);
    expect(payer?.reconciliation).toBe('exact');
    expect(recipient?.netLamports).toBe(500_000_000n);
    expect(recipient?.residualLamports).toBe(0n);
    expect(recipient?.reconciliation).toBe('exact');

    expect(effects.unattributedEffects).toEqual([]);
    expect(effects.counts).toMatchObject({ proven: 2, reconciled: 0, unattributed: 0, amountNotObservable: 0 });
  });

  it('marks the fee payer, and only asserts a recipient where an instruction names one', () => {
    const effects = transferScenario(1_000n);
    const payer = effects.netSolByAccount.find(net => net.address === FEES.payer);
    expect(payer?.isFeePayer).toBe(true);
    expect(effects.netSolByAccount.find(net => net.address === FEES.recipient)?.isFeePayer).toBe(false);
    // The fee flow has no recipient by construction: the RPC reports one total.
    expect(effects.solFlows[0]?.to).toBeNull();
  });

  it('keeps a CPI-mediated transfer tied to the inner instruction that made it', () => {
    const fee = 5000n;
    const lamports = 42n;
    const effects = effectsOf({
      fee,
      accounts: [
        account(0, ACC.funding, { signer: true, before: 1_000_000n, after: 1_000_000n - lamports - fee }),
        account(1, ACC.recipient, { before: 0n, after: lamports }),
      ],
      instructions: [rawInstruction(ACC.other, [1, 2, 3], [])],
      inner: new Map([
        [0, [rawInstruction(SYSTEM, system.transfer(lamports), [ACC.funding, ACC.recipient], { outerIndex: 0, stackHeight: 2 })]],
      ]),
    });

    const transfer = effects.solFlows.find(flow => flow.kind === 'transfer');
    expect(transfer?.ref).toEqual({ path: 'inner', index: 0, outerIndex: 0, stackHeight: 2 });
    expect(transfer?.actionKind).toBe('system.transfer');
    expect(effects.netSolByAccount.find(net => net.address === ACC.recipient)?.residualLamports).toBe(0n);
  });

  it('sums several transfers out of one account exactly', () => {
    const fee = 5000n;
    const first = 300n;
    const second = 700n;
    const effects = effectsOf({
      fee,
      accounts: [
        account(0, ACC.funding, { signer: true, before: 10_000n, after: 10_000n - first - second - fee }),
        account(1, ACC.recipient, { before: 0n, after: first }),
        account(2, ACC.other, { before: 0n, after: second }),
      ],
      instructions: [
        rawInstruction(SYSTEM, system.transfer(first), [ACC.funding, ACC.recipient]),
        rawInstruction(SYSTEM, system.transfer(second), [ACC.funding, ACC.other]),
      ],
    });

    expect(effects.solFlows.filter(flow => flow.kind === 'transfer')).toHaveLength(2);
    for (const address of [ACC.funding, ACC.recipient, ACC.other]) {
      expect(effects.netSolByAccount.find(net => net.address === address)?.reconciliation).toBe('exact');
    }
  });

  it('charges the fee and nothing else when there are no instructions', () => {
    const effects = effectsOf({
      fee: 5000n,
      accounts: [account(0, ACC.funding, { signer: true, before: 1_000_000n, after: 995_000n })],
    });

    expect(effects.solFlows).toHaveLength(1);
    expect(effects.solFlows[0]?.kind).toBe('fee');
    expect(effects.netSolByAccount[0]?.netLamports).toBe(-5000n);
    expect(effects.netSolByAccount[0]?.reconciliation).toBe('exact');
    expect(effects.tokenFlows).toEqual([]);
  });
});

describe('when the data is incomplete', () => {
  it('sizes an unreadable amount from both endpoints instead of assuming zero', () => {
    const effects = effectsOf({
      fee: 0n,
      accounts: [
        account(0, ACC.funding, { signer: true, before: 1_000n, after: 500n }),
        account(1, ACC.recipient, { before: 0n, after: 500n }),
      ],
      // Tag and a truncated lamport field: the decoder keeps the kind, not the amount.
      instructions: [rawInstruction(SYSTEM, [2, 0, 0, 0, 1], [ACC.funding, ACC.recipient])],
    });

    const transfer = effects.solFlows.find(flow => flow.kind === 'transfer');
    // The instruction proves the movement; the balances are the only thing that
    // can size it, and both endpoints agree on 500 — so it is reported as
    // reconciled, never as proven and never as zero.
    expect(transfer?.lamports).toBe(500n);
    expect(transfer?.amountSource).toBe('residual-reconciliation');
    expect(transfer?.confidence).toBe('reconciled');
    expect(effects.diagnostics.some(note => note.code === 'effects-amount-reconciled')).toBe(true);
    expect(effects.netSolByAccount.every(net => net.residualLamports === 0n)).toBe(true);
    expect(effects.unattributedEffects).toEqual([]);
    expect(effects.counts).toMatchObject({ amountNotObservable: 0, unattributed: 0 });
  });

  it('leaves an unreadable amount unattributed when a balance cannot size it', () => {
    const effects = effectsOf({
      fee: 0n,
      accounts: [
        // No lamport row for the payer's side, so nothing pins the amount down.
        account(0, ACC.funding, { signer: true, before: null, after: null }),
        account(1, ACC.recipient, { before: 0n, after: 500n }),
      ],
      instructions: [rawInstruction(SYSTEM, [2, 0, 0, 0, 1], [ACC.funding, ACC.recipient])],
    });

    const transfer = effects.solFlows.find(flow => flow.kind === 'transfer');
    expect(transfer?.lamports).toBeNull();
    expect(transfer?.amountSource).toBe('not-observable');
    expect(effects.counts.amountNotObservable).toBe(1);
    // Two entries, and both are honest: the recipient has an unexplained 500
    // lamports that only the unreadable flow could account for, and the payer has
    // no lamport row at all, so its own net change cannot be stated either.
    expect(effects.unattributedEffects.map(entry => entry.reason).toSorted()).toEqual([
      'amounts-not-separable',
      'delta-not-observable',
    ]);
    expect(effects.unattributedEffects.find(entry => entry.reason === 'amounts-not-separable')).toMatchObject({
      side: 'sol',
      amount: 500n,
      address: ACC.recipient,
      candidateRefs: [{ path: 'top-level', index: 0, outerIndex: null, stackHeight: 1 }],
    });
  });

  it('leaves a lamport delta it cannot explain unattributed, and claims no counterparty', () => {
    const fee = 5000n;
    const lamports = 100n;
    const effects = effectsOf({
      fee,
      accounts: [
        account(0, ACC.funding, { signer: true, before: 10_000n, after: 10_000n - lamports - fee }),
        // The recipient ends up 50 lamports richer than the instruction says.
        account(1, ACC.recipient, { before: 0n, after: lamports + 50n }),
      ],
      instructions: [rawInstruction(SYSTEM, system.transfer(lamports), [ACC.funding, ACC.recipient])],
    });

    const recipient = effects.netSolByAccount.find(net => net.address === ACC.recipient);
    expect(recipient?.residualLamports).toBe(50n);
    expect(recipient?.reconciliation).toBe('residual');
    expect(effects.unattributedEffects).toHaveLength(1);
    expect(effects.unattributedEffects[0]).toMatchObject({ reason: 'not-explained', amount: 50n });
    expect(effects.unattributedEffects[0]?.explanation).toContain('no sender or receiver is claimed');
    // No invented flow: the only committed flows are still the fee and the transfer.
    expect(effects.solFlows).toHaveLength(2);
    // The unexplained credit also means lamports do not add up, and both checks
    // say so independently.
    expect(effects.diagnostics.some(note => note.code === 'effects-lamport-conservation-violated')).toBe(true);
  });

  it('says so when an account has no usable lamport row', () => {
    const effects = effectsOf({
      fee: 0n,
      accounts: [
        account(0, ACC.funding, { signer: true, before: null, after: null }),
        account(1, ACC.recipient, { before: 0n, after: 10n }),
      ],
      instructions: [rawInstruction(SYSTEM, system.transfer(10n), [ACC.funding, ACC.recipient])],
    });

    const funding = effects.netSolByAccount.find(net => net.address === ACC.funding);
    expect(funding?.netLamports).toBeNull();
    expect(funding?.reconciliation).toBe('unknown');
    expect(effects.unattributedEffects.some(entry => entry.reason === 'delta-not-observable')).toBe(true);
  });

  it('reports a missing fee instead of assuming one', () => {
    const effects = effectsOf({
      fee: null,
      accounts: [account(0, ACC.funding, { signer: true, before: 1_000n, after: 1_000n })],
    });

    expect(effects.solFlows).toEqual([]);
    expect(effects.diagnostics.some(note => note.code === 'effects-fee-unknown')).toBe(true);
    expect(effects.counts.proven).toBe(0);
  });

  it('reports a fee it cannot attribute instead of guessing the payer', () => {
    const effects = effectsOf({
      fee: 5000n,
      feePayer: null,
      accounts: [account(0, ACC.funding, { signer: true, before: 1_000n, after: 1_000n })],
    });

    expect(effects.solFlows).toEqual([]);
    expect(effects.diagnostics.some(note => note.code === 'effects-fee-payer-unknown')).toBe(true);
  });
});

describe('lamport conservation', () => {
  it('is silent when the changes offset the fee exactly', () => {
    const effects = transferScenario(777n);
    expect(effects.diagnostics.filter(note => note.code === 'effects-lamport-conservation-violated')).toEqual([]);
  });

  it('warns when the account changes do not offset the fee', () => {
    const effects = effectsOf({
      fee: 5000n,
      accounts: [account(0, ACC.funding, { signer: true, before: 1_000_000n, after: 1_000_000n - 4000n })],
    });
    const warning = effects.diagnostics.find(note => note.code === 'effects-lamport-conservation-violated');
    expect(warning?.level).toBe('warning');
    expect(warning?.message).toContain('-4000');
  });

  it('checks that flows cancel, warning when one is aimed outside the transaction', () => {
    const effects = effectsOf({
      fee: 5000n,
      // `ACC.other` never appears in the account list, so the transfer's credit
      // lands nowhere while its debit is real.
      accounts: [account(0, ACC.funding, { signer: true, before: 10_000n, after: 10_000n - 100n - 5000n })],
      instructions: [rawInstruction(SYSTEM, system.transfer(100n), [ACC.funding, ACC.other])],
    });

    // The payer really did lose the lamports, and nothing in the account list
    // gained them, so both independent checks notice: the flow bookkeeping (a flow
    // that credits nobody) and total conservation (the deltas do not offset the fee).
    expect(effects.diagnostics.find(note => note.code === 'effects-sol-bookkeeping-violated')?.level).toBe('warning');
    expect(effects.diagnostics.some(note => note.code === 'effects-lamport-conservation-violated')).toBe(true);
    // And the change itself is still reported as exactly what the balances show.
    expect(effects.netSolByAccount[0]?.netLamports).toBe(-5_100n);
  });
});

describe('determinism and purity', () => {
  it('produces identical effects for the same input, twice', () => {
    const first = scenario({
      fee: 5000n,
      accounts: [
        account(0, ACC.funding, { signer: true, before: 10_000n, after: 4_000n }),
        account(1, ACC.recipient, { before: 0n, after: 6_000n }),
      ],
      instructions: [rawInstruction(SYSTEM, system.transfer(6_000n), [ACC.funding, ACC.recipient])],
    });
    const second = buildAgain(first);
    expect(stringifyJson(second)).toBe(stringifyJson(first.effects));
  });

  it('exposes only the canonical facts it is allowed to see', () => {
    const { input } = scenario({ accounts: [account(0, ACC.funding, { before: 1n, after: 1n })] });
    expect(Object.keys(input).toSorted()).toEqual([
      'accounts',
      'feeLamports',
      'feePayer',
      'status',
      'tokenBalancesAvailable',
      'tokenRows',
      'undecoded',
    ]);
    // The view has no slot for a raw payload or logs at all, so nothing in this
    // layer can start re-reading the response.
    for (const forbidden of ['raw', 'logs', 'instructions', 'data']) {
      expect(Object.keys(input)).not.toContain(forbidden);
    }
  });
});

function buildAgain(built: Scenario) {
  return buildTransactionEffects(built.input, built.actions);
}
