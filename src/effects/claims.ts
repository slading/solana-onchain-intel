/**
 * From decoded actions to effect *claims*.
 *
 * A claim is a value movement or account state change that an instruction
 * implies, with everything the instruction itself states already filled in.
 * Amounts an instruction does not state (what a closed account returns, what an
 * Associated Token Account create deposited) stay `null` here — sizing those is
 * `reconcile.ts`'s job, and it uses the transaction's own boundary balances.
 *
 * Nothing in this file looks at balance deltas to decide *what happened*.
 * Account metadata is used only for what it can prove about an account's
 * identity (which mint a token account is of, who owns it), never to invent a
 * movement.
 */

import { refLabel, type ActionKind, type DecodedAction, type InstructionRef } from '../decode/actions.ts';
import type {
  AccountLifecycleEffect,
  EffectsAccountRow,
  EffectsDiagnostic,
  EffectsInput,
  EffectsTokenRow,
  SolFlow,
  TokenFieldEvidence,
  TokenFlow,
} from './model.ts';
import { NATIVE_MINT, isNativeMint } from './native.ts';

/** What the transaction's own account rows say about one token account. */
interface TokenAccountFacts {
  readonly address: string;
  readonly row: EffectsTokenRow | null;
  /** A pre-transaction row exists, i.e. the address already was an initialised token account. */
  readonly existedAsTokenAccount: boolean;
  readonly mint: string | null;
  readonly owner: string | null;
  readonly decimals: number | null;
  readonly programId: string | null;
  /** A `pre`-transaction amount the RPC reported (raw units). */
  readonly beforeAmount: bigint | null;
}

export interface Claims {
  readonly solFlows: readonly SolFlow[];
  readonly tokenFlows: readonly TokenFlow[];
  readonly lifecycle: readonly AccountLifecycleEffect[];
  readonly diagnostics: readonly EffectsDiagnostic[];
  /** Addresses an instruction proves were created within this transaction. */
  readonly created: readonly string[];
  /** Addresses an instruction proves were closed within this transaction. */
  readonly closed: readonly string[];
  /** Mint/owner/token-program knowledge instructions provide about token accounts. */
  readonly tokenAccountHints: ReadonlyMap<string, TokenAccountHint>;
}

export interface TokenAccountHint {
  readonly mint: string | null;
  readonly owner: string | null;
  readonly tokenProgram: string | null;
}

/** Lamport rows keyed by address (only rows with an address). */
function rowsByAddress(accounts: readonly EffectsAccountRow[]): ReadonlyMap<string, EffectsAccountRow> {
  const map = new Map<string, EffectsAccountRow>();
  for (const row of accounts) {
    if (row.address !== null) map.set(row.address, row);
  }
  return map;
}

/** All token rows keyed by address, in row order. */
function tokenRowsByAddress(rows: readonly EffectsTokenRow[]): ReadonlyMap<string, readonly EffectsTokenRow[]> {
  const map = new Map<string, EffectsTokenRow[]>();
  for (const row of rows) {
    if (row.address === null) continue;
    const list = map.get(row.address);
    if (list === undefined) map.set(row.address, [row]);
    else list.push(row);
  }
  return map;
}

function signerFlags(accounts: readonly EffectsAccountRow[]): ReadonlyMap<string, boolean | null> {
  const map = new Map<string, boolean | null>();
  for (const row of accounts) {
    if (row.address !== null) map.set(row.address, row.signer);
  }
  return map;
}

/**
 * What is known about one token account.
 *
 * The rows are the primary source. For an account created *in this transaction*
 * the rows are often absent (the RPC reports nothing for an account that did not
 * exist before and was purged after), so the create instruction fills in what it
 * proves: the Associated Token Account program creates the account with exactly
 * the mint and the owner it was given.
 */
