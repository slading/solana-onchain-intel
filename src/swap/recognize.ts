/**
 * Milestone 4.1: recognizing a Meteora DLMM `swap2`.
 *
 * The algorithm, in order, and nothing else:
 *
 *   1. scan every instruction (top-level and CPI) for the DLMM program id;
 *   2. read its discriminator and require exactly `414b3f4ceb5b5b88`;
 *   3. parse the arguments with **exact** byte consumption (`./dlmm.ts`);
 *   4. map the 16 named account roles in the IDL's declared order;
 *   5. take the instruction's own **CPI subtree** — the contiguous run of
 *      following instructions in the same inner group whose CPI depth is strictly
 *      greater, i.e. the frames it executed;
 *   6. inside that subtree, find the token transfer that leaves `user_token_in`
 *      and the one that arrives at `user_token_out`;
 *   7. prove them: the mints must agree with the named roles, each transfer's
 *      counterparty must be the corresponding pool vault, `amount_in` must equal
 *      the input transfer, and the M3 effects model must contain the same
 *      movement with an instruction-stated amount;
 *   8. report one `DlmmSwapLeg` per recognized instruction, with every check and
 *      every conflict, or say why nothing was recognized.
 *
 * What this deliberately does not do: read the swap *event* (optional, and a leg
 * must be provable without it), read the logs (never a source of truth), read
 * balances to decide *that* a swap happened (only M3 may size things, and only to
 * cross-check), or look at the Jupiter route that caused the CPI (out of scope
 * for 4.1; not needed, since the DLMM instruction is self-describing).
 *
 * Inputs are the canonical normalized transaction (M1) and, optionally, the
 * effects model (M3). The raw RPC payload is never consulted — the purity test
 * proves it — and no field is added to any M1–M3 type.
 */

import { refLabel, type ActionKind, type DecodedAction, type InstructionRef } from '../decode/actions.ts';
import { decodeBase58Data, takeAccountRoles, type Bytes } from '../decode/bytes.ts';
import type { NormalizedInstruction, NormalizedTransaction } from '../model/transaction.ts';
import type { TokenFlow, TransactionEffects } from '../effects/model.ts';
import {
  DLMM_PROGRAM_ID,
  DLMM_SWAP2_ACCOUNT_ROLES,
  DLMM_SWAP2_DISCRIMINATOR,
  instructionDiscriminator,
  parseDlmmSwap2Args,
  type DlmmSwap2Role,
} from './dlmm.ts';
import type {
  DlmmCheckOutcome,
  DlmmCommitState,
  DlmmOwnerEvidence,
  DlmmSwapCheck,
  DlmmSwapDiagnostic,
  DlmmSwapLeg,
  DlmmSwapRoles,
  DlmmSwapSide,
  DlmmSwapState,
  TransactionSwaps,
} from './model.ts';

export interface RecognizeSwapOptions {
  /**
   * The Milestone 3 effects model for the same transaction.
   *
   * When supplied, every attributed transfer is required to appear in it with an
   * instruction-stated amount; when omitted, those checks are `not-checkable` and
   * no leg can be `proven`.
   */
  readonly effects?: TransactionEffects | null;
}

const UNKNOWN = 'unknown';

/* --------------------------------------------------------------- instructions */

function refOf(instruction: NormalizedInstruction): InstructionRef {
  return {
    path: instruction.outerIndex === null ? 'top-level' : 'inner',
    index: instruction.index,
    outerIndex: instruction.outerIndex,
    stackHeight: instruction.stackHeight,
  };
}

/** Stable key for matching a decoded action back to its instruction. */
function refKey(ref: InstructionRef): string {
  return `${ref.path}:${ref.outerIndex ?? '-'}:${ref.index}`;
}

function allInstructions(transaction: NormalizedTransaction): readonly NormalizedInstruction[] {
  const out: NormalizedInstruction[] = [];
  for (const instruction of transaction.instructions) out.push(instruction);
  for (const group of transaction.innerInstructionGroups) {
    for (const instruction of group.instructions) out.push(instruction);
  }
  return out;
}

/**
 * The frames an instruction executed: the contiguous run of following
 * instructions in the same inner group with a strictly greater CPI depth.
 *
 * The RPC reports inner instructions in execution order, and a frame's
 * descendants always immediately follow it and run deeper, so the run ends
 * exactly where the instruction returned. A top-level instruction behaves the
 * same way with its whole group as the candidate list. Returns `ok: false` when
 * the group or the depths needed for the claim are missing.
 */
