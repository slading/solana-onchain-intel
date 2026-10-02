/**
 * System Program decoder.
 *
 * Layout (bincode, from `system-interface/src/instruction.rs`):
 *
 *   CreateAccount (tag 0): u32 tag LE | u64 lamports LE | u64 space LE | owner[32]
 *     accounts: 0 funding [write, signer], 1 new account [write, signer]
 *   Transfer      (tag 2): u32 tag LE | u64 lamports LE
 *     accounts: 0 funding [write, signer], 1 recipient [write]
 *
 * The tag is a 4-byte little-endian integer (`Instruction::new_with_bincode`),
 * so fewer than 4 bytes of data cannot prove anything at all.
 */
import type { ActionFields } from './programs.ts';
import {
  SYSTEM_INSTRUCTION_NAMES,
  SYSTEM_PROGRAM_ID,
  notInScopeNote,
  type ByteDecodeResult,
  type ParsedDecodeResult,
  type ProgramDecoder,
} from './programs.ts';
import { asBigIntLike, asRecord, asString, pick } from '../lib/read-json.ts';
import { encodeAddress, readU32LE, readU64LE, takeAccountRoles, type Bytes } from './bytes.ts';

const PROGRAM_NAME = 'System Program';

function decodeBytes(input: {
  readonly bytes: Bytes;
  readonly accounts: readonly string[];
}): ByteDecodeResult {
  const { bytes, accounts } = input;
  const tag = readU32LE(bytes, 0);
  if (tag === null) {
    return {
      outcome: 'malformed',
      note:
        `instruction data is ${bytes.length} byte(s), but the System Program encodes its ` +
        `instruction tag as a 4-byte little-endian integer; the instruction cannot be identified.`,
    };
  }

  const name = SYSTEM_INSTRUCTION_NAMES[tag] ?? null;

  if (tag === 2) {
    const notes: string[] = [];
    const { from, to } = takeAccountRoles(accounts, ['from', 'to'] as const, notes);
    const lamports = readU64LE(bytes, 4);
    if (lamports === null) {
      notes.push(`expected 8 bytes of lamports after the tag, found ${Math.max(bytes.length - 4, 0)}.`);
    }
    const fields: ActionFields = { kind: 'system.transfer', from, to, lamports };
    return { outcome: 'decoded', fields, notes };
  }

  if (tag === 0) {
    const notes: string[] = [];
    const { from, newAccount } = takeAccountRoles(accounts, ['from', 'newAccount'] as const, notes);
    const lamports = readU64LE(bytes, 4);
    const space = readU64LE(bytes, 12);
    const owner = encodeAddress(bytes, 20);
    if (lamports === null) notes.push('lamports could not be read (data ends before byte 12).');
    if (space === null) notes.push('space could not be read (data ends before byte 20).');
    if (owner === null) notes.push('owner could not be read (data ends before byte 52).');
    const fields: ActionFields = { kind: 'system.createAccount', from, newAccount, lamports, space, owner };
    return { outcome: 'decoded', fields, notes };
  }

  if (name === null) {
    return {
      outcome: 'unknown-tag',
      note: `System Program instruction tag ${tag} is not part of the official instruction set.`,
    };
  }
  return {
    outcome: 'not-in-scope',
    note: notInScopeNote(PROGRAM_NAME, name, `tag ${tag}`),
  };
}

function decodeParsed(input: {
  readonly parsedType: string;
  readonly parsedInfo: unknown;
}): ParsedDecodeResult {
  const { parsedType, parsedInfo } = input;
  const info = asRecord(parsedInfo);
  const notes: string[] = [];
  if (info === null) {
    notes.push('the RPC reported a parsed instruction without an info object; its fields are null.');
  }
  const field = (key: string): unknown => (info === null ? undefined : pick(info, key));

  if (parsedType === 'transfer') {
    const fields: ActionFields = {
      kind: 'system.transfer',
      from: asString(field('source')),
      to: asString(field('destination')),
      lamports: asBigIntLike(field('lamports')),
    };
    return { outcome: 'decoded', fields, notes };
  }

  if (parsedType === 'createAccount') {
    const fields: ActionFields = {
      kind: 'system.createAccount',
      from: asString(field('source')),
      newAccount: asString(field('newAccount')),
      lamports: asBigIntLike(field('lamports')),
      space: asBigIntLike(field('space')),
      owner: asString(field('owner')),
    };
    return { outcome: 'decoded', fields, notes };
  }

  if (SYSTEM_PARSED_TYPE_NAMES.has(parsedType)) {
    return {
      outcome: 'not-in-scope',
      note: notInScopeNote(PROGRAM_NAME, parsedType, 'parsed by the RPC'),
    };
  }

  return {
    outcome: 'unknown-type',
    note: `the RPC parsed this as System Program instruction "${parsedType}", which is not part of the official instruction set.`,
  };
}

/**
 * Types the RPC's system parser can report (camelCase of the Rust variants).
 * Used only to distinguish "recognized, out of scope" from "not a system
 * instruction at all".
 */
const SYSTEM_PARSED_TYPE_NAMES = new Set([
  'assign',
  'createAccountWithSeed',
  'advanceNonce',
  'withdrawNonce',
  'initializeNonce',
  'authorizeNonce',
  'allocate',
  'allocateWithSeed',
  'assignWithSeed',
  'transferWithSeed',
  'upgradeNonce',
  'createAccountAllowPrefund',
]);

export const systemProgramDecoder: ProgramDecoder = {
  label: 'system',
  programId: SYSTEM_PROGRAM_ID,
  decodeBytes,
  decodeParsed,
  instructionName: discriminator => SYSTEM_INSTRUCTION_NAMES[discriminator] ?? null,
};
