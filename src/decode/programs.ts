/**
 * Program ids and instruction name tables.
 *
 * All of this is transcribed from official program sources — nothing here is
 * inferred from observed transactions:
 *
 * - System Program: `solana-program`/`system-interface` `instruction.rs`
 *   (`SystemInstruction` enum order = bincode u32 little-endian tags) and
 *   `system_instruction.rs` (`Instruction::new_with_bincode`).
 * - SPL Token: `solana-program/token` `interface/src/instruction.rs` (`pack()`).
 * - Token-2022: `solana-program/token-2022` `interface/src/instruction.rs`.
 * - Associated Token Account: `solana-program/associated-token-account`
 *   `interface/src/instruction.rs` and `program/src/processor.rs`.
 *
 * The name tables are used ONLY to explain what was not decoded. They are never
 * used to decide meaning: decoding always reads the discriminator and payload.
 */
import type { ReadonlyUint8Array } from '@solana/kit';
import type { ActionPayload, DecodedProgramLabel } from './actions.ts';

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** `SystemInstruction`, in declaration order (bincode writes the index as u32 LE). */
export const SYSTEM_INSTRUCTION_NAMES: Readonly<Record<number, string>> = {
  0: 'CreateAccount',
  1: 'Assign',
  2: 'Transfer',
  3: 'CreateAccountWithSeed',
  4: 'AdvanceNonceAccount',
  5: 'WithdrawNonceAccount',
  6: 'InitializeNonceAccount',
  7: 'AuthorizeNonceAccount',
  8: 'Allocate',
  9: 'AllocateWithSeed',
  10: 'AssignWithSeed',
  11: 'TransferWithSeed',
  12: 'UpgradeNonceAccount',
  13: 'CreateAccountAllowPrefund',
};

/** `TokenInstruction` tags shared by SPL Token and Token-2022. */
export const TOKEN_CORE_INSTRUCTION_NAMES: Readonly<Record<number, string>> = {
  0: 'InitializeMint',
  1: 'InitializeAccount',
  2: 'InitializeMultisig',
  3: 'Transfer',
  4: 'Approve',
  5: 'Revoke',
  6: 'SetAuthority',
  7: 'MintTo',
  8: 'Burn',
  9: 'CloseAccount',
  10: 'FreezeAccount',
  11: 'ThawAccount',
  12: 'TransferChecked',
  13: 'ApproveChecked',
  14: 'MintToChecked',
  15: 'BurnChecked',
  16: 'InitializeAccount2',
  17: 'SyncNative',
  18: 'InitializeAccount3',
  19: 'InitializeMultisig2',
  20: 'InitializeMint2',
  21: 'GetAccountDataSize',
  22: 'InitializeImmutableOwner',
  23: 'AmountToUiAmount',
  24: 'UiAmountToAmount',
  38: 'WithdrawExcessLamports',
  45: 'UnwrapLamports',
  255: 'Batch',
};

/** Tags defined only by Token-2022 (extensions). */
export const TOKEN_2022_EXTENSION_INSTRUCTION_NAMES: Readonly<Record<number, string>> = {
  25: 'InitializeMintCloseAuthority',
  26: 'TransferFeeExtension',
  27: 'ConfidentialTransferExtension',
  28: 'DefaultAccountStateExtension',
  29: 'Reallocate',
  30: 'MemoTransferExtension',
  31: 'CreateNativeMint',
  32: 'InitializeNonTransferableMint',
  33: 'InterestBearingMintExtension',
  34: 'CpiGuardExtension',
  35: 'InitializePermanentDelegate',
  36: 'TransferHookExtension',
  37: 'ConfidentialTransferFeeExtension',
  39: 'MetadataPointerExtension',
  40: 'GroupPointerExtension',
  41: 'GroupMemberPointerExtension',
  42: 'ConfidentialMintBurnExtension',
  43: 'ScaledUiAmountExtension',
  44: 'PausableExtension',
  46: 'PermissionedBurnExtension',
};

/** `AssociatedTokenAccountInstruction`, in declaration order. */
export const ASSOCIATED_TOKEN_INSTRUCTION_NAMES: Readonly<Record<number, string>> = {
  0: 'Create',
  1: 'CreateIdempotent',
  2: 'RecoverNested',
};

/** A payload without its base fields; the orchestrator attaches program/evidence/ref. */
export type ActionFields = ActionPayload;

/** Result of trying to decode an instruction from its own bytes. */
export type ByteDecodeResult =
  | { readonly outcome: 'decoded'; readonly fields: ActionFields; readonly notes: readonly string[] }
  /** Recognized instruction outside the Milestone 2 target set. */
  | { readonly outcome: 'not-in-scope'; readonly note: string }
  /** Discriminator is not part of this program's instruction set. */
  | { readonly outcome: 'unknown-tag'; readonly note: string }
  /** Discriminator or payload could not be read. */
  | { readonly outcome: 'malformed'; readonly note: string };

/** Result of mapping the RPC node's own parse into our model. */
export type ParsedDecodeResult =
  | { readonly outcome: 'decoded'; readonly fields: ActionFields; readonly notes: readonly string[] }
  /** The node recognized the instruction, but it is outside the Milestone 2 target set. */
  | { readonly outcome: 'not-in-scope'; readonly note: string }
  /** The node parsed it as something not in this program's instruction set. */
  | { readonly outcome: 'unknown-type'; readonly note: string };

/**
 * A program this layer understands. Two decode paths, one per evidence kind:
 * the instruction's own bytes, or the RPC node's parse. Keeping them separate
 * (rather than pretending bytes exist when they do not) is what lets `evidence`
 * be reported honestly.
 */
export interface ProgramDecoder {
  readonly label: DecodedProgramLabel;
  readonly programId: string;
  decodeBytes(input: {
    readonly bytes: ReadonlyUint8Array;
    readonly accounts: readonly string[];
  }): ByteDecodeResult;
  decodeParsed(input: {
    readonly parsedType: string;
    readonly parsedInfo: unknown;
  }): ParsedDecodeResult;
  /** Official name of a discriminator, for explaining what was *not* decoded. */
  instructionName(discriminator: number): string | null;
}

const malformed = (note: string): ByteDecodeResult => ({ outcome: 'malformed', note });
export { malformed as malformedResult };

/** Shared helper: a message for a recognized-but-undecoded instruction. */
export function notInScopeNote(programName: string, instruction: string, detail: string): string {
  return `${programName} instruction ${instruction} (${detail}) is recognized but not decoded in Milestone 2.`;
}