function cpiSubtree(
  transaction: NormalizedTransaction,
  instruction: NormalizedInstruction,
): { readonly ok: boolean; readonly detail: string; readonly instructions: readonly NormalizedInstruction[] } {
  const depth = instruction.stackHeight ?? (instruction.outerIndex === null ? 1 : null);
  if (depth === null) {
    return { ok: false, detail: 'the RPC did not report a CPI depth for this instruction', instructions: [] };
  }

  let candidates: readonly NormalizedInstruction[];
  let start: number;
  if (instruction.outerIndex === null) {
    const group = transaction.innerInstructionGroups.find(entry => entry.outerIndex === instruction.index);
    if (group === undefined) {
      return { ok: false, detail: 'the RPC recorded no inner instructions for this transaction', instructions: [] };
    }
    candidates = group.instructions;
    start = -1;
  } else {
    const group = transaction.innerInstructionGroups.find(
      entry => entry.outerIndex === instruction.outerIndex,
    );
    if (group === undefined) {
      return { ok: false, detail: 'the RPC recorded no inner instructions for this transaction', instructions: [] };
    }
    candidates = group.instructions;
    const found = group.instructions.findIndex(entry => entry.index === instruction.index);
    if (found < 0) {
      return { ok: false, detail: 'the instruction is not part of the inner group it claims', instructions: [] };
    }
    start = found;
  }

  const subtree: NormalizedInstruction[] = [];
  for (let position = start + 1; position < candidates.length; position += 1) {
    const sibling = candidates[position];
    if (sibling === undefined) break;
    if (sibling.stackHeight === null || sibling.stackHeight <= depth) break;
    subtree.push(sibling);
  }
  return {
    ok: true,
    detail: `${subtree.length} CPI instruction(s) at depth > ${depth}`,
    instructions: subtree,
  };
}

/* -------------------------------------------------------------------- actions */

interface TransferLeg {
  readonly ref: InstructionRef;
  readonly kind: ActionKind;
  readonly source: string | null;
  readonly destination: string | null;
  readonly mint: string | null;
  readonly amount: bigint | null;
  readonly authority: string | null;
}

/**
 * The transfer a decoded action represents, or `null` for anything that is not a
 * token movement. Both `transfer` and `transferChecked` are accepted, because a
 * `transferChecked` carries the mint while a plain `transfer` does not — and the
 * mint is needed, so a plain transfer can only ever be a *partially* proven side.
 */
function transferLeg(action: DecodedAction): TransferLeg | null {
  switch (action.kind) {
    case 'spl-token.transfer':
      return {
        ref: action.ref,
        kind: action.kind,
        source: action.source,
        destination: action.destination,
        mint: null,
        amount: action.amount,
        authority: action.authority,
      };
    case 'spl-token.transferChecked':
      return {
        ref: action.ref,
        kind: action.kind,
        source: action.source,
        destination: action.destination,
        mint: action.mint,
        amount: action.amount,
        authority: action.authority,
      };
    default:
      return null;
  }
}

/* ---------------------------------------------------------------- checks ---- */

function check(id: string, outcome: DlmmCheckOutcome, detail: string, required = true): DlmmSwapCheck {
  return { id, required, outcome, detail };
}

const pass = (id: string, detail: string, required = true): DlmmSwapCheck =>
  check(id, 'pass', detail, required);
const fail = (id: string, detail: string, required = true): DlmmSwapCheck =>
  check(id, 'fail', detail, required);
const unchecked = (id: string, detail: string, required = true): DlmmSwapCheck =>
  check(id, 'not-checkable', detail, required);

/* ---------------------------------------------------------------- the layer - */

function commitStateOf(status: NormalizedTransaction['status']): DlmmCommitState {
  return status === 'success' ? 'committed' : status === 'failed' ? 'reverted' : 'unknown';
}

interface OwnerFact {
  readonly owner: string;
  readonly evidence: DlmmOwnerEvidence;
}

/**
 * Who owns each token account, from evidence only.
 *
 * Primary source: the RPC's own token balance rows (`account-metadata`). Fallback:
 * an Associated Token Account `create` action in this transaction that names the
 * account — the ATA program proves the mint and owner it creates, and without this
 * an account created *and* closed inside one transaction (as the fixture's wrapped
 * SOL account is) would have no owner at all, since the RPC reports no row for it.
 * Nothing is ever derived from an authority field.
 */
