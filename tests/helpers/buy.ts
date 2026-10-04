/**
 * Helpers for the Milestone 4.3 pump_amm `buy` tests.
 *
 * Same approach as 4.1/4.2: the real mainnet fixtures are the primary vectors, and
 * everything mainnet samples do not contain is reached by patching the normalized
 * model *in memory* — an argument, an account slot, an inner instruction, the
 * status. The patch helpers themselves are shared with the earlier suites; what is
 * buy-specific lives here: the accessor that keeps the two pump directions apart,
 * the payload builder with its optional trailing `OptionBool` byte, and the
 * payment-plus-fees enumeration a recognizer test needs to talk about.
 */
import { transactionEffects } from '../../src/effects/build.ts';
import type { NormalizedTransaction } from '../../src/model/transaction.ts';
import { recognizeSwaps } from '../../src/swap/recognize-swaps.ts';
import type { PumpBuyLeg, PumpSellLeg, SwapCheck, SwapReport } from '../../src/swap/model.ts';
import { PUMP_AMM_BUY_DISCRIMINATOR } from '../../src/swap/pump.ts';
import { normalizeFixture } from './fixtures.ts';
import { base58, u64leBytes } from './swaps.ts';

export interface BuyFixture {
  readonly transaction: NormalizedTransaction;
  readonly effects: ReturnType<typeof transactionEffects>;
  /** The aggregate report (M4.1 + M4.2 + M4.3), which is what the CLI produces. */
  readonly report: SwapReport;
  readonly buys: readonly PumpBuyLeg[];
  /** The 4.2 legs, so a buy vector can prove it did not disturb them. */
  readonly sells: readonly PumpSellLeg[];
}

export function buyFixture(name: string): BuyFixture {
  const { transaction } = normalizeFixture(name);
  const effects = transactionEffects(transaction);
  const report = recognizeSwaps(transaction, { effects });
  return {
    transaction,
    effects,
    report,
    buys: report.legs.filter((leg): leg is PumpBuyLeg => leg.protocol === 'pump-amm' && leg.instructionName === 'buy'),
    sells: report.legs.filter(leg => leg.protocol === 'pump-amm' && leg.instructionName === 'sell'),
  };
}

/** The one buy leg of a fixture — the fixtures carry at most one. */
export function onlyBuy(fixture: BuyFixture): PumpBuyLeg {
  if (fixture.buys.length !== 1) {
    throw new Error(`expected exactly one pump_amm buy, found ${fixture.buys.length}`);
  }
  return fixture.buys[0] as PumpBuyLeg;
}

/** The pump buy leg at `[outerIndex.index]` (`outerIndex === null` for top-level). */
export function buyLegAt(report: SwapReport, outerIndex: number | null, index: number): PumpBuyLeg {
  const leg = report.legs.find(
    (entry): entry is PumpBuyLeg =>
      entry.protocol === 'pump-amm' &&
      entry.instructionName === 'buy' &&
      entry.ref.path === (outerIndex === null ? 'top-level' : 'inner') &&
      entry.ref.outerIndex === outerIndex &&
      entry.ref.index === index,
  );
  if (leg === undefined) {
    throw new Error(
      `no pump_amm buy at [${outerIndex ?? 'top'}.${index}]; legs: ` +
        report.legs
          .map(entry => `${entry.instructionName}[${entry.ref.outerIndex ?? 'top'}.${entry.ref.index}]`)
          .join(', '),
    );
  }
  return leg;
}

export function checkOf(leg: PumpBuyLeg, id: string): SwapCheck {
  const found = leg.checks.find(entry => entry.id === id);
  if (found === undefined) {
    throw new Error(`the leg at [${leg.ref.outerIndex ?? 'top'}.${leg.ref.index}] has no check "${id}"`);
  }
  return found;
}

export function outcomeOf(leg: PumpBuyLeg, id: string): SwapCheck['outcome'] {
  return checkOf(leg, id).outcome;
}

/* ------------------------------------------------------------------- bytes -- */

/**
 * A `buy` payload: the IDL's discriminator, the two `u64` arguments, and — when
 * `trailing` is given — the `OptionBool` byte. Passing no `trailing` builds the
 * 24-byte form; passing `null` builds a 25-byte payload with no meaningful byte at
 * all, which only a mutation test wants.
 */
export function pumpBuyPayload(baseAmountOut: bigint, maxQuoteAmountIn: bigint, trailing?: number | null): string {
  const discriminator = PUMP_AMM_BUY_DISCRIMINATOR.match(/../g) ?? [];
  const bytes = [
    ...discriminator.map(byte => Number.parseInt(byte, 16)),
    ...u64leBytes(baseAmountOut),
    ...u64leBytes(maxQuoteAmountIn),
    ...(trailing === undefined ? [] : [trailing ?? 0xff]),
  ];
  return base58(bytes);
}

/* ------------------------------------------------------------------ amounts -- */

/** The user's quote spend decomposed exactly as the leg reports it. */
export function spendOf(leg: PumpBuyLeg): {
  readonly vault: bigint | null;
  readonly fees: bigint | null;
  readonly total: bigint | null;
} {
  const vault = leg.input.amount;
  const fees = leg.feeTransfers.length === 0 ? 0n : leg.feeTransfers.reduce<bigint | null>(
    (sum, transfer) => (sum === null || transfer.amount === null ? null : sum + transfer.amount),
    0n,
  );
  return {
    vault,
    fees,
    total: vault === null || fees === null ? null : vault + fees,
  };
}