function factsFor(
  address: string | null,
  rows: ReadonlyMap<string, readonly EffectsTokenRow[]>,
  hints: ReadonlyMap<string, TokenAccountHint>,
): TokenAccountFacts | null {
  if (address === null) return null;
  const addressRows = rows.get(address) ?? [];
  const row = addressRows[0] ?? null;
  const preRow = addressRows.find(entry => entry.presence !== 'only-after') ?? null;
  const hint = row === null ? hints.get(address) : undefined;
  return {
    address,
    row,
    existedAsTokenAccount: preRow !== null,
    mint: row?.mint ?? hint?.mint ?? null,
    owner: row?.owner ?? hint?.owner ?? null,
    decimals: row?.decimals ?? null,
    programId: row?.programId ?? hint?.tokenProgram ?? null,
    beforeAmount: preRow?.beforeAmount ?? null,
  };
}

/**
 * A token account's mint, with the evidence for it, for flows whose instruction
 * does not state the mint (a plain `transfer`).
 */
function mintFromMetadata(
  source: TokenAccountFacts | null,
  destination: TokenAccountFacts | null,
): { mint: string | null; evidence: TokenFieldEvidence; conflict: boolean } {
  const sourceMint = source?.mint ?? null;
  const destinationMint = destination?.mint ?? null;
  if (sourceMint !== null && destinationMint !== null) {
    if (sourceMint === destinationMint) {
      return { mint: sourceMint, evidence: 'account-metadata', conflict: false };
    }
    return { mint: null, evidence: 'none', conflict: true };
  }
  if (sourceMint !== null) return { mint: sourceMint, evidence: 'account-metadata', conflict: false };
  if (destinationMint !== null) return { mint: destinationMint, evidence: 'account-metadata', conflict: false };
  return { mint: null, evidence: 'none', conflict: false };
}

function decimalsFromMetadata(...accounts: readonly (TokenAccountFacts | null)[]): number | null {
  for (const account of accounts) {
    if (account?.decimals !== null && account?.decimals !== undefined) return account.decimals;
  }
  return null;
}

/**
 * Extracts every effect the decoded actions imply.
 *
 * `commitState` is supplied by the caller: for a failed transaction the
 * instruction-derived effects are produced identically and then reported as
 * reverted, so the attempted movement stays inspectable without ever being
 * counted as committed state.
 */