function tokenAccountOwners(transaction: NormalizedTransaction): ReadonlyMap<string, OwnerFact> {
  const owners = new Map<string, OwnerFact>();
  for (const action of transaction.decoded.actions) {
    if (action.kind !== 'associated-token-account.create') continue;
    if (action.associatedTokenAccount === null || action.wallet === null) continue;
    if (!owners.has(action.associatedTokenAccount)) {
      owners.set(action.associatedTokenAccount, {
        owner: action.wallet,
        evidence: 'ata-create-instruction',
      });
    }
  }
  for (const change of transaction.tokenBalanceChanges) {
    if (change.address === null || change.owner === null) continue;
    // Row evidence wins: it is the account's own reported metadata.
    owners.set(change.address, { owner: change.owner, evidence: 'account-metadata' });
  }
  return owners;
}

export function recognizeDlmmSwaps(
  transaction: NormalizedTransaction,
  options: RecognizeSwapOptions = {},
): TransactionSwaps {
  const effects = options.effects ?? null;
  const commitState = commitStateOf(transaction.status);
  const owners = tokenAccountOwners(transaction);

  const actionsByRef = new Map<string, DecodedAction[]>();
  for (const action of transaction.decoded.actions) {
    const key = refKey(action.ref);
    const bucket = actionsByRef.get(key);
    if (bucket === undefined) actionsByRef.set(key, [action]);
    else bucket.push(action);
  }

  const legs: DlmmSwapLeg[] = [];
  const diagnostics: DlmmSwapDiagnostic[] = [];

  for (const instruction of allInstructions(transaction)) {
    if (instruction.programId !== DLMM_PROGRAM_ID) continue;

    const ref = refOf(instruction);
    const bytes: Bytes | null = instruction.data === null ? null : decodeBase58Data(instruction.data);
    if (bytes === null) {
      diagnostics.push({
        level: 'warning',
        code: 'dlmm-instruction-data-unreadable',
        message: `${refLabel(ref)} is a Meteora DLMM instruction but its data is missing or not valid base58; nothing is claimed about it.`,
        ref,
      });
      continue;
    }
    const discriminator = instructionDiscriminator(bytes);
    if (discriminator !== DLMM_SWAP2_DISCRIMINATOR) {
      // Another DLMM instruction: out of scope for Milestone 4.1, and silently so —
      // recognizing it is not this layer's job yet.
      continue;
    }

    const argParse = parseDlmmSwap2Args(bytes);
    if (!argParse.ok) {
      diagnostics.push({
        level: 'warning',
        code: 'dlmm-swap2-args-not-recognized',
        message:
          `${refLabel(ref)} has the DLMM swap2 discriminator but its arguments do not parse exactly ` +
          `(${argParse.detail}); it is left unrecognized rather than partially read.`,
        ref,
      });
      continue;
    }

    legs.push(
      recognizeSwap2({ transaction, instruction, ref, args: argParse.args, commitState, owners, effects, actionsByRef }),
    );
  }

  if (!transaction.innerInstructionsAvailable) {
    diagnostics.push({
      level: 'warning',
      code: 'swap-inner-instructions-unavailable',
      message:
        'This node did not record CPI instructions, so an AMM swap executed inside a CPI cannot be seen at ' +
        'all: absence of a recognized swap here is not evidence that none happened.',
      ref: null,
    });
  }

  if (effects === null && legs.length > 0) {
    diagnostics.push({
      level: 'info',
      code: 'swap-effects-model-absent',
      message:
        'No effects model was supplied, so the recognized DLMM swap legs could not be reconciled against ' +
        'the Milestone 3 effects; those checks are not-checkable and the legs cannot be proven.',
      ref: null,
    });
  }

  const counts = {
    recognized: legs.length,
    proven: legs.filter(leg => leg.state === 'proven').length,
    partiallyProven: legs.filter(leg => leg.state === 'partially-proven').length,
    notCommitted: legs.filter(leg => leg.state === 'not-committed').length,
    conflicting: legs.filter(leg => leg.state === 'conflicting').length,
  };

  return { legs, diagnostics, counts };
}

/* ------------------------------------------------------------- one instruction */

interface RecognizeSwap2Input {
  readonly transaction: NormalizedTransaction;
  readonly instruction: NormalizedInstruction;
  readonly ref: InstructionRef;
  readonly args: { readonly amountIn: bigint; readonly minAmountOut: bigint; readonly hookSliceCount: number };
  readonly commitState: DlmmCommitState;
  readonly owners: ReadonlyMap<string, OwnerFact>;
  readonly effects: TransactionEffects | null;
  readonly actionsByRef: ReadonlyMap<string, DecodedAction[]>;
}

