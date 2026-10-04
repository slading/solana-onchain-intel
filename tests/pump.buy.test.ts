/**
 * Milestone 4.3: the pump_amm `buy` — payload, roles, and the economic claims.
 *
 * The real fixtures are the primary vectors (`pump.buy.fixtures.test.ts` pins them
 * byte for byte); this file is where the semantics are stated so a reader can see
 * what is being claimed and what is deliberately not. Everything that is not in the
 * fixtures is reached by patching the normalized model in memory.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { base58, bytesOfData } from './helpers/swaps.ts';
import { buyFixture, checkOf, onlyBuy, outcomeOf, pumpBuyPayload, spendOf } from './helpers/buy.ts';
import {
  PUMP_AMM_BUY_ACCOUNT_ROLES,
  PUMP_AMM_BUY_DISCRIMINATOR,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SELL_ACCOUNT_ROLES,
  parsePumpBuyArgs,
} from '../src/swap/pump.ts';
import { recognizePumpBuys } from '../src/swap/pump-buy-recognize.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { patchInstruction, withStatus, withoutLogs } from './helpers/swaps.ts';

const U64_MAX = 18_446_744_073_709_551_615n;

/** The direct 24-byte buy: top-level [6], its five transfers at [6.1]–[6.5]. */
const DIRECT = 'v0-success-pump-buy-24b-direct';
/** The routed 24-byte buy whose cap is exactly binding. */
const ROUTED = 'v0-success-pump-buy-24b';

function payloadBytes(payload: string): Uint8Array {
  return bytesOfData(payload);
}

/** A `buy` payload with the arguments replaced, everything else kept. */
function withArgs(fixture: string, baseAmountOut: bigint, maxQuoteAmountIn: bigint, trailing?: number | null) {
  const { transaction, effects } = buyFixture(fixture);
  const patched = patchInstruction(transaction, null, 6, {
    data: pumpBuyPayload(baseAmountOut, maxQuoteAmountIn, trailing),
  });
  return { transaction: patched, effects, recognition: recognizePumpBuys(patched, { effects }) };
}

describe('the buy discriminator and account table', () => {
  it('derives the discriminator from the program source, not from an observation', () => {
    expect(createHash('sha256').update('global:buy').digest('hex').slice(0, 16)).toBe(
      PUMP_AMM_BUY_DISCRIMINATOR,
    );
    expect(PUMP_AMM_BUY_DISCRIMINATOR).toBe('66063d1201daebea');
  });

  it('lists the 23 roles in the IDL order: sell\u2019s first 19, then the volume accumulators and the fee pair', () => {
    // Exactly the IDL order of `pump-fun/pump-public-docs` → `idl/pump_amm.json`.
    expect([...PUMP_AMM_BUY_ACCOUNT_ROLES]).toEqual([
      ...PUMP_AMM_SELL_ACCOUNT_ROLES.slice(0, 19),
      'global_volume_accumulator',
      'user_volume_accumulator',
      'fee_config',
      'fee_program',
    ]);
    expect(PUMP_AMM_BUY_ACCOUNT_ROLES).toHaveLength(23);
  });
});

describe('buy argument parsing', () => {
  it('reads the two arguments with exact consumption in the 24-byte form', () => {
    const parsed = parsePumpBuyArgs(payloadBytes(pumpBuyPayload(13_454_552_763n, 97_750_000n)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.baseAmountOut).toBe(13_454_552_763n);
    expect(parsed.args.maxQuoteAmountIn).toBe(97_750_000n);
    expect(parsed.args.trackVolumeByte).toBe('absent');
    expect(parsed.args.consumedBytes).toBe(24);
  });

  it('records the trailing OptionBool byte verbatim in the 25-byte form', () => {
    for (const [byte, expected] of [
      [0x00, '0x00'],
      [0x01, '0x01'],
    ] as const) {
      const parsed = parsePumpBuyArgs(payloadBytes(pumpBuyPayload(1n, 2n, byte)));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.args.trackVolumeByte).toBe(expected);
      expect(parsed.args.consumedBytes).toBe(25);
      // The byte is recorded, never interpreted: it changes nothing else.
      expect(parsed.args.baseAmountOut).toBe(1n);
      expect(parsed.args.maxQuoteAmountIn).toBe(2n);
    }
  });

  it('never partially reads a payload', () => {
    const good = pumpBuyPayload(13_454_552_763n, 97_750_000n, 0x01);
    const bytes = payloadBytes(good);
    const cases: readonly (readonly [string, Uint8Array])[] = [
      ['8 bytes, no arguments', bytes.slice(0, 8)],
      ['17 bytes, the first argument truncated', bytes.slice(0, 17)],
      ['23 bytes, the second argument truncated', bytes.slice(0, 23)],
      ['26 bytes, one byte too many', new Uint8Array([...bytes, 0x00])],
    ];
    for (const [label, truncated] of cases) {
      const parsed = parsePumpBuyArgs(truncated);
      expect(parsed.ok, label).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.detail.length, label).toBeGreaterThan(0);
    }
  });

  it('rejects a trailing byte that is neither 0x00 nor 0x01', () => {
    for (const byte of [0x02, 0x7f, 0xff]) {
      const parsed = parsePumpBuyArgs(payloadBytes(pumpBuyPayload(1n, 2n, byte)));
      expect(parsed.ok, `0x${byte.toString(16)}`).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.detail).toContain('0x00 or 0x01');
    }
  });
});

