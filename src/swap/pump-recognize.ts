/**
 * Milestone 4.2: recognizing a pump_amm `sell`.
 *
 * The algorithm, in order, and nothing else — deliberately the same shape as the
 * 4.1 DLMM recognizer, with pump's own evidence:
 *
 *   1. scan every instruction (top-level and CPI) for the pump_amm program id;
 *   2. read its discriminator and require exactly `33e685a4017f83ad`;
 *   3. parse the arguments with **exact** byte consumption (`./pump.ts`);
 *   4. map the 21 named account roles in the IDL's declared order;
 *   5. take the instruction's own **CPI subtree** — the contiguous run of
 *      following instructions in the same inner group whose CPI depth is strictly
 *      greater, i.e. the frames it executed;
 *   6. inside that subtree, find the single transfer that leaves
 *      `user_base_token_account` and the single transfer that arrives at
 *      `user_quote_token_account`;
 *   7. prove them: the mints must agree with the named roles, the base transfer
 *      must land on `pool_base_token_account` and the quote transfer must leave
 *      `pool_quote_token_account`, `base_amount_in` must equal the base transfer,
 *      and the M3 effects model must contain the same movement with an
 *      instruction-stated amount;
 *   8. account for everything else the pool's quote vault paid, by *named slot*
 *      only, so a protocol/creator/buyback fee can never be reported as the
 *      user's output — and report one `PumpSellLeg` per recognized instruction,
 *      with every check and conflict.
 *
 * What this deliberately does not do: read the pump `SellEvent` (optional and
 * never required), read the logs (never a source of truth), decompose fees, read
 * the Jupiter route that may have caused the CPI, or decide *that* a sale happened
 * from token deltas — the instruction is the only source of the claim.
 *
 * Inputs are the canonical normalized transaction (M1) and, optionally, the
 * effects model (M3). Nothing is added to any M1–M3 type.
 */

import { refLabel, type DecodedAction, type InstructionRef } from '../decode/actions.ts';
import { decodeBase58Data, takeAccountRoles, type Bytes } from '../decode/bytes.ts';
import type { NormalizedInstruction, NormalizedTransaction } from '../model/transaction.ts';
import type { TransactionEffects } from '../effects/model.ts';
import type { SwapCheck, SwapDiagnostic, SwapState, SwapSide } from './model.ts';
import type { PumpFeeTransferRole, PumpSellFeeTransfer, PumpSellLeg, PumpSellRoles } from './model.ts';
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SELL_ACCOUNT_ROLES,
  PUMP_AMM_SELL_DISCRIMINATOR,
  parsePumpSellArgs,
  type PumpSellRole,
} from './pump.ts';
import { instructionDiscriminator } from './dlmm.ts';
import {
  allInstructions,
  commitStateOf,
  cpiSubtree,
  fail,
  pass,
  reconcileWithEffects,
  refKey,
  refOf,
  resolveState,
  tokenAccountOwners,
  transferLeg,
  unchecked,
  type OwnerFact,
  type TransferLeg,
} from './recognize.ts';

