/**
 * Adversarial and mutation vectors for the pump_amm `sell` layer.
 *
 * Every vector takes the real direct fixture (`token-mixed-closeAccount`) or the
 * real routed one (`v0-success-swap`) and changes exactly one thing **in memory**,
 * then asks whether the layer still tells the truth. Nothing is written to disk.
 *
 * `fixtures/*.json` stay exactly as harvested.
 */
import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { normalizeFixture } from './helpers/fixtures.ts';
import { recognizeSwaps } from '../src/swap/recognize-swaps.ts';
import { recognizePumpSells } from '../src/swap/pump-recognize.ts';
import { PUMP_AMM_BUY_DISCRIMINATOR, PUMP_AMM_PROGRAM_ID, PUMP_AMM_SELL_DISCRIMINATOR } from '../src/swap/pump.ts';
import {
  base58,
  dropInstruction,
  insertInnerInstruction,
  patchInstruction,
  withLogs,
  withoutInnerInstructions,
  withoutLogs,
  withStatus,
} from './helpers/swaps.ts';
import {
  checkOf,
  instructionAt,
  outcomeOf,
  patchAccounts,
  patchParsedInfo,
  pumpSellPayload,
  setGroupStackHeight,
} from './helpers/pump.ts';

const USER_QUOTE = 'FfcKsP6PMDG33mvuPpTtqjyW9SHpB7z7nChY7F9EghhP';
const USER_BASE = 'HiRnLovipYBuCuguxheoLZGu4brUKjzByp7mwwtqfWsx';
const POOL_BASE = 'A7mZjX2EBqGxSn3zfDcKfmTQjyHMoCfJ9BEZzdmR9RBW';
const POOL_QUOTE = 'GayMivbsuNBQgve23Lz9qoMjzpKxmiN36Ydf2XNYo3vs';
const QUOTE_MINT = '4LjRPLjLGSnzRjeL6GyTqLH7iQYeyVqJZUz7eWBwyUKK';
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const direct = () => normalizeFixture('token-mixed-closeAccount').transaction;
const routed = () => normalizeFixture('v0-success-swap').transaction;

/** Recognize with an effects model built from the (possibly mutated) transaction. */
function run(transaction: ReturnType<typeof direct>, options: { effects?: boolean } = {}) {
  const effects = options.effects === false ? undefined : transactionEffects(transaction);
  return recognizePumpSells(transaction, { effects });
}

function onlyLeg(transaction: ReturnType<typeof direct>) {
  const recognition = run(transaction);
  expect(recognition.legs).toHaveLength(1);
  const leg = recognition.legs[0];
  if (leg === undefined) throw new Error('unreachable');
  return leg;
}

function onlySell(transaction: ReturnType<typeof direct>) {
  return onlyLeg(transaction);
}

describe('the instruction is the only source of the claim', () => {
  it('requires the exact program id', () => {
    const recognition = run(patchInstruction(direct(), null, 7, { programId: TOKEN }));
    expect(recognition.legs).toEqual([]);
  });

  it('requires the sell discriminator, and never accepts a buy', () => {
    const sellBytes = pumpSellPayload(185_356n, 171_510_690n);
    const buyBytes = [
      ...(PUMP_AMM_BUY_DISCRIMINATOR.match(/../g) ?? []).map(byte => Number.parseInt(byte, 16)),
      ...sellBytes.slice(8),
    ];
    const recognition = run(patchInstruction(direct(), null, 7, { data: base58(buyBytes) }));
    expect(recognition.legs).toEqual([]);
    // A different instruction of the same program is out of scope, and silently so.
    expect(recognition.diagnostics).toEqual([]);
  });

  it('leaves an unparseable payload unrecognized, and says why', () => {
    const recognition = run(
      patchInstruction(direct(), null, 7, {
        data: base58([...pumpSellPayload(185_356n, 171_510_690n), 0x00]),
      }),
    );
    expect(recognition.legs).toEqual([]);
    const note = recognition.diagnostics.find(entry => entry.code === 'pump-sell-args-not-recognized');
    expect(note?.level).toBe('warning');
    expect(note?.ref?.index).toBe(7);
    expect(note?.message).toContain('trailing byte');
  });

  it('reports unreadable instruction data instead of guessing', () => {
    const recognition = run(patchInstruction(direct(), null, 7, { data: 'not-base58!!' }));
    expect(recognition.legs).toEqual([]);
    expect(recognition.diagnostics.map(entry => entry.code)).toContain('pump-instruction-data-unreadable');
  });

  it('does not depend on logs, and does not trust them', () => {
    const withoutLogsLeg = onlySell(withoutLogs(direct()));
    expect(withoutLogsLeg.state).toBe('proven');

    const vote = normalizeFixture('legacy-success-vote').transaction;
    const fake = withLogs(vote, [
      ...(vote.logs ?? []),
      `Program ${PUMP_AMM_PROGRAM_ID} invoke [1]`,
      'Program log: Instruction: Sell',
      'Program data: 42NwqlCjCtI=',
      'Program log: Instruction: Sell',
    ]);
    const recognition = run(fake);
    expect(recognition.legs).toEqual([]);
  });
});