describe('the recognized buy is the instruction\u2019s own claim', () => {
  it('reads the direction from the instruction, not from which token moved first', () => {
    const leg = onlyBuy(buyFixture(DIRECT));
    expect(leg.protocol).toBe('pump-amm');
    expect(leg.instructionName).toBe('buy');
    expect(leg.programId).toBe(PUMP_AMM_PROGRAM_ID);
    expect(leg.state).toBe('proven');
    expect(leg.trackVolumeByte).toBe('absent');
    // The payment is the transfer into the pool's quote vault, from the named user
    // quote account; the output is the base transfer into the named user base account.
    expect(leg.input.legRef).toEqual({ path: 'inner', index: 2, outerIndex: 6, stackHeight: 2 });
    expect(leg.output.legRef).toEqual({ path: 'inner', index: 1, outerIndex: 6, stackHeight: 2 });
    expect(leg.output.mint).toBe('AJAaGdG3rV1Awsd9asSPj6PYECE2avZPN3M54wp7pump');
    expect(leg.input.mint).toBe('So11111111111111111111111111111111111111112');
    expect(leg.roles.tailAccountCount).toBe(3);
    expect(leg.roles.coinCreatorVaultAta).not.toBeNull();
  });

  it('requires the base transfer to equal base_amount_out exactly', () => {
    const leg = onlyBuy(buyFixture(DIRECT));
    expect(leg.baseAmountOut).toBe(4_734_094_242_460n);
    expect(leg.output.amount).toBe(leg.baseAmountOut);
    expect(outcomeOf(leg, 'base-amount-out-matches-base-transfer')).toBe('pass');
  });

  it('lists who the user paid, and counts the whole spend as the payment plus those outflows', () => {
    const leg = onlyBuy(buyFixture(DIRECT));
    expect(leg.input.amount).toBe(2_343_923_556n);
    expect(leg.feeTransfers.map(transfer => [transfer.amount, transfer.role])).toEqual([
      [584_812n, 'protocol-fee-recipient'],
      [22_222_829n, 'coin-creator-vault'],
      [584_811n, 'other'],
    ]);
    expect(spendOf(leg)).toEqual({ vault: 2_343_923_556n, fees: 23_392_452n, total: 2_367_316_008n });
    expect(leg.quoteSpend).toBe(2_367_316_008n);
    expect(leg.quoteSpendComplete).toBe(true);
    // Fees are part of what the user paid; they are never part of what the user got.
    expect(leg.output.amount).not.toBe(leg.quoteSpend);
    for (const transfer of leg.feeTransfers) {
      expect(transfer.destTokenAccount).not.toBe(leg.output.tokenAccount);
      expect(transfer.mint).toBe(leg.input.mint);
    }
  });

  it('keeps a buy out of the sell recognizer\u2019s way, and vice versa', () => {
    const { transaction, effects } = buyFixture(DIRECT);
    const buys = recognizePumpBuys(transaction, { effects });
    expect(buys.legs).toHaveLength(1);
    // The sell recognizer (4.2) sees no sell here — the discriminators differ.
    const sells = buyFixture(DIRECT).sells;
    expect(sells).toEqual([]);
  });
});

