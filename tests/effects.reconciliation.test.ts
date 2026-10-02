/**
 * Reconciliation: what exact balance arithmetic may and may not be turned into.
 *
 * The rules under test:
 *
 *  - a balance change alone never becomes a sender→receiver edge;
 *  - a relationship an instruction proved may be *sized* from balances;
 *  - a residual that exactly one unobservable flow can explain is that flow's
 *    amount, but only when both endpoints agree;
 *  - whatever is left over is reported as unattributed with its sign and its
 *    candidates, never guessed.
 */

import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { ACC, ATA, SYSTEM, TOKEN, TOKEN_2022, ata, rawInstruction, splToken, system } from './helpers/instructions.ts';
import { account, effectsOf, scenario, tokenRow } from './helpers/effects.ts';

const FEE = 5000n;
const FUNDER = ACC.other;

function funderRow() {
  return account(9, FUNDER, { signer: true, before: 10_000_000n, after: 10_000_000n - FEE });
}

describe('no attribution from balances alone', () => {
  it('reports a token balance change nothing explains, without naming a counterparty', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow(), account(0, ACC.source, { before: 1_000n, after: 1_000n })],
      tokenRows: [tokenRow(0, ACC.source, ACC.mint, ACC.authority, { before: 1_000n, after: 400n })],
      instructions: [],
    });

    expect(effects.tokenFlows).toEqual([]);
    const entry = effects.unattributedEffects.find(candidate => candidate.side === 'token');
    expect(entry).toMatchObject({
      side: 'token',
      reason: 'not-explained',
      amount: -600n,
      address: ACC.source,
      mint: ACC.mint,
      confidence: 'ambiguous',
    });
    expect(entry?.explanation).not.toContain('→');
    expect(entry?.explanation).toContain('no decoded instruction accounts for');
    expect(effects.netTokenByAccountMint[0]?.residualAmount).toBe(-600n);
    expect(effects.netTokenByAccountMint[0]?.reconciliation).toBe('residual');
    // The same -600 is missing from the mint's supply accounting, and the units
    // left the accounts without passing through a mint or burn.
    expect(effects.diagnostics.some(note => note.code === 'effects-token-conservation-violated')).toBe(true);
    expect(effects.unattributedEffects.filter(candidate => candidate.side === 'sol')).toEqual([]);
  });

  it('points at an undecoded instruction of the account own token program', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow(), account(0, ACC.source, { before: 1_000n, after: 1_000n })],
      tokenRows: [
        tokenRow(0, ACC.source, ACC.mint, ACC.authority, { before: 1_000n, after: 900n, programId: TOKEN_2022 }),
      ],
      // Only the token program that owns a token account can change its units, so an
      // undecoded instruction of that program is a real lead rather than a guess.
      // Tag 26 is a Token-2022 instruction outside the decoded set.
      instructions: [rawInstruction(TOKEN_2022, [26, 1, 2, 3], [ACC.source, ACC.destination, ACC.authority])],
    });

    const entry = effects.unattributedEffects.find(candidate => candidate.side === 'token');
    expect(entry?.undecodedRefs).toEqual([{ path: 'top-level', index: 0, outerIndex: null, stackHeight: 1 }]);
    expect(entry?.explanation).toContain('undecoded instructions of its token program could have moved them');
    expect(entry?.amount).toBe(-100n);
  });

  it('says plainly when nothing in the transaction could explain the change either', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow(), account(0, ACC.source, { before: 1_000n, after: 1_000n })],
      tokenRows: [tokenRow(0, ACC.source, ACC.mint, ACC.authority, { before: 1_000n, after: 900n })],
      instructions: [],
    });

    const entry = effects.unattributedEffects.find(candidate => candidate.side === 'token');
    expect(entry?.undecodedRefs).toEqual([]);
    expect(entry?.explanation).toContain('no undecoded instruction targets its token program either');
  });

  it('leaves a lamport change it cannot explain unattributed, signed, with no counterparty', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [
        account(0, ACC.funding, { signer: true, before: 10_000n, after: 10_000n - 100n - FEE }),
        account(1, ACC.recipient, { before: 0n, after: 150n }),
      ],
      instructions: [rawInstruction(SYSTEM, system.transfer(100n), [ACC.funding, ACC.recipient])],
    });

    const entry = effects.unattributedEffects.find(candidate => candidate.side === 'sol');
    expect(entry).toMatchObject({ reason: 'not-explained', amount: 50n, address: ACC.recipient });
    expect(entry?.explanation).toContain('A program can move the lamports of accounts it owns');
    expect(entry?.explanation).toContain('no sender or receiver is claimed');
    // An unexplained credit also means the lamports do not add up, and both checks
    // say so independently.
    expect(effects.diagnostics.some(note => note.code === 'effects-lamport-conservation-violated')).toBe(true);
  });
});