export function claimsFromActions(
  input: EffectsInput,
  actions: readonly DecodedAction[],
  commitState: SolFlow['commitState'],
): Claims {
  const lamportRows = rowsByAddress(input.accounts);
  const tokenRowIndex = tokenRowsByAddress(input.tokenRows);
  const signers = signerFlags(input.accounts);

  const solFlows: SolFlow[] = [];
  const tokenFlows: TokenFlow[] = [];
  const lifecycle: AccountLifecycleEffect[] = [];
  const diagnostics: EffectsDiagnostic[] = [];
  const created: string[] = [];
  const closed: string[] = [];
  const tokenAccountHints = new Map<string, TokenAccountHint>();

  const base = (action: DecodedAction, confidence: 'proven' | 'reconciled') => ({
    confidence,
    commitState,
    ref: action.ref,
    actionKind: action.kind,
  });

  /* ------------------------------------------------------------- pre-pass */

  // A close may follow the create that tells us what the account is, but nothing
  // forbids the reverse order, so collect identity facts from every action first.
  for (const action of actions) {
    if (action.kind !== 'associated-token-account.create') continue;
    const address = action.associatedTokenAccount;
    if (address === null) continue;
    tokenAccountHints.set(address, {
      mint: action.mint,
      owner: action.wallet,
      tokenProgram: action.tokenProgram,
    });
  }

  const createOutcomes = new Map<string, TokenAccountCreateOutcome>();
  for (const action of actions) {
    if (action.kind !== 'associated-token-account.create') continue;
    createOutcomes.set(refKeyOf(action.ref), decideCreateOutcome(action, tokenRowIndex, lamportRows));
  }

  /* ------------------------------------------------------------ main pass */

  for (const action of actions) {
    switch (action.kind) {
      case 'system.transfer': {
        solFlows.push({
          ...base(action, 'proven'),
          kind: 'transfer',
          from: action.from,
          to: action.to,
          lamports: action.lamports,
          amountSource: action.lamports === null ? 'not-observable' : 'instruction-data',
        });
        if (action.lamports === null) {
          diagnostics.push({
            level: 'warning',
            code: 'effects-amount-not-stated',
            message: `system.transfer [${refLabel(action.ref)}] does not state a readable lamport amount; the flow is reported with an unknown amount rather than a guessed one.`,
            ref: action.ref,
          });
        }
        break;
      }

      case 'system.createAccount': {
        solFlows.push({
          ...base(action, 'proven'),
          kind: 'account-create-deposit',
          from: action.from,
          to: action.newAccount,
          lamports: action.lamports,
          amountSource: action.lamports === null ? 'not-observable' : 'instruction-data',
        });
        if (action.newAccount !== null) created.push(action.newAccount);
        lifecycle.push({
          ...base(action, 'proven'),
          kind: 'account-created',
          address: action.newAccount,
          funder: action.from,
          lamportsDeposited: action.lamports,
          space: action.space,
          ownerProgram: action.owner,
        });
        break;
      }

      case 'spl-token.transfer': {
        const source = factsFor(action.source, tokenRowIndex, tokenAccountHints);
        const destination = factsFor(action.destination, tokenRowIndex, tokenAccountHints);
        const resolvedMint = mintFromMetadata(source, destination);
        if (resolvedMint.conflict) {
          diagnostics.push({
            level: 'warning',
            code: 'effects-transfer-mint-conflict',
            message:
              `spl-token.transfer [${refLabel(action.ref)}] moves units between two token accounts that report different mints ` +
              `(${source?.mint ?? 'unknown'} → ${destination?.mint ?? 'unknown'}). A plain transfer does not check the mint, and the ` +
              'instruction data does not name one, so no single mint is claimed for this flow.',
            ref: action.ref,
          });
        } else if (resolvedMint.mint === null) {
          diagnostics.push({
            level: 'info',
            code: 'effects-transfer-mint-unknown',
            message:
              `spl-token.transfer [${refLabel(action.ref)}] carries no mint (that is what transferChecked is for), and no token account ` +
              'metadata is available for it, so the flow is reported without a mint.',
            ref: action.ref,
          });
        }
        const native = isNativeMint(resolvedMint.mint);
        tokenFlows.push({
          ...base(action, 'proven'),
          kind: 'transfer',
          mint: resolvedMint.mint,
          mintEvidence: resolvedMint.evidence,
          decimals: decimalsFromMetadata(destination, source),
          decimalsEvidence: decimalsFromMetadata(destination, source) === null ? 'none' : 'account-metadata',
          sourceTokenAccount: action.source,
          destinationTokenAccount: action.destination,
          sourceOwner: source?.owner ?? null,
          destinationOwner: destination?.owner ?? null,
          authority: action.authority,
          authorityIsSigner: signerOf(action.authority, signers),
          amount: action.amount,
          amountSource: action.amount === null ? 'not-observable' : 'instruction-data',
          nativeLamportLeg: native,
        });
        if (native) solFlows.push(nativeLeg(action, commitState, action.source, action.destination, action.amount));
        break;
      }

      case 'spl-token.transferChecked': {
        const source = factsFor(action.source, tokenRowIndex, tokenAccountHints);
        const destination = factsFor(action.destination, tokenRowIndex, tokenAccountHints);
        checkMintAgainstMetadata(action.ref, action.mint, source, destination, diagnostics);
        const native = isNativeMint(action.mint);
        tokenFlows.push({
          ...base(action, 'proven'),
          kind: 'transfer',
          mint: action.mint,
          mintEvidence: action.mint === null ? 'none' : 'instruction-data',
          decimals: action.decimals,
          decimalsEvidence: action.decimals === null ? 'none' : 'instruction-data',
          sourceTokenAccount: action.source,
          destinationTokenAccount: action.destination,
          sourceOwner: source?.owner ?? null,
          destinationOwner: destination?.owner ?? null,
          authority: action.authority,
          authorityIsSigner: signerOf(action.authority, signers),
          amount: action.amount,
          amountSource: action.amount === null ? 'not-observable' : 'instruction-data',
          nativeLamportLeg: native,
        });
        if (native) solFlows.push(nativeLeg(action, commitState, action.source, action.destination, action.amount));
        break;
      }

      case 'spl-token.mintTo':
      case 'spl-token.mintToChecked': {
        const destination = factsFor(action.destination, tokenRowIndex, tokenAccountHints);
        checkNativeMintOrBurn(action.kind, action.ref, action.mint, destination, diagnostics);
        const decimals = action.kind === 'spl-token.mintToChecked' ? action.decimals : decimalsFromMetadata(destination);
        tokenFlows.push({
          ...base(action, 'proven'),
          kind: 'mint',
          mint: action.mint,
          mintEvidence: action.mint === null ? 'none' : 'instruction-data',
          decimals,
          decimalsEvidence:
            action.kind === 'spl-token.mintToChecked'
              ? action.decimals === null
                ? 'none'
                : 'instruction-data'
              : decimals === null
                ? 'none'
                : 'account-metadata',
          sourceTokenAccount: null,
          destinationTokenAccount: action.destination,
          sourceOwner: null,
          destinationOwner: destination?.owner ?? null,
          authority: action.authority,
          authorityIsSigner: signerOf(action.authority, signers),
          amount: action.amount,
          amountSource: action.amount === null ? 'not-observable' : 'instruction-data',
          nativeLamportLeg: false,
        });
        break;
      }

      case 'spl-token.burn':
      case 'spl-token.burnChecked': {
        const account = factsFor(action.account, tokenRowIndex, tokenAccountHints);
        checkNativeMintOrBurn(action.kind, action.ref, action.mint, account, diagnostics);
        const decimals = action.kind === 'spl-token.burnChecked' ? action.decimals : decimalsFromMetadata(account);
        tokenFlows.push({
          ...base(action, 'proven'),
          kind: 'burn',
          mint: action.mint,
          mintEvidence: action.mint === null ? 'none' : 'instruction-data',
          decimals,
          decimalsEvidence:
            action.kind === 'spl-token.burnChecked'
              ? action.decimals === null
                ? 'none'
                : 'instruction-data'
              : decimals === null
                ? 'none'
                : 'account-metadata',
          sourceTokenAccount: action.account,
          destinationTokenAccount: null,
          sourceOwner: account?.owner ?? null,
          destinationOwner: null,
          authority: action.authority,
          authorityIsSigner: signerOf(action.authority, signers),
          amount: action.amount,
          amountSource: action.amount === null ? 'not-observable' : 'instruction-data',
          nativeLamportLeg: false,
        });
        break;
      }

      case 'spl-token.approve': {
        const source = factsFor(action.source, tokenRowIndex, tokenAccountHints);
        lifecycle.push({
          ...base(action, 'proven'),
          kind: 'allowance-set',
          tokenAccount: action.source,
          owner: source?.owner ?? action.authority,
          delegate: action.delegate,
          allowance: action.amount,
        });
        break;
      }

      case 'spl-token.revoke': {
        const source = factsFor(action.source, tokenRowIndex, tokenAccountHints);
        lifecycle.push({
          ...base(action, 'proven'),
          kind: 'allowance-cleared',
          tokenAccount: action.source,
          owner: source?.owner ?? action.authority,
        });
        break;
      }

      case 'spl-token.closeAccount': {
        const account = factsFor(action.account, tokenRowIndex, tokenAccountHints);
        const hint = action.account === null ? undefined : tokenAccountHints.get(action.account);
        if (action.account !== null) closed.push(action.account);
        // The sweep is proven; the amount never is (the instruction states no
        // figure), so a close is recorded as reconciled rather than proven.
        lifecycle.push({
          ...base(action, 'reconciled'),
          kind: 'token-account-closed',
          address: action.account,
          destination: action.destination,
          owner: account?.owner ?? hint?.owner ?? null,
          mint: account?.mint ?? hint?.mint ?? null,
          isNativeMint: isNativeMint(account?.mint ?? hint?.mint ?? null),
          // The instruction proves the whole balance is swept; it does not state
          // how much that is. `reconcile.ts` fills this in when the transaction's
          // own boundary balances determine it.
          lamportsReturned: null,
          returnSource: 'not-observable',
          unwrappedLamports: null,
          otherLamports: null,
          // `reconcile.ts` knows the transaction's boundary balances and its other
          // lamport movements; this instruction only proves that the whole balance
          // was swept, not where it came from.
          lamportsAtStart: null,
          lamportsCredited: null,
          lamportsSpent: null,
          returnComposition: 'not-provable',
        });
        solFlows.push({
          ...base(action, 'proven'),
          kind: 'account-close-return',
          from: action.account,
          to: action.destination,
          lamports: null,
          amountSource: 'not-observable',
        });
        break;
      }

      case 'associated-token-account.create': {
        const outcome = createOutcomes.get(refKeyOf(action.ref)) ?? {
          outcome: 'not-provable' as const,
          basis: 'none' as const,
        };
        const address = action.associatedTokenAccount;
        if (outcome.outcome === 'created' && address !== null) created.push(address);
        if (address !== null) {
          const existingHint = tokenAccountHints.get(address);
          tokenAccountHints.set(address, {
            mint: action.mint ?? existingHint?.mint ?? null,
            owner: action.wallet ?? existingHint?.owner ?? null,
            tokenProgram: action.tokenProgram ?? existingHint?.tokenProgram ?? null,
          });
        }
        lifecycle.push({
          ...base(action, outcome.outcome === 'no-op' ? 'proven' : 'reconciled'),
          kind: 'token-account-create',
          outcome: outcome.outcome,
          outcomeBasis: outcome.basis,
          address,
          funder: action.payer,
          owner: action.wallet,
          mint: action.mint,
          tokenProgram: action.tokenProgram,
          // Stated nowhere in this instruction: the amount is whatever the create
          // deposit was. `reconcile.ts` sizes it from the account's lamport delta
          // when nothing else touches the account.
          lamportsDeposited: null,
          depositSource: 'not-observable',
        });
        // A no-op create moves no lamports at all (the account already existed and
        // was already an initialised token account), so it contributes no flow.
        if (outcome.outcome !== 'no-op') {
          solFlows.push({
            ...base(action, 'reconciled'),
            kind: 'account-create-deposit',
            from: action.payer,
            to: address,
            lamports: null,
            amountSource: 'not-observable',
          });
        }
        if (outcome.outcome === 'not-provable') {
          diagnostics.push({
            level: 'info',
            code: 'effects-create-outcome-not-provable',
            message:
              `associated-token-account.create [${refLabel(action.ref)}] could not be classified as creating or skipping the account: ` +
              'it is idempotent, and the response shows neither a pre-existing token account nor a zero pre-transaction lamport balance.',
            ref: action.ref,
          });
        }
        break;
      }

      // Exhaustive by construction: every action kind above is a supported decode.
      // Anything new must be handled here rather than silently ignored.
      default: {
        const unreachable: never = action;
        throw new Error(`effects layer: unhandled action ${JSON.stringify(unreachable)}`);
      }
    }
  }

  return { solFlows, tokenFlows, lifecycle, diagnostics, created, closed, tokenAccountHints };
}