describe('amount reconciliation', () => {
  it('conflicts when base_amount_in disagrees with the transfer, printing both', () => {
    const leg = onlySell(patchInstruction(direct(), null, 7, { data: base58(pumpSellPayload(185_357n, 171_510_690n)) }));
    expect(leg.state).toBe('conflicting');
    // The argument no longer matches the transfer. (The effects model is rebuilt
    // from the same instruction, so it agrees with the transfer, not the argument —
    // the cross-check that catches *that* is exercised separately below.)
    expect(leg.conflicts).toEqual(['base-amount-matches-base-amount-in']);
    const check = checkOf(leg, 'base-amount-matches-base-amount-in');
    expect(check.detail).toContain('185357');
    expect(check.detail).toContain('185356');
    expect(leg.baseAmountIn).toBe(185_357n);
  });

  it('conflicts when the instruction and the effects model describe different movement', () => {
    // The layer is handed the *original* effects model with a mutated instruction:
    // the action says 176,602,690 and the effects flow still says 176,602,689. A
    // layer that trusted either side alone would call this proven.
    const original = transactionEffects(direct());
    const mutated = patchParsedInfo(direct(), 7, 2, {
      tokenAmount: { amount: '176602690', decimals: 6, uiAmount: 176.60269, uiAmountString: '176.60269' },
    });
    const recognition = recognizePumpSells(mutated, { effects: original });
    const leg = recognition.legs[0];
    expect(leg?.state).toBe('conflicting');
    expect(leg?.conflicts).toEqual(['quote-reconciles-with-effects']);
    expect(checkOf(leg!, 'quote-reconciles-with-effects').detail).toContain('does not match the transfer');
    // A mismatch on the base side is caught the same way.
    const baseMutated = patchParsedInfo(direct(), 7, 1, {
      tokenAmount: { amount: '185357', decimals: 9, uiAmount: 0.000185357, uiAmountString: '0.000185357' },
    });
    const second = recognizePumpSells(baseMutated, { effects: original });
    expect(second.legs[0]?.conflicts).toEqual([
      'base-amount-matches-base-amount-in',
      'base-reconciles-with-effects',
    ]);
  });

  it('conflicts when the output is below a stated floor, and only then', () => {
    const violated = onlySell(patchInstruction(direct(), null, 7, { data: base58(pumpSellPayload(185_356n, 176_602_690n)) }));
    expect(violated.state).toBe('conflicting');
    expect(violated.conflicts).toEqual(['min-quote-amount-out-satisfied']);
    expect(checkOf(violated, 'min-quote-amount-out-satisfied').detail).toBe(
      'output 176602689 is below min_quote_amount_out 176602690',
    );

    // Exactly meeting the floor is satisfied.
    const met = onlySell(patchInstruction(direct(), null, 7, { data: base58(pumpSellPayload(185_356n, 176_602_689n)) }));
    expect(met.state).toBe('proven');
    expect(outcomeOf(met, 'min-quote-amount-out-satisfied')).toBe('pass');
    expect(met.unknowns).toEqual([]);

    // One unit less of protection is a pass again — the floor moved, the output did not.
    const lowered = onlySell(patchInstruction(direct(), null, 7, { data: base58(pumpSellPayload(185_356n, 1n)) }));
    expect(lowered.state).toBe('proven');
    expect(lowered.minQuoteAmountOut).toBe(1n);
  });

  it('never reports a zero floor as satisfied', () => {
    // The routed fixture's real sell states min_quote_amount_out = 0.
    const recognition = run(routed());
    const legs = recognition.legs;
    expect(legs).toHaveLength(1);
    const leg = legs[0];
    expect(leg?.minQuoteAmountOut).toBe(0n);
    expect(leg?.state).toBe('proven');
    expect(outcomeOf(leg!, 'min-quote-amount-out-stated')).toBe('not-checkable');
    expect(outcomeOf(leg!, 'min-quote-amount-out-satisfied')).toBe('not-checkable');
    expect(leg?.unknowns).toContain('min-quote-amount-out-not-stated');
  });
});