function recognizeSwap2(context: RecognizeSwap2Input): DlmmSwapLeg {
  const { transaction, instruction, ref, args, commitState, owners, effects, actionsByRef } = context;
  const checks: DlmmSwapCheck[] = [];
  const legDiagnostics: DlmmSwapDiagnostic[] = [];
  const unknowns: string[] = [];

  /* 1–2: program id and discriminator (the caller matched both to get here). */
  checks.push(pass('dlmm-program-id', `program is ${DLMM_PROGRAM_ID}`));
  checks.push(pass('swap2-discriminator', `8-byte discriminator ${DLMM_SWAP2_DISCRIMINATOR} (IDL: swap2)`));

  /* 3: exact byte consumption. */
  checks.push(
    pass(
      'args-decode-exact',
      `amount_in=${args.amountIn}, min_amount_out=${args.minAmountOut}, ` +
        `${args.hookSliceCount} remaining-accounts slice(s); ${instruction.data === null ? 0 : instruction.data.length} base58 char(s) consumed exactly`,
    ),
  );

  /* 4: named account roles, in IDL order. */
  const accounts = instruction.accounts;
  const roleNotes: string[] = [];
  const roles: Record<DlmmSwap2Role, string | null> =
    accounts === null
      ? (Object.fromEntries(DLMM_SWAP2_ACCOUNT_ROLES.map(role => [role, null])) as Record<
          DlmmSwap2Role,
          string | null
        >)
      : takeAccountRoles(accounts, DLMM_SWAP2_ACCOUNT_ROLES, roleNotes);
  const hasNamedAccounts = accounts !== null && accounts.length >= DLMM_SWAP2_ACCOUNT_ROLES.length;
  checks.push(
    hasNamedAccounts
      ? pass(
          'named-accounts-present',
          `${accounts.length} account(s) for ${DLMM_SWAP2_ACCOUNT_ROLES.length} named roles + ` +
            `${accounts.length - DLMM_SWAP2_ACCOUNT_ROLES.length} remaining (bin arrays)`,
        )
      : fail(
          'named-accounts-present',
          accounts === null
            ? 'the RPC reported no account list for this instruction'
            : `${accounts.length} account(s) but the IDL declares ${DLMM_SWAP2_ACCOUNT_ROLES.length} named roles`,
        ),
  );

  const swapRoles: DlmmSwapRoles = {
    pool: roles.lb_pair,
    reserveX: roles.reserve_x,
    reserveY: roles.reserve_y,
    tokenXMint: roles.token_x_mint,
    tokenYMint: roles.token_y_mint,
    tailAccountCount: accounts === null ? 0 : Math.max(0, accounts.length - DLMM_SWAP2_ACCOUNT_ROLES.length),
    hookSliceCount: args.hookSliceCount,
  };
  if (args.hookSliceCount > 0) {
    unknowns.push('remaining-accounts-slices-not-interpreted');
  }

  /* 5: the instruction's own CPI subtree. */
  const subtree = cpiSubtree(transaction, instruction);
  checks.push(
    subtree.ok
      ? pass('cpi-subtree-available', subtree.detail)
      : unchecked('cpi-subtree-available', subtree.detail),
  );

  const inCandidates: TransferLeg[] = [];
  const outCandidates: TransferLeg[] = [];
  if (subtree.ok) {
    for (const sibling of subtree.instructions) {
      const actions = actionsByRef.get(refKey(refOf(sibling))) ?? [];
      for (const action of actions) {
        const leg = transferLeg(action);
        if (leg === null) continue;
        if (roles.user_token_in !== null && leg.source === roles.user_token_in) inCandidates.push(leg);
        if (roles.user_token_out !== null && leg.destination === roles.user_token_out) outCandidates.push(leg);
      }
    }
  }

  const inLeg = inCandidates.length === 1 ? inCandidates[0] ?? null : null;
  const outLeg = outCandidates.length === 1 ? outCandidates[0] ?? null : null;

  checks.push(
    inLeg !== null
      ? pass(
          'input-transfer-found',
          `${inLeg.kind} ${inLeg.amount ?? UNKNOWN} raw units out of user_token_in (${roles.user_token_in ?? UNKNOWN}) at ${refLabel(inLeg.ref)}`,
        )
      : fail(
          'input-transfer-found',
          inCandidates.length === 0
            ? `no token transfer from user_token_in (${roles.user_token_in ?? UNKNOWN}) inside the instruction's CPI subtree`
            : `${inCandidates.length} candidate transfers from user_token_in: ${inCandidates
                .map(leg => refLabel(leg.ref))
                .join(', ')} — ambiguous, so none is used`,
        ),
  );
  checks.push(
    outLeg !== null
      ? pass(
          'output-transfer-found',
          `${outLeg.kind} ${outLeg.amount ?? UNKNOWN} raw units into user_token_out (${roles.user_token_out ?? UNKNOWN}) at ${refLabel(outLeg.ref)}`,
        )
      : fail(
          'output-transfer-found',
          outCandidates.length === 0
            ? `no token transfer into user_token_out (${roles.user_token_out ?? UNKNOWN}) inside the instruction's CPI subtree`
            : `${outCandidates.length} candidate transfers into user_token_out: ${outCandidates
                .map(leg => refLabel(leg.ref))
                .join(', ')} — ambiguous, so none is used`,
        ),
  );

  /* 6–7: prove the sides against the named roles. */
  const inSide = sideFrom(inLeg, roles.user_token_in, swapRoles.reserveX, swapRoles.reserveY, owners);
  const outSide = sideFrom(outLeg, roles.user_token_out, swapRoles.reserveX, swapRoles.reserveY, owners);
  const input = inSide.side;
  const output = outSide.side;

  checks.push(
    input.mint === null
      ? unchecked(
          'input-mint-matches-named-role',
          `the input mint could not be established, so it cannot be compared with token_x_mint (${swapRoles.tokenXMint ?? UNKNOWN}) / token_y_mint (${swapRoles.tokenYMint ?? UNKNOWN})`,
        )
      : mintMatchesRole(input.mint, swapRoles.tokenXMint, swapRoles.tokenYMint)
        ? pass(
            'input-mint-matches-named-role',
            `input mint ${input.mint} is a named pool mint (x ${swapRoles.tokenXMint ?? UNKNOWN} / y ${swapRoles.tokenYMint ?? UNKNOWN})`,
          )
        : fail(
            'input-mint-matches-named-role',
            `input mint ${input.mint} is neither token_x_mint (${swapRoles.tokenXMint ?? UNKNOWN}) nor token_y_mint (${swapRoles.tokenYMint ?? UNKNOWN})`,
          ),
  );
  checks.push(
    output.mint === null
      ? unchecked(
          'output-mint-matches-named-role',
          `the output mint could not be established (the transfer at out-side is ${outLeg === null ? 'missing' : outLeg.kind}), so it cannot be compared with the input's`,
        )
      : input.mint === null
        ? unchecked(
            'output-mint-matches-named-role',
            'the input mint could not be established, so "the pool mint opposite the input" is undefined',
          )
        : mintMatchesRole(output.mint, swapRoles.tokenXMint, swapRoles.tokenYMint) &&
            input.mint !== output.mint
          ? pass(
              'output-mint-matches-named-role',
              `output mint ${output.mint} is the other named pool mint`,
            )
          : fail(
              'output-mint-matches-named-role',
              `output mint ${output.mint} is not the pool mint opposite the input mint ${input.mint}`,
            ),
  );

  const xToY: boolean | null =
    input.mint === null
      ? null
      : input.mint === swapRoles.tokenXMint
        ? true
        : input.mint === swapRoles.tokenYMint
          ? false
          : null;
  checks.push(
    xToY === null
      ? unchecked('direction-established', 'the input mint could not be matched to token_x_mint or token_y_mint')
      : pass('direction-established', `input is the pool's token ${xToY ? 'X' : 'Y'} (swap_for_y=${xToY})`),
  );

  // Which vault each side must touch follows from the direction: a swap X -> Y is
  // paid into reserve_x and paid out of reserve_y. When the direction cannot be
  // established, membership in the role pair is all that can be checked.
  const expectedInputVault = xToY === null ? null : xToY ? swapRoles.reserveX : swapRoles.reserveY;
  const expectedOutputVault = xToY === null ? null : xToY ? swapRoles.reserveY : swapRoles.reserveX;
  const inputCounterparty = counterpartyOf(inLeg, roles.user_token_in);
  const outputCounterparty = counterpartyOf(outLeg, roles.user_token_out);
  checks.push(
    inLeg === null
      ? unchecked(
          'input-reserve-is-pool-vault',
          'no input transfer was attributed, so its counterparty could not be compared with reserve_x / reserve_y',
        )
      : inSide.reserveSide !== null && (expectedInputVault === null || inSide.reserveSide.actual === expectedInputVault)
        ? pass(
            'input-reserve-is-pool-vault',
            `the input transfer's counterparty ${inSide.reserveSide.actual ?? UNKNOWN} is ${inSide.reserveSide.role} (${inSide.reserveSide.expected ?? UNKNOWN})`,
          )
        : fail(
            'input-reserve-is-pool-vault',
            inSide.reserveSide === null
              ? `the input transfer's counterparty ${inputCounterparty ?? UNKNOWN} is neither reserve_x (${swapRoles.reserveX ?? UNKNOWN}) nor reserve_y (${swapRoles.reserveY ?? UNKNOWN})`
              : `the input transfer's counterparty ${inputCounterparty ?? UNKNOWN} is ${inSide.reserveSide.role}, but the established direction (${xToY ? 'token X in' : 'token Y in'}) requires ${expectedInputVault ?? UNKNOWN}`,
          ),
  );
  checks.push(
    outLeg === null
      ? unchecked(
          'output-reserve-is-pool-vault',
          'no output transfer was attributed, so its source could not be compared with reserve_x / reserve_y',
        )
      : outSide.reserveSide !== null &&
          (expectedOutputVault === null || outSide.reserveSide.actual === expectedOutputVault)
        ? pass(
            'output-reserve-is-pool-vault',
            `the output transfer's source ${outSide.reserveSide.actual ?? UNKNOWN} is ${outSide.reserveSide.role} (${outSide.reserveSide.expected ?? UNKNOWN})`,
          )
        : fail(
            'output-reserve-is-pool-vault',
            outSide.reserveSide === null
              ? `the output transfer's source ${outputCounterparty ?? UNKNOWN} is neither reserve_x (${swapRoles.reserveX ?? UNKNOWN}) nor reserve_y (${swapRoles.reserveY ?? UNKNOWN})`
              : `the output transfer's source ${outputCounterparty ?? UNKNOWN} is ${outSide.reserveSide.role}, but the established direction (${xToY ? 'token Y out' : 'token X out'}) requires ${expectedOutputVault ?? UNKNOWN}`,
          ),
  );

  /* 8: the arguments against the transfers. */
  checks.push(
    input.amount !== null && input.amount === args.amountIn
      ? pass(
          'input-amount-matches-amount-in',
          `the ${inLeg === null ? 'transfer' : inLeg.kind} moves exactly amount_in (${args.amountIn} raw units)`,
        )
      : input.amount === null
        ? unchecked(
            'input-amount-matches-amount-in',
            `amount_in is ${args.amountIn} but the input transfer's amount is not observable`,
          )
        : fail(
            'input-amount-matches-amount-in',
            `instruction amount_in ${args.amountIn} does not equal the input transfer amount ${input.amount} at ${inLeg === null ? UNKNOWN : refLabel(inLeg.ref)}`,
          ),
  );

  /* 9–10: the floor, honestly. */
  const floorStated = args.minAmountOut > 0n;
  checks.push(
    floorStated
      ? pass('min-amount-out-stated', `min_amount_out=${args.minAmountOut}`, false)
      : unchecked(
          'min-amount-out-stated',
          'min_amount_out is 0: this instruction states no floor, so the output cannot be tested against one (this is not a satisfied floor)',
          false,
        ),
  );
  if (!floorStated) unknowns.push('min-amount-out-not-stated');
  checks.push(
    !floorStated
      ? unchecked(
          'min-amount-out-satisfied',
          'min_amount_out is 0 — no floor is stated, so this condition does not exist for this instruction (never reported as passed)',
          false,
        )
      : output.amount === null
        ? unchecked(
            'min-amount-out-satisfied',
            `min_amount_out is ${args.minAmountOut} but the output amount is not observable`,
          )
        : output.amount >= args.minAmountOut
          ? pass(
              'min-amount-out-satisfied',
              `output ${output.amount} satisfies min_amount_out ${args.minAmountOut}`,
            )
          : fail(
              'min-amount-out-satisfied',
              `output ${output.amount} is below min_amount_out ${args.minAmountOut}`,
            ),
  );

  /* Informational: who authorized the input side. */
  checks.push(
    inLeg === null
      ? unchecked('input-leg-authority-is-account-owner', 'no input transfer was attributed', false)
      : input.owner === null
        ? unchecked(
            'input-leg-authority-is-account-owner',
            `no token balance row reports the owner of ${input.tokenAccount ?? UNKNOWN}`,
            false,
          )
        : inLeg.authority === input.owner
          ? pass(
              'input-leg-authority-is-account-owner',
              `the input transfer was authorized by ${inLeg.authority}, the account's reported owner`,
              false,
            )
          : fail(
              'input-leg-authority-is-account-owner',
              `the input transfer was authorized by ${inLeg.authority ?? UNKNOWN} but ${input.tokenAccount ?? UNKNOWN} reports owner ${input.owner}`,
              false,
            ),
  );

  /* 11: reconcile both transfers with the Milestone 3 effects model. */
  checks.push(reconcileWithEffects('input-reconciles-with-effects', inLeg, inSide, commitState, effects));
  checks.push(reconcileWithEffects('output-reconciles-with-effects', outLeg, outSide, commitState, effects));
  if (effects === null) unknowns.push('effects-model-absent');

  /* 12: commitment. */
  checks.push(
    commitState === 'committed'
      ? pass('transaction-committed', 'the transaction succeeded, so the instruction committed')
      : unchecked(
          'transaction-committed',
          commitState === 'reverted'
            ? 'the transaction failed: Solana rolls every state change back, so this leg is not committed state'
            : 'the response carries no meta, so commitment is unknown',
        ),
  );

  const conflicts = checks.filter(entry => entry.outcome === 'fail').map(entry => entry.id);
  const state = resolveState(commitState, checks, conflicts);

  if (state === 'conflicting') {
    legDiagnostics.push({
      level: 'warning',
      code: 'dlmm-swap2-conflicting',
      message: `${refLabel(ref)} is a recognized swap2 but two pieces of evidence disagree (${conflicts.join(', ')}); both values are reported and nothing is guessed.`,
      ref,
    });
  }
  if (state === 'not-committed') {
    legDiagnostics.push({
      level: 'warning',
      code: 'dlmm-swap2-not-committed',
      message: `${refLabel(ref)} is a recognized swap2 but the transaction did not commit; the amounts described are attempted movement, not state.`,
      ref,
    });
  }
  for (const note of roleNotes) {
    legDiagnostics.push({
      level: 'warning',
      code: 'dlmm-swap2-named-accounts-incomplete',
      message: `${refLabel(ref)}: ${note}`,
      ref,
    });
  }

  return {
    protocol: 'meteora-dlmm',
    programId: DLMM_PROGRAM_ID,
    instructionName: 'swap2',
    ref,
    commitState,
    state,
    input: inSide.side,
    output: outSide.side,
    amountIn: args.amountIn,
    minAmountOut: args.minAmountOut,
    xToY,
    roles: swapRoles,
    checks,
    conflicts,
    unknowns,
    diagnostics: legDiagnostics,
  };
}

