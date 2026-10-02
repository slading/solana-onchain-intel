/**
 * Builder for effects-layer tests.
 *
 * Scenarios are written the way a transaction arrives: normalized instructions
 * (the same builders the decoder tests use), the balance rows the RPC reported,
 * and then the *real* pipeline runs over them — Milestone 2 decoding first, then
 * the effects layer. Nothing here re-implements decoding or effects, so a test
 * cannot pass against a shape the pipeline would never produce.
 *
 * Balance rows are always written by hand, including the fee, so the arithmetic
 * under test is the arithmetic the test states.
 */

import { decodeTransaction } from '../../src/decode/decode.ts';
import type { DecodedAction, DecodedTransaction } from '../../src/decode/actions.ts';
import { buildTransactionEffects } from '../../src/effects/build.ts';
import type {
  EffectsAccountRow,
  EffectsInput,
  EffectsTokenRow,
  TransactionEffects,
} from '../../src/effects/model.ts';
import type { NormalizedInnerInstructionGroup, NormalizedInstruction } from '../../src/model/transaction.ts';

export interface AccountOptions {
  /** Lamports before the transaction. Defaults to `null` (RPC omitted them). */
  readonly before?: bigint | null;
  readonly after?: bigint | null;
  readonly signer?: boolean | null;
}

/** One row of the transaction's account list with its boundary lamports. */
export function account(index: number, address: string, options: AccountOptions = {}): EffectsAccountRow {
  return {
    index,
    address,
    signer: options.signer ?? false,
    beforeLamports: options.before === undefined ? null : options.before,
    afterLamports: options.after === undefined ? null : options.after,
  };
}

export interface TokenRowOptions {
  readonly before?: bigint | null;
  readonly after?: bigint | null;
  readonly decimals?: number | null;
  readonly programId?: string | null;
  readonly presence?: 'both' | 'only-before' | 'only-after';
}

/** One (token account, mint) row as the RPC reported it. */
export function tokenRow(
  accountIndex: number,
  address: string,
  mint: string,
  owner: string,
  options: TokenRowOptions = {},
): EffectsTokenRow {
  return {
    accountIndex,
    address,
    mint,
    owner,
    programId: options.programId ?? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    decimals: options.decimals === undefined ? 6 : options.decimals,
    beforeAmount: options.before === undefined ? null : options.before,
    afterAmount: options.after === undefined ? null : options.after,
    presence: options.presence ?? 'both',
  };
}

export interface ScenarioParts {
  readonly status?: 'success' | 'failed' | 'unknown';
  /** Defaults to the 5,000-lamport base fee, like the real fixtures. */
  readonly fee?: bigint | null;
  readonly feePayer?: string | null;
  readonly accounts?: readonly EffectsAccountRow[];
  readonly tokenRows?: readonly EffectsTokenRow[];
  readonly tokenBalancesAvailable?: boolean;
  /** Top-level instructions, in execution order; indices are assigned here. */
  readonly instructions?: readonly NormalizedInstruction[];
  /** Inner instructions (CPI) per outer instruction index. */
  readonly inner?: ReadonlyMap<number, readonly NormalizedInstruction[]>;
  /** Instructions appended purely to be reported as undecoded. */
  readonly undecodedFrom?: readonly NormalizedInstruction[];
}

export interface Scenario {
  readonly input: EffectsInput;
  readonly decoded: DecodedTransaction;
  readonly actions: readonly DecodedAction[];
  readonly effects: TransactionEffects;
}

/**
 * Runs one scenario through decoding and the effects layer.
 *
 * `undecodedFrom` is a convenience for the common case: those instructions are
 * appended after the others and are expected to be ones the decoder cannot turn
 * into an action (a custom program, an instruction outside the decoded set),
 * which is exactly what the effects layer receives as its `undecoded` list in a
 * real transaction.
 */
export function scenario(parts: ScenarioParts): Scenario {
  const instructions = withIndexes([...(parts.instructions ?? []), ...(parts.undecodedFrom ?? [])]);
  // The RPC reports inner instructions as groups keyed by the outer instruction
  // that made the CPI; M1 stamps each instruction with that outer index, so the
  // helper does too. `stackHeight` is at least 2 inside a CPI, and a test can raise
  // it further to model a nested invocation.
  const innerGroups: NormalizedInnerInstructionGroup[] = [...(parts.inner ?? new Map())].map(
    ([outerIndex, group]) => ({
      outerIndex,
      instructions: withIndexes(group).map(instruction => ({
        ...instruction,
        outerIndex,
        stackHeight: Math.max(instruction.stackHeight ?? 1, 2),
      })),
      outerIndexOutOfRange: false,
    }),
  );

  const decoded = decodeTransaction({ instructions, innerInstructionGroups: innerGroups });

  const input: EffectsInput = {
    status: parts.status ?? 'success',
    feeLamports: parts.fee === undefined ? 5000n : parts.fee,
    feePayer: parts.feePayer === undefined ? (parts.accounts?.[0]?.address ?? null) : parts.feePayer,
    accounts: parts.accounts ?? [],
    tokenRows: parts.tokenRows ?? [],
    tokenBalancesAvailable: parts.tokenBalancesAvailable ?? true,
    undecoded: decoded.undecoded,
  };

  return { input, decoded, actions: decoded.actions, effects: buildTransactionEffects(input, decoded.actions) };
}

/** Effects only, for tests that do not need the intermediate stages. */
export function effectsOf(parts: ScenarioParts): TransactionEffects {
  return scenario(parts).effects;
}

function withIndexes(instructions: readonly NormalizedInstruction[]): NormalizedInstruction[] {
  return instructions.map((instruction, index) => ({ ...instruction, index }));
}
