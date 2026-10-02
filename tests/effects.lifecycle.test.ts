/**
 * Account lifecycle: createAccount, ATA create and closeAccount.
 *
 * The point of these records is not the flow itself but *which* claim is being
 * made. A creation deposit is stated by instruction data; what a close returns is
 * reconciled from boundary balances; whether the returned lamports were already
 * sitting in the account (rent) or arrived during the transaction is a separate
 * question that is only answered when the three terms reproduce the return exactly.
 */

import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { NATIVE_MINT } from '../src/effects/native.ts';
import { ACC, ATA, SYSTEM, TOKEN, ata, rawInstruction, splToken, system } from './helpers/instructions.ts';
import { account, effectsOf, scenario, tokenRow } from './helpers/effects.ts';

const FEE = 5000n;
const FUNDER = ACC.funding;
const RENT = 2_039_280n;
/** A token account's space: 165 bytes. */
const TOKEN_SPACE = 165n;

function fundingRow(after: bigint) {
  return account(0, FUNDER, { signer: true, before: 10_000_000_000n, after });
}

describe('system.createAccount', () => {
  it('records the account, who funded it and how much, from instruction data', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [
        fundingRow(10_000_000_000n - RENT - FEE),
        account(1, ACC.recipient, { before: 0n, after: RENT }),
      ],
      instructions: [rawInstruction(SYSTEM, system.createAccount(RENT, TOKEN_SPACE, TOKEN), [FUNDER, ACC.recipient])],
    });

    const created = effects.accountLifecycleEffects.find(effect => effect.kind === 'account-created');
    expect(created).toMatchObject({
      address: ACC.recipient,
      funder: FUNDER,
      lamportsDeposited: RENT,
      space: TOKEN_SPACE,
      ownerProgram: TOKEN,
      confidence: 'proven',
      commitState: 'committed',
    });
    // The lamports are a plain transfer under the hood, and creating the record
    // must not turn it into two overlapping claims.
    const solFlows = effects.solFlows.filter(flow => flow.kind === 'account-create-deposit' || flow.kind === 'transfer');
    expect(solFlows).toHaveLength(1);
    expect(solFlows[0]).toMatchObject({ from: FUNDER, to: ACC.recipient, lamports: RENT, amountSource: 'instruction-data' });

    // The new account's whole balance is explained: it started at zero.
    const net = effects.netSolByAccount.find(entry => entry.address === ACC.recipient);
    expect(net).toMatchObject({ netLamports: RENT, reconciliation: 'exact', residualLamports: 0n, signer: false });
  });
});

