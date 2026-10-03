/**
 * Helpers for the Milestone 4.2 pump_amm tests.
 *
 * Same approach as 4.1: real fixtures are the primary vectors, and one thing is
 * changed at a time *in memory* (never on disk) to reach what mainnet samples do
 * not contain. The mutation helpers for instruction lists are shared with the
 * 4.1 suite; what is pump-specific lives here — the argument builder and the
 * parsed-info patch, because a `jsonParsed` token transfer carries its endpoints
 * in `parsedInfo` and has no `accounts` array at all.
 */
import { decodeTransaction } from '../../src/decode/decode.ts';
import { transactionEffects } from '../../src/effects/build.ts';
import type { NormalizedInstruction, NormalizedTransaction } from '../../src/model/transaction.ts';
import { recognizeSwaps } from '../../src/swap/recognize-swaps.ts';
import type { PumpSellLeg, SwapCheck, SwapLeg, SwapReport } from '../../src/swap/model.ts';
import { PUMP_AMM_SELL_DISCRIMINATOR } from '../../src/swap/pump.ts';
import { normalizeFixture } from './fixtures.ts';

export interface PumpFixture {
  readonly transaction: NormalizedTransaction;
  readonly effects: ReturnType<typeof transactionEffects>;
  /** The aggregate report (M4.1 + M4.2), which is what the CLI produces. */
  readonly report: SwapReport;
  readonly pump: readonly PumpSellLeg[];
  /** The 4.1 recognizer alone, for regression comparisons. */
  readonly dlmmOnly: ReturnType<typeof recognizeSwaps>['legs'];
}

export function pumpFixture(name: string): PumpFixture {
  const { transaction } = normalizeFixture(name);
  const effects = transactionEffects(transaction);
  const report = recognizeSwaps(transaction, { effects });
  return {
    transaction,
    effects,
    report,
    pump: report.legs.filter((leg): leg is PumpSellLeg => leg.protocol === 'pump-amm'),
    dlmmOnly: [],
  };
}

/** The pump leg at `[outerIndex.index]` (`outerIndex === null` for top-level). */
export function pumpLegAt(report: SwapReport, outerIndex: number | null, index: number): PumpSellLeg {
  const leg = report.legs.find(
    (entry): entry is PumpSellLeg =>
      entry.protocol === 'pump-amm' &&
      entry.ref.path === (outerIndex === null ? 'top-level' : 'inner') &&
      entry.ref.outerIndex === outerIndex &&
      entry.ref.index === index,
  );
  if (leg === undefined) {
    throw new Error(
      `no pump-amm leg at [${outerIndex ?? 'top'}.${index}]; legs: ` +
        report.legs.map(entry => `${entry.protocol}[${entry.ref.outerIndex ?? 'top'}.${entry.ref.index}]`).join(', '),
    );
  }
  return leg;
}

export function dlmmLegs(report: SwapReport): readonly SwapLeg[] {
  return report.legs.filter(entry => entry.protocol === 'meteora-dlmm');
}

export function checkOf(leg: PumpSellLeg, id: string): SwapCheck {
  const found = leg.checks.find(entry => entry.id === id);
  if (found === undefined) throw new Error(`the leg at [${leg.ref.outerIndex ?? 'top'}.${leg.ref.index}] has no check "${id}"`);
  return found;
}

export function outcomeOf(leg: PumpSellLeg, id: string): SwapCheck['outcome'] {
  return checkOf(leg, id).outcome;
}

/* ------------------------------------------------------------------- bytes -- */

export function u64leBytes(value: bigint): number[] {
  const out: number[] = [];
  let rest = value;
  for (let index = 0; index < 8; index += 1) {
    out.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return out;
}

/** `sell` payload built from the IDL's declared layout: disc | base_amount_in | min_quote_amount_out. */
export function pumpSellPayload(baseAmountIn: bigint, minQuoteAmountOut: bigint): number[] {
  const discriminator = PUMP_AMM_SELL_DISCRIMINATOR.match(/../g) ?? [];
  return [
    ...discriminator.map(byte => Number.parseInt(byte, 16)),
    ...u64leBytes(baseAmountIn),
    ...u64leBytes(minQuoteAmountOut),
  ];
}

/* ------------------------------------------------------ in-memory patching -- */

function redecoded(transaction: NormalizedTransaction): NormalizedTransaction {
  return { ...transaction, decoded: decodeTransaction(transaction) };
}

export function innerInstructionsOf(
  transaction: NormalizedTransaction,
  outerIndex: number,
): readonly NormalizedInstruction[] {
  return transaction.innerInstructionGroups.find(group => group.outerIndex === outerIndex)?.instructions ?? [];
}

export function instructionAt(
  transaction: NormalizedTransaction,
  outerIndex: number | null,
  index: number,
): NormalizedInstruction | undefined {
  if (outerIndex === null) return transaction.instructions.find(entry => entry.index === index);
  return innerInstructionsOf(transaction, outerIndex).find(entry => entry.index === index);
}

/**
 * Patches the RPC-parsed `info` of one instruction — the only place a
 * `jsonParsed` token transfer keeps its endpoints.
 */
export function patchParsedInfo(
  transaction: NormalizedTransaction,
  outerIndex: number | null,
  index: number,
  patch: Record<string, unknown>,
): NormalizedTransaction {
  const apply = (instruction: NormalizedInstruction): NormalizedInstruction =>
    instruction.index === index && instruction.parsedInfo !== null
      ? {
          ...instruction,
          parsedInfo: { ...(instruction.parsedInfo as Record<string, unknown>), ...patch },
        }
      : instruction;
  if (outerIndex === null) {
    return redecoded({ ...transaction, instructions: transaction.instructions.map(apply) });
  }
  return redecoded({
    ...transaction,
    innerInstructionGroups: transaction.innerInstructionGroups.map(group =>
      group.outerIndex !== outerIndex
        ? group
        : { ...group, instructions: group.instructions.map(apply) },
    ),
  });
}

/** Patches an instruction's account list (the unparsed AMM instruction itself). */
export function patchAccounts(
  transaction: NormalizedTransaction,
  outerIndex: number | null,
  index: number,
  mutate: (accounts: string[]) => string[],
): NormalizedTransaction {
  const apply = (instruction: NormalizedInstruction): NormalizedInstruction =>
    instruction.index === index && instruction.accounts !== null
      ? { ...instruction, accounts: mutate([...instruction.accounts]) }
      : instruction;
  if (outerIndex === null) {
    return redecoded({ ...transaction, instructions: transaction.instructions.map(apply) });
  }
  return redecoded({
    ...transaction,
    innerInstructionGroups: transaction.innerInstructionGroups.map(group =>
      group.outerIndex !== outerIndex
        ? group
        : { ...group, instructions: group.instructions.map(apply) },
    ),
  });
}

/** Downgrades every inner instruction of one group to a given CPI depth. */
export function setGroupStackHeight(
  transaction: NormalizedTransaction,
  outerIndex: number,
  stackHeight: number,
): NormalizedTransaction {
  return redecoded({
    ...transaction,
    innerInstructionGroups: transaction.innerInstructionGroups.map(group =>
      group.outerIndex !== outerIndex
        ? group
        : {
            ...group,
            instructions: group.instructions.map(instruction => ({ ...instruction, stackHeight })),
          },
    ),
  });
}
