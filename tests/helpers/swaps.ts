/**
 * Helpers for the Milestone 4.1 swap tests.
 *
 * Same approach as the other test helpers: the real fixtures are the primary
 * vectors, and the transactions are patched in *memory* (never on disk) to reach
 * the cases mainnet samples do not contain — a missing leg, a tampered argument, a
 * failed status, a stripped log list. Patching the normalized model rather than
 * the raw payload keeps the tests honest: they exercise the same objects the
 * production path builds.
 */
import { getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { decodeTransaction } from '../../src/decode/decode.ts';
import type {
  NormalizedInstruction,
  NormalizedInnerInstructionGroup,
  NormalizedTransaction,
} from '../../src/model/transaction.ts';
import { transactionEffects } from '../../src/effects/build.ts';
import { recognizeDlmmSwaps } from '../../src/swap/recognize.ts';
import {
  DLMM_SWAP2_DISCRIMINATOR,
  DLMM_SWAP2_ACCOUNT_ROLES,
} from '../../src/swap/dlmm.ts';
import type { DlmmSwapCheck, DlmmSwapLeg, TransactionSwaps } from '../../src/swap/model.ts';
import { normalizeFixture } from './fixtures.ts';

export interface SwapFixture {
  readonly transaction: NormalizedTransaction;
  readonly effects: ReturnType<typeof transactionEffects>;
  readonly swaps: TransactionSwaps;
}

/** One real fixture, normalized, with the effects and swap layers applied to it. */
export function swapFixture(name: string): SwapFixture {
  const { transaction } = normalizeFixture(name);
  const effects = transactionEffects(transaction);
  return { transaction, effects, swaps: recognizeDlmmSwaps(transaction, { effects }) };
}

/** The recognized leg whose instruction sits at `[outerIndex.index]`. */
export function legAt(swaps: TransactionSwaps, outerIndex: number, index: number): DlmmSwapLeg {
  const leg = swaps.legs.find(
    entry => entry.ref.path === 'inner' && entry.ref.outerIndex === outerIndex && entry.ref.index === index,
  );
  if (leg === undefined) {
    throw new Error(
      `no recognized leg at [${outerIndex}.${index}]; recognized: ` +
        swaps.legs.map(entry => `[${entry.ref.outerIndex}.${entry.ref.index}]`).join(', '),
    );
  }
  return leg;
}

export function checkOf(leg: DlmmSwapLeg, id: string): DlmmSwapCheck {
  const found = leg.checks.find(entry => entry.id === id);
  if (found === undefined) throw new Error(`leg at [${leg.ref.outerIndex}.${leg.ref.index}] has no check "${id}"`);
  return found;
}

export function outcomeOf(leg: DlmmSwapLeg, id: string): DlmmSwapCheck['outcome'] {
  return checkOf(leg, id).outcome;
}

/* ------------------------------------------------------------------- bytes -- */

export function bytesOfData(data: string): Uint8Array {
  return Uint8Array.from([...getBase58Encoder().encode(data)]);
}

export function base58(bytes: readonly number[]): string {
  return getBase58Decoder().decode(Uint8Array.from(bytes));
}

export function u64leBytes(value: bigint): number[] {
  const out: number[] = [];
  let rest = value;
  for (let index = 0; index < 8; index += 1) {
    out.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return out;
}

/** `swap2` payload built from the IDL's declared layout: disc | amount_in | min_amount_out | slices. */
export function swap2Payload(
  amountIn: bigint,
  minAmountOut: bigint,
  slices: readonly (readonly [number, number])[] = [],
): number[] {
  const discriminator = DLMM_SWAP2_DISCRIMINATOR.match(/../g) ?? [];
  const sliceCount = [slices.length & 0xff, (slices.length >> 8) & 0xff, (slices.length >> 16) & 0xff, (slices.length >> 24) & 0xff];
  return [
    ...discriminator.map(byte => Number.parseInt(byte, 16)),
    ...u64leBytes(amountIn),
    ...u64leBytes(minAmountOut),
    ...sliceCount,
    ...slices.flatMap(([type, length]) => [type, length]),
  ];
}

/* ------------------------------------------------------ in-memory patching -- */

/**
 * Re-runs the Milestone 2 decoder over patched instructions.
 *
 * The normalized model carries its decoded actions as data, so a patched
 * instruction would otherwise be visible to the swap layer's *byte* reader but
 * invisible to its action reader. Normalization decodes once; a mutation has to
 * do the same or the vector tests something that cannot happen in production.
 */
function redecoded(transaction: NormalizedTransaction): NormalizedTransaction {
  return { ...transaction, decoded: decodeTransaction(transaction) };
}

function groupsOf(transaction: NormalizedTransaction): NormalizedInnerInstructionGroup[] {
  return transaction.innerInstructionGroups.map(group => ({
    ...group,
    instructions: [...group.instructions],
  }));
}

export function innerInstructionsOf(
  transaction: NormalizedTransaction,
  outerIndex: number,
): readonly NormalizedInstruction[] {
  return transaction.innerInstructionGroups.find(group => group.outerIndex === outerIndex)?.instructions ?? [];
}

/** Replaces one instruction (top-level when `outerIndex` is `null`). */
export function patchInstruction(
  transaction: NormalizedTransaction,
  outerIndex: number | null,
  index: number,
  patch: Partial<NormalizedInstruction>,
): NormalizedTransaction {
  if (outerIndex === null) {
    return redecoded({
      ...transaction,
      instructions: transaction.instructions.map(instruction =>
        instruction.index === index ? { ...instruction, ...patch } : instruction,
      ),
    });
  }
  return redecoded({
    ...transaction,
    innerInstructionGroups: groupsOf(transaction).map(group =>
      group.outerIndex !== outerIndex
        ? group
        : {
            ...group,
            instructions: group.instructions.map(instruction =>
              instruction.index === index ? { ...instruction, ...patch } : instruction,
            ),
          },
    ),
  });
}

/** Drops one instruction from its list. */
export function dropInstruction(
  transaction: NormalizedTransaction,
  outerIndex: number | null,
  index: number,
): NormalizedTransaction {
  if (outerIndex === null) {
    return redecoded({
      ...transaction,
      instructions: transaction.instructions.filter(entry => entry.index !== index),
    });
  }
  return redecoded({
    ...transaction,
    innerInstructionGroups: groupsOf(transaction).map(group =>
      group.outerIndex !== outerIndex
        ? group
        : { ...group, instructions: group.instructions.filter(entry => entry.index !== index) },
    ),
  });
}

/** Inserts an instruction into an inner group directly after `afterIndex`. */
export function insertInnerInstruction(
  transaction: NormalizedTransaction,
  outerIndex: number,
  afterIndex: number,
  instruction: NormalizedInstruction,
): NormalizedTransaction {
  return redecoded({
    ...transaction,
    innerInstructionGroups: groupsOf(transaction).map(group => {
      if (group.outerIndex !== outerIndex) return group;
      const position = group.instructions.findIndex(entry => entry.index === afterIndex);
      const instructions = [...group.instructions];
      instructions.splice(position + 1, 0, instruction);
      return { ...group, instructions };
    }),
  });
}

export function withStatus(
  transaction: NormalizedTransaction,
  status: NormalizedTransaction['status'],
  error: unknown = null,
): NormalizedTransaction {
  return { ...transaction, status, error };
}

export function withoutLogs(transaction: NormalizedTransaction): NormalizedTransaction {
  return { ...transaction, logs: null };
}

export function withLogs(
  transaction: NormalizedTransaction,
  logs: readonly string[],
): NormalizedTransaction {
  return { ...transaction, logs };
}

export function withoutInnerInstructions(transaction: NormalizedTransaction): NormalizedTransaction {
  return redecoded({ ...transaction, innerInstructionGroups: [], innerInstructionsAvailable: false });
}

/** The DLMM account roles of one of the fixture's real `swap2` instructions. */
export function rolesOf(instruction: NormalizedInstruction): readonly string[] {
  const accounts = instruction.accounts ?? [];
  return DLMM_SWAP2_ACCOUNT_ROLES.map((_role, index) => accounts[index] ?? '(missing)');
}
