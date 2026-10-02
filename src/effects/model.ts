/**
 * Milestone 3: the effects layer.
 *
 * Milestone 1 modelled *what the transaction did mechanically* (accounts,
 * instructions, boundary balance deltas). Milestone 2 decoded *what the
 * instructions mean* (actions). This layer answers the transaction-level
 * questions those two cannot answer on their own: who moved value to whom, what
 * each account's net change was, which accounts were created or closed, and
 * which of those conclusions are proven, reconciled, or simply not attributable.
 *
 * Design rules (Milestone 3):
 *
 * 1. **Two inputs only.** Effects are computed from the canonical normalized
 *    transaction (as a narrow `EffectsInput` view) plus the decoded
 *    `DecodedAction[]`. Decoders and the normalizer are untouched, and no raw
 *    RPC payload is visible from here — the input view simply has no such field.
 * 2. **`DecodedAction`s are read, never reinterpreted.** This layer adds no
 *    meaning to an action; it adds the *value movement and account state change*
 *    that the action-plus-balances imply.
 * 3. **Three honest buckets.** Every claim is either
 *      - `proven`      — relationship *and* amount stated by instruction data
 *                        (or, for the fee, by transaction metadata);
 *      - `reconciled`  — the relationship is instruction-proven but a value
 *                        (usually the amount) comes from exact boundary-balance
 *                        arithmetic;
 *      - ambiguous     — not asserted at all; recorded in `unattributedEffects`
 *                        with the residual, its sign, and whatever candidate
 *                        instructions could explain it.
 * 4. **No attribution from deltas alone.** A balance change never produces a
 *    sender→receiver edge. Only an instruction can do that. Reconciliation can
 *    *size* a relationship an instruction already proved, and can prove an
 *    account's net change; it cannot invent a counterparty.
 * 5. **Raw units only.** Every amount in this model is an exact integer
 *    (lamports, or token raw units) or `null`. `decimals` is carried for
 *    presentation and is never used in arithmetic.
 * 6. **Names mean what the data proves.** The model keeps these separate
 *    throughout: a *token account* (an address), its *owner* (the authority
 *    recorded in the account), a *mint*, and a *signer* (an account that signed
 *    this transaction). "Signer" is only ever claimed from the transaction's own
 *    signer flag; the model deliberately has no word for "wallet".
 * 7. **CPI is not flattened.** Every effect keeps the `ref` of the instruction
 *    that implies it, and inner instructions keep their CPI depth, so a transfer
 *    executed inside someone else's program call is never presented as a user's
 *    direct intent.
 * 8. **Failed means reverted.** A failed transaction commits nothing except the
 *    fee (Solana transactions are atomic). Instruction-derived effects are then
 *    reported in the `uncommitted*` collections, never as committed effects.
 * 9. **Deterministic.** Fixed field order, fixed collection order, no locale, no
 *    clock, no I/O. All amounts are `bigint`.
 */

import type { ActionKind, InstructionRef, UndecodedInstruction } from '../decode/actions.ts';

/* ------------------------------------------------------------------ buckets */

/**
 * How much of an effect survived the transaction's commit.
 *
 * `reverted` and `unknown` exist so that a failed or metadata-less transaction
 * can never be read as "this happened".
 */
export type EffectCommitState =
  /** All instructions succeeded: the effect is part of committed state. */
  | 'committed'
  /** The transaction failed and rolled back: only the fee committed. */
  | 'reverted'
  /** `meta` was absent, so commitment is unknown. */
  | 'unknown';

/**
 * Where a number came from.
 *
 * `instruction-data` and `transaction-metadata` are direct (the value is stated,
 * not computed). The two reconciliation sources are exact arithmetic over the
 * transaction's own boundary balances — they size a relationship an instruction
 * proved, or deduce an amount no instruction states. `not-observable` is the
 * honest absence: the relationship is proven, the number is not knowable from
 * this layer's inputs.
 */
export type AmountSource =
  | 'instruction-data'
  | 'transaction-metadata'
  | 'balance-reconciliation'
  | 'residual-reconciliation'
  | 'not-observable';

/** The three buckets of rule 3. */
export type EffectConfidence =
  /** Relationship and value both stated (instruction data / transaction metadata). */
  | 'proven'
  /** Relationship stated by an instruction; a value reconciled from exact balances. */
  | 'reconciled'
  /** Only used for entries in `unattributedEffects`: nothing is asserted. */
  | 'ambiguous';