describe('named roles and vaults are proof, not decoration', () => {
  it('conflicts when the base transfer does not land on the named pool vault', () => {
    const leg = onlySell(patchAccounts(direct(), null, 7, accounts => {
      accounts[7] = POOL_QUOTE;
      return accounts;
    }));
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['base-input-vault-is-pool-vault']);
    expect(checkOf(leg, 'base-input-vault-is-pool-vault').detail).toContain('is not pool_base_token_account');
  });

  it('conflicts when the quote transfer does not come from the named vault', () => {
    const leg = onlySell(patchParsedInfo(direct(), 7, 2, { source: POOL_BASE }));
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toContain('quote-output-vault-is-pool-vault');
  });

  it('conflicts when the base mint is not the named base mint', () => {
    const leg = onlySell(patchAccounts(direct(), null, 7, accounts => {
      accounts[3] = QUOTE_MINT;
      return accounts;
    }));
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['base-mint-matches-named-role']);
    expect(checkOf(leg, 'base-mint-matches-named-role').detail).toContain('is not base_mint');
  });

  it('conflicts when the quote mint is not the named quote mint', () => {
    const leg = onlySell(patchParsedInfo(direct(), 7, 2, { mint: WSOL }));
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['quote-mint-matches-named-role']);
  });

  it('refuses to guess when the program does not name the user accounts', () => {
    // Without the 21 named roles there is nothing to match a transfer against.
    const leg = onlySell(patchAccounts(direct(), null, 7, accounts => accounts.slice(0, 6)));
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toContain('named-accounts-present');
    expect(leg.roles.userQuoteTokenAccount).toBeNull();
  });
});

describe('the user\u2019s output is identified by its named slot, never by shape', () => {
  it('excludes every fee transfer, including the largest one', () => {
    const leg = onlyLeg(routed());
    expect(leg.feeTransfers.map(entry => entry.amount)).toEqual([2_211_106n, 75_177_576n, 2_211_105n]);
    for (const fee of leg.feeTransfers) {
      expect(fee.destTokenAccount).not.toBe(leg.roles.userQuoteTokenAccount);
    }
    expect(leg.output.amount).toBe(8_747_131_976n);
    expect(checkOf(leg, 'user-output-excludes-fee-transfers').outcome).toBe('pass');
  });

  it('conflicts when a fee transfer is redirected into the user\u2019s quote account', () => {
    // [7.3] is the protocol-fee transfer. Pointing it at the user's quote account
    // leaves two equally plausible outputs: never a pick, always a conflict.
    const leg = onlySell(patchParsedInfo(direct(), 7, 3, { destination: USER_QUOTE }));
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['quote-output-transfer-found']);
    expect(checkOf(leg, 'quote-output-transfer-found').detail).toContain('2 candidate transfers');
    expect(checkOf(leg, 'quote-output-transfer-found').detail).toContain('ambiguous');
    expect(leg.output.amount).toBeNull();
  });

  it('never counts a transfer into a different account the user happens to own', () => {
    // Send the pool's output to the user's *base* account instead of the named
    // quote account: the named slot has no incoming transfer, and nothing else is
    // accepted in its place.
    const leg = onlySell(patchParsedInfo(direct(), 7, 2, { destination: USER_BASE }));
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['quote-output-transfer-found']);
    expect(leg.output.amount).toBeNull();
  });

  it('reports a fee destination by its IDL slot only when a slot names it', () => {
    const leg = onlyLeg(direct());
    expect(leg.feeTransfers.map(entry => entry.role)).toEqual(['protocol-fee-recipient', 'other']);
    // The second destination is the BuybackVault's quote account, which the
    // instruction does not name: it is reported as `other` with owner evidence,
    // never given a role the instruction does not state.
    expect(leg.feeTransfers[1]?.destOwnerEvidence).toBe('account-metadata');
    expect(leg.feeTransfers[1]?.destOwner).toBe('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');
  });
});