/* --------------------------------------------------------------- side helpers */

interface SidedSide {
  readonly side: DlmmSwapSide;
  readonly reserveSide: { readonly actual: string | null; readonly expected: string | null; readonly role: string } | null;
}

/** `token_x_mint` / `token_y_mint` membership, used for both sides. */
function mintMatchesRole(mint: string | null, tokenXMint: string | null, tokenYMint: string | null): boolean {
  if (mint === null) return false;
  return mint === tokenXMint || mint === tokenYMint;
}

/**
 * Turns an attributed transfer into a side, including which pool vault it must
 * have touched. The vault is checked as an identity, never guessed: an input
 * transfer must *arrive at* one of the two reserves, an output transfer must
 * *leave* one of them.
 */
function sideFrom(
  leg: TransferLeg | null,
  tokenAccount: string | null,
  reserveX: string | null,
  reserveY: string | null,
  owners: ReadonlyMap<string, OwnerFact>,
): SidedSide {
  if (leg === null) {
    const fact = tokenAccount === null ? undefined : owners.get(tokenAccount);
    return {
      side: {
        tokenAccount,
        owner: fact?.owner ?? null,
        ownerEvidence: fact?.evidence ?? 'none',
        mint: null,
        amount: null,
        amountEvidence: 'not-observable',
        legRef: null,
        legKind: null,
      },
      reserveSide: null,
    };
  }
  const counterparty = leg.destination === tokenAccount ? leg.source : leg.destination;
  const reserveSide =
    counterparty === null
      ? null
      : counterparty === reserveX
        ? { actual: counterparty, expected: reserveX, role: 'reserve_x' }
        : counterparty === reserveY
          ? { actual: counterparty, expected: reserveY, role: 'reserve_y' }
          : null;
  const fact = tokenAccount === null ? undefined : owners.get(tokenAccount);
  return {
    side: {
      tokenAccount,
      owner: fact?.owner ?? null,
      ownerEvidence: fact?.evidence ?? 'none',
      mint: leg.mint,
      amount: leg.amount,
      amountEvidence: leg.amount === null ? 'not-observable' : 'transfer-leg',
      legRef: leg.ref,
      legKind: leg.kind,
    },
    reserveSide,
  };
}

