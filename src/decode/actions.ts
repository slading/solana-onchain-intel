/**
 * The semantic layer: what a *decoded* instruction means.
 *
 * Design rules (Milestone 2):
 *
 * 1. **Instruction-driven only.** An action exists because an instruction's data
 *    (or the node's own parse of that instruction) says so. Balance deltas never
 *    produce, confirm or modify an action. A large SOL outflow is not a "swap";
 *    it is a balanced change until an instruction proves otherwise.
 * 2. **Evidence is recorded, not hidden.** `evidence` says whether the semantics
 *    came from the instruction's own bytes (`instruction-data`) or from the RPC
 *    node's parser (`rpc-parsed`). Both are deterministic given a response; only
 *    the first is independent of the node.
 * 3. **Unknown stays unknown.** If we cannot establish the meaning, no action is
 *    produced — the instruction is reported as undecoded with a reason instead.
 * 4. **Unreadable fields are `null`.** A discriminator byte proves the *kind* of
 *    instruction; if the payload is truncated or the account list is short, the
 *    proven kind is kept and the unreadable fields are `null` (plus a
 *    diagnostic). We never backfill a field from elsewhere in the transaction —
 *    in particular, a plain SPL `transfer` does not carry the mint or the
 *    decimals, so we do not look them up from token balances.
 */

/** Programs this layer decodes. Anything else is explicitly not decoded. */
export type DecodedProgramLabel =
  | 'system'
  | 'spl-token'
  | 'spl-token-2022'
  | 'associated-token-account';

/** Where the semantics came from. */
export type DecodeEvidence =
  /** The instruction's own bytes (base58 `data`) + resolved accounts. */
  | 'instruction-data'
  /** The RPC node's `jsonParsed` parse of the instruction. */
  | 'rpc-parsed';

/** Points back at the normalized instruction an action was decoded from. */
export interface InstructionRef {
  readonly path: 'top-level' | 'inner';
  /** Instruction index inside its own list. */
  readonly index: number;
  /** For inner instructions: the outer instruction index. `null` for top-level. */
  readonly outerIndex: number | null;
  readonly stackHeight: number | null;
}

/**
 * Display label for a reference, e.g. `[3]` for a top-level instruction or
 * `[3.2]` for the third CPI of that instruction. Deterministic; used by the
 * renderer and by tests to cross-reference the INSTRUCTIONS section.
 */
export function refLabel(ref: InstructionRef): string {
  return ref.path === 'inner' && ref.outerIndex !== null
    ? `[${ref.outerIndex}.${ref.index}]`
    : `[${ref.index}]`;
}

/** Fields every action carries. */
export interface ActionBase {
  readonly program: DecodedProgramLabel;
  readonly programId: string;
  readonly evidence: DecodeEvidence;
  readonly ref: InstructionRef;
}

/* ------------------------------------------------------------------ system */

/** System Program `Transfer` (bincode tag 2): lamports from `from` to `to`. */
export interface SystemTransferAction {
  readonly kind: 'system.transfer';
  readonly from: string | null;
  readonly to: string | null;
  readonly lamports: bigint | null;
}

/** System Program `CreateAccount` (bincode tag 0). */
export interface SystemCreateAccountAction {
  readonly kind: 'system.createAccount';
  /** Funding account (account 0). */
  readonly from: string | null;
  /** The account being created (account 1). */
  readonly newAccount: string | null;
  readonly lamports: bigint | null;
  readonly space: bigint | null;
  /** Program that will own the new account. */
  readonly owner: string | null;
}

/* --------------------------------------------------------------- spl-token */

/** `Transfer` (tag 3). Carries no mint and no decimals by design. */
export interface SplTokenTransferAction {
  readonly kind: 'spl-token.transfer';
  readonly source: string | null;
  readonly destination: string | null;
  /** Owner or delegate (account 2), or the multisig account when one is used. */
  readonly authority: string | null;
  readonly amount: bigint | null;
}

/** `TransferChecked` (tag 12). */
export interface SplTokenTransferCheckedAction {
  readonly kind: 'spl-token.transferChecked';
  readonly source: string | null;
  readonly mint: string | null;
  readonly destination: string | null;
  readonly authority: string | null;
  readonly amount: bigint | null;
  readonly decimals: number | null;
}

/** `MintTo` (tag 7). */
export interface SplTokenMintToAction {
  readonly kind: 'spl-token.mintTo';
  readonly mint: string | null;
  readonly destination: string | null;
  readonly authority: string | null;
  readonly amount: bigint | null;
}

/** `MintToChecked` (tag 14). */
export interface SplTokenMintToCheckedAction {
  readonly kind: 'spl-token.mintToChecked';
  readonly mint: string | null;
  readonly destination: string | null;
  readonly authority: string | null;
  readonly amount: bigint | null;
  readonly decimals: number | null;
}