/** Fields common to every effect. */
export interface EffectBase {
  readonly confidence: EffectConfidence;
  readonly commitState: EffectCommitState;
  /**
   * The instruction this effect came from. `null` for the fee, which comes from
   * transaction metadata rather than an instruction.
   */
  readonly ref: InstructionRef | null;
  /** Cross-reference to the decoded action, when there is one. */
  readonly actionKind: ActionKind | null;
}

/* ---------------------------------------------------------------- sol flows */

export type SolFlowKind =
  /** `system.transfer`: an instruction that moves lamports. */
  | 'transfer'
  /** `system.createAccount` / ATA create: lamports funding a new account. */
  | 'account-create-deposit'
  /** `spl-token.closeAccount`: the closed account's lamports going to the destination. */
  | 'account-close-return'
  /** The transaction fee taken from the fee payer. */
  | 'fee'
  /** The lamport half of a wrapped-SOL token movement (see `native.ts`). */
  | 'native-token-leg';

/** One lamport movement, in the direction the instruction (or the protocol) states. */
export interface SolFlow extends EffectBase {
  readonly kind: SolFlowKind;
  readonly from: string | null;
  /**
   * Recipient. `null` for `kind: 'fee'` by construction: the fee leaves the
   * payer, and the RPC does not report how it is split between burn and
   * validator reward, so this layer names no recipient rather than guessing one.
   */
  readonly to: string | null;
  /** Exact lamports, or `null` when the amount is not observable. */
  readonly lamports: bigint | null;
  readonly amountSource: AmountSource;
}

/* -------------------------------------------------------------- token flows */

/** How a mint/decimals value was established. */
export type TokenFieldEvidence =
  /** Stated by the instruction itself (`transferChecked`, `mintTo`, `burn`, …). */
  | 'instruction-data'
  /** Read from the token account's own reported metadata, not from the instruction. */
  | 'account-metadata'
  /** Not establishable. */
  | 'none';

export type TokenFlowKind =
  /** `spl-token.transfer` / `transferChecked`. */
  | 'transfer'
  /** `spl-token.mintTo` / `mintToChecked`: supply increases. */
  | 'mint'
  /** `spl-token.burn` / `burnChecked`: supply decreases. */
  | 'burn'
  /**
   * The units a wrapped-SOL account held when it was closed with them.
   *
   * `closeAccount` sweeps an account's whole lamport balance to the destination
   * and deletes the account. A non-native account may only be closed at a zero
   * balance, but a wrapped-SOL one may be closed holding units — those units are
   * the lamport claim the close pays out, so they leave the token system with the
   * account. The mint's supply is *not* decremented (the program only moves
   * lamports), so this is deliberately neither a `transfer` nor a `burn`; the
   * matching lamport movement is the close's `account-close-return` flow.
   */
  | 'close-unwrap';

/**
 * One token movement in RAW UNITS.
 *
 * `sourceTokenAccount` and `destinationTokenAccount` are token *accounts*;
 * `sourceOwner`/`destinationOwner` are the owners those accounts report; `mint`
 * is the token type. They are never merged into one "from user to user" field,
 * because only the account is what the instruction actually named.
 */
export interface TokenFlow extends EffectBase {
  readonly kind: TokenFlowKind;
  readonly mint: string | null;
  readonly mintEvidence: TokenFieldEvidence;
  /** Presentation metadata only — never used to compute an amount. */
  readonly decimals: number | null;
  readonly decimalsEvidence: TokenFieldEvidence;
  /** Token account the units left. `null` for `kind: 'mint'` (supply creation). */
  readonly sourceTokenAccount: string | null;
  /** Token account the units arrived at. `null` for `kind: 'burn'` (supply destruction). */
  readonly destinationTokenAccount: string | null;
  readonly sourceOwner: string | null;
  readonly destinationOwner: string | null;
  /** Account that authorized the instruction: owner, delegate, or multisig account. */
  readonly authority: string | null;
  /**
   * `false` when the authority is not among this transaction's signers. That is
   * normal for a multisig authority (the member signers are not identifiable
   * from instruction data), which is why it is reported rather than treated as
   * an error.
   */
  readonly authorityIsSigner: boolean | null;
  /** Exact raw units, or `null` when the payload did not carry a readable amount. */
  readonly amount: bigint | null;
  readonly amountSource: AmountSource;
  /**
   * `true` when the units moved are a lamport claim: a wrapped-SOL movement also
   * moved lamports 1:1 (a matching `native-token-leg` appears in `solFlows`), and
   * a `close-unwrap` is the lamport leg the close's `account-close-return` pays.
   */
  readonly nativeLamportLeg: boolean;
}