interface TokenAccountCreateOutcome {
  readonly outcome: 'created' | 'no-op' | 'not-provable';
  readonly basis: 'instruction-variant' | 'pre-state' | 'none';
}

/**
 * Did an Associated Token Account create actually create anything?
 *
 * `Create` (non-idempotent) fails when the account already exists, so a
 * committed `Create` proves the account is new. `CreateIdempotent` is a no-op
 * when the address already is an initialised token account, which the response
 * shows directly as a pre-transaction token row. Otherwise the address must have
 * been empty for the system-level create to succeed: zero pre-transaction
 * lamports and no pre-transaction token row.
 */
function decideCreateOutcome(
  action: Extract<DecodedAction, { kind: 'associated-token-account.create' }>,
  tokenRowIndex: ReadonlyMap<string, readonly EffectsTokenRow[]>,
  lamportRows: ReadonlyMap<string, EffectsAccountRow>,
): TokenAccountCreateOutcome {
  const address = action.associatedTokenAccount;
  if (!action.idempotent) return { outcome: 'created', basis: 'instruction-variant' };
  if (address === null) return { outcome: 'not-provable', basis: 'none' };
  const rows = tokenRowIndex.get(address) ?? [];
  if (rows.some(row => row.presence !== 'only-after')) return { outcome: 'no-op', basis: 'pre-state' };
  const lamports = lamportRows.get(address);
  if (lamports?.beforeLamports === 0n && rows.length === 0) return { outcome: 'created', basis: 'pre-state' };
  return { outcome: 'not-provable', basis: 'none' };
}

