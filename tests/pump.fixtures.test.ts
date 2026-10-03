/**
 * The pump_amm `sell` layer against real mainnet fixtures.
 *
 * `token-mixed-closeAccount` is the direct case: a top-level `sell` with a real
 * non-zero floor and two fee transfers leaving the same pool quote vault as the
 * user's output — the case the acceptance criteria call out by name.
 *
 * `v0-success-swap` is the routed case: the same instruction invoked under the
 * Jupiter route, where it must be recognized as its own leg alongside the two
 * Meteora DLMM legs that Milestone 4.1 already proves.
 */
import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { recognizeSwaps } from '../src/swap/recognize-swaps.ts';
import { recognizeDlmmSwaps } from '../src/swap/recognize.ts';
import { PUMP_AMM_PROGRAM_ID, PUMP_AMM_SELL_ACCOUNT_ROLES } from '../src/swap/pump.ts';
import { normalizeFixture } from './helpers/fixtures.ts';
import { checkOf, dlmmLegs, innerInstructionsOf, pumpFixture, pumpLegAt } from './helpers/pump.ts';

const WSOL = 'So11111111111111111111111111111111111111112';
const X_MINT = '9pJWJdpPebyANys45eetpemLJo8yTz4n5B9zbpYw9ZMr';

/** The 19 checks, in the fixed order the model emits them. */
const CHECK_ORDER = [
  'pump-program-id',
  'sell-discriminator',
  'args-decode-exact',
  'named-accounts-present',
  'cpi-subtree-available',
  'base-input-transfer-found',
  'quote-output-transfer-found',
  'base-mint-matches-named-role',
  'quote-mint-matches-named-role',
  'base-input-vault-is-pool-vault',
  'quote-output-vault-is-pool-vault',
  'base-amount-matches-base-amount-in',
  'min-quote-amount-out-stated',
  'min-quote-amount-out-satisfied',
  'base-leg-authority-is-account-owner',
  'user-output-excludes-fee-transfers',
  'base-reconciles-with-effects',
  'quote-reconciles-with-effects',
  'transaction-committed',
];