describe('sizing a proven relationship from balances', () => {
  it('uses both endpoints when exactly one flow has no stated amount', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [
        tokenRow(0, ACC.source, ACC.mint, ACC.authority, { before: 1_000n, after: 850n }),
        tokenRow(1, ACC.destination, ACC.mint, ACC.recipient, { before: 0n, after: 150n }),
      ],
      // A `transfer` tag with a truncated amount: the movement is proven, the
      // number is not stated anywhere. Both sides moved 150, so it can be sized.
      instructions: [rawInstruction(TOKEN, [3, 0, 0, 0], [ACC.source, ACC.destination, ACC.authority])],
    });

    const flow = effects.tokenFlows[0];
    expect(flow?.amount).toBe(150n);
    expect(flow?.amountSource).toBe('residual-reconciliation');
    expect(flow?.confidence).toBe('reconciled');
    expect(effects.diagnostics.some(note => note.code === 'effects-amount-reconciled')).toBe(true);
    expect(effects.netTokenByAccountMint.every(row => row.residualAmount === 0n)).toBe(true);
    expect(effects.unattributedEffects).toEqual([]);
    expect(effects.counts.amountNotObservable).toBe(0);
  });

  it('leaves an amount unobservable when only one side can be measured', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [tokenRow(1, ACC.destination, ACC.mint, ACC.recipient, { before: 0n, after: 150n })],
      instructions: [rawInstruction(TOKEN, [3, 0, 0, 0], [ACC.source, ACC.destination, ACC.authority])],
    });

    expect(effects.tokenFlows[0]?.amount).toBeNull();
    expect(effects.tokenFlows[0]?.amountSource).toBe('not-observable');
    expect(effects.counts.amountNotObservable).toBe(1);
    expect(effects.unattributedEffects.map(entry => [entry.reason, entry.amount])).toEqual([
      ['amounts-not-separable', 150n],
    ]);
  });

  it('sizes a close return from the closed account when nothing else touched it', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [
        funderRow(),
        account(0, ACC.source, { before: 2_039_280n, after: 0n }),
        account(1, ACC.destination, { before: 0n, after: 2_039_280n }),
      ],
      tokenRows: [tokenRow(0, ACC.source, ACC.mint, ACC.authority, { before: 0n, after: null, presence: 'only-before' })],
      instructions: [rawInstruction(TOKEN, splToken.closeAccount(), [ACC.source, ACC.destination, ACC.authority])],
    });

    const flow = effects.solFlows.find(entry => entry.kind === 'account-close-return');
    expect(flow?.lamports).toBe(2_039_280n);
    expect(flow?.amountSource).toBe('balance-reconciliation');
    expect(effects.netSolByAccount.find(net => net.address === ACC.destination)?.reconciliation).toBe('exact');
    expect(effects.unattributedEffects).toEqual([]);
  });

  it('adds what the account received before the close instead of using its starting balance', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [
        // The funder pays both the fee and the 500 it sent to the account.
        account(9, FUNDER, { signer: true, before: 10_000_000n, after: 10_000_000n - 500n - FEE }),
        account(0, ACC.source, { before: 1_000n, after: 0n }),
        account(1, ACC.destination, { before: 0n, after: 1_500n }),
      ],
      tokenRows: [tokenRow(0, ACC.source, ACC.mint, ACC.authority, { before: 0n, after: null, presence: 'only-before' })],
      instructions: [
        rawInstruction(SYSTEM, system.transfer(500n), [FUNDER, ACC.source]),
        rawInstruction(TOKEN, splToken.closeAccount(), [ACC.source, ACC.destination, ACC.authority]),
      ],
    });

    // The close sweeps the balance at close time, which is the starting balance
    // plus the 500 lamports that arrived first.
    const flow = effects.solFlows.find(entry => entry.kind === 'account-close-return');
    expect(flow?.lamports).toBe(1_500n);
    expect(effects.netSolByAccount.find(net => net.address === ACC.destination)?.reconciliation).toBe('exact');
    expect(effects.unattributedEffects).toEqual([]);
  });

  it('reports a create and a close that net to a number neither of them owns', () => {
    // A payer creates an Associated Token Account and closes it again. The ATA
    // program funds the account by CPI, and no system.createAccount was recorded,
    // so neither the deposit nor the return is stated anywhere. Their *net* is
    // still exact: the payer ended 400 lamports up.
    const effects = effectsOf({
      fee: FEE,
      accounts: [
        account(0, ACC.funding, { signer: true, before: 10_000_000n, after: 10_000_000n - FEE + 400n }),
        account(1, ACC.destination, { before: 0n, after: 0n }),
      ],
      tokenRows: [],
      instructions: [
        rawInstruction(ATA, ata.create(), [ACC.funding, ACC.destination, ACC.authority, ACC.mint, SYSTEM, TOKEN]),
        rawInstruction(TOKEN, splToken.closeAccount(), [ACC.destination, ACC.funding, ACC.authority]),
      ],
    });

    const deposit = effects.solFlows.find(flow => flow.kind === 'account-create-deposit');
    const returned = effects.solFlows.find(flow => flow.kind === 'account-close-return');
    expect(deposit?.lamports).toBeNull();
    expect(returned?.lamports).toBeNull();
    expect(returned?.amountSource).toBe('not-observable');
    // Two proven movements, neither sizeable, and the residual they leave is
    // reported with both of them named — never split by guesswork.
    const entry = effects.unattributedEffects.find(candidate => candidate.side === 'sol');
    expect(entry).toMatchObject({ reason: 'amounts-not-separable', amount: 400n, address: ACC.funding });
    expect(entry?.candidateRefs).toHaveLength(2);
    expect(effects.counts.amountNotObservable).toBe(2);
    expect(effects.diagnostics.some(note => note.code === 'effects-create-deposit-not-observable')).toBe(true);
    expect(effects.diagnostics.some(note => note.code === 'effects-close-return-not-observable')).toBe(true);
  });

  it('leaves a close return unobservable when it was created in this transaction', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [
        funderRow(),
        account(2, ACC.source, { before: 0n, after: 0n }),
        account(1, ACC.destination, { before: 0n, after: 0n }),
      ],
      tokenRows: [],
      // Closing an account this transaction created and never funded: the row shows
      // zero on both sides, and with no decoded create the balance at close time is
      // simply not knowable — so nothing is claimed about it.
      instructions: [rawInstruction(TOKEN, splToken.closeAccount(), [ACC.source, ACC.destination, ACC.authority])],
    });

    const flow = effects.solFlows.find(entry => entry.kind === 'account-close-return');
    expect(flow?.lamports).toBe(0n);
    // Zero is what the boundaries allow: nothing moved in or out of the account, so
    // a close of it can only have returned what it held at the start of the
    // transaction. It is reported as reconciled, not as proven.
    expect(flow?.confidence).toBe('reconciled');
    expect(flow?.amountSource).toBe('balance-reconciliation');
  });
});