describe('the CPI subtree decides which transfers belong to the instruction', () => {
  it('proves the leg when the transfers were executed inside its subtree', () => {
    const leg = onlyLeg(direct());
    expect(leg.state).toBe('proven');
    expect(outcomeOf(leg, 'cpi-subtree-available')).toBe('pass');
    expect(leg.input.legRef?.index).toBe(1);
    expect(leg.output.legRef?.index).toBe(2);
  });

  it('refuses transfers recorded as siblings rather than descendants', () => {
    // Every inner instruction of the group is downgraded to the sell's own depth,
    // so nothing is inside its subtree any more.
    const leg = onlySell(setGroupStackHeight(direct(), 7, 1));
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['base-input-transfer-found', 'quote-output-transfer-found']);
    expect(leg.input.amount).toBeNull();
    expect(leg.output.amount).toBeNull();
  });

  it('is partially proven, not contradictory, when the node recorded no CPIs', () => {
    const recognition = run(withoutInnerInstructions(direct()));
    expect(recognition.legs).toHaveLength(1);
    const leg = recognition.legs[0];
    expect(leg?.state).toBe('partially-proven');
    expect(leg?.conflicts).toEqual([]);
    expect(leg?.unknowns).toEqual([]);
    for (const id of ['cpi-subtree-available', 'base-input-transfer-found', 'quote-output-transfer-found']) {
      expect(outcomeOf(leg!, id), id).toBe('not-checkable');
    }
    const note = recognition.diagnostics.find(entry => entry.code === 'swap-inner-instructions-unavailable');
    expect(note?.level).toBe('warning');
    expect(note?.message).toContain('not evidence that none happened');
  });

  it('refuses to guess when two transfers on one side are equally plausible', () => {
    const original = instructionAt(direct(), 7, 1);
    if (original === undefined) throw new Error('expected the base transfer at [7.1]');
    const leg = onlySell(insertInnerInstruction(direct(), 7, 1, { ...original, index: 100 }));
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['base-input-transfer-found']);
    expect(checkOf(leg, 'base-input-transfer-found').detail).toContain('2 candidate transfers');
  });

  it('never attributes a transfer of the nested fee oracle', () => {
    // [7.0] is the pump_fees CPI. It sits inside the subtree but carries no
    // transfer: nothing about it can become part of the claim.
    const leg = onlyLeg(direct());
    const subtreeRefs = leg.checks
      .filter(entry => entry.outcome === 'pass')
      .map(entry => entry.detail)
      .join(' ');
    expect(subtreeRefs).toContain('[7.1]');
    expect(subtreeRefs).toContain('[7.2]');
    expect(subtreeRefs).not.toContain('[7.0]');
  });
});

describe('commitment', () => {
  it('never reports a committed sell for a failed transaction', () => {
    for (const name of ['token-mixed-closeAccount', 'v0-success-swap'] as const) {
      const transaction = withStatus(normalizeFixture(name).transaction, 'failed', {
        InstructionError: [7, { Custom: 6004 }],
      });
      const recognition = recognizePumpSells(transaction, { effects: transactionEffects(transaction) });
      const pump = recognition.legs;
      expect(pump.length, name).toBe(1);
      for (const leg of pump) {
        expect(leg.state, name).toBe('not-committed');
        expect(leg.commitState, name).toBe('reverted');
        expect(outcomeOf(leg, 'transaction-committed'), name).toBe('not-checkable');
        expect(checkOf(leg, 'transaction-committed').detail).toContain('rolls every state change back');
        expect(leg.diagnostics.map(note => note.code)).toEqual(['pump-sell-not-committed']);
        // The amounts are still instruction data; they are simply not state.
        expect(leg.input.amount).toBe(leg.baseAmountIn);
      }
    }
  });

  it('cannot prove a leg when no effects model was supplied', () => {
    const recognition = run(direct(), { effects: false });
    const leg = recognition.legs[0];
    expect(leg?.state).toBe('partially-proven');
    expect(outcomeOf(leg!, 'base-reconciles-with-effects')).toBe('not-checkable');
    expect(outcomeOf(leg!, 'quote-reconciles-with-effects')).toBe('not-checkable');
    expect(leg?.unknowns).toContain('effects-model-absent');
    const note = recognition.diagnostics.find(entry => entry.code === 'swap-effects-model-absent');
    expect(note?.level).toBe('info');
    expect(note?.message).toContain('pump_amm sell');
  });

  it('treats an unknown status as unknown', () => {
    const transaction = { ...direct(), status: 'unknown' as const };
    const recognition = recognizePumpSells(transaction, { effects: transactionEffects(transaction) });
    expect(recognition.legs[0]?.commitState).toBe('unknown');
    expect(recognition.legs[0]?.state).toBe('not-committed');
  });
});

