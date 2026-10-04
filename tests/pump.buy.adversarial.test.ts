/**
 * The Milestone 4.3 adversarial matrix: one thing changed at a time, in memory.
 *
 * Each case states what the layer must *not* do — accept a look-alike, read a
 * truncated payload, guess between two equally plausible transfers, treat a second
 * outflow as output, or let a log line stand in for an instruction. The expected
 * outcome is a refusal, a warning, or a `conflicting` leg with both values named.
 */
import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { base58, bytesOfData, insertInnerInstruction, patchInstruction, withLogs } from './helpers/swaps.ts';
import { buyFixture, checkOf, onlyBuy, pumpBuyPayload } from './helpers/buy.ts';
import { instructionAt, patchAccounts, patchParsedInfo, setGroupStackHeight } from './helpers/pump.ts';
import { recognizePumpBuys } from '../src/swap/pump-buy-recognize.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { normalizeFixture } from './helpers/fixtures.ts';

/** The direct 24-byte buy: buy at [6], its five transfers at [6.1]–[6.5]. */
const DIRECT = 'v0-success-pump-buy-24b-direct';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Recognizes a mutated model, with effects rebuilt from the mutation. */
function recognize(transaction: ReturnType<typeof buyFixture>['transaction']) {
  return recognizePumpBuys(transaction, { effects: transactionEffects(transaction) });
}

function withData(data: string) {
  const { transaction } = buyFixture(DIRECT);
  return recognize(patchInstruction(transaction, null, 6, { data }));
}

describe('it is the instruction, or nothing', () => {
  it('requires the buy discriminator: a sell payload is a different instruction', () => {
    const sellDiscriminator = '33e685a4017f83ad';
    const real = instructionAt(buyFixture(DIRECT).transaction, null, 6);
    const bytes = [...bytesOfData(real?.data ?? '')];
    const swapped = [
      ...[...sellDiscriminator].map(pair => Number.parseInt(pair, 2)),
      ...[...sellDiscriminator].map(pair => Number.parseInt(pair, 2)),
    ];
    void swapped;
    const substituted = [
      ...[...sellDiscriminator].map(pair => Number.parseInt(pair, 2)),
      ...bytes.slice(8),
    ];
    const recognition = withData(base58(substituted));
    expect(recognition.legs).toEqual([]);
    // A different instruction of the same program is out of scope, and silently so.
    expect(recognition.diagnostics).toEqual([]);
  });

  it('requires the exact program id', () => {
    const { transaction } = buyFixture(DIRECT);
    const lookAlike = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEB';
    const recognition = recognize(patchInstruction(transaction, null, 6, { programId: lookAlike }));
    expect(recognition.legs).toEqual([]);
  });

  it('requires exact byte consumption', () => {
    const good = pumpBuyPayload(4_734_094_242_460n, 2_980_000_000n, 0x01);
    const bytes = [...bytesOfData(good)];
    const vectors: readonly (readonly [string, number[]])[] = [
      ['20 bytes', bytes.slice(0, 20)],
      ['23 bytes', bytes.slice(0, 23)],
      ['25th byte 0x02', [...bytes.slice(0, 24), 0x02]],
      ['26 bytes', [...bytes, 0x00]],
    ];
    for (const [label, value] of vectors) {
      const recognition = withData(base58(value));
      expect(recognition.legs.map(leg => leg.ref.index), label).toEqual([]);
      const note = recognition.diagnostics.find(entry => entry.code === 'pump-buy-args-not-recognized');
      expect(note?.level, label).toBe('warning');
    }
  });

  it('refuses a payload that is not valid base58 at all', () => {
    const recognition = withData('0OIl-not-base58');
    expect(recognition.legs).toEqual([]);
    expect(recognition.diagnostics.map(entry => entry.code)).toContain('pump-instruction-data-unreadable');
  });
});