function refKeyOf(ref: InstructionRef): string {
  return `${ref.path}:${ref.outerIndex ?? 'top'}:${ref.index}`;
}

function signerOf(address: string | null, signers: ReadonlyMap<string, boolean | null>): boolean | null {
  if (address === null) return null;
  return signers.get(address) ?? null;
}

/**
 * The lamport half of a wrapped-SOL transfer (see `native.ts`). Only the source
 * account's native-ness matters: the program moves `amount` lamports from the
 * source to the destination when the *source* is native.
 */
function nativeLeg(
  action: DecodedAction,
  commitState: SolFlow['commitState'],
  from: string | null,
  to: string | null,
  lamports: bigint | null,
): SolFlow {
  return {
    confidence: lamports === null ? 'reconciled' : 'proven',
    commitState,
    ref: action.ref,
    actionKind: action.kind,
    kind: 'native-token-leg',
    from,
    to,
    lamports,
    amountSource: lamports === null ? 'not-observable' : 'instruction-data',
  };
}

/** Warns when a checked instruction's mint disagrees with the accounts' own mint. */
function checkMintAgainstMetadata(
  ref: InstructionRef,
  mint: string | null,
  source: TokenAccountFacts | null,
  destination: TokenAccountFacts | null,
  diagnostics: EffectsDiagnostic[],
): void {
  if (mint === null) return;
  for (const [label, account] of [
    ['source', source],
    ['destination', destination],
  ] as const) {
    if (account?.mint !== null && account?.mint !== undefined && account.mint !== mint) {
      diagnostics.push({
        level: 'warning',
        code: 'effects-mint-disagrees-with-metadata',
        message:
          `[${refLabel(ref)}] states mint ${mint}, but the ${label} token account reports mint ${account.mint}. ` +
          'The instruction is reported (it is what executed); the disagreement is a data contradiction worth checking.',
        ref: ref,
      });
    }
  }
}

/** `mint_to` and `burn` reject native accounts in the token program (`NativeNotSupported`). */
function checkNativeMintOrBurn(
  kind: ActionKind,
  ref: InstructionRef,
  mint: string | null,
  account: TokenAccountFacts | null,
  diagnostics: EffectsDiagnostic[],
): void {
  const candidate = mint ?? account?.mint ?? null;
  if (candidate !== NATIVE_MINT) return;
  diagnostics.push({
    level: 'warning',
    code: 'effects-native-mint-or-burn',
    message:
      `${kind} [${refLabel(ref)}] targets a wrapped-SOL account, which the token program rejects (NativeNotSupported). ` +
      'The action is reported as decoded; a committed transaction contradicting this would mean the decode or the metadata is wrong.',
    ref,
  });
}