/* --------------------------------------------------------------- lifecycle */

export type LifecycleKind =
  /** `system.createAccount` — creates a fresh account. */
  | 'account-created'
  /** Associated Token Account `Create` / `CreateIdempotent`. */
  | 'token-account-create'
  /** `spl-token.closeAccount`. */
  | 'token-account-closed'
  /** `spl-token.approve` — a delegation, not a value movement. */
  | 'allowance-set'
  /** `spl-token.revoke`. */
  | 'allowance-cleared';

/** `system.createAccount`: the account certainly did not exist before (the program fails otherwise). */
export interface AccountCreatedEffect extends EffectBase {
  readonly kind: 'account-created';
  readonly address: string | null;
  /** The account that paid for it (instruction account 0). */
  readonly funder: string | null;
  /** Stated by the instruction. */
  readonly lamportsDeposited: bigint | null;
  readonly space: bigint | null;
  /** Program that now owns the new account. */
  readonly ownerProgram: string | null;
}

/**
 * Associated Token Account create.
 *
 * `outcome` is the point of this record: `Create` (non-idempotent) proves the
 * account did not exist beforehand, while `CreateIdempotent` on an account that
 * already was an initialised token account is a **no-op**. Claiming a creation
 * where the program did nothing would be exactly the kind of invented effect
 * this layer must not produce.
 */
export interface TokenAccountCreateEffect extends EffectBase {
  readonly kind: 'token-account-create';
  readonly outcome: 'created' | 'no-op' | 'not-provable';
  readonly outcomeBasis: 'instruction-variant' | 'pre-state' | 'none';
  /** The associated token account. */
  readonly address: string | null;
  readonly funder: string | null;
  /** The wallet the associated account belongs to == the token account's owner. */
  readonly owner: string | null;
  readonly mint: string | null;
  readonly tokenProgram: string | null;
  /** Lamports that funded the new account; reconciled when observable. */
  readonly lamportsDeposited: bigint | null;
  readonly depositSource: AmountSource;
}

/**
 * `spl-token.closeAccount`.
 *
 * The whole lamport balance is swept to `destination` and the account is
 * deleted. For a native (wrapped-SOL) account the balance may be non-zero and
 * part of what comes back is unwrapped SOL; for any other account the token
 * balance had to be zero at close time. The returned amount is only observable
 * when boundary balances can show it (see `returnSource`).
 */
export interface TokenAccountClosedEffect extends EffectBase {
  readonly kind: 'token-account-closed';
  readonly address: string | null;
  readonly destination: string | null;
  readonly owner: string | null;
  readonly mint: string | null;
  /** The account holds wrapped SOL, so part of what it returns is an unwrapped balance. */
  readonly isNativeMint: boolean;
  readonly lamportsReturned: bigint | null;
  readonly returnSource: AmountSource;
  /**
   * The part of the return that is the account's unwrapped wrapped-SOL balance
   * (1:1 lamports). `null` for non-native accounts or when not provable.
   */
  readonly unwrappedLamports: bigint | null;
  /**
   * Everything else that came back — the account's rent-exempt deposit plus any
   * extra lamports sent to it. This layer does **not** claim to separate rent
   * from dust: that needs the rent-exempt minimum, which is a sysvar value that
   * can change between epochs, so it is deliberately not hardcoded.
   */
  readonly otherLamports: bigint | null;
  /**
   * Lamports the account already held when the transaction started: `0n` when the
   * transaction created it, its pre-transaction balance when it already existed,
   * `null` when the response does not say.
   */
  readonly lamportsAtStart: bigint | null;
  /** Committed lamports other instructions moved *into* it during the transaction. */
  readonly lamportsCredited: bigint | null;
  /**
   * Committed lamports it moved *out* during the transaction, excluding the
   * close's own return.
   */
  readonly lamportsSpent: bigint | null;
  /**
   * What the returned lamports were before the close. Derived from the three
   * figures above when they reproduce the return exactly
   * (`returned == atStart + credited - spent`):
   *
   * - `own-lamports`: nothing was paid into the account during this transaction,
   *   so everything it returned was already sitting in it — recovered rent, not a
   *   payment into the destination.
   * - `in-transaction-lamports`: the transaction created the account, so none of
   *   the return is rent it had held; all of it arrived during the transaction.
   * - `mixed`: some was already there (rent) and some arrived during the
   *   transaction.
   * - `not-provable`: a term is missing, or the three do not reproduce the return.
   */
  readonly returnComposition: 'own-lamports' | 'in-transaction-lamports' | 'mixed' | 'not-provable';
}