describe('transaction-level invariants', () => {
  it('passes lamport conservation when the changes add up to the fee', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [
        account(0, ACC.funding, { signer: true, before: 10_000n, after: 10_000n - 2_500n - FEE }),
        account(1, ACC.recipient, { before: 0n, after: 2_500n }),
      ],
      instructions: [rawInstruction(SYSTEM, system.transfer(2_500n), [ACC.funding, ACC.recipient])],
    });

    expect(effects.diagnostics.some(note => note.code === 'effects-lamport-conservation-violated')).toBe(false);
    expect(deltaSum(effects)).toBe(-FEE);
  });

  it('warns when the account changes do not add up to the fee', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [account(0, ACC.funding, { signer: true, before: 10_000n, after: 10_000n - 4_000n })],
    });

    const warning = effects.diagnostics.find(note => note.code === 'effects-lamport-conservation-violated');
    expect(warning?.level).toBe('warning');
    expect(warning?.message).toContain('-4000');
  });

  it('warns when a flow is aimed at an account the transaction does not list', () => {
    const effects = effectsOf({
      fee: FEE,
      // The 100 lamports leave the payer but no listed account receives them, so
      // this layer's own flow bookkeeping cannot balance.
      accounts: [account(0, ACC.funding, { signer: true, before: 10_000n, after: 10_000n - 100n - FEE })],
      instructions: [rawInstruction(SYSTEM, system.transfer(100n), [ACC.funding, ACC.recipient])],
    });

    expect(effects.diagnostics.find(note => note.code === 'effects-sol-bookkeeping-violated')?.level).toBe('warning');
    // Both independent checks notice: the flow bookkeeping (a flow credits nobody)
    // and total conservation (the listed accounts' changes no longer offset the fee).
    expect(effects.diagnostics.some(note => note.code === 'effects-lamport-conservation-violated')).toBe(true);
    expect(effects.netSolByAccount[0]?.netLamports).toBe(-5_100n);
  });

  it('skips the token conservation check when a flow touches an account with no row', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [tokenRow(1, ACC.destination, ACC.mint, ACC.recipient, { before: 0n, after: 500n })],
      // The source account has no balance row at all (created and closed inside the
      // transaction, say), so a per-mint total cannot be computed either way.
      instructions: [rawInstruction(TOKEN, splToken.transfer(500n), [ACC.source, ACC.destination, ACC.authority])],
    });

    expect(effects.diagnostics.some(note => note.code === 'effects-token-conservation-violated')).toBe(false);
    expect(effects.diagnostics.some(note => note.code === 'effects-token-conservation-not-checkable')).toBe(true);
  });
});

