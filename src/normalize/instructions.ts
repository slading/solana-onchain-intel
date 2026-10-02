import { asArray, asNumber, asRecord, asString, pick } from '../lib/read-json.ts';
import type { NormalizedInstruction } from '../model/transaction.ts';
import type { DiagnosticCollector } from './diagnostics.ts';

/**
 * Normalizes one instruction from `jsonParsed` output.
 *
 * The RPC returns exactly one of two shapes:
 *
 *  - **parsed**:  `{ parsed: { info, type }, program, programId, stackHeight? }`
 *  - **partially decoded**: `{ accounts: [addr...], data: <base58>, programId, stackHeight? }`
 *
 * The second shape is the important one: the RPC could not decode the
 * instruction, so *we* do not either. We keep the program id and the raw
 * base58 data and mark the instruction as undecoded.
 */
export function normalizeInstruction(
  raw: unknown,
  position: { readonly index: number; readonly outerIndex: number | null },
  diagnostics: DiagnosticCollector,
  context: string,
): NormalizedInstruction {
  const record = asRecord(raw);
  if (record === null) {
    diagnostics.warn(
      'instruction-not-an-object',
      `${context}[${position.index}] was not a JSON object; preserved in raw only.`,
    );
    return {
      index: position.index,
      outerIndex: position.outerIndex,
      programId: null,
      programName: null,
      parsedType: null,
      parsedInfo: null,
      accounts: null,
      data: null,
      dataEncoding: 'base58',
      stackHeight: null,
      decoding: 'unrecognized-shape',
    };
  }

  const programId = asString(pick(record, 'programId'));
  if (programId === null) {
    diagnostics.warn(
      'instruction-without-program-id',
      `${context}[${position.index}] has no programId; it cannot be attributed to a program.`,
    );
  }

  const stackHeight = asNumber(pick(record, 'stackHeight'));

  const parsed = asRecord(pick(record, 'parsed'));
  if (parsed !== null) {
    const parsedType = asString(pick(parsed, 'type'));
    const parsedInfo = pick(parsed, 'info') ?? null;
    if (parsedType === null) {
      diagnostics.info(
        'parsed-instruction-without-type',
        `${context}[${position.index}] has a parsed block with no "type"; kept verbatim.`,
      );
    }
    return {
      index: position.index,
      outerIndex: position.outerIndex,
      programId,
      // The RPC's own label for the program, e.g. "system" or "spl-token".
      programName: asString(pick(record, 'program')),
      parsedType,
      parsedInfo,
      // Parsed instructions carry neither an account list nor raw data.
      accounts: null,
      data: null,
      dataEncoding: 'base58',
      stackHeight,
      decoding: 'rpc-parsed',
    };
  }

  const rawAccounts = asArray(pick(record, 'accounts'));
  const data = asString(pick(record, 'data'));
  if (rawAccounts === null && data === null) {
    diagnostics.warn(
      'instruction-shape-unrecognized',
      `${context}[${position.index}] has neither a parsed block nor accounts/data. ` +
        `It is preserved in raw but is not interpreted.`,
    );
    return {
      index: position.index,
      outerIndex: position.outerIndex,
      programId,
      programName: null,
      parsedType: null,
      parsedInfo: null,
      accounts: null,
      data: null,
      dataEncoding: 'base58',
      stackHeight,
      decoding: 'unrecognized-shape',
    };
  }

  const accounts: string[] = [];
  for (const account of rawAccounts ?? []) {
    const address = asString(account);
    if (address === null) {
      diagnostics.warn(
        'instruction-account-not-a-string',
        `${context}[${position.index}] contains an account entry that is not an address string.`,
      );
      continue;
    }
    accounts.push(address);
  }

  return {
    index: position.index,
    outerIndex: position.outerIndex,
    programId,
    programName: null,
    parsedType: null,
    parsedInfo: null,
    accounts,
    data,
    dataEncoding: 'base58',
    stackHeight,
    decoding: 'rpc-partially-decoded',
  };
}

/** Normalizes `message.instructions` in order. */
export function normalizeTopLevelInstructions(
  rawInstructions: readonly unknown[],
  diagnostics: DiagnosticCollector,
): readonly NormalizedInstruction[] {
  return rawInstructions.map((raw, index) =>
    normalizeInstruction(raw, { index, outerIndex: null }, diagnostics, 'message.instructions'),
  );
}

/**
 * Normalizes `meta.innerInstructions`, preserving the RPC's grouping: each group
 * belongs to one top-level instruction.
 *
 * `index` in the response is the index of the outer instruction in
 * `message.instructions` — confirmed against Agave's `map_inner_instructions`
 * (solana-transaction-status), which enumerates the instruction list before
 * filtering out empty groups. Groups can therefore be non-contiguous, and we
 * keep a defensive out-of-range check instead of trusting the value.
 */
export function normalizeInnerInstructions(
  rawGroups: readonly unknown[],
  topLevelCount: number,
  diagnostics: DiagnosticCollector,
) {
  const groups = rawGroups.map((rawGroup) => {
    const group = asRecord(rawGroup);
    const outerIndex = group === null ? null : asNumber(pick(group, 'index'));
    const instructions = group === null ? null : asArray(pick(group, 'instructions'));

    if (outerIndex === null || instructions === null) {
      diagnostics.warn(
        'inner-instruction-group-malformed',
        'An innerInstructions entry is missing "index" or "instructions"; preserved in raw only.',
      );
      return {
        outerIndex: -1,
        instructions: [] as readonly NormalizedInstruction[],
        outerIndexOutOfRange: true,
      };
    }

    const outerIndexOutOfRange = outerIndex < 0 || outerIndex >= topLevelCount;
    if (outerIndexOutOfRange) {
      diagnostics.warn(
        'inner-instruction-outer-index-out-of-range',
        `innerInstructions group references outer instruction ${outerIndex}, but the transaction ` +
          `has ${topLevelCount} top-level instruction(s).`,
      );
    }

    return {
      outerIndex,
      outerIndexOutOfRange,
      instructions: instructions.map((rawInner, index) =>
        normalizeInstruction(
          rawInner,
          { index, outerIndex },
          diagnostics,
          `innerInstructions[outer=${outerIndex}].instructions`,
        ),
      ),
    };
  });

  // Stable ordering by outer index; ties keep the RPC's original order.
  return groups
    .map((group, originalPosition) => ({ group, originalPosition }))
    .sort((a, b) =>
      a.group.outerIndex === b.group.outerIndex
        ? a.originalPosition - b.originalPosition
        : a.group.outerIndex - b.group.outerIndex,
    )
    .map(({ group }) => group);
}