describe('token-mixed-closeAccount: a direct top-level pump_amm sell', () => {
  const { transaction, effects, report, pump } = pumpFixture('token-mixed-closeAccount');
  const leg = pumpLegAt(report, null, 7);

  it('recognizes exactly one sell and nothing else', () => {
    expect(report.counts).toEqual({
      recognized: 1,
      proven: 1,
      partiallyProven: 0,
      notCommitted: 0,
      conflicting: 0,
    });
    expect(pump).toHaveLength(1);
    expect(report.scannedProtocols).toEqual(['meteora-dlmm', 'pump-amm']);
  });

  it('recognizes it as a top-level instruction, from its own bytes', () => {
    expect(leg.protocol).toBe('pump-amm');
    expect(leg.programId).toBe(PUMP_AMM_PROGRAM_ID);
    expect(leg.instructionName).toBe('sell');
    expect(leg.ref.path).toBe('top-level');
    expect(leg.ref.outerIndex).toBeNull();
    expect(leg.ref.index).toBe(7);
    expect(leg.state).toBe('proven');
    expect(leg.commitState).toBe('committed');
    expect(leg.baseAmountIn).toBe(185_356n);
    expect(leg.minQuoteAmountOut).toBe(171_510_690n);
    expect(leg.conflicts).toEqual([]);
    expect(leg.unknowns).toEqual([]);
  });

  it('maps the named roles in IDL order', () => {
    const accounts = transaction.instructions.find(entry => entry.index === 7)?.accounts ?? [];
    expect(accounts.slice(0, 21)).toEqual([
      '5wYcsL6CLeDtpG9us6BLawLnFV8oQS4yGEgjPrArTdV', // pool
      '21gsFXQ8sEZHkt5PdXsJXQ9Mce43hEhYD1QALZdBvBNH', // user
      'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw', // global_config
      WSOL, // base_mint
      '4LjRPLjLGSnzRjeL6GyTqLH7iQYeyVqJZUz7eWBwyUKK', // quote_mint
      'HiRnLovipYBuCuguxheoLZGu4brUKjzByp7mwwtqfWsx', // user_base_token_account
      'FfcKsP6PMDG33mvuPpTtqjyW9SHpB7z7nChY7F9EghhP', // user_quote_token_account
      'A7mZjX2EBqGxSn3zfDcKfmTQjyHMoCfJ9BEZzdmR9RBW', // pool_base_token_account
      'GayMivbsuNBQgve23Lz9qoMjzpKxmiN36Ydf2XNYo3vs', // pool_quote_token_account
      '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV', // protocol_fee_recipient
      'DapfVTGPV27P1ECJbv7m1LySFUVWdkLuBwCaw6iM9q2K', // protocol_fee_recipient_token_account
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // base_token_program
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // quote_token_program
      '11111111111111111111111111111111', // system_program
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // associated_token_program
      'GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR', // event_authority
      PUMP_AMM_PROGRAM_ID, // program
      '4VFRp7RoDp8qbJw6EfjV72mZPh5QRJV5eT6Jcmv3Lmjq', // coin_creator_vault_ata
      '8N3GDaZ2iwN65oxVatKTLPNooAVUJTbfiVJ1ahyqwjSk', // coin_creator_vault_authority
      '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx', // fee_config
      'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', // fee_program
    ]);
    expect(accounts).toHaveLength(23);
    expect(leg.roles.tailAccountCount).toBe(2);
    expect(leg.roles.pool).toBe('5wYcsL6CLeDtpG9us6BLawLnFV8oQS4yGEgjPrArTdV');
    expect(leg.roles.user).toBe('21gsFXQ8sEZHkt5PdXsJXQ9Mce43hEhYD1QALZdBvBNH');
    expect(leg.roles.baseMint).toBe(WSOL);
    expect(leg.roles.quoteMint).toBe('4LjRPLjLGSnzRjeL6GyTqLH7iQYeyVqJZUz7eWBwyUKK');
    expect(leg.roles.poolBaseTokenAccount).toBe('A7mZjX2EBqGxSn3zfDcKfmTQjyHMoCfJ9BEZzdmR9RBW');
    expect(leg.roles.poolQuoteTokenAccount).toBe('GayMivbsuNBQgve23Lz9qoMjzpKxmiN36Ydf2XNYo3vs');
  });

  it('attributes the base transfer out and the quote transfer in from the instruction\u2019s own subtree', () => {
    expect([leg.input.legRef, leg.output.legRef].map(ref => `[${ref?.outerIndex}.${ref?.index}]`)).toEqual([
      '[7.1]',
      '[7.2]',
    ]);
    expect(leg.input.tokenAccount).toBe('HiRnLovipYBuCuguxheoLZGu4brUKjzByp7mwwtqfWsx');
    expect(leg.input.mint).toBe(WSOL);
    expect(leg.input.amount).toBe(185_356n);
    expect(leg.input.owner).toBe('21gsFXQ8sEZHkt5PdXsJXQ9Mce43hEhYD1QALZdBvBNH');
    expect(leg.input.amountEvidence).toBe('transfer-leg');
    expect(leg.output.tokenAccount).toBe('FfcKsP6PMDG33mvuPpTtqjyW9SHpB7z7nChY7F9EghhP');
    expect(leg.output.mint).toBe('4LjRPLjLGSnzRjeL6GyTqLH7iQYeyVqJZUz7eWBwyUKK');
    expect(leg.output.amount).toBe(176_602_689n);
    expect(leg.output.owner).toBe('21gsFXQ8sEZHkt5PdXsJXQ9Mce43hEhYD1QALZdBvBNH');
  });

  it('reconciles both transfers with the effects model, leg by leg', () => {
    for (const side of ['input', 'output'] as const) {
      const legRef = leg[side].legRef;
      if (legRef === null) throw new Error(`${side} has no attributed transfer`);
      expect(checkOf(leg, `${side === 'input' ? 'base' : 'quote'}-reconciles-with-effects`).outcome).toBe('pass');
      const flow = effects.tokenFlows.find(
        entry =>
          entry.ref?.path === legRef.path &&
          entry.ref.outerIndex === legRef.outerIndex &&
          entry.ref.index === legRef.index,
      );
      expect(flow, `${side} flow at the leg's own reference`).toBeDefined();
      expect(flow?.amount).toBe(leg[side].amount);
      expect(flow?.mint).toBe(leg[side].mint);
      expect(flow?.amountSource).toBe('instruction-data');
      expect(flow?.commitState).toBe('committed');
    }
    // The user pays from their own account; the pool pays out of its own vault.
    expect(leg.input.owner).toBe(leg.roles.user);
    expect(effects.tokenFlows.find(entry => entry.ref?.index === 1)?.sourceTokenAccount).toBe(
      leg.roles.userBaseTokenAccount,
    );
    expect(effects.tokenFlows.find(entry => entry.ref?.index === 2)?.sourceTokenAccount).toBe(
      leg.roles.poolQuoteTokenAccount,
    );
  });

  it('treats the other pool-quote outflows as fee transfers, never as user output', () => {
    expect(leg.feeTransfers.map(entry => [entry.amount, entry.destTokenAccount, entry.role])).toEqual([
      [44_284n, 'DapfVTGPV27P1ECJbv7m1LySFUVWdkLuBwCaw6iM9q2K', 'protocol-fee-recipient'],
      [44_284n, 'DmdCrDeMPT2i2Q4VYuscN3KLGjnSyQyGbh7AHFNEYYDJ', 'other'],
    ]);
    // The fee destinations are other accounts, with their own owners...
    for (const fee of leg.feeTransfers) {
      expect(fee.destTokenAccount).not.toBe(leg.roles.userQuoteTokenAccount);
      expect(fee.destTokenAccount).not.toBe(leg.output.tokenAccount);
      expect(fee.destOwner).not.toBe('21gsFXQ8sEZHkt5PdXsJXQ9Mce43hEhYD1QALZdBvBNH');
      expect(fee.mint).toBe(leg.output.mint);
      expect(fee.destOwnerEvidence).toBe('account-metadata');
    }
    expect(leg.feeTransfers[0]?.destOwner).toBe('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');
    // ...and no fee amount is folded into the user's proceeds (176,602,689 either way).
    expect(leg.output.amount).toBe(176_602_689n);
    expect(checkOf(leg, 'user-output-excludes-fee-transfers').outcome).toBe('pass');
    expect(checkOf(leg, 'user-output-excludes-fee-transfers').detail).toContain('excluded by destination identity');
  });

  it('tests the real non-zero floor against the real output', () => {
    expect(checkOf(leg, 'min-quote-amount-out-stated').outcome).toBe('pass');
    expect(checkOf(leg, 'min-quote-amount-out-satisfied').outcome).toBe('pass');
    expect(checkOf(leg, 'min-quote-amount-out-satisfied').detail).toBe(
      'output 176602689 satisfies min_quote_amount_out 171510690',
    );
    expect(leg.unknowns).not.toContain('min-quote-amount-out-not-stated');
  });

  it('passes every check, in the fixed order', () => {
    expect(leg.checks.map(check => check.id)).toEqual(CHECK_ORDER);
    expect(leg.checks.every(check => check.outcome === 'pass')).toBe(true);
  });

  it('keeps the effects model green alongside the new layer', () => {
    expect(transaction.status).toBe('success');
    // Both notes are informational M3 findings about this transaction (an ATA
    // create whose deposit is recorded elsewhere, and a wrapped-SOL close whose
    // composition is not observable). Neither is a warning, and neither is
    // affected by the swap layer.
    expect(effects.diagnostics.map(note => [note.level, note.code])).toEqual([
      ['info', 'effects-create-deposit-stated-elsewhere'],
      ['info', 'effects-close-composition-not-observable'],
    ]);
    expect(effects.counts).toMatchObject({ proven: 11, reconciled: 3, unattributed: 0 });
  });
});