describe('the named roles are the only addresses it trusts', () => {
  it('fails a leg whose account list cannot fill the named roles', () => {
    const { transaction } = buyFixture(DIRECT);
    const truncated = patchAccounts(transaction, null, 6, accounts => accounts.slice(0, 8));
    const recognition = recognize(truncated);
    const leg = recognition.legs[0];
    expect(leg?.state).toBe('conflicting');
    expect(leg?.conflicts).toContain('named-accounts-present');
    expect(leg?.diagnostics.map(note => note.code)).toContain('pump-buy-named-accounts-incomplete');
    // The missing role is the pool's quote account (slot 9), so the payment cannot be
    // attributed at all; the base output still can, because the roles that carry it
    // are present. What is *not* done is inventing the missing one.
    expect(leg?.input.legRef).toBeNull();
    expect(leg?.output.legRef?.index).toBe(1);
    expect(leg?.conflicts).toContain('quote-input-transfer-found');
  });

  it('fails when the two mints are swapped', () => {
    const { transaction } = buyFixture(DIRECT);
    const swapped = patchAccounts(transaction, null, 6, accounts => {
      const copy = [...accounts];
      [copy[3], copy[4]] = [copy[4] as string, copy[3] as string];
      return copy;
    });
    const leg = recognize(swapped).legs[0];
    expect(leg?.state).toBe('conflicting');
    expect(leg?.conflicts).toContain('base-output-mint-matches-named-role');
    expect(leg?.conflicts).toContain('quote-input-mint-matches-named-role');
  });

  it('fails when the two pool vaults are swapped', () => {
    const { transaction } = buyFixture(DIRECT);
    const swapped = patchAccounts(transaction, null, 6, accounts => {
      const copy = [...accounts];
      [copy[7], copy[8]] = [copy[8] as string, copy[7] as string];
      return copy;
    });
    const leg = recognize(swapped).legs[0];
    expect(leg?.state).toBe('conflicting');
    // The payment into the (now wrongly named) quote vault cannot be found, and the
    // base output no longer comes from the account named as its vault.
    expect(leg?.conflicts).toEqual(['quote-input-transfer-found', 'base-output-source-is-pool-vault']);
    expect(leg?.input.legRef).toBeNull();
  });

  it('fails when the user\u2019s own two token accounts are swapped', () => {
    const { transaction } = buyFixture(DIRECT);
    const swapped = patchAccounts(transaction, null, 6, accounts => {
      const copy = [...accounts];
      [copy[5], copy[6]] = [copy[6] as string, copy[5] as string];
      return copy;
    });
    const leg = recognize(swapped).legs[0];
    // The output can no longer be found where the instruction says it arrives, and the
    // transfer the instruction calls a payment now comes from the user's *base* slot.
    expect(leg?.state).toBe('conflicting');
    expect(leg?.conflicts).toEqual(['base-output-transfer-found', 'quote-input-source-is-user-quote-account']);
  });

  it('never consults the token programs: the transfers are read for what they are', () => {
    const { transaction, effects } = buyFixture(DIRECT);
    const swapped = patchAccounts(transaction, null, 6, accounts => {
      const copy = [...accounts];
      copy[11] = TOKEN_2022_PROGRAM;
      copy[12] = TOKEN_2022_PROGRAM;
      return copy;
    });
    expect(stringifyJson(recognize(swapped))).toBe(
      stringifyJson(recognizePumpBuys(transaction, { effects })),
    );
    expect(TOKEN_PROGRAM).not.toBe(TOKEN_2022_PROGRAM);
  });
});