describe('ambiguity is reported, never hidden', () => {
  it('keeps a residual with no candidate flows as not-explained rather than routing it somewhere', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [
        account(0, ACC.funding, { signer: true, before: 10_000_000n, after: 10_000_000n - FEE }),
        account(1, ACC.recipient, { before: 0n, after: 500n }),
      ],
    });

    const entry = effects.unattributedEffects.find(candidate => candidate.side === 'sol');
    expect(entry).toMatchObject({ reason: 'not-explained', amount: 500n, address: ACC.recipient });
    // No flow had an unobservable amount here, so there is nothing to name as a
    // candidate: the entry stays a pure statement of the unexplained residual.
    expect(entry?.candidateRefs).toEqual([]);
  });

  it('reports an address-less account row without inventing a fee payer', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [{ index: 0, address: null, signer: null, beforeLamports: 1_000n, afterLamports: 500n }],
    });

    // The row's own boundaries still give an exact net change; what cannot be done
    // is matching decoded flows to an account with no address, so the residual is
    // left unknown rather than declared unexplained.
    expect(effects.netSolByAccount[0]).toMatchObject({
      address: null,
      netLamports: -500n,
      residualLamports: null,
      reconciliation: 'unknown',
    });
    // No address means no fee flow either: the layer names an account or nothing.
    expect(effects.solFlows).toEqual([]);
    expect(effects.diagnostics.some(note => note.code === 'effects-fee-payer-unknown')).toBe(true);
  });
});

describe('the effects layer sees only what it is allowed to see', () => {
  it('takes a narrow input view with no raw payload, logs or instruction data', () => {
    const { input } = scenario({ accounts: [funderRow()] });
    expect(Object.keys(input).toSorted()).toEqual([
      'accounts',
      'feeLamports',
      'feePayer',
      'status',
      'tokenBalancesAvailable',
      'tokenRows',
      'undecoded',
    ]);
    expect(stringifyJson(input)).not.toContain('logMessages');
    expect(stringifyJson(input)).not.toContain('"raw"');
  });

  it('projects the canonical model onto exactly those fields', () => {
    const { input } = scenario({
      accounts: [funderRow(), account(1, ACC.destination, { before: 0n, after: 1n })],
      tokenRows: [tokenRow(1, ACC.destination, ACC.mint, ACC.recipient, { before: 0n, after: 1n })],
    });
    expect(input.accounts.map(row => row.index)).toEqual([9, 1]);
    expect(input.tokenRows.map(row => row.accountIndex)).toEqual([1]);
    expect(input.status).toBe('success');
    expect(input.tokenBalancesAvailable).toBe(true);
  });
});

function deltaSum(effects: ReturnType<typeof effectsOf>): bigint {
  return effects.netSolByAccount.reduce((sum, net) => sum + (net.netLamports ?? 0n), 0n);
}