describe('v0-success-swap: a sell under the Jupiter route, next to two DLMM legs', () => {
  const { transaction, report, pump } = pumpFixture('v0-success-swap');
  const leg = pumpLegAt(report, 3, 0);

  it('reports one pump sell plus the two existing DLMM legs, in execution order', () => {
    expect(report.counts).toEqual({
      recognized: 3,
      proven: 3,
      partiallyProven: 0,
      notCommitted: 0,
      conflicting: 0,
    });
    expect(report.legs.map(entry => `${entry.protocol}[${entry.ref.outerIndex}.${entry.ref.index}]`)).toEqual([
      'pump-amm[3.0]',
      'meteora-dlmm[3.8]',
      'meteora-dlmm[3.13]',
    ]);
    expect(pump).toHaveLength(1);
    expect(dlmmLegs(report).map(entry => entry.ref.index)).toEqual([8, 13]);
  });

  it('reads the routed leg\u2019s own numbers, not the route\u2019s', () => {
    expect(leg.baseAmountIn).toBe(2_729_270_725_642n);
    expect(leg.minQuoteAmountOut).toBe(0n);
    expect(leg.input.tokenAccount).toBe('CLD7C8D2yiwCpGQ8e2HvcVwVti8Puc22wXYLqn6EruTt');
    expect(leg.input.mint).toBe(X_MINT);
    expect(leg.input.amount).toBe(2_729_270_725_642n);
    expect(leg.output.tokenAccount).toBe('Cr5vxXJTC4vu8PraDANEGLfE1YStzQo8JHYJ7K8qqAeh');
    expect(leg.output.mint).toBe(WSOL);
    expect(leg.output.amount).toBe(8_747_131_976n);
    // The user's WSOL account is created and closed in this transaction, so the
    // owner comes from the ATA `create`, not from a balance row.
    expect(leg.output.ownerEvidence).toBe('ata-create-instruction');
    expect([leg.input.legRef?.index, leg.output.legRef?.index]).toEqual([2, 3]);
    expect(leg.roles.pool).toBe('31eCTC8W3VcX7BiFwK2o5Ax41FPi2UyHcehcy2Gd3H5h');
    expect(leg.roles.tailAccountCount).toBe(3);
  });

  it('names each fee transfer by the slot the IDL gives it', () => {
    expect(leg.feeTransfers.map(entry => [entry.amount, entry.role, entry.ref.index])).toEqual([
      [2_211_106n, 'protocol-fee-recipient', 4],
      [75_177_576n, 'coin-creator-vault', 5],
      [2_211_105n, 'other', 6],
    ]);
    // The clause of the acceptance criteria this exists for: the biggest other
    // outflow (the creator's 75,177,576) is never the user's proceeds.
    expect(leg.output.amount).not.toBe(75_177_576n);
    expect(leg.output.amount).toBe(8_747_131_976n);
    expect(leg.feeTransfers.every(entry => entry.destTokenAccount !== leg.output.tokenAccount)).toBe(true);
  });

  it('reports the zero floor as an absence, never as a satisfied bound', () => {
    expect(checkOf(leg, 'min-quote-amount-out-stated').outcome).toBe('not-checkable');
    expect(checkOf(leg, 'min-quote-amount-out-satisfied').outcome).toBe('not-checkable');
    expect(leg.unknowns).toEqual(['min-quote-amount-out-not-stated']);
    expect(leg.checks.filter(check => check.id.startsWith('min-quote') && check.outcome === 'pass')).toEqual([]);
  });

  it('does not change the two DLMM legs M4.1 already proved', () => {
    const effects = transactionEffects(transaction);
    const before = recognizeDlmmSwaps(transaction, { effects });
    const after = dlmmLegs(report);
    expect(after).toHaveLength(2);
    expect(stringifyJson(after)).toBe(stringifyJson(before.legs));
  });
});

