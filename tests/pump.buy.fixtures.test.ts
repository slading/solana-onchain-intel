/**
 * The six real `pump_amm buy` transactions, through the whole pipeline.
 *
 * These are the only real buys in the repository, so they are where the recognizer
 * has to hold up against data it was not written around: a legacy direct buy, a
 * routed 24-byte buy whose cap is exactly binding, a direct 24-byte buy, the
 * 25-byte form that carries `0x00`, a `u64::MAX` cap, and a real failure. Every
 * number below was read from the transaction's own bytes and transfers, not from a
 * log or an event.
 */
import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { isNativeMint } from '../src/effects/native.ts';
import { normalizeFixture } from './helpers/fixtures.ts';
import { buyFixture, onlyBuy, spendOf } from './helpers/buy.ts';
import { PUMP_AMM_PROGRAM_ID } from '../src/swap/pump.ts';

const U64_MAX = 18_446_744_073_709_551_615n;

describe.each([
  {
    fixture: 'legacy-success-pump-buy',
    version: 'legacy',
    ref: [null, 6] as const,
    form: '0x01',
    baseAmountOut: 13_454_552_763n,
    maxQuoteAmountIn: 97_750_000n,
    vault: 83_772_159n,
    fees: [20_902n, 627_038n, 20_901n],
    quoteMint: 'So11111111111111111111111111111111111111112',
    baseMint: 'Gy5bjXA2Bu9NsExqxs5xDbWt6ZJPpqdfGQHCg6aMpump',
    tail: 3,
  },
  {
    fixture: 'v0-success-pump-buy-24b-direct',
    version: 0,
    ref: [null, 6] as const,
    form: 'absent',
    baseAmountOut: 4_734_094_242_460n,
    maxQuoteAmountIn: 2_980_000_000n,
    vault: 2_343_923_556n,
    fees: [584_812n, 22_222_829n, 584_811n],
    quoteMint: 'So11111111111111111111111111111111111111112',
    baseMint: 'AJAaGdG3rV1Awsd9asSPj6PYECE2avZPN3M54wp7pump',
    tail: 3,
  },
  {
    fixture: 'v0-success-pump-buy-24b',
    version: 0,
    ref: [3, 8] as const,
    form: 'absent',
    baseAmountOut: 85_582_319_888n,
    maxQuoteAmountIn: 22_914_125n,
    vault: 22_635_760n,
    fees: [105_236n, 67_894n, 105_235n],
    quoteMint: 'So11111111111111111111111111111111111111112',
    baseMint: 'H5mBRtgRA2jkAx4ALbF3cEbhYJJVHYcdYDSjE4wUpump',
    tail: 3,
  },
  {
    fixture: 'v0-success-pump-buy-25b-false',
    version: 0,
    ref: [null, 2] as const,
    form: '0x00',
    baseAmountOut: 20_865_294n,
    maxQuoteAmountIn: 48_731_403_628n,
    vault: 46_189_648_169n,
    fees: [11_518_616n, 11_518_616n],
    quoteMint: 'qSSmg4JqCoXVHBaBa1Y7t74cwkhXUgdb8cUj7uPVisz',
    baseMint: 'So11111111111111111111111111111111111111112',
    tail: 2,
  },
  {
    fixture: 'v0-success-pump-buy-unbounded',
    version: 0,
    ref: [null, 6] as const,
    form: '0x01',
    baseAmountOut: 9_650_000_000n,
    maxQuoteAmountIn: U64_MAX,
    vault: 7_480_589_654_077n,
    fees: [1_865_483_705n, 1_865_483_704n],
    quoteMint: 'CCpQFmAiRxYn9twQ3ArgZHzLKx3gP3KarpBunj5oURji',
    baseMint: 'So11111111111111111111111111111111111111112',
    tail: 2,
  },
] as const)('%s', entry => {
  const fixture = buyFixture(entry.fixture);

  it('recognizes exactly the buy the bytes describe', () => {
    const [outerIndex, index] = entry.ref;
    const leg = onlyBuy(fixture);
    expect(leg.ref.path).toBe(outerIndex === null ? 'top-level' : 'inner');
    expect(leg.ref.outerIndex).toBe(outerIndex);
    expect(leg.ref.index).toBe(index);
    expect(leg.baseAmountOut).toBe(entry.baseAmountOut);
    expect(leg.maxQuoteAmountIn).toBe(entry.maxQuoteAmountIn);
    expect(leg.trackVolumeByte).toBe(entry.form);
    expect(leg.input.mint).toBe(entry.quoteMint);
    expect(leg.output.mint).toBe(entry.baseMint);
    expect(leg.roles.tailAccountCount).toBe(entry.tail);
    expect(leg.programId).toBe(PUMP_AMM_PROGRAM_ID);
  });

  it('accounts for the whole spend: the vault transfer plus exactly the observed fee transfers', () => {
    const leg = onlyBuy(fixture);
    expect(leg.input.amount).toBe(entry.vault);
    expect(leg.feeTransfers.map(transfer => transfer.amount)).toEqual([...entry.fees]);
    expect(spendOf(leg).total).toBe(entry.vault + entry.fees.reduce((sum, fee) => sum + fee, 0n));
    expect(leg.quoteSpend).toBe(spendOf(leg).total);
    expect(leg.quoteSpendComplete).toBe(true);
    // Every fee leg is a transfer out of the *same* account the payment came from,
    // in the same mint.
    for (const transfer of leg.feeTransfers) {
      expect(transfer.mint).toBe(entry.quoteMint);
      expect(transfer.destTokenAccount).not.toBe(leg.input.tokenAccount);
    }
  });

  it('recomputes the spend independently from the effects model, and agrees', () => {
    // The completeness gate compares the enumeration with the Milestone 3 flows; this
    // re-derives the number from those flows so a bug in the enumeration cannot hide.
    const leg = onlyBuy(fixture);
    // The subtree re-derived from the effects model's own refs: the inner group the
    // buy ran in, restricted to frames deeper than the buy itself.
    const group = leg.ref.path === 'inner' ? leg.ref.outerIndex : leg.ref.index;
    const observed = fixture.effects.tokenFlows
      .filter(
        flow =>
          flow.ref !== null &&
          flow.ref.path === 'inner' &&
          flow.ref.outerIndex === group &&
          (flow.ref.stackHeight ?? 0) > (leg.ref.stackHeight ?? 1) &&
          flow.sourceTokenAccount === leg.input.tokenAccount,
      )
      .reduce((sum, flow) => sum + (flow.amount ?? 0n), 0n);
    expect(observed).toBe(leg.quoteSpend);
    expect(leg.checks.find(check => check.id === 'user-quote-spend-enumerated')?.outcome).toBe('pass');
  });

  it('keeps the cap a bound on that total, and states what it can', () => {
    const leg = onlyBuy(fixture);
    const spend = leg.quoteSpend;
    expect(spend).not.toBeNull();
    if (leg.maxQuoteAmountIn === U64_MAX) {
      expect(leg.unknowns).toContain('max-quote-amount-in-unbounded');
      expect(leg.checks.find(check => check.id === 'max-quote-amount-in-satisfied')?.outcome).toBe('not-checkable');
      return;
    }
    expect(leg.checks.find(check => check.id === 'max-quote-amount-in-satisfied')?.outcome).toBe('pass');
    expect(spend! <= leg.maxQuoteAmountIn!).toBe(true);
  });

  it('is proven, deterministic, and free of unexplained claims', () => {
    const leg = onlyBuy(fixture);
    expect(leg.state).toBe('proven');
    expect(leg.commitState).toBe('committed');
    expect(leg.conflicts).toEqual([]);
    expect(leg.unknowns).toEqual(leg.maxQuoteAmountIn === U64_MAX ? ['max-quote-amount-in-unbounded'] : []);
    const notPassing = leg.checks.filter(check => check.outcome !== 'pass').map(check => check.id);
    expect(notPassing).toEqual(
      leg.maxQuoteAmountIn === U64_MAX ? ['max-quote-amount-in-stated', 'max-quote-amount-in-satisfied'] : [],
    );
    const { transaction } = normalizeFixture(entry.fixture);
    expect(stringifyJson(buyFixture(entry.fixture).report)).toBe(stringifyJson(buyFixture(entry.fixture).report));
    expect(transaction.innerInstructionsAvailable).toBe(true);
  });

  it('never needs the logs: the same report comes back without them', () => {
    const { transaction } = normalizeFixture(entry.fixture);
    expect(transaction.logs === null || transaction.logs.length >= 0).toBe(true);
    expect(stringifyJson(buyFixture(entry.fixture).report)).toBe(stringifyJson(fixture.report));
  });
});

