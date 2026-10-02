/**
 * Failed transactions.
 *
 * Solana transactions are atomic: the runtime deducts the fee before execution
 * and rolls back every state change when any instruction fails (Solana docs, *Fee
 * Structure* and *Transactions*). So a failed transaction's only committed effect
 * is the fee, and every instruction-derived effect must be reported as attempted
 * but uncommitted — never as something that happened.
 */

import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { normalizeFixture } from './helpers/fixtures.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { ACC, SYSTEM, TOKEN, rawInstruction, splToken, system } from './helpers/instructions.ts';
import { account, scenario, tokenRow } from './helpers/effects.ts';

const FEE = 5000n;

/** A transaction that failed *after* an attempted transfer and an attempted approve. */
function failedScenario(feePayerAfter: bigint, tokenAfter: bigint | null = null) {
  return scenario({
    status: 'failed',
    fee: FEE,
    accounts: [
      account(0, ACC.funding, { signer: true, before: 1_000_000n, after: feePayerAfter }),
      account(1, ACC.recipient, { before: 0n, after: 0n }),
    ],
    tokenRows: [
      tokenRow(0, ACC.source, ACC.mint, ACC.authority, {
        before: 1_000n,
        after: tokenAfter === null ? 1_000n : tokenAfter,
      }),
    ],
    instructions: [
      rawInstruction(SYSTEM, system.transfer(500n), [ACC.funding, ACC.recipient]),
      rawInstruction(TOKEN, splToken.approve(42n), [ACC.source, ACC.other, ACC.authority]),
    ],
  });
}

describe('a failed transaction commits nothing but the fee', () => {
  it('reports only the fee as committed', () => {
    const { effects } = failedScenario(1_000_000n - FEE);

    expect(effects.commitState).toBe('reverted');
    expect(effects.solFlows).toHaveLength(1);
    expect(effects.solFlows[0]).toMatchObject({
      kind: 'fee',
      from: ACC.funding,
      to: null,
      lamports: FEE,
      confidence: 'proven',
      amountSource: 'transaction-metadata',
      commitState: 'committed',
    });
    expect(effects.tokenFlows).toEqual([]);
    expect(effects.accountLifecycleEffects).toEqual([]);
  });

  it('keeps the attempted movements, marked as reverted', () => {
    const { effects } = failedScenario(1_000_000n - FEE);

    expect(effects.uncommittedSolFlows.map(flow => flow.kind)).toEqual(['transfer']);
    expect(effects.uncommittedSolFlows[0]).toMatchObject({
      lamports: 500n,
      from: ACC.funding,
      to: ACC.recipient,
      commitState: 'reverted',
      // The attempt is still shown as the instruction stated it: it is the
      // *commitment* that is negated, not the instruction's meaning.
      confidence: 'proven',
    });
    // `approve` is a delegation, not a value movement: it produces an uncommitted
    // state change and no token flow at all, in a failed transaction like any other.
    expect(effects.uncommittedTokenFlows).toEqual([]);
    expect(effects.uncommittedLifecycleEffects.map(effect => effect.kind)).toEqual(['allowance-set']);
    expect(effects.uncommittedLifecycleEffects[0]).toMatchObject({ commitState: 'reverted', confidence: 'proven' });
    expect(effects.counts).toMatchObject({ proven: 1, reconciled: 0, uncommitted: 2, unattributed: 0 });
  });

  it('shows the rollback in the balances and says it verified it', () => {
    const { effects } = failedScenario(1_000_000n - FEE);

    expect(effects.netSolByAccount.find(net => net.address === ACC.funding)).toMatchObject({
      netLamports: -FEE,
      reconciliation: 'exact',
      isFeePayer: true,
    });
    expect(effects.netSolByAccount.find(net => net.address === ACC.recipient)).toMatchObject({
      netLamports: 0n,
      reconciliation: 'exact',
    });
    // Token rows did not move either: nothing to reconcile, and nothing claimed.
    expect(effects.netTokenByAccountMint[0]).toMatchObject({ netAmount: 0n, reconciliation: 'exact' });
    expect(effects.unattributedEffects).toEqual([]);

    const reverted = effects.diagnostics.find(note => note.code === 'effects-transaction-reverted');
    expect(reverted?.level).toBe('info');
    expect(reverted?.message).toContain('atomic');
    expect(effects.diagnostics.some(note => note.code === 'effects-rollback-confirmed')).toBe(true);
    expect(effects.diagnostics.some(note => note.code === 'effects-reverted-state-changed')).toBe(false);
  });

  it('warns when a failed transaction did move something beyond the fee', () => {
    // A rollback cannot leave a non-fee change behind, so this is a contradiction
    // between the reported error and the reported balances, and it is surfaced.
    const { effects } = failedScenario(1_000_000n - FEE - 500n, 900n);

    const warning = effects.diagnostics.find(note => note.code === 'effects-reverted-state-changed');
    expect(warning?.level).toBe('warning');
    expect(warning?.message).toContain('contradicts the reported error');
    expect(effects.diagnostics.some(note => note.code === 'effects-rollback-confirmed')).toBe(false);
    // The instruction effects are still not committed, and the stray change is then
    // reported as unexplained rather than read as a committed transfer.
    expect(effects.solFlows).toHaveLength(1);
    expect(effects.unattributedEffects.some(entry => entry.side === 'sol')).toBe(true);
  });

  it('does not resolve an unobservable amount from a rolled-back transaction', () => {
    const { effects } = scenario({
      status: 'failed',
      fee: FEE,
      accounts: [
        account(0, ACC.funding, { signer: true, before: 1_000_000n, after: 1_000_000n - FEE }),
        account(1, ACC.recipient, { before: 0n, after: 0n }),
      ],
      // A truncated transfer amount, in a transaction that failed: there is no
      // committed movement to size, so the amount stays unknown.
      instructions: [rawInstruction(SYSTEM, [2, 0, 0, 0, 1], [ACC.funding, ACC.recipient])],
    });

    expect(effects.uncommittedSolFlows[0]?.lamports).toBeNull();
    expect(effects.uncommittedSolFlows[0]?.amountSource).toBe('not-observable');
    expect(effects.counts.amountNotObservable).toBe(0);
  });
});