describe('the cap bounds the total spend', () => {
  it('is satisfied when the total is below the stated maximum', () => {
    const leg = onlyBuy(buyFixture(DIRECT));
    expect(leg.maxQuoteAmountIn).toBe(2_980_000_000n);
    expect(outcomeOf(leg, 'max-quote-amount-in-satisfied')).toBe('pass');
    expect(checkOf(leg, 'max-quote-amount-in-satisfied').detail).toContain('2367316008');
    expect(checkOf(leg, 'max-quote-amount-in-satisfied').detail).toContain('other outflow(s)');
  });

  it('is exactly binding when the total equals it — satisfied, not exceeded', () => {
    const leg = onlyBuy(buyFixture(ROUTED));
    expect(leg.quoteSpend).toBe(22_914_125n);
    expect(leg.maxQuoteAmountIn).toBe(22_914_125n);
    expect(outcomeOf(leg, 'max-quote-amount-in-satisfied')).toBe('pass');
    expect(leg.state).toBe('proven');
    // The vault leg alone is *below* the cap: the cap bounds the total, not just the
    // transfer into the vault (the fees are the difference).
    expect(leg.input.amount !== null && leg.maxQuoteAmountIn !== null && leg.input.amount < leg.maxQuoteAmountIn).toBe(
      true,
    );
  });

  it('fails, with both values reported, when the total exceeds it', () => {
    const { effects } = buyFixture(DIRECT);
    const total = 2_367_316_008n;
    const { recognition } = withArgs(DIRECT, 4_734_094_242_460n, total - 1n);
    const leg = recognition.legs[0];
    expect(leg?.conflicts).toEqual(['max-quote-amount-in-satisfied']);
    expect(leg?.state).toBe('conflicting');
    const detail = checkOf(leg!, 'max-quote-amount-in-satisfied').detail;
    expect(detail).toContain('2367316007');
    expect(detail).toContain('2367316008');
    expect(leg?.quoteSpendComplete).toBe(true);
    void effects;
  });

  it('evaluates a zero cap literally: it is a bound of zero, not sell\u2019s "no floor"', () => {
    const { recognition } = withArgs(DIRECT, 4_734_094_242_460n, 0n);
    const leg = recognition.legs[0];
    expect(outcomeOf(leg!, 'max-quote-amount-in-satisfied')).toBe('fail');
    expect(leg?.state).toBe('conflicting');
    expect(leg?.unknowns).toEqual([]);
  });

  it('treats u64::MAX as no bound stated, never as a satisfied cap', () => {
    const { recognition } = withArgs(DIRECT, 4_734_094_242_460n, U64_MAX);
    const leg = recognition.legs[0];
    expect(outcomeOf(leg!, 'max-quote-amount-in-stated')).toBe('not-checkable');
    expect(outcomeOf(leg!, 'max-quote-amount-in-satisfied')).toBe('not-checkable');
    expect(leg?.unknowns).toEqual(['max-quote-amount-in-unbounded']);
    // The leg itself is still fully established — only the bound does not exist.
    expect(leg?.state).toBe('proven');
    expect(checkOf(leg!, 'max-quote-amount-in-satisfied').detail).toContain('never reported as passed');
  });

  it('never reports a cap as satisfied when the transaction failed', () => {
    const { transaction, effects } = buyFixture(DIRECT);
    const failed = withStatus(transaction, 'failed', { InstructionError: [6, { Custom: 6004 }] });
    const recognition = recognizePumpBuys(failed, { effects });
    const leg = recognition.legs[0];
    expect(outcomeOf(leg!, 'max-quote-amount-in-satisfied')).toBe('not-checkable');
    expect(checkOf(leg!, 'max-quote-amount-in-satisfied').detail).toContain('attempted movement');
  });
});

describe('the completeness gate precedes any cap claim', () => {
  it('refuses to test the cap when an outflow of the user\u2019s quote account is not enumerated', () => {
    // The fixture is recognized, then one fee transfer is removed from the subtree
    // while the effects model still records it — exactly the situation where a
    // recognizer that trusted its own enumeration would report "cap satisfied".
    const { transaction, effects } = buyFixture(DIRECT);
    const without = patchInstruction(transaction, 6, 3, { accounts: null, parsedInfo: null, programId: null });
    const recognition = recognizePumpBuys(without, { effects });
    const leg = recognition.legs[0];
    expect(outcomeOf(leg!, 'user-quote-spend-enumerated')).toBe('not-checkable');
    expect(leg?.unknowns).toContain('user-quote-spend-not-fully-enumerated');
    expect(outcomeOf(leg!, 'max-quote-amount-in-satisfied')).toBe('not-checkable');
    expect(leg?.state).toBe('partially-proven');
  });

  it('marks the spend unknown rather than guessing it from the effects', () => {
    // [6.4] is the coin-creator fee (22 222 829 units). With it unreadable, the
    // effects model still carries the movement, and it is still *not* added to the
    // spend: the total is the payment plus only what was actually attributed.
    const { transaction, effects } = buyFixture(DIRECT);
    const without = patchInstruction(transaction, 6, 4, { accounts: null, parsedInfo: null, programId: null });
    const leg = recognizePumpBuys(without, { effects }).legs[0];
    expect(leg?.feeTransfers.map(transfer => transfer.amount)).toEqual([584_812n, 584_811n]);
    expect(leg?.quoteSpend).toBe(2_343_923_556n + 584_812n + 584_811n);
    expect(leg?.quoteSpendComplete).toBe(false);
    expect(leg?.unknowns).toContain('user-quote-spend-not-fully-enumerated');
  });
});