describe('fixtures with no pump_amm sell', () => {
  const names = [
    'v0-success-dlmm-minout',
    'token-mixed-approve',
    'v1-failed-custom11',
    'v1-failed-custom6001',
    'legacy-success-vote',
  ] as const;

  it('recognizes no pump leg, and never invents one', () => {
    for (const name of names) {
      const { report } = pumpFixture(name);
      const pump = report.legs.filter(entry => entry.protocol === 'pump-amm');
      expect(pump, name).toEqual([]);
    }
  });

  it('still finds the DLMM leg in the DLMM-only fixture', () => {
    const { report } = pumpFixture('v0-success-dlmm-minout');
    expect(report.counts).toMatchObject({ recognized: 1, proven: 1 });
    expect(report.legs[0]?.protocol).toBe('meteora-dlmm');
  });
});

describe('purity, determinism and what the model carries', () => {
  it('is a pure function of the normalized transaction', () => {
    for (const name of ['token-mixed-closeAccount', 'v0-success-swap'] as const) {
      const { transaction } = normalizeFixture(name);
      const before = stringifyJson(transaction);
      const effects = transactionEffects(transaction);
      const first = recognizeSwaps(transaction, { effects });
      const second = recognizeSwaps(transaction, { effects });
      expect(stringifyJson(first), name).toBe(stringifyJson(second));
      expect(stringifyJson(transaction), name).toBe(before);
    }
  });

  it('reads no clock and carries no raw payload or logs', () => {
    const { report, transaction } = pumpFixture('token-mixed-closeAccount');
    const text = stringifyJson(report);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toContain('logMessages');
    expect(text).not.toContain('preTokenBalances');
    expect(text).not.toContain('"raw"');
    for (const instruction of [
      ...transaction.instructions,
      ...innerInstructionsOf(transaction, 7),
    ]) {
      if (instruction.data !== null && instruction.data.length > 20) {
        expect(text).not.toContain(instruction.data);
      }
    }
    expect(PUMP_AMM_SELL_ACCOUNT_ROLES).toHaveLength(21);
  });
});