/** The pool-side account a transfer touched: the endpoint that is not the user's. */
function counterpartyOf(leg: TransferLeg | null, tokenAccount: string | null): string | null {
  if (leg === null) return null;
  return leg.destination === tokenAccount ? leg.source : leg.destination;
}

/**
 * The effects-model cross-check for one attributed transfer.
 *
 * Requirement: the effects layer must contain *this* instruction's movement —
 * same ref, endpoints, mint and amount, with `amountSource: 'instruction-data'`
 * and a committed state. A mismatch is a conflict, not something to average out;
 * a missing effects model is `not-checkable`, which is why no leg is `proven`
 * without one.
 */
function reconcileWithEffects(
  id: string,
  leg: TransferLeg | null,
  side: SidedSide,
  commitState: DlmmCommitState,
  effects: TransactionEffects | null,
): DlmmSwapCheck {
  if (leg === null) return unchecked(id, 'no transfer was attributed to this side');
  if (effects === null) {
    return unchecked(id, `no effects model was supplied, so ${refLabel(leg.ref)} could not be reconciled`);
  }

  const flows: readonly TokenFlow[] = [...effects.tokenFlows, ...effects.uncommittedTokenFlows];
  const candidates = flows.filter(flow => flow.ref !== null && refKey(flow.ref) === refKey(leg.ref));
  if (candidates.length === 0) {
    return fail(
      id,
      `the effects model has no token flow for ${refLabel(leg.ref)} (${leg.source ?? UNKNOWN} -> ${leg.destination ?? UNKNOWN})`,
    );
  }

  const flow = candidates.find(
    entry =>
      entry.sourceTokenAccount === leg.source &&
      entry.destinationTokenAccount === leg.destination &&
      entry.mint === (leg.mint ?? entry.mint) &&
      entry.amount === leg.amount,
  );
  if (flow === undefined) {
    const described = candidates
      .map(
        entry =>
          `${entry.sourceTokenAccount ?? UNKNOWN} -> ${entry.destinationTokenAccount ?? UNKNOWN} ` +
          `${entry.amount === null ? 'amount not observable' : entry.amount} (${entry.amountSource})`,
      )
      .join('; ');
    return fail(
      id,
      `the effects model's flow for ${refLabel(leg.ref)} does not match the transfer: ` +
        `expected ${leg.source ?? UNKNOWN} -> ${leg.destination ?? UNKNOWN} ${leg.amount ?? UNKNOWN}, found ${described}`,
    );
  }
  if (flow.commitState !== 'committed') {
    return unchecked(
      id,
      `${refLabel(leg.ref)} is recorded as ${flow.commitState} in the effects model (the transaction did not commit)`,
    );
  }
  if (flow.amountSource !== 'instruction-data') {
    return unchecked(
      id,
      `${refLabel(leg.ref)} is sized by ${flow.amountSource} in the effects model, not stated by instruction data`,
    );
  }
  if (flow.mint === null && side.side.mint !== null) {
    return unchecked(
      id,
      `${refLabel(leg.ref)} carries no mint evidence in the effects model (a plain transfer does not state one)`,
    );
  }
  if (commitState !== 'committed') {
    return unchecked(
      id,
      `${refLabel(leg.ref)} matches the effects model, but the transaction itself did not commit`,
    );
  }
  return pass(
    id,
    `${refLabel(leg.ref)} reconciles exactly with the effects model (${flow.amountSource}, committed, mint ${flow.mint ?? UNKNOWN})`,
  );
}

/* --------------------------------------------------------------- state machine */

/**
 * `conflicting` beats everything: a disagreement must never be averaged away.
 * Then `not-committed` (a failed transaction recognizes but never asserts), then
 * any required condition that could not be evaluated ⇒ `partially-proven`, and
 * only then `proven`.
 */
function resolveState(
  commitState: DlmmCommitState,
  checks: readonly DlmmSwapCheck[],
  conflicts: readonly string[],
): DlmmSwapState {
  if (conflicts.length > 0) return 'conflicting';
  if (commitState !== 'committed') return 'not-committed';
  if (checks.some(entry => entry.required && entry.outcome === 'not-checkable')) return 'partially-proven';
  return 'proven';
}