describe('a transaction whose commitment is unknown', () => {
  it('claims nothing about committed state when meta is absent', () => {
    const { effects } = scenario({
      status: 'unknown',
      fee: FEE,
      accounts: [
        account(0, ACC.funding, { signer: true, before: 1_000_000n, after: 1_000_000n - 500n - FEE }),
        account(1, ACC.recipient, { before: 0n, after: 500n }),
      ],
      instructions: [rawInstruction(SYSTEM, system.transfer(500n), [ACC.funding, ACC.recipient])],
    });

    expect(effects.commitState).toBe('unknown');
    expect(effects.solFlows).toHaveLength(1);
    expect(effects.solFlows[0]).toMatchObject({ kind: 'fee', commitState: 'unknown' });
    expect(effects.uncommittedSolFlows.map(flow => flow.kind)).toEqual(['transfer']);
    expect(effects.uncommittedSolFlows[0]?.commitState).toBe('unknown');
    const note = effects.diagnostics.find(entry => entry.code === 'effects-commitment-unknown');
    expect(note?.level).toBe('warning');
    expect(note?.message).toContain('no `meta`');
  });

  it('claims no fee when the fee itself is unknown', () => {
    const { effects } = scenario({
      status: 'unknown',
      fee: null,
      accounts: [account(0, ACC.funding, { signer: true, before: 1_000n, after: 1_000n })],
    });

    expect(effects.solFlows).toEqual([]);
    expect(effects.diagnostics.some(note => note.code === 'effects-fee-unknown')).toBe(true);
  });
});

describe('the two recorded failed mainnet transactions', () => {
  it.each(['v1-failed-custom11', 'v1-failed-custom6001'])('%s commits only its fee', name => {
    const { transaction } = normalizeFixture(name);
    const effects = transactionEffects(transaction);

    expect(transaction.status).toBe('failed');
    expect(effects.commitState).toBe('reverted');
    expect(effects.solFlows.map(flow => flow.kind)).toEqual(['fee']);
    expect(effects.solFlows[0]?.lamports).toBe(transaction.feeLamports);
    expect(effects.tokenFlows).toEqual([]);
    expect(effects.accountLifecycleEffects).toEqual([]);
    expect(effects.uncommittedSolFlows.length + effects.uncommittedTokenFlows.length).toBeGreaterThan(0);
    // Every attempted movement is preserved but marked.
    expect(
      [...effects.uncommittedSolFlows, ...effects.uncommittedTokenFlows].every(flow => flow.commitState === 'reverted'),
    ).toBe(true);

    // Only the fee payer moved, and only by the fee: the rollback, measured.
    const changed = effects.netSolByAccount.filter(net => (net.netLamports ?? 0n) !== 0n);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.address).toBe(transaction.feePayerAddress);
    expect(changed[0]?.netLamports).toBe(-(transaction.feeLamports ?? 0n));
    expect(changed[0]?.reconciliation).toBe('exact');

    expect(effects.unattributedEffects).toEqual([]);
    expect(effects.diagnostics.map(note => note.code).toSorted()).toEqual([
      'effects-rollback-confirmed',
      'effects-transaction-reverted',
    ]);
  });

  it('is deterministic across builds', () => {
    const { transaction } = normalizeFixture('v1-failed-custom11');
    expect(stringifyJson(transactionEffects(transaction))).toBe(stringifyJson(transactionEffects(transaction)));
  });
});
