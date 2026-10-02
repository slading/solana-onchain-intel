/**
 * Associated Token Account Program decoder.
 *
 * From `associated-token-account/interface/src/instruction.rs`:
 *
 *   Create           = 0
 *   CreateIdempotent = 1
 *   RecoverNested    = 2
 *
 * Both creation instructions are single-byte instructions, one discriminator
 * and no payload. Accounts (identical for both):
 *
 *   0 `[writable, signer]` funding account
 *   1 `[writable]`         the associated token account to be created
 *   2 `[]`                 wallet address the account is associated with
 *   3 `[]`                 token mint
 *   4 `[]`                 System Program
 *   5 `[]`                 SPL Token program
 *
 * The program treats *empty* instruction data as `Create` (see
 * `program/src/processor.rs`: `if input.is_empty() { Create }`). We reproduce
 * that rule because it is the program's own behaviour, not an inference from
 * the transaction.
 *
 * Scope note: decoding this instruction does not claim the account was created.
 * The creation itself is performed by the System Program and SPL Token CPIs
 * that this instruction makes; those arrive as inner instructions and decode
 * into their own actions.
 */
import { asRecord, asString, pick } from '../lib/read-json.ts';
import { readU8, takeAccountRoles, type Bytes } from './bytes.ts';
import type { ActionFields } from './programs.ts';
import {
  ASSOCIATED_TOKEN_INSTRUCTION_NAMES,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  notInScopeNote,
  type ByteDecodeResult,
  type ParsedDecodeResult,
  type ProgramDecoder,
} from './programs.ts';

const PROGRAM_NAME = 'Associated Token Account Program';
const ROLES = ['payer', 'associatedTokenAccount', 'wallet', 'mint', 'systemProgram', 'tokenProgram'] as const;

function fieldsFor(
  idempotent: boolean,
  accounts: readonly string[],
  notes: string[],
): ActionFields {
  const { payer, associatedTokenAccount, wallet, mint, systemProgram, tokenProgram } =
    takeAccountRoles(accounts, ROLES, notes);
  return {
    kind: 'associated-token-account.create',
    idempotent,
    payer,
    associatedTokenAccount,
    wallet,
    mint,
    systemProgram,
    tokenProgram,
  };
}

function decodeBytes(input: {
  readonly bytes: Bytes;
  readonly accounts: readonly string[];
}): ByteDecodeResult {
  const { bytes, accounts } = input;
  const notes: string[] = [];

  // The program itself reads empty data as Create.
  if (bytes.length === 0) {
    return { outcome: 'decoded', fields: fieldsFor(false, accounts, notes), notes };
  }

  const tag = readU8(bytes, 0);
  if (tag === null) {
    return { outcome: 'malformed', note: 'the instruction data could not be read.' };
  }

  if (tag === 0 || tag === 1) {
    if (bytes.length > 1) {
      notes.push(
        `data carries ${bytes.length - 1} trailing byte(s) after the discriminator; ` +
          `the program ignores them, and so do we.`,
      );
    }
    return { outcome: 'decoded', fields: fieldsFor(tag === 1, accounts, notes), notes };
  }

  const name = ASSOCIATED_TOKEN_INSTRUCTION_NAMES[tag] ?? null;
  if (name === null) {
    return {
      outcome: 'unknown-tag',
      note: `Associated Token Account instruction tag ${tag} is not part of the official instruction set.`,
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

  if (parsedType === 'create' || parsedType === 'createIdempotent') {
    return {
      outcome: 'decoded',
      fields: {
        kind: 'associated-token-account.create',
        idempotent: parsedType === 'createIdempotent',
        payer: asString(field('source')),
        associatedTokenAccount: asString(field('account')),
        wallet: asString(field('wallet')),
        mint: asString(field('mint')),
        systemProgram: asString(field('systemProgram')),
        tokenProgram: asString(field('tokenProgram')),
      },
      notes,
    };
  }

  if (parsedType === 'recoverNested') {
    return {
      outcome: 'not-in-scope',
      note: notInScopeNote(PROGRAM_NAME, 'RecoverNested', 'parsed by the RPC'),
    };
  }

  return {
    outcome: 'unknown-type',
    note: `the RPC parsed this as Associated Token Account instruction "${parsedType}", which is not part of the official instruction set.`,
  };
}

export const associatedTokenProgramDecoder: ProgramDecoder = {
  label: 'associated-token-account',
  programId: ASSOCIATED_TOKEN_PROGRAM_ID,
  decodeBytes,
  decodeParsed,
  instructionName: tag => ASSOCIATED_TOKEN_INSTRUCTION_NAMES[tag] ?? null,
};