describe('commitment', () => {
  it('labels a failed transaction\u2019s numbers as attempted, never as committed', () => {
    const { transaction, effects } = buyFixture(DIRECT);
    const failed = withStatus(transaction, 'failed', { InstructionError: [6, { Custom: 6004 }] });
    const recognition = recognizePumpBuys(failed, { effects });
    const leg = recognition.legs[0];
    expect(leg?.commitState).toBe('reverted');
    expect(leg?.state).toBe('not-committed');
    expect(leg?.conflicts).toEqual([]);
    // The amounts are still reported — they are just not state.
    expect(leg?.input.amount).toBe(2_343_923_556n);
    expect(outcomeOf(leg!, 'base-output-reconciles-with-effects')).toBe('not-checkable');
    expect(outcomeOf(leg!, 'transaction-committed')).toBe('not-checkable');
    // The leg's own diagnostics (the recognition-level list carries transaction-level
    // notes only, as in 4.1/4.2).
    expect(leg?.diagnostics.map(note => note.code)).toEqual(['pump-buy-not-committed']);
  });
});

describe('logs and events are never evidence', () => {
  it('produces the same report with the logs removed', () => {
    const { transaction, effects } = buyFixture(DIRECT);
    const withLogs = recognizePumpBuys(transaction, { effects });
    const without = recognizePumpBuys(withoutLogs(transaction), { effects });
    expect(stringifyJson(without)).toBe(stringifyJson(withLogs));
  });

  it('does not let a BuyEvent imply committed execution', () => {
    // The real failed fixture carries pump's own BuyEvent in its instructions and
    // logs; the transaction still reverted, so nothing it describes is state.
    const { transaction, effects, report } = buyFixture('v0-failed-pump-buy-slippage');
    const leg = report.legs.find(entry => entry.protocol === 'pump-amm' && entry.instructionName === 'buy');
    expect(leg?.commitState).toBe('reverted');
    expect(leg?.state).toBe('not-committed');
    expect(stringifyJson(recognizePumpBuys(withoutLogs(transaction), { effects }))).toBe(
      stringifyJson(recognizePumpBuys(transaction, { effects })),
    );
  });
});

describe('what buy recognition does not claim', () => {
  it('says nothing at all about a pump_amm instruction it does not recognize', () => {
    // `buy_exact_quote_in` shares the program and the direction, and its payload
    // begins with a different discriminator: it stays unrecognized, silently.
    const { transaction } = buyFixture(DIRECT);
    const real = transaction.instructions.find(entry => entry.index === 6);
    const bytes = [...bytesOfData(real?.data ?? '')];
    const substituted = [
      ...[...'c62e1552b4d9e870'].map(pair => Number.parseInt(pair, 16)),
      ...bytes.slice(8),
    ];
    const other = patchInstruction(transaction, null, 6, { data: base58(substituted) });
    const recognition = recognizePumpBuys(other, { effects: transactionEffects(other) });
    expect(recognition.legs).toEqual([]);
    expect(recognition.diagnostics).toEqual([]);
  });

  it('warns instead of guessing when the payload cannot be read exactly', () => {
    const { transaction } = buyFixture(DIRECT);
    const truncated = patchInstruction(transaction, null, 6, {
      data: pumpBuyPayload(4_734_094_242_460n, 2_980_000_000n, 0x02),
    });
    const recognition = recognizePumpBuys(truncated, { effects: transactionEffects(truncated) });
    expect(recognition.legs).toEqual([]);
    const note = recognition.diagnostics.find(entry => entry.code === 'pump-buy-args-not-recognized');
    expect(note?.level).toBe('warning');
    expect(note?.message).toContain('0x00 or 0x01');
  });

  it('marks everything not-checkable when no effects model is supplied', () => {
    const { transaction } = buyFixture(DIRECT);
    const recognition = recognizePumpBuys(transaction);
    const leg = recognition.legs[0];
    expect(leg?.state).toBe('partially-proven');
    expect(leg?.unknowns).toContain('effects-model-absent');
    expect(outcomeOf(leg!, 'base-output-reconciles-with-effects')).toBe('not-checkable');
    expect(outcomeOf(leg!, 'user-quote-spend-enumerated')).toBe('not-checkable');
    expect(recognition.diagnostics.some(note => note.code === 'swap-effects-model-absent')).toBe(true);
  });

  it('is pure: the input transaction is untouched and the report is deterministic', () => {
    const { transaction, effects } = buyFixture(DIRECT);
    const before = stringifyJson(transaction);
    const first = recognizePumpBuys(transaction, { effects });
    const second = recognizePumpBuys(transaction, { effects });
    expect(stringifyJson(transaction)).toBe(before);
    expect(stringifyJson(first)).toBe(stringifyJson(second));
  });
});
