/**
 * The decode orchestrator.
 *
 * Consumes `NormalizedInstruction`s (never raw RPC payloads) and produces
 * `DecodedAction`s. Pure and synchronous: the same normalized transaction always
 * produces the same actions, diagnostics included.
 *
 * Two paths, chosen by what evidence the instruction actually carries:
 *
 *   1. `instruction-data` — the instruction has base58 `data`; we read its
 *      discriminator and payload ourselves. Independent of the RPC node's parser.
 *   2. `rpc-parsed` — the instruction has no data but the node parsed it; we map
 *      the node's `parsed.type`/`parsed.info` into our model.
 *
 * `instruction-data` wins if both are somehow present, because reading the bytes
 * is the stronger evidence. Neither path is allowed to consult balances, logs or
 * anything else in the transaction.
 */
import type {
  NormalizedInnerInstructionGroup,
  NormalizedInstruction,
} from '../model/transaction.ts';
import {
  type DecodedProgramLabel,
  type DecodeDiagnostic,
  type DecodedAction,
  type DecodedTransaction,
  type DecodeEvidence,
  type InstructionRef,
  type UndecodedInstruction,
} from './actions.ts';
import { decodeBase58Data } from './bytes.ts';
import { associatedTokenProgramDecoder } from './associated-token-account.ts';
import { splTokenProgramDecoder, token2022ProgramDecoder } from './spl-token.ts';
import { systemProgramDecoder } from './system.ts';
import type { ActionFields, ProgramDecoder } from './programs.ts';

/** Every program this layer can decode. Lookup is by exact program id. */
export const PROGRAM_DECODERS: readonly ProgramDecoder[] = [
  systemProgramDecoder,
  splTokenProgramDecoder,
  token2022ProgramDecoder,
  associatedTokenProgramDecoder,
];

const DECODERS_BY_PROGRAM_ID: ReadonlyMap<string, ProgramDecoder> = new Map(
  PROGRAM_DECODERS.map(decoder => [decoder.programId, decoder]),
);

function toRef(instruction: NormalizedInstruction): InstructionRef {
  return {
    path: instruction.outerIndex === null ? 'top-level' : 'inner',
    index: instruction.index,
    outerIndex: instruction.outerIndex,
    stackHeight: instruction.stackHeight,
  };
}

/**
 * What `decodeTransaction` needs from a normalized transaction: the instructions
 * and their CPI grouping, nothing else.
 *
 * Deliberately narrow. The decoder cannot reach balances, logs, accounts or the
 * raw RPC payload, so it *cannot* infer meaning from them even by accident —
 * which is the Milestone 2 requirement "never infer meaning from balance deltas
 * alone", enforced by the type rather than by discipline.
 */
export interface DecodableTransactionView {
  readonly instructions: readonly NormalizedInstruction[];
  readonly innerInstructionGroups: readonly NormalizedInnerInstructionGroup[];
}

export interface InstructionDecodeOutcome {
  /** The decoded action, or `null` if the instruction could not be decoded. */
  readonly action: DecodedAction | null;
  /** Why no action was produced, when that is the case. */
  readonly undecoded: UndecodedInstruction | null;
  readonly diagnostics: readonly DecodeDiagnostic[];
}

function undecoded(
  instruction: NormalizedInstruction,
  reason: UndecodedInstruction['reason'],
  note: string,
): UndecodedInstruction {
  return {
    ref: toRef(instruction),
    programId: instruction.programId,
    programName: instruction.programName,
    parsedType: instruction.parsedType,
    reason,
    note,
  };
}

/**
 * Decodes a single normalized instruction. Exported so each program's decoder
 * can be exercised on its own, without building a whole transaction.
 */