describe('one transfer per side, or no claim at all', () => {
  it('refuses to guess between two transfers into the user\u2019s base account', () => {
    const { transaction } = buyFixture(DIRECT);
    const original = instructionAt(transaction, 6, 1);
    if (original === undefined) throw new Error('expected the base transfer at [6.1]');
    const leg = recognize(insertInnerInstruction(transaction, 6, 1, { ...original, index: 100 })).legs[0];
    expect(leg?.state).toBe('conflicting');
    expect(leg?.conflicts).toEqual(['base-output-transfer-found']);
    expect(checkOf(leg!, 'base-output-transfer-found').detail).toContain('2 candidate transfers');
    expect(checkOf(leg!, 'base-output-transfer-found').detail).toContain('ambiguous');
    expect(leg?.output.legRef).toBeNull();
  });

  it('refuses a payment that did not come from the named user quote account', () => {
    const { transaction } = buyFixture(DIRECT);
    const leg = onlyBuy(buyFixture(DIRECT));
    const rerouted = patchParsedInfo(transaction, 6, 2, {
      source: leg.roles.protocolFeeRecipientTokenAccount as string,
    });
    const mutated = recognize(rerouted).legs[0];
    expect(mutated?.state).toBe('conflicting');
    expect(mutated?.conflicts).toEqual(['quote-input-source-is-user-quote-account']);
    // Found — and rejected as the payment — rather than silently adopted.
    expect(mutated?.input.legRef?.index).toBe(2);
  });

  it('does not treat a transfer an account makes to itself as a payment', () => {
    const { transaction } = buyFixture(DIRECT);
    const leg = onlyBuy(buyFixture(DIRECT));
    const selfTransfer = patchParsedInfo(transaction, 6, 2, {
      source: leg.roles.poolQuoteTokenAccount as string,
    });
    const mutated = recognize(selfTransfer).legs[0];
    expect(mutated?.state).toBe('conflicting');
    expect(mutated?.conflicts).toEqual(['quote-input-transfer-found']);
    expect(mutated?.quoteSpend).toBeNull();
  });

  it('refuses a fee transfer re-pointed at the user\u2019s base account', () => {
    // The tail fee leg ([6.5]) is aimed at the account the user is paid in, so it is
    // now a second candidate for the output — and it is still an outflow, so it is
    // still part of the spend. Both facts are reported; neither is resolved by a rule.
    const { transaction } = buyFixture(DIRECT);
    const leg = onlyBuy(buyFixture(DIRECT));
    const moved = patchParsedInfo(transaction, 6, 5, {
      destination: leg.output.tokenAccount as string,
    });
    const mutated = recognize(moved).legs[0];
    expect(mutated?.state).toBe('conflicting');
    expect(mutated?.conflicts).toContain('base-output-transfer-found');
    expect(mutated?.feeTransfers.map(transfer => transfer.amount)).toEqual([584_812n, 22_222_829n, 584_811n]);
  });
});

describe('the argument is checked against the transfer', () => {
  it('fails when base_amount_out disagrees with the transfer, and says both values', () => {
    const { transaction, effects } = buyFixture(DIRECT);
    // The argument is changed; the transaction (and its effects) are not.
    const generous = patchInstruction(transaction, null, 6, {
      data: pumpBuyPayload(4_734_094_242_461n, 2_980_000_000n),
    });
    const leg = recognizePumpBuys(generous, { effects }).legs[0];
    expect(leg?.state).toBe('conflicting');
    expect(leg?.conflicts).toEqual(['base-amount-out-matches-base-transfer']);
    const detail = checkOf(leg!, 'base-amount-out-matches-base-transfer').detail;
    expect(detail).toContain('4734094242461');
    expect(detail).toContain('4734094242460');
    // The spend is untouched: it comes from the transfers, never from the argument.
    expect(leg?.quoteSpend).toBe(2_367_316_008n);
  });

  it('fails when the base transfer is re-pointed somewhere else', () => {
    const { transaction, effects } = buyFixture(DIRECT);
    const leg = onlyBuy(buyFixture(DIRECT));
    const diverted = patchParsedInfo(transaction, 6, 1, {
      destination: leg.roles.protocolFeeRecipientTokenAccount as string,
    });
    const mutated = recognizePumpBuys(diverted, { effects }).legs[0];
    expect(mutated?.state).toBe('conflicting');
    expect(mutated?.conflicts).toContain('base-output-transfer-found');
    expect(mutated?.output.amount).toBeNull();
  });
});