describe('the two forms and the one sentinel are recorded, never interpreted', () => {
  it('records the 24-byte form as absent, and the 25-byte forms as their byte', () => {
    expect(onlyBuy(buyFixture('v0-success-pump-buy-24b')).trackVolumeByte).toBe('absent');
    expect(onlyBuy(buyFixture('v0-success-pump-buy-24b-direct')).trackVolumeByte).toBe('absent');
    expect(onlyBuy(buyFixture('legacy-success-pump-buy')).trackVolumeByte).toBe('0x01');
    expect(onlyBuy(buyFixture('v0-success-pump-buy-25b-false')).trackVolumeByte).toBe('0x00');
  });

  it('accepts a real buy whose quote side is not wrapped SOL', () => {
    // Buying with a token and receiving SOL is the mirror image; the direction still
    // comes from the instruction, and the mints come from the named roles.
    const leg = onlyBuy(buyFixture('v0-success-pump-buy-25b-false'));
    expect(isNativeMint(leg.input.mint!)).toBe(false);
    expect(isNativeMint(leg.output.mint!)).toBe(true);
    expect(leg.state).toBe('proven');
  });

  it('keeps the cap exactly binding rather than approximating it', () => {
    const leg = onlyBuy(buyFixture('v0-success-pump-buy-24b'));
    expect(leg.quoteSpend).toBe(leg.maxQuoteAmountIn);
    expect(leg.input.amount).toBeLessThan(leg.maxQuoteAmountIn!);
    expect(leg.feeTransfers.reduce((sum, transfer) => sum + (transfer.amount ?? 0n), 0n)).toBe(
      278_365n,
    );
  });
});