export interface RecognizePumpOptions {
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

/* --------------------------------------------------------------- role access */

function rolesFrom(
  accounts: readonly string[] | null,
  notes: string[],
): Record<PumpSellRole, string | null> {
  return accounts === null
    ? (Object.fromEntries(PUMP_AMM_SELL_ACCOUNT_ROLES.map(role => [role, null])) as Record<
        PumpSellRole,
        string | null
      >)
    : takeAccountRoles(accounts, PUMP_AMM_SELL_ACCOUNT_ROLES, notes);
}

function pumpRoles(
  roles: Record<PumpSellRole, string | null>,
  accounts: readonly string[] | null,
): PumpSellRoles {
  return {
    pool: roles.pool,
    user: roles.user,
    globalConfig: roles.global_config,
    baseMint: roles.base_mint,
    quoteMint: roles.quote_mint,
    userBaseTokenAccount: roles.user_base_token_account,
    userQuoteTokenAccount: roles.user_quote_token_account,
    poolBaseTokenAccount: roles.pool_base_token_account,
    poolQuoteTokenAccount: roles.pool_quote_token_account,
    protocolFeeRecipientTokenAccount: roles.protocol_fee_recipient_token_account,
    coinCreatorVaultAta: roles.coin_creator_vault_ata,
    tailAccountCount: accounts === null ? 0 : Math.max(0, accounts.length - PUMP_AMM_SELL_ACCOUNT_ROLES.length),
  };
}

/** The IDL name of a fee destination, or `other` when no named slot matches. */
function feeRoleOf(destination: string | null, roles: PumpSellRoles): PumpFeeTransferRole {
  if (destination !== null && destination === roles.protocolFeeRecipientTokenAccount) {
    return 'protocol-fee-recipient';
  }
  if (destination !== null && destination === roles.coinCreatorVaultAta) {
    return 'coin-creator-vault';
  }
  return 'other';
}

/* ------------------------------------------------------------ one instruction */

interface RecognizePumpSellInput {
  readonly transaction: NormalizedTransaction;
  readonly instruction: NormalizedInstruction;
  readonly ref: InstructionRef;
  readonly baseAmountIn: bigint;
  readonly minQuoteAmountOut: bigint;
  readonly commitState: ReturnType<typeof commitStateOf>;
  readonly owners: ReadonlyMap<string, OwnerFact>;
  readonly effects: TransactionEffects | null;
  readonly actionsByRef: ReadonlyMap<string, DecodedAction[]>;
}

function recognizeSell(input: RecognizePumpSellInput): PumpSellLeg {
  const { transaction, instruction, ref, baseAmountIn, minQuoteAmountOut, commitState, owners, effects } = input;
  const accounts = instruction.accounts;
  const roleNotes: string[] = [];
  const roleMap = rolesFrom(accounts, roleNotes);
  const roles = pumpRoles(roleMap, accounts);
  const checks: SwapCheck[] = [];
  const unknowns: string[] = [];
  const legDiagnostics: SwapDiagnostic[] = [];

  checks.push(pass('pump-program-id', `program is ${PUMP_AMM_PROGRAM_ID}`));
  checks.push(
    pass('sell-discriminator', `8-byte discriminator ${PUMP_AMM_SELL_DISCRIMINATOR} (IDL: sell)`),
  );
  checks.push(
    pass(
      'args-decode-exact',
      `base_amount_in=${baseAmountIn}, min_quote_amount_out=${minQuoteAmountOut}; ` +
        `${instruction.data === null ? 0 : instruction.data.length} base58 char(s) consumed exactly`,
    ),
  );
  const namedCount = PUMP_AMM_SELL_ACCOUNT_ROLES.length;
  const hasNamedAccounts = accounts !== null && accounts.length >= namedCount;
  checks.push(
    hasNamedAccounts
      ? pass(
          'named-accounts-present',
          `${accounts.length} account(s) for ${namedCount} named roles + ${accounts.length - namedCount} ` +
            'remaining (tail, counted but never named)',
        )
      : fail(
          'named-accounts-present',
          accounts === null
            ? 'the RPC reported no account list for this instruction'
            : `${accounts.length} account(s) for ${namedCount} named roles`,
        ),
  );

  const subtree = cpiSubtree(transaction, instruction);
  checks.push(
    subtree.ok ? pass('cpi-subtree-available', subtree.detail) : unchecked('cpi-subtree-available', subtree.detail),
  );

  /* 1–2: the one base transfer out, the one quote transfer in. */
  const baseCandidates: TransferLeg[] = [];
  const quoteCandidates: TransferLeg[] = [];
  const quoteVaultOutflows: TransferLeg[] = [];
  if (subtree.ok) {
    for (const sibling of subtree.instructions) {
      const actions = input.actionsByRef.get(refKey(refOf(sibling))) ?? [];
      for (const action of actions) {
        const leg = transferLeg(action);
        if (leg === null) continue;
        if (leg.source === roles.userBaseTokenAccount && leg.destination !== roles.userBaseTokenAccount) {
          baseCandidates.push(leg);
        }
        if (leg.destination === roles.userQuoteTokenAccount && leg.source !== roles.userQuoteTokenAccount) {
          quoteCandidates.push(leg);
        }
        if (
          leg.source === roles.poolQuoteTokenAccount &&
          leg.destination !== null &&
          leg.destination !== roles.userQuoteTokenAccount
        ) {
          quoteVaultOutflows.push(leg);
        }
      }
    }
  }
  const baseLeg = baseCandidates.length === 1 ? baseCandidates[0] ?? null : null;
  const quoteLeg = quoteCandidates.length === 1 ? quoteCandidates[0] ?? null : null;

  // A missing subtree is not a contradiction — it is evidence that does not exist,
  // so those two checks are `not-checkable` and the leg lands on `partially-proven`.
  // An *available* subtree with no (or several) matching transfer is a fail.
  checks.push(
    baseLeg !== null
      ? pass(
          'base-input-transfer-found',
          `${baseLeg.kind} ${baseLeg.amount ?? UNKNOWN} raw units out of user_base_token_account ` +
            `(${roles.userBaseTokenAccount ?? UNKNOWN}) at ${refLabel(baseLeg.ref)}`,
        )
      : !subtree.ok
        ? unchecked('base-input-transfer-found', subtree.detail)
        : fail(
            'base-input-transfer-found',
            baseCandidates.length === 0
              ? `no token transfer from user_base_token_account (${roles.userBaseTokenAccount ?? UNKNOWN}) inside the instruction's CPI subtree`
              : `${baseCandidates.length} candidate transfers from user_base_token_account: ${baseCandidates
                  .map(leg => refLabel(leg.ref))
                  .join(', ')} — ambiguous, so none is used`,
          ),
  );
  checks.push(
    quoteLeg !== null
      ? pass(
          'quote-output-transfer-found',
          `${quoteLeg.kind} ${quoteLeg.amount ?? UNKNOWN} raw units into user_quote_token_account ` +
            `(${roles.userQuoteTokenAccount ?? UNKNOWN}) at ${refLabel(quoteLeg.ref)}`,
        )
      : !subtree.ok
        ? unchecked('quote-output-transfer-found', subtree.detail)
        : fail(
            'quote-output-transfer-found',
            quoteCandidates.length === 0
              ? `no token transfer into user_quote_token_account (${roles.userQuoteTokenAccount ?? UNKNOWN}) inside the instruction's CPI subtree`
              : `${quoteCandidates.length} candidate transfers into user_quote_token_account: ${quoteCandidates
                  .map(leg => refLabel(leg.ref))
                  .join(', ')} — ambiguous, so none is used`,
          ),
  );

  /* 3–4: the mints, from the named roles. */
  const baseMintMatches =
    baseLeg !== null && baseLeg.mint !== null && baseLeg.mint === roles.baseMint ? true : null;
  checks.push(
    baseMintMatches === true
      ? pass('base-mint-matches-named-role', `base mint ${baseLeg?.mint ?? UNKNOWN} is base_mint (${roles.baseMint ?? UNKNOWN})`)
      : baseLeg === null
        ? unchecked('base-mint-matches-named-role', 'no base transfer was attributed, so its mint could not be compared with base_mint')
        : baseLeg.mint === null
          ? unchecked(
              'base-mint-matches-named-role',
              `${baseLeg.kind} at ${refLabel(baseLeg.ref)} does not state a mint (only transferChecked does)`,
            )
          : fail(
              'base-mint-matches-named-role',
              `base transfer mint ${baseLeg.mint} is not base_mint (${roles.baseMint ?? UNKNOWN})`,
            ),
  );
  checks.push(
    quoteLeg !== null && quoteLeg.mint !== null && quoteLeg.mint === roles.quoteMint
      ? pass('quote-mint-matches-named-role', `quote mint ${quoteLeg.mint} is quote_mint (${roles.quoteMint ?? UNKNOWN})`)
      : quoteLeg === null
        ? unchecked('quote-mint-matches-named-role', 'no quote transfer was attributed, so its mint could not be compared with quote_mint')
        : quoteLeg.mint === null
          ? unchecked(
              'quote-mint-matches-named-role',
              `${quoteLeg.kind} at ${refLabel(quoteLeg.ref)} does not state a mint (only transferChecked does)`,
            )
          : fail(
              'quote-mint-matches-named-role',
              `quote transfer mint ${quoteLeg.mint} is not quote_mint (${roles.quoteMint ?? UNKNOWN})`,
            ),
  );

  /* 5–6: the vault identities. */
  const baseCounterparty = baseLeg === null ? null : baseLeg.destination === roles.userBaseTokenAccount ? baseLeg.source : baseLeg.destination;
  const quoteSource = quoteLeg === null ? null : quoteLeg.source;
  checks.push(
    baseLeg === null
      ? unchecked('base-input-vault-is-pool-vault', 'no base transfer was attributed, so its counterparty could not be compared with pool_base_token_account')
      : baseCounterparty !== null && baseCounterparty === roles.poolBaseTokenAccount
        ? pass(
            'base-input-vault-is-pool-vault',
            `the base transfer's counterparty ${baseCounterparty} is pool_base_token_account (${roles.poolBaseTokenAccount ?? UNKNOWN})`,
          )
        : fail(
            'base-input-vault-is-pool-vault',
            `the base transfer's counterparty ${baseCounterparty ?? UNKNOWN} is not pool_base_token_account (${roles.poolBaseTokenAccount ?? UNKNOWN})`,
          ),
  );
  checks.push(
    quoteLeg === null
      ? unchecked('quote-output-vault-is-pool-vault', 'no quote transfer was attributed, so its source could not be compared with pool_quote_token_account')
      : quoteSource !== null && quoteSource === roles.poolQuoteTokenAccount
        ? pass(
            'quote-output-vault-is-pool-vault',
            `the quote transfer's source ${quoteSource} is pool_quote_token_account (${roles.poolQuoteTokenAccount ?? UNKNOWN})`,
          )
        : fail(
            'quote-output-vault-is-pool-vault',
            `the quote transfer's source ${quoteSource ?? UNKNOWN} is not pool_quote_token_account (${roles.poolQuoteTokenAccount ?? UNKNOWN})`,
          ),
  );

  /* 7: the argument against the transfer. */
  checks.push(
    baseLeg !== null && baseLeg.amount !== null && baseLeg.amount === baseAmountIn
      ? pass('base-amount-matches-base-amount-in', `the ${baseLeg.kind} moves exactly base_amount_in (${baseAmountIn} raw units)`)
      : baseLeg === null || baseLeg.amount === null
        ? unchecked(
            'base-amount-matches-base-amount-in',
            baseLeg === null
              ? `base_amount_in is ${baseAmountIn} but no base transfer was attributed`
              : `base_amount_in is ${baseAmountIn} but the base transfer's amount is not observable`,
          )
        : fail(
            'base-amount-matches-base-amount-in',
            `instruction base_amount_in ${baseAmountIn} does not equal the base transfer amount ${baseLeg.amount} at ${refLabel(baseLeg.ref)}`,
          ),
  );

  /* 8–9: the floor, honestly. */
  const floorStated = minQuoteAmountOut > 0n;
  checks.push(
    floorStated
      ? pass('min-quote-amount-out-stated', `min_quote_amount_out=${minQuoteAmountOut}`, false)
      : unchecked(
          'min-quote-amount-out-stated',
          'min_quote_amount_out is 0: this instruction states no floor, so the output cannot be tested against one (this is not a satisfied floor)',
          false,
        ),
  );
  if (!floorStated) unknowns.push('min-quote-amount-out-not-stated');
  checks.push(
    !floorStated
      ? unchecked(
          'min-quote-amount-out-satisfied',
          'min_quote_amount_out is 0 — no floor is stated, so this condition does not exist for this instruction (never reported as passed)',
          false,
        )
      : quoteLeg === null || quoteLeg.amount === null
        ? unchecked(
            'min-quote-amount-out-satisfied',
            `min_quote_amount_out is ${minQuoteAmountOut} but the quote amount is not observable`,
          )
        : quoteLeg.amount >= minQuoteAmountOut
          ? pass(
              'min-quote-amount-out-satisfied',
              `output ${quoteLeg.amount} satisfies min_quote_amount_out ${minQuoteAmountOut}`,
            )
          : fail(
              'min-quote-amount-out-satisfied',
              `output ${quoteLeg.amount} is below min_quote_amount_out ${minQuoteAmountOut}`,
            ),
  );

  /* Informational: who authorized the base side. */
  const baseOwner = roles.userBaseTokenAccount === null ? undefined : owners.get(roles.userBaseTokenAccount);
  checks.push(
    baseLeg === null
      ? unchecked('base-leg-authority-is-account-owner', 'no base transfer was attributed', false)
      : baseOwner === undefined
        ? unchecked(
            'base-leg-authority-is-account-owner',
            `no token balance row reports the owner of ${roles.userBaseTokenAccount ?? UNKNOWN}`,
            false,
          )
        : baseLeg.authority === baseOwner.owner
          ? pass(
              'base-leg-authority-is-account-owner',
              `the base transfer was authorized by ${baseLeg.authority}, the account's reported owner`,
              false,
            )
          : fail(
              'base-leg-authority-is-account-owner',
              `the base transfer was authorized by ${baseLeg.authority ?? UNKNOWN} but ${roles.userBaseTokenAccount ?? UNKNOWN} reports owner ${baseOwner.owner}`,
              false,
            ),
  );

  /* 10: everything else the quote vault paid, excluded by named slot. */
  const feeTransfers: PumpSellFeeTransfer[] = quoteVaultOutflows.map(leg => {
    const fact = leg.destination === null ? undefined : owners.get(leg.destination);
    return {
      ref: leg.ref,
      destTokenAccount: leg.destination,
      destOwner: fact?.owner ?? null,
      destOwnerEvidence: fact?.evidence ?? 'none',
      amount: leg.amount,
      mint: leg.mint,
      role: feeRoleOf(leg.destination, roles),
    };
  });
  const namedFeeCount = feeTransfers.filter(entry => entry.role !== 'other').length;
  const namedFeeSummary = feeTransfers
    .map(
      entry =>
        `${entry.amount === null ? 'amount not observable' : entry.amount} to ${
          entry.destTokenAccount ?? UNKNOWN
        } (${entry.role}${entry.destOwner === null ? '' : `, owner ${entry.destOwner}`})`,
    )
    .join('; ');
  checks.push(
    quoteLeg === null
      ? unchecked(
          'user-output-excludes-fee-transfers',
          'no quote transfer was attributed, so there is no user output to exclude other transfers from',
        )
      : pass(
          'user-output-excludes-fee-transfers',
          `the user's output is the transfer into the named user_quote_token_account (${roles.userQuoteTokenAccount ?? UNKNOWN}); ` +
            `${feeTransfers.length} other quote-vault transfer(s) were excluded by destination identity` +
            (feeTransfers.length === 0 ? '' : ` (${namedFeeCount} into a named fee slot): ${namedFeeSummary}`),
        ),
  );

  /* 11: reconcile both transfers with the Milestone 3 effects model. */
  checks.push(reconcileWithEffects('base-reconciles-with-effects', baseLeg, baseLeg?.mint ?? null, commitState, effects));
  checks.push(
    reconcileWithEffects('quote-reconciles-with-effects', quoteLeg, quoteLeg?.mint ?? null, commitState, effects),
  );
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

  const inputSide = sideOf(baseLeg, roles.userBaseTokenAccount, owners);
  const outputSide = sideOf(quoteLeg, roles.userQuoteTokenAccount, owners);
  const conflicts = checks.filter(entry => entry.outcome === 'fail').map(entry => entry.id);
  const state: SwapState = resolveState(commitState, checks, conflicts);

  if (state === 'conflicting') {
    legDiagnostics.push({
      level: 'warning',
      code: 'pump-sell-conflicting',
      message: `${refLabel(ref)} is a recognized ` + '`sell`' + ` but two pieces of evidence disagree (${conflicts.join(', ')}); both values are reported and nothing is guessed.`,
      ref,
    });
  }
  if (state === 'not-committed') {
    legDiagnostics.push({
      level: 'warning',
      code: 'pump-sell-not-committed',
      message: `${refLabel(ref)} is a recognized ` + '`sell`' + ` but the transaction did not commit; the amounts described are attempted movement, not state.`,
      ref,
    });
  }
  for (const note of roleNotes) {
    legDiagnostics.push({
      level: 'warning',
      code: 'pump-sell-named-accounts-incomplete',
      message: `${refLabel(ref)}: ${note}`,
      ref,
    });
  }

  return {
    protocol: 'pump-amm',
    programId: PUMP_AMM_PROGRAM_ID,
    instructionName: 'sell',
    ref,
    commitState,
    state,
    input: inputSide,
    output: outputSide,
    baseAmountIn,
    minQuoteAmountOut,
    roles,
    feeTransfers,
    checks,
    conflicts,
    unknowns,
    diagnostics: legDiagnostics,
  };
}

/** A side as the model reports it: what the named role points at, and what moved. */
function sideOf(
  leg: TransferLeg | null,
  tokenAccount: string | null,
  owners: ReadonlyMap<string, OwnerFact>,
): SwapSide {
  const fact = tokenAccount === null ? undefined : owners.get(tokenAccount);
  return {
    tokenAccount,
    owner: fact?.owner ?? null,
    ownerEvidence: fact?.evidence ?? 'none',
    mint: leg?.mint ?? null,
    amount: leg?.amount ?? null,
    amountEvidence: leg === null || leg.amount === null ? 'not-observable' : 'transfer-leg',
    legRef: leg?.ref ?? null,
    legKind: leg?.kind ?? null,
  };
}

/* -------------------------------------------------------------------- the scan */

export interface PumpSellRecognition {
  readonly legs: readonly PumpSellLeg[];
  readonly diagnostics: readonly SwapDiagnostic[];
}

export function recognizePumpSells(
  transaction: NormalizedTransaction,
  options: RecognizePumpOptions = {},
): PumpSellRecognition {
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

  const legs: PumpSellLeg[] = [];
  const diagnostics: SwapDiagnostic[] = [];

  for (const instruction of allInstructions(transaction)) {
    if (instruction.programId !== PUMP_AMM_PROGRAM_ID) continue;

    const ref = refOf(instruction);
    const bytes: Bytes | null = instruction.data === null ? null : decodeBase58Data(instruction.data);
    if (bytes === null) {
      diagnostics.push({
        level: 'warning',
        code: 'pump-instruction-data-unreadable',
        message: `${refLabel(ref)} is a pump_amm instruction but its data is missing or not valid base58; nothing is claimed about it.`,
        ref,
      });
      continue;
    }
    if (instructionDiscriminator(bytes) !== PUMP_AMM_SELL_DISCRIMINATOR) {
      // Another pump_amm instruction (e.g. `buy`): out of scope for 4.2, and
      // silently so — recognizing it is not this layer's job yet.
      continue;
    }

    const argParse = parsePumpSellArgs(bytes);
    if (!argParse.ok) {
      diagnostics.push({
        level: 'warning',
        code: 'pump-sell-args-not-recognized',
        message:
          `${refLabel(ref)} has the pump_amm sell discriminator but its arguments do not parse exactly ` +
          `(${argParse.detail}); it is left unrecognized rather than partially read.`,
        ref,
      });
      continue;
    }

    legs.push(
      recognizeSell({
        transaction,
        instruction,
        ref,
        baseAmountIn: argParse.args.baseAmountIn,
        minQuoteAmountOut: argParse.args.minQuoteAmountOut,
        commitState,
        owners,
        effects,
        actionsByRef,
      }),
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
        'No effects model was supplied, so the recognized pump_amm sell legs could not be reconciled ' +
        'against the Milestone 3 effects; those checks are not-checkable and the legs cannot be proven.',
      ref: null,
    });
  }

  return { legs, diagnostics };
}