describe('evidence that is absent is not evidence', () => {
  it('never concludes "no buy" when the node recorded no CPI instructions', () => {
    const { transaction } = buyFixture(DIRECT);
    const blind = { ...transaction, innerInstructionGroups: [], innerInstructionsAvailable: false };
    const recognition = recognizePumpBuys(blind, { effects: transactionEffects(blind) });
    const leg = recognition.legs[0];
    expect(leg?.state).toBe('partially-proven');
    expect(leg?.conflicts).toEqual([]);
    for (const id of ['cpi-subtree-available', 'base-output-transfer-found', 'quote-input-transfer-found']) {
      expect(checkOf(leg!, id).outcome, id).toBe('not-checkable');
    }
    const note = recognition.diagnostics.find(entry => entry.code === 'swap-inner-instructions-unavailable');
    expect(note?.level).toBe('warning');
    expect(note?.message).toContain('not evidence that none happened');
  });

  it('refuses to attribute transfers that sit at the buy\u2019s own depth', () => {
    // A `swap2` rendered as top-level with its transfers as siblings: they belong to
    // the instruction only if they ran *inside* it.
    const { transaction } = buyFixture(DIRECT);
    const flattened = setGroupStackHeight(transaction, 6, 1);
    const leg = recognize(flattened).legs[0];
    expect(leg?.state).toBe('conflicting');
    expect(leg?.conflicts).toContain('base-output-transfer-found');
    expect(leg?.output.amount).toBeNull();
  });
});

describe('logs and events never substitute for instructions', () => {
  it('ignores logs entirely, on a successful and on a failed transaction', () => {
    const { transaction, effects } = buyFixture(DIRECT);
    const withBuyLogs = withLogs(transaction, [
      'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]',
      'Program log: Instruction: Buy',
      'Program data: QWxsIHRoZSBmZWVzIGFyZSBwYWlk',
      'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA success',
    ]);
    expect(stringifyJson(recognizePumpBuys(withBuyLogs, { effects }))).toBe(
      stringifyJson(recognizePumpBuys(transaction, { effects })),
    );
  });

  it('produces no legs for a vote transaction that only logs the word Buy', () => {
    const { transaction } = normalizeFixture('legacy-success-vote');
    const shouted = withLogs(transaction, [
      'Program Vote111111111111111111111111111111111111111 invoke [1]',
      'Program log: Instruction: Buy',
    ]);
    const recognition = recognizePumpBuys(shouted, { effects: transactionEffects(shouted) });
    expect(recognition.legs).toEqual([]);
    expect(recognition.diagnostics.filter(entry => entry.ref !== null)).toEqual([]);
  });
});

describe('the two payload forms are one instruction', () => {
  it('produces the same leg for 24 and 25 bytes, differing only in the recorded form', () => {
    const { transaction, effects } = buyFixture(DIRECT);
    const as25 = patchInstruction(transaction, null, 6, {
      data: pumpBuyPayload(4_734_094_242_460n, 2_980_000_000n, 0x00),
    });
    const leg24 = recognizePumpBuys(transaction, { effects }).legs[0];
    const leg25 = recognizePumpBuys(as25, { effects }).legs[0];
    expect(leg24?.trackVolumeByte).toBe('absent');
    expect(leg25?.trackVolumeByte).toBe('0x00');
    expect(leg24?.quoteSpend).toBe(leg25?.quoteSpend);
    expect(leg24?.baseAmountOut).toBe(leg25?.baseAmountOut);
    expect(leg24?.state).toBe(leg25?.state);
    // The only other difference is the sentence describing the payload itself.
    const strip = (leg: typeof leg24) =>
      leg?.checks
        .filter(check => check.id !== 'args-decode-exact')
        .map(check => [check.id, check.outcome, check.detail]);
    expect(strip(leg24)).toEqual(strip(leg25));
  });
});