/** `Burn` (tag 8). */
export interface SplTokenBurnAction {
  readonly kind: 'spl-token.burn';
  /** The token account burned from (account 0). */
  readonly account: string | null;
  readonly mint: string | null;
  readonly authority: string | null;
  readonly amount: bigint | null;
}

/** `BurnChecked` (tag 15). */
export interface SplTokenBurnCheckedAction {
  readonly kind: 'spl-token.burnChecked';
  readonly account: string | null;
  readonly mint: string | null;
  readonly authority: string | null;
  readonly amount: bigint | null;
  readonly decimals: number | null;
}

/** `Approve` (tag 4). */
export interface SplTokenApproveAction {
  readonly kind: 'spl-token.approve';
  readonly source: string | null;
  readonly delegate: string | null;
  readonly authority: string | null;
  readonly amount: bigint | null;
}

/** `Revoke` (tag 5). Carries no amount. */
export interface SplTokenRevokeAction {
  readonly kind: 'spl-token.revoke';
  readonly source: string | null;
  readonly authority: string | null;
}

/** `CloseAccount` (tag 9). The remaining lamports go to `destination`. */
export interface SplTokenCloseAccountAction {
  readonly kind: 'spl-token.closeAccount';
  readonly account: string | null;
  readonly destination: string | null;
  readonly authority: string | null;
}

/* --------------------------------------------- associated token account(s) */

/**
 * Associated Token Account Program `Create` / `CreateIdempotent`
 * (tag 0 / tag 1; empty data is also `Create`).
 *
 * This is the *outer* instruction. The account it creates really is created by
 * the System Program + SPL Token CPIs it makes, which appear as inner
 * instructions and decode separately.
 */
export interface AssociatedTokenAccountCreateAction {
  readonly kind: 'associated-token-account.create';
  /** `true` for `CreateIdempotent`, `false` for `Create`. */
  readonly idempotent: boolean;
  /** Funding account (account 0). */
  readonly payer: string | null;
  /** The associated token account being created (account 1). */
  readonly associatedTokenAccount: string | null;
  /** Wallet the account is associated with (account 2). */
  readonly wallet: string | null;
  readonly mint: string | null;
  readonly systemProgram: string | null;
  readonly tokenProgram: string | null;
}

/** All action payloads. Discriminated by `kind`. */
export type ActionPayload =
  | SystemTransferAction
  | SystemCreateAccountAction
  | SplTokenTransferAction
  | SplTokenTransferCheckedAction
  | SplTokenMintToAction
  | SplTokenMintToCheckedAction
  | SplTokenBurnAction
  | SplTokenBurnCheckedAction
  | SplTokenApproveAction
  | SplTokenRevokeAction
  | SplTokenCloseAccountAction
  | AssociatedTokenAccountCreateAction;

/** A decoded action: a payload plus where it came from and on what evidence. */
export type DecodedAction = ActionPayload & ActionBase;

/** Stable machine id of an action, e.g. `'system.transfer'`. */
export type ActionKind = ActionPayload['kind'];

/* ------------------------------------------------------------- not decoded */

/** Why an instruction produced no action. */
export type UndecodedReason =
  /** The instruction has no program id at all, so it cannot be attributed. */
  | 'program-id-missing'
  /** A program this layer does not implement. */
  | 'program-not-supported'
  /** Recognized program and instruction, but outside the Milestone 2 target set. */
  | 'instruction-not-in-scope'
  /** Recognized program, but the discriminator is not one of its instructions. */
  | 'unknown-instruction-tag'
  /** Discriminator or payload could not be read (bad base58, truncated). */
  | 'malformed-instruction-data'
  /** Neither raw data nor an RPC parse is available for this instruction. */
  | 'no-decoding-evidence';

export interface UndecodedInstruction {
  readonly ref: InstructionRef;
  readonly programId: string | null;
  /** The RPC's label for the program, when it parsed the instruction. */
  readonly programName: string | null;
  readonly parsedType: string | null;
  readonly reason: UndecodedReason;
  /** Human-readable, deterministic explanation. Never a guess at meaning. */
  readonly note: string;
}

/** A coded note produced while decoding (malformed payloads, partial data). */
export interface DecodeDiagnostic {
  readonly level: 'info' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly ref: InstructionRef;
}

export interface DecodedTransaction {
  /** Actions in execution order (each instruction followed by the CPIs it made). */
  readonly actions: readonly DecodedAction[];
  /** Instructions that produced no action, in the same execution order. */
  readonly undecoded: readonly UndecodedInstruction[];
  /** Top-level + inner instructions considered. */
  readonly instructionCount: number;
  readonly diagnostics: readonly DecodeDiagnostic[];
}