describe('associated token account creation', () => {
  it('recognises the account it creates and sizes the deposit from the inner System instruction', () => {
    const { effects } = scenario({
      fee: FEE,
      accounts: [
        fundingRow(10_000_000_000n - RENT - FEE),
        account(1, ACC.destination, { before: 0n, after: RENT }),
      ],
      tokenRows: [tokenRow(1, ACC.destination, ACC.mint, ACC.authority, { before: 0n, after: 0n, presence: 'only-after' })],
      instructions: [rawInstruction(ATA, ata.create(), [FUNDER, ACC.destination, ACC.authority, ACC.mint, SYSTEM, TOKEN])],
      inner: new Map([
        [0, [rawInstruction(SYSTEM, system.createAccount(RENT, TOKEN_SPACE, TOKEN), [FUNDER, ACC.destination])]],
      ]),
    });

    const [ataEffect, systemEffect] = effects.accountLifecycleEffects;
    expect(ataEffect).toMatchObject({
      kind: 'token-account-create',
      address: ACC.destination,
      owner: ACC.authority,
      mint: ACC.mint,
      tokenProgram: TOKEN,
      outcome: 'created',
      outcomeBasis: 'instruction-variant',
      lamportsDeposited: RENT,
      depositSource: 'instruction-data',
      // The outer instruction's own data does not state the amount: the deposit is
      // the inner System instruction's, matched to this create by reference.
      confidence: 'reconciled',
    });
    expect(systemEffect).toMatchObject({
      kind: 'account-created',
      address: ACC.destination,
      funder: FUNDER,
      lamportsDeposited: RENT,
      space: TOKEN_SPACE,
      ownerProgram: TOKEN,
      confidence: 'proven',
      // The movement belongs to the CPI, and the record says so.
      ref: { path: 'inner', index: 0, outerIndex: 0, stackHeight: 2 },
    });
    expect(effects.solFlows.map(flow => flow.kind)).toEqual(['fee', 'account-create-deposit']);
    expect(effects.solFlows[1]).toMatchObject({
      from: FUNDER,
      to: ACC.destination,
      lamports: RENT,
      ref: { path: 'inner', index: 0, outerIndex: 0, stackHeight: 2 },
    });
    // The duplicate flow the ATA create itself implies is dropped, with a note
    // saying where the movement went, so one movement is never counted twice.
    expect(effects.diagnostics.map(note => note.code)).toEqual(['effects-create-deposit-stated-elsewhere']);

    expect(effects.netTokenByAccountMint[0]).toMatchObject({
      beforeAmount: 0n,
      afterAmount: 0n,
      netAmount: 0n,
      presence: 'only-after',
      reconciliation: 'exact',
    });
  });

  it('keeps the answer unstated when an idempotent create may have been a no-op', () => {
    const { effects } = scenario({
      fee: FEE,
      accounts: [
        fundingRow(10_000_000_000n - RENT - FEE),
        account(1, ACC.destination, { before: 0n, after: RENT }),
      ],
      tokenRows: [tokenRow(1, ACC.destination, ACC.mint, ACC.authority, { before: 0n, after: 0n, presence: 'only-after' })],
      instructions: [rawInstruction(ATA, ata.createIdempotent(), [FUNDER, ACC.destination, ACC.authority, ACC.mint, SYSTEM, TOKEN])],
      inner: new Map([
        [0, [rawInstruction(SYSTEM, system.createAccount(RENT, TOKEN_SPACE, TOKEN), [FUNDER, ACC.destination])]],
      ]),
    });

    const effect = effects.accountLifecycleEffects.find(entry => entry.kind === 'token-account-create');
    // `CreateIdempotent` succeeds whether or not the account already existed, and an
    // only-after token row does not prove which it was (the account could have been
    // initialised earlier in this same transaction), so the outcome is not stated.
    expect(effect).toMatchObject({ outcome: 'not-provable', outcomeBasis: 'none' });
    const note = effects.diagnostics.find(entry => entry.code === 'effects-create-outcome-not-provable');
    expect(note?.level).toBe('info');
    // The lamports are still known: the inner System instruction states them.
    expect(effect?.lamportsDeposited).toBe(RENT);
  });

  it('calls an idempotent create on an existing account a no-op with no lamport movement', () => {
    const { effects } = scenario({
      fee: FEE,
      accounts: [
        fundingRow(10_000_000_000n - FEE),
        account(1, ACC.destination, { before: RENT, after: RENT }),
      ],
      tokenRows: [tokenRow(1, ACC.destination, ACC.mint, ACC.authority, { before: 0n, after: 0n, presence: 'both' })],
      instructions: [rawInstruction(ATA, ata.createIdempotent(), [FUNDER, ACC.destination, ACC.authority, ACC.mint, SYSTEM, TOKEN])],
    });

    const effect = effects.accountLifecycleEffects.find(entry => entry.kind === 'token-account-create');
    // The outcome is proven from pre-state. No lamports were deposited, and the
    // record says the amount is not observable rather than turning that into a
    // measured zero: the claim lives in `outcome`, not in an invented number.
    expect(effect).toMatchObject({
      outcome: 'no-op',
      outcomeBasis: 'pre-state',
      lamportsDeposited: null,
      depositSource: 'not-observable',
      confidence: 'proven',
    });
    // Nothing moved, so there is no deposit flow, no residual, and no diagnostic:
    // a no-op is a normal result, not an anomaly.
    expect(effects.solFlows.map(flow => flow.kind)).toEqual(['fee']);
    expect(effects.unattributedEffects).toEqual([]);
    expect(effects.diagnostics).toEqual([]);
    expect(effects.netSolByAccount.find(entry => entry.address === ACC.destination)?.residualLamports).toBe(0n);
  });

  it('reports a create whose account never appears in the balances as unstated, not as zero', () => {
    const { effects } = scenario({
      fee: FEE,
      // The payer's balance shows the fee and nothing else, so the deposit of the
      // account that never shows up in the balance lists is simply not observable.
      accounts: [fundingRow(10_000_000_000n - FEE)],
      instructions: [rawInstruction(ATA, ata.create(), [FUNDER, ACC.destination, ACC.authority, ACC.mint, SYSTEM, TOKEN])],
    });

    const effect = effects.accountLifecycleEffects.find(entry => entry.kind === 'token-account-create');
    // The variant still proves a creation was attempted and would have created the
    // account; the amount is left unstated instead of recorded as zero.
    expect(effect).toMatchObject({
      outcome: 'created',
      outcomeBasis: 'instruction-variant',
      lamportsDeposited: null,
      depositSource: 'not-observable',
    });
    expect(effects.diagnostics.some(note => note.code === 'effects-create-deposit-not-observable')).toBe(true);
  });
});