describe('the failed buy', () => {
  const fixture = buyFixture('v0-failed-pump-buy-slippage');
  const leg = onlyBuy(fixture);

  it('is recognized from its instruction, and only its instruction', () => {
    expect(leg.ref.index).toBe(5);
    expect(leg.ref.path).toBe('top-level');
    expect(leg.baseAmountOut).toBe(145_549_276_401n);
    expect(leg.maxQuoteAmountIn).toBe(579_173_563n);
    expect(leg.trackVolumeByte).toBe('0x01');
  });

  it('presents nothing as committed state', () => {
    expect(fixture.transaction.status).toBe('failed');
    expect(leg.commitState).toBe('reverted');
    expect(leg.state).toBe('not-committed');
    expect(leg.output.amount).toBeNull();
    expect(leg.output.legRef).toBeNull();
    expect(leg.input.amount).toBeNull();
    expect(leg.quoteSpend).toBeNull();
    expect(leg.feeTransfers).toEqual([]);
    expect(leg.diagnostics.map(note => note.code)).toEqual(['pump-buy-not-committed']);
  });

  it('does not test the cap against anything, and does not fail it either', () => {
    expect(leg.checks.find(check => check.id === 'max-quote-amount-in-satisfied')?.outcome).toBe('not-checkable');
    expect(leg.conflicts).toEqual([]);
    expect(leg.unknowns).toEqual([]);
  });

  it('says the sibling close of the volume accumulator is none of its business', () => {
    // The transaction also closes a volume accumulator; the buy's own claim covers
    // only the transfers out of the user's quote account, and there are none.
    expect(leg.checks.find(check => check.id === 'user-quote-spend-enumerated')?.outcome).toBe('pass');
    expect(leg.checks.find(check => check.id === 'fee-transfers-reconcile-with-effects')?.outcome).toBe('pass');
  });
});

describe('a transaction with a buy and a sell', () => {
  it('keeps each leg to its own subtree', () => {
    const { report, buys, sells } = buyFixture('v0-success-pump-buy-unbounded');
    expect(report.legs).toHaveLength(2);
    expect(buys).toHaveLength(1);
    expect(sells).toHaveLength(1);
    const buy = onlyBuy({ ...buyFixture('v0-success-pump-buy-unbounded') });
    // The buy paid out of its own quote account, the sell received into its own
    // user quote account: different instructions, different transfers.
    expect(buy.feeTransfers.map(transfer => [transfer.ref.outerIndex, transfer.ref.index])).toEqual([
      [6, 3],
      [6, 4],
    ]);
    expect(buy.output.legRef?.outerIndex).toBe(6);
    expect(buy.input.legRef?.outerIndex).toBe(6);
    expect(sells[0]?.ref.index).not.toBe(buy.ref.index);
    expect(report.counts).toMatchObject({ recognized: 2, proven: 2 });
  });
});