/** `spl-token.approve`: sets a delegate allowance. No balance changes hands. */
export interface AllowanceSetEffect extends EffectBase {
  readonly kind: 'allowance-set';
  readonly tokenAccount: string | null;
  /** The account owner (instruction authority), when known. */
  readonly owner: string | null;
  readonly delegate: string | null;
  /** Raw units of the allowance. */
  readonly allowance: bigint | null;
}

/** `spl-token.revoke`: clears the delegate allowance. */
export interface AllowanceClearedEffect extends EffectBase {
  readonly kind: 'allowance-cleared';
  readonly tokenAccount: string | null;
  readonly owner: string | null;
}

export type AccountLifecycleEffect =
  | AccountCreatedEffect
  | TokenAccountCreateEffect
  | TokenAccountClosedEffect
  | AllowanceSetEffect
  | AllowanceClearedEffect;

/* --------------------------------------------------------------- net change */

/**
 * How well an account's exact boundary delta is explained.
 *
 * `exact` — every lamport (or raw unit) of the net change is accounted for by
 * committed flows; `residual` — a non-zero part is not; `unknown` — the delta
 * itself is not knowable from the response.
 */
export type Reconciliation = 'exact' | 'residual' | 'unknown';

/** Net lamport change of one account, with its reconciliation against decoded flows. */
export interface SolAccountNet {
  readonly accountIndex: number;
  readonly address: string | null;
  readonly signer: boolean | null;
  readonly isFeePayer: boolean;
  readonly beforeLamports: bigint | null;
  readonly afterLamports: bigint | null;
  /** Exact `after - before`. Includes the fee and any CPI-mediated movement. */
  readonly netLamports: bigint | null;
  /** Σ of committed flows with a known amount that touch this account. */
  readonly explainedLamports: bigint;
  /** `netLamports - explainedLamports`. */
  readonly residualLamports: bigint | null;
  readonly reconciliation: Reconciliation;
  /** Committed flows touching this account whose amount is not observable. */
  readonly unobservableFlowRefs: readonly InstructionRef[];
}

/** How a token account's starting amount was established. */
export type StartingAmountSource =
  /** The RPC reported a pre-transaction balance for this account. */
  | 'reported'
  /** The account was proven created in this transaction, so it started at zero. */
  | 'account-created'
  /** No pre-transaction value and no proof of creation. */
  | 'not-observable';

/** Net change of one (token account, mint) pair — raw units, exact or not at all. */
export interface TokenAccountMintNet {
  readonly accountIndex: number;
  readonly tokenAccount: string | null;
  readonly mint: string | null;
  readonly owner: string | null;
  readonly programId: string | null;
  readonly decimals: number | null;
  readonly presence: 'both' | 'only-before' | 'only-after';
  readonly beforeAmount: bigint | null;
  readonly afterAmount: bigint | null;
  readonly startingAmountSource: StartingAmountSource;
  readonly netAmount: bigint | null;
  readonly explainedAmount: bigint;
  readonly residualAmount: bigint | null;
  readonly reconciliation: Reconciliation;
  readonly isNativeMint: boolean;
  readonly unobservableFlowRefs: readonly InstructionRef[];
}

/**
 * Net change of one owner across the token accounts of one mint.
 *
 * The owner is the authority recorded by the token accounts, which is not the
 * same thing as a signer. `tokenAccountCount` is carried so a reader can tell
 * one account from an aggregate.
 */
export interface OwnerMintNet {
  readonly owner: string | null;
  readonly mint: string | null;
  readonly decimals: number | null;
  readonly netAmount: bigint | null;
  readonly tokenAccountCount: number;
  readonly tokenAccounts: readonly (string | null)[];
  readonly reconciliation: Reconciliation;
}

/* ------------------------------------------------------------- unattributed */

/** Why something could not be attributed. */
export type UnattributedReason =
  /** A residual no committed flow touches, and no undecoded instruction on the program family. */
  | 'not-explained'
  /** Residual is real, and the holders of the unexplained amount are known flows. */
  | 'amounts-not-separable'
  /** The account's own delta is not knowable from the response. */
  | 'delta-not-observable';

/**
 * Anything this layer refuses to turn into an effect.
 *
 * These entries are the visible form of "we do not know". They always carry the
 * signed residual (when there is one), the instructions that could be
 * responsible, and a deterministic explanation.
 */