describe('closeAccount', () => {
  it('reconciles what a close returns and says the account already held it', () => {
    const { effects } = scenario({
      fee: FEE,
      accounts: [
        fundingRow(10_000_000_000n - FEE),
        account(1, ACC.source, { before: RENT, after: 0n }),
        account(2, ACC.destination, { before: 0n, after: RENT }),
      ],
      tokenRows: [tokenRow(1, ACC.source, ACC.mint, ACC.authority, { before: 0n, after: null, presence: 'only-before' })],
      instructions: [rawInstruction(TOKEN, splToken.closeAccount(), [ACC.source, ACC.destination, ACC.authority])],
    });

    const closed = effects.accountLifecycleEffects.find(entry => entry.kind === 'token-account-closed');
    expect(closed).toMatchObject({
      address: ACC.source,
      destination: ACC.destination,
      owner: ACC.authority,
      mint: ACC.mint,
      isNativeMint: false,
      lamportsReturned: RENT,
      returnSource: 'balance-reconciliation',
      lamportsAtStart: RENT,
      lamportsCredited: 0n,
      lamportsSpent: 0n,
      returnComposition: 'own-lamports',
      confidence: 'reconciled',
    });
    // The return is a real SOL flow, proven by the instruction, sized by the balance.
    const flow = effects.solFlows.find(entry => entry.kind === 'account-close-return');
    expect(flow).toMatchObject({
      from: ACC.source,
      to: ACC.destination,
      lamports: RENT,
      amountSource: 'balance-reconciliation',
      confidence: 'reconciled',
      commitState: 'committed',
    });
    expect(effects.unattributedEffects).toEqual([]);
  });

  it('says the return is mixed when lamports arrived during the transaction', () => {
    const { effects } = scenario({
      fee: FEE,
      accounts: [
        account(9, ACC.other, { signer: true, before: 10_000_000n, after: 10_000_000n - 700n - FEE }),
        account(1, ACC.source, { before: RENT, after: 0n }),
        account(2, ACC.destination, { before: 0n, after: RENT + 700n }),
      ],
      tokenRows: [tokenRow(1, ACC.source, ACC.mint, ACC.authority, { before: 0n, after: null, presence: 'only-before' })],
      instructions: [
        rawInstruction(SYSTEM, system.transfer(700n), [ACC.other, ACC.source]),
        rawInstruction(TOKEN, splToken.closeAccount(), [ACC.source, ACC.destination, ACC.authority]),
      ],
    });

    const closed = effects.accountLifecycleEffects.find(entry => entry.kind === 'token-account-closed');
    expect(closed).toMatchObject({
      lamportsReturned: RENT + 700n,
      lamportsAtStart: RENT,
      lamportsCredited: 700n,
      lamportsSpent: 0n,
      returnComposition: 'mixed',
    });
  });

  it('says none of a new account return is rent when the transaction created it', () => {
    const { effects } = scenario({
      fee: FEE,
      accounts: [
        // The payer funds the deposit and gets it straight back on the close.
        fundingRow(10_000_000_000n - FEE),
        account(1, ACC.source, { before: 0n, after: 0n }),
      ],
      tokenRows: [tokenRow(1, ACC.source, ACC.mint, ACC.authority, { before: 0n, after: null, presence: 'only-after' })],
      instructions: [
        rawInstruction(ATA, ata.create(), [FUNDER, ACC.source, ACC.authority, ACC.mint, SYSTEM, TOKEN]),
        rawInstruction(TOKEN, splToken.closeAccount(), [ACC.source, FUNDER, ACC.authority]),
      ],
      inner: new Map([
        [0, [rawInstruction(SYSTEM, system.createAccount(RENT, TOKEN_SPACE, TOKEN), [FUNDER, ACC.source])]],
      ]),
    });

    const closed = effects.accountLifecycleEffects.find(entry => entry.kind === 'token-account-closed');
    expect(closed).toMatchObject({
      lamportsReturned: RENT,
      lamportsAtStart: 0n,
      lamportsCredited: RENT,
      lamportsSpent: 0n,
      returnComposition: 'in-transaction-lamports',
    });
    // The account is gone, so it holds no balance afterwards and has no residual.
    expect(effects.netSolByAccount.find(entry => entry.address === ACC.source)).toMatchObject({
      netLamports: 0n,
      reconciliation: 'exact',
      residualLamports: 0n,
    });
    expect(effects.unattributedEffects).toEqual([]);
  });

  it('refuses to claim where the return came from when the three terms do not reproduce it', () => {
    const { effects } = scenario({
      fee: FEE,
      accounts: [
        fundingRow(10_000_000_000n - FEE - 100n),
        account(1, ACC.source, { before: RENT, after: 0n }),
        account(2, ACC.destination, { before: 0n, after: RENT }),
      ],
      tokenRows: [tokenRow(1, ACC.source, ACC.mint, ACC.authority, { before: 0n, after: null, presence: 'only-before' })],
      instructions: [
        // A Custom System instruction this layer does not decode (tag 3 is
        // `transferWithSeed`): the payer is 100 lamports short of what the decoded
        // flows explain, and this is what could account for it.
        rawInstruction(SYSTEM, [3, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0], [FUNDER, ACC.source]),
        rawInstruction(TOKEN, splToken.closeAccount(), [ACC.source, ACC.destination, ACC.authority]),
      ],
    });

    const closed = effects.accountLifecycleEffects.find(entry => entry.kind === 'token-account-closed');
    // The payer is 100 lamports short and the closed account's history cannot
    // account for it, so the composition is left unstated instead of guessed.
    expect(closed?.returnComposition).toBe('own-lamports');
    const entry = effects.unattributedEffects.find(candidate => candidate.side === 'sol');
    expect(entry).toMatchObject({ reason: 'not-explained', amount: -100n, address: FUNDER });
    expect(entry?.undecodedRefs).toEqual([{ path: 'top-level', index: 0, outerIndex: null, stackHeight: 1 }]);
  });

  it('reports a close whose amount cannot be reconciled instead of sizing it anyway', () => {
    const { effects } = scenario({
      fee: FEE,
      accounts: [
        fundingRow(10_000_000_000n - FEE),
        // The account still has lamports after the transaction, which a successful
        // close makes impossible: so something moved them after the close and the
        // amount the close returned is not recoverable from these boundaries.
        account(1, ACC.source, { before: RENT, after: 1n }),
        account(2, ACC.destination, { before: 0n, after: RENT }),
      ],
      tokenRows: [tokenRow(1, ACC.source, ACC.mint, ACC.authority, { before: 0n, after: null, presence: 'only-before' })],
      instructions: [rawInstruction(TOKEN, splToken.closeAccount(), [ACC.source, ACC.destination, ACC.authority])],
    });

    const flow = effects.solFlows.find(entry => entry.kind === 'account-close-return');
    expect(flow?.lamports).toBeNull();
    expect(flow?.amountSource).toBe('not-observable');
    const note = effects.diagnostics.find(entry => entry.code === 'effects-close-return-not-observable');
    expect(note?.level).toBe('info');
    expect(effects.counts.amountNotObservable).toBeGreaterThan(0);
  });
});