export function decodeInstruction(instruction: NormalizedInstruction): InstructionDecodeOutcome {
  const diagnostics: DecodeDiagnostic[] = [];
  const push = (level: DecodeDiagnostic['level'], code: string, message: string): void => {
    diagnostics.push({ level, code, message, ref: toRef(instruction) });
  };

  if (instruction.programId === null) {
    return {
      action: null,
      undecoded: undecoded(
        instruction,
        'program-id-missing',
        'the instruction has no program id, so it cannot be attributed to any program.',
      ),
      diagnostics,
    };
  }

  const decoder = DECODERS_BY_PROGRAM_ID.get(instruction.programId);
  if (decoder === undefined) {
    // Deliberately explicit: an unknown program produces no action. The node's
    // own label is repeated as a fact, never converted into meaning.
    const who = instruction.programName === null ? '' : ` (program "${instruction.programName}")`;
    const what =
      instruction.parsedType === null
        ? ''
        : `; the RPC labeled this instruction "${instruction.parsedType}", which we do not treat as meaning`;
    return {
      action: null,
      undecoded: undecoded(
        instruction,
        'program-not-supported',
        `program ${instruction.programId}${who} is not decoded by this layer${what}.`,
      ),
      diagnostics,
    };
  }

  const attach = (fields: ActionFields, evidence: DecodeEvidence): DecodedAction =>
    ({ ...fields, program: decoder.label, programId: decoder.programId, evidence, ref: toRef(instruction) });

  // Path 1: read the instruction's own bytes.
  if (instruction.data !== null) {
    const bytes = decodeBase58Data(instruction.data);
    if (bytes === null) {
      return {
        action: null,
        undecoded: undecoded(
          instruction,
          'malformed-instruction-data',
          'the instruction data is not valid base58, so its content cannot be read.',
        ),
        diagnostics,
      };
    }

    const result = decoder.decodeBytes({ bytes, accounts: instruction.accounts ?? [] });
    if (result.outcome === 'decoded') {
      for (const note of result.notes) {
        push('info', 'decode-partial', note);
      }
      return {
        action: attach(result.fields, 'instruction-data'),
        undecoded: null,
        diagnostics,
      };
    }
    if (result.outcome === 'not-in-scope') {
      return { action: null, undecoded: undecoded(instruction, 'instruction-not-in-scope', result.note), diagnostics };
    }
    if (result.outcome === 'unknown-tag') {
      return { action: null, undecoded: undecoded(instruction, 'unknown-instruction-tag', result.note), diagnostics };
    }
    return { action: null, undecoded: undecoded(instruction, 'malformed-instruction-data', result.note), diagnostics };
  }

  // Path 2: map the node's parse.
  if (instruction.parsedType !== null) {
    const result = decoder.decodeParsed({
      parsedType: instruction.parsedType,
      parsedInfo: instruction.parsedInfo,
    });
    if (result.outcome === 'decoded') {
      for (const note of result.notes) {
        push('info', 'decode-partial', note);
      }
      return { action: attach(result.fields, 'rpc-parsed'), undecoded: null, diagnostics };
    }
    if (result.outcome === 'not-in-scope') {
      return { action: null, undecoded: undecoded(instruction, 'instruction-not-in-scope', result.note), diagnostics };
    }
    return {
      action: null,
      undecoded: undecoded(instruction, 'unknown-instruction-tag', result.note),
      diagnostics,
    };
  }

  return {
    action: null,
    undecoded: undecoded(
      instruction,
      'no-decoding-evidence',
      'the instruction carries neither raw data nor an RPC parse, so it cannot be decoded.',
    ),
    diagnostics,
  };
}

/**
 * Decodes every instruction of a transaction into actions and undecoded entries.
 *
 * Order is execution order: each top-level instruction is followed by the inner
 * instructions (CPIs) it made, which is the order the programs actually ran in.
 * The full set of instructions is not re-derived from balances or logs.
 */
export function decodeTransaction(transaction: DecodableTransactionView): DecodedTransaction {
  const actions: DecodedAction[] = [];
  const undecodedInstructions: UndecodedInstruction[] = [];
  const diagnostics: DecodeDiagnostic[] = [];

  const consider = (instruction: NormalizedInstruction): void => {
    const outcome = decodeInstruction(instruction);
    diagnostics.push(...outcome.diagnostics);
    if (outcome.action !== null) actions.push(outcome.action);
    if (outcome.undecoded !== null) undecodedInstructions.push(outcome.undecoded);
  };

  const innerByOuter = new Map(
    transaction.innerInstructionGroups.map(group => [group.outerIndex, group.instructions]),
  );

  let count = 0;
  transaction.instructions.forEach(instruction => {
    consider(instruction);
    count += 1;
    for (const inner of innerByOuter.get(instruction.index) ?? []) {
      consider(inner);
      count += 1;
    }
  });

  // Inner groups whose outer index did not resolve (reported by the RPC but not
  // matching a top-level instruction) are still decoded rather than dropped.
  transaction.innerInstructionGroups
    .filter(group => group.outerIndex < 0 || group.outerIndex >= transaction.instructions.length)
    .forEach(group => {
      for (const inner of group.instructions) {
        consider(inner);
        count += 1;
      }
    });

  return { actions, undecoded: undecodedInstructions, instructionCount: count, diagnostics };
}

/** Convenience for grouping/reporting: action kinds present, in occurrence order. */
export function actionKinds(decoded: DecodedTransaction): readonly DecodedAction['kind'][] {
  const seen: DecodedAction['kind'][] = [];
  for (const action of decoded.actions) {
    if (!seen.includes(action.kind)) seen.push(action.kind);
  }
  return seen;
}

export type { ActionFields, DecodedProgramLabel, DecodedAction, DecodedTransaction, DecodeDiagnostic };