describe('the aggregate report', () => {
  it('deduplicates transaction-level notes across protocols', () => {
    const transaction = withoutInnerInstructions(routed());
    const report = recognizeSwaps(transaction, { effects: transactionEffects(transaction) });
    const codes = report.diagnostics.filter(note => note.ref === null).map(note => note.code);
    expect(codes.filter(code => code === 'swap-inner-instructions-unavailable')).toHaveLength(1);
  });

  it('still reports DLMM legs when pump recognition is refused', () => {
    // Break the pump instruction: the two DLMM legs must be unaffected.
    const report = recognizeSwaps(
      patchInstruction(routed(), 3, 0, { data: base58([...pumpSellPayload(1n, 1n), 0x7f]) }),
      { effects: transactionEffects(patchInstruction(routed(), 3, 0, { data: base58([...pumpSellPayload(1n, 1n), 0x7f]) })) },
    );
    expect(report.legs.map(entry => entry.protocol)).toEqual(['meteora-dlmm', 'meteora-dlmm']);
    expect(report.counts).toMatchObject({ recognized: 2, proven: 2, conflicting: 0 });
  });

  it('keeps the legs in execution order across protocols', () => {
    const report = recognizeSwaps(routed(), { effects: transactionEffects(routed()) });
    expect(report.legs.map(entry => `${entry.protocol}[${entry.ref.outerIndex}.${entry.ref.index}]`)).toEqual([
      'pump-amm[3.0]',
      'meteora-dlmm[3.8]',
      'meteora-dlmm[3.13]',
    ]);
    expect(report.scannedProtocols).toEqual(['meteora-dlmm', 'pump-amm']);
  });
});

describe('determinism and non-mutation', () => {
  it('produces the same model for the same input', () => {
    for (const name of ['token-mixed-closeAccount', 'v0-success-swap'] as const) {
      const transaction = normalizeFixture(name).transaction;
      const effects = transactionEffects(transaction);
      const first = recognizePumpSells(transaction, { effects });
      const second = recognizePumpSells(transaction, { effects });
      expect(stringifyJson(first), name).toBe(stringifyJson(second));
    }
  });

  it('carries u64 arguments through without losing a unit', () => {
    for (const [amount, floor] of [
      [0n, 0n],
      [185_356n, 171_510_690n],
      [18_446_744_073_709_551_615n, 18_446_744_073_709_551_615n],
    ] as const) {
      const leg = onlySell(patchInstruction(direct(), null, 7, { data: base58(pumpSellPayload(amount, floor)) }));
      expect(leg.baseAmountIn).toBe(amount);
      expect(leg.minQuoteAmountOut).toBe(floor);
      // The real transfer moves 185,356 units: that argument is the proven case,
      // any other argument is a conflict, and the extreme values survive intact.
      if (amount === 185_356n) {
        expect(leg.state).toBe('proven');
      } else {
        expect(leg.state).toBe('conflicting');
        expect(leg.conflicts).toContain('base-amount-matches-base-amount-in');
      }
    }
  });

  it('leaves the normalized transaction untouched', () => {
    const transaction = direct();
    const before = stringifyJson(transaction);
    recognizePumpSells(transaction, { effects: transactionEffects(transaction) });
    recognizeSwaps(transaction, { effects: transactionEffects(transaction) });
    expect(stringifyJson(transaction)).toBe(before);
  });
});

describe('the constants the layer matches on', () => {
  it('is one program, one discriminator, and they are distinct values', () => {
    expect(PUMP_AMM_PROGRAM_ID).toBe('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
    expect(PUMP_AMM_SELL_DISCRIMINATOR).not.toBe(PUMP_AMM_BUY_DISCRIMINATOR);
  });

  it('does not disturb the 4.1 DLMM layer', () => {
    const transaction = routed();
    const effects = transactionEffects(transaction);
    const before = recognizeSwaps(transaction, { effects });
    const dlmm = before.legs.filter(entry => entry.protocol === 'meteora-dlmm');
    expect(dlmm).toHaveLength(2);
    // Removing the pump instruction entirely leaves both DLMM legs proven.
    const withoutPump = dropInstruction(transaction, 3, 0);
    const after = recognizeSwaps(withoutPump, { effects: transactionEffects(withoutPump) });
    expect(after.legs.filter(entry => entry.protocol === 'meteora-dlmm')).toHaveLength(2);
    expect(after.counts.proven).toBe(2);
  });
});