describe('a wrapped-SOL close, where the token leg and the lamport leg are one movement', () => {
  it('keeps the unwrapped balance and the other lamports apart', () => {
    const wrapped = 500n;
    const { effects } = scenario({
      fee: FEE,
      accounts: [
        fundingRow(10_000_000_000n - FEE),
        account(1, ACC.source, { before: RENT + wrapped, after: 0n }),
        account(2, ACC.destination, { before: 0n, after: RENT + wrapped }),
      ],
      tokenRows: [
        tokenRow(1, ACC.source, NATIVE_MINT, ACC.authority, {
          before: wrapped,
          after: null,
          presence: 'only-before',
          decimals: 9,
        }),
      ],
      instructions: [rawInstruction(TOKEN, splToken.closeAccount(), [ACC.source, ACC.destination, ACC.authority])],
    });

    const closed = effects.accountLifecycleEffects.find(entry => entry.kind === 'token-account-closed');
    expect(closed).toMatchObject({
      isNativeMint: true,
      lamportsReturned: RENT + wrapped,
      unwrappedLamports: wrapped,
      otherLamports: RENT,
    });
    // The account's whole balance is returned by the close and nothing else touched
    // it, so there is exactly one SOL flow for it and no residual anywhere.
    expect(effects.solFlows.filter(flow => flow.kind === 'account-close-return')).toHaveLength(1);
    expect(effects.unattributedEffects).toEqual([]);

    // The units leave the token system with the account, and the lamport
    // composition says exactly how many, so the movement is recorded rather than
    // left as a token delta nothing explains.
    expect(effects.tokenFlows.map(flow => flow.kind)).toEqual(['close-unwrap']);
    expect(effects.tokenFlows[0]).toMatchObject({
      amount: wrapped,
      amountSource: 'balance-reconciliation',
      confidence: 'reconciled',
      nativeLamportLeg: true,
      sourceTokenAccount: ACC.source,
      destinationTokenAccount: null,
    });
    expect(effects.netTokenByAccountMint.every(row => row.residualAmount === 0n)).toBe(true);
  });

  it('leaves the split unstated when a syncNative moved lamports without a decoded flow', () => {
    // The account holds RENT + 500 lamports and 500 wrapped units. During the
    // transaction 700 lamports are sent to it and a `syncNative` (an instruction
    // this layer does not decode) turns them into wrapped balance, so at close time
    // it holds 1200 wrapped units and returns RENT + 1200 lamports.
    const { effects } = scenario({
      fee: FEE,
      accounts: [
        account(0, FUNDER, { signer: true, before: 10_000_000_000n, after: 10_000_000_000n - FEE - 700n }),
        account(1, ACC.source, { before: RENT + 500n, after: 0n }),
        account(2, ACC.destination, { before: 0n, after: RENT + 1_200n }),
      ],
      tokenRows: [
        tokenRow(1, ACC.source, NATIVE_MINT, ACC.authority, {
          before: 500n,
          after: null,
          presence: 'only-before',
          decimals: 9,
        }),
      ],
      instructions: [
        rawInstruction(SYSTEM, system.transfer(700n), [FUNDER, ACC.source]),
        rawInstruction(TOKEN, [17], [ACC.source, ACC.destination, ACC.authority]),
        rawInstruction(TOKEN, splToken.closeAccount(), [ACC.source, ACC.destination, ACC.authority]),
      ],
    });

    const closed = effects.accountLifecycleEffects.find(entry => entry.kind === 'token-account-closed');
    // The lamport and token histories cannot be made to agree here — the sync
    // created wrapped balance without moving a lamport — so the split is reported
    // as unknown rather than as "no unwrapped balance".
    expect(closed).toMatchObject({
      isNativeMint: true,
      lamportsReturned: RENT + 1_200n,
      unwrappedLamports: null,
      otherLamports: null,
    });
    // What the close returned and where it was before the close are still stated:
    // the account held RENT + 500, 700 was paid in, nothing was spent.
    expect(closed).toMatchObject({
      lamportsAtStart: RENT + 500n,
      lamportsCredited: 700n,
      lamportsSpent: 0n,
      returnComposition: 'mixed',
    });
    const note = effects.diagnostics.find(entry => entry.code === 'effects-close-composition-not-observable');
    expect(note?.level).toBe('info');
    expect(note?.ref).toMatchObject({ path: 'top-level', index: 2 });
    expect(effects.diagnostics.some(entry => entry.code === 'effects-close-units-not-observable')).toBe(true);

    // The units that left cannot be sized — the pre-transaction balance would
    // understate them — so the movement is recorded unsized and the token residual
    // stays attributed to the close instead of being closed out with a guess.
    expect(effects.tokenFlows[0]).toMatchObject({
      kind: 'close-unwrap',
      amount: null,
      amountSource: 'not-observable',
      confidence: 'ambiguous',
    });
    expect(effects.unattributedEffects).toHaveLength(1);
    expect(effects.unattributedEffects[0]).toMatchObject({
      side: 'token',
      reason: 'amounts-not-separable',
      amount: -500n,
      address: ACC.source,
    });
    expect(effects.netTokenByAccountMint[0]?.reconciliation).toBe('residual');
  });
});

describe('lifecycle records are deterministic', () => {
  it('produces the same JSON for the same input twice', () => {
    const parts = {
      fee: FEE,
      accounts: [fundingRow(10_000_000_000n - FEE)],
      instructions: [rawInstruction(ATA, ata.create(), [FUNDER, ACC.destination, ACC.authority, ACC.mint, SYSTEM, TOKEN])],
    };
    expect(stringifyJson(effectsOf(parts))).toBe(stringifyJson(effectsOf(parts)));
  });
});