export interface UnattributedEffect {
  readonly confidence: 'ambiguous';
  readonly side: 'sol' | 'token';
  readonly reason: UnattributedReason;
  readonly accountIndex: number | null;
  readonly address: string | null;
  /** For token effects: which mint's units. */
  readonly mint: string | null;
  /** Signed residual in raw units (lamports for `side: 'sol'`). */
  readonly amount: bigint | null;
  /** Committed flows whose amounts boundary balances cannot pin down. */
  readonly candidateRefs: readonly InstructionRef[];
  /**
   * Undecoded instructions that could have moved the value: for token balances
   * only the account's own token program can change them, so these are a real
   * lead rather than a guess.
   */
  readonly undecodedRefs: readonly InstructionRef[];
  readonly explanation: string;
}

/* --------------------------------------------------------------- diagnostics */

export interface EffectsDiagnostic {
  readonly level: 'info' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly ref: InstructionRef | null;
}

/* ------------------------------------------------------------------- result */

export interface EffectsCounts {
  readonly proven: number;
  readonly reconciled: number;
  readonly uncommitted: number;
  readonly unattributed: number;
  /** Committed flows whose amount is `null` (relationship proven, value not observable). */
  readonly amountNotObservable: number;
}

/** Everything the effects layer concluded about one transaction. */
export interface TransactionEffects {
  /**
   * The transaction's commit state as far as this layer is concerned:
   * `committed` (all instructions succeeded), `reverted` (failed → only the fee
   * committed), `unknown` (`meta` absent).
   */
  readonly commitState: EffectCommitState;

  /** Committed lamport movements, in instruction order (fee first). */
  readonly solFlows: readonly SolFlow[];
  /** Committed token movements in raw units, in instruction order. */
  readonly tokenFlows: readonly TokenFlow[];
  /** Committed account lifecycle and allowance effects, in instruction order. */
  readonly accountLifecycleEffects: readonly AccountLifecycleEffect[];

  /**
   * Effects implied by instructions that did **not** commit — because the
   * transaction failed and rolled back, or because `meta` was missing so
   * commitment is unknown. Each carries its own `commitState`. Kept structured
   * (not summarised) so the attempted movement stays inspectable, but never mixed
   * into the committed collections above.
   */
  readonly uncommittedSolFlows: readonly SolFlow[];
  readonly uncommittedTokenFlows: readonly TokenFlow[];
  readonly uncommittedLifecycleEffects: readonly AccountLifecycleEffect[];

  /** Exact net lamport change per account, ordered by account index. */
  readonly netSolByAccount: readonly SolAccountNet[];
  /** Exact net raw-unit change per (token account, mint), ordered by account index then mint. */
  readonly netTokenByAccountMint: readonly TokenAccountMintNet[];
  /** Net raw-unit change per (owner, mint), aggregated over that owner's accounts of that mint. */
  readonly netTokenByOwnerMint: readonly OwnerMintNet[];

  readonly unattributedEffects: readonly UnattributedEffect[];
  readonly diagnostics: readonly EffectsDiagnostic[];
  readonly counts: EffectsCounts;
}

/**
 * Everything the effects layer is allowed to look at.
 *
 * Built once from the canonical model by `toEffectsInput`. It deliberately
 * contains no raw payload, no logs and no instruction *data*: meaning arrives
 * only through the decoded actions, so the effects layer cannot start decoding
 * things on its own.
 */
export interface EffectsInput {
  readonly status: 'success' | 'failed' | 'unknown';
  readonly feeLamports: bigint | null;
  /** Derived from the message's first account; `null` when the RPC omitted accounts. */
  readonly feePayer: string | null;
  /** The transaction's ordered account list with its boundary lamport balances. */
  readonly accounts: readonly EffectsAccountRow[];
  /** Token balance rows, one per (account, mint) the RPC reported. */
  readonly tokenRows: readonly EffectsTokenRow[];
  /** `false` when the RPC omitted token balance data entirely. */
  readonly tokenBalancesAvailable: boolean;
  /** Instructions no decoder could turn into an action (used to explain residuals). */
  readonly undecoded: readonly UndecodedInstruction[];
}

export interface EffectsAccountRow {
  readonly index: number;
  readonly address: string | null;
  readonly signer: boolean | null;
  readonly beforeLamports: bigint | null;
  readonly afterLamports: bigint | null;
}

export interface EffectsTokenRow {
  readonly accountIndex: number;
  readonly address: string | null;
  readonly mint: string | null;
  readonly owner: string | null;
  readonly programId: string | null;
  readonly decimals: number | null;
  readonly beforeAmount: bigint | null;
  readonly afterAmount: bigint | null;
  readonly presence: 'both' | 'only-before' | 'only-after';
}
