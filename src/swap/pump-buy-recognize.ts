/**
 * Milestone 4.3: recognizing a pump_amm `buy`.
 *
 * The algorithm, in order, and nothing else — deliberately the same shape as the
 * 4.2 `sell` recognizer, with buy's own (mirrored) evidence:
 *
 *   1. scan every instruction (top-level and CPI) for the pump_amm program id;
 *   2. read its discriminator and require exactly `66063d1201daebea`;
 *   3. parse the arguments with **exact** byte consumption (`./pump.ts`): the two
 *      `u64`s, and the optional trailing `OptionBool` byte — 24 or 25 bytes, never
 *      anything else;
 *   4. map the 23 named account roles in the IDL's declared order;
 *   5. take the instruction's own **CPI subtree** — the contiguous run of
 *      following instructions in the same inner group whose CPI depth is strictly
 *      greater, i.e. the frames it executed;
 *   6. inside that subtree, find the single transfer that arrives at
 *      `user_base_token_account` (the user's base output) and the single transfer
 *      that arrives at `pool_quote_token_account` (the user's payment);
 *   7. prove them: the mints must agree with the named roles, the base output must
 *      come from `pool_base_token_account`, the payment must come from
 *      `user_quote_token_account`, and `base_amount_out` must equal the base
 *      transfer exactly — a buy states the output it asked for, not the quote it
 *      paid;
 *   8. enumerate **every** outflow of the user's quote account inside the subtree:
 *      the payment into the pool vault plus each fee transfer, classified by
 *      destination identity (protocol fee recipient, coin creator vault, other) —
 *      the total *is* the user's spend;
 *   9. establish that the enumeration is complete against the Milestone 3 effects
 *      (flow-set equality), because only then may the instruction's
 *      `max_quote_amount_in` bound be tested — a missed fee leg would otherwise be
 *      a silently false "cap satisfied";
 *  10. reconcile the two main legs and every fee leg with the effects model, and
 *      report one `PumpBuyLeg` per recognized instruction with every check.
 *
 * What this deliberately does not do: read the pump `BuyEvent` (optional and never
 * required — a real reverted buy emits a full one), read the logs (never a source
 * of truth), decompose fees beyond destination identity, read the router that may
 * have caused the CPI, or decide *that* a purchase happened from token deltas. It
 * also never treats `0` the way `sell` treats a zero floor: for buy, `0` is a real
 * (unsatisfiable) cap and `u64::MAX` is the "nothing stated" sentinel.
 *
 * Inputs are the canonical normalized transaction (M1) and, optionally, the
 * effects model (M3). Nothing is added to any M1–M3 type.
 */

import { refLabel, type DecodedAction, type InstructionRef } from '../decode/actions.ts';
import { decodeBase58Data, takeAccountRoles } from '../decode/bytes.ts';
import type { NormalizedInstruction, NormalizedTransaction } from '../model/transaction.ts';
import type { TransactionEffects } from '../effects/model.ts';
import type {
  PumpBuyFeeTransfer,
  PumpBuyFeeTransferRole,
  PumpBuyLeg,
  PumpBuyRoles,
  SwapCheck,
  SwapDiagnostic,
  SwapState,
  SwapSide,
} from './model.ts';
import {
  PUMP_AMM_BUY_ACCOUNT_ROLES,
  PUMP_AMM_BUY_DISCRIMINATOR,
  PUMP_AMM_PROGRAM_ID,
  parsePumpBuyArgs,
  type PumpBuyArgs,
  type PumpBuyRole,
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

export interface RecognizePumpBuyOptions {
  /**
   * The Milestone 3 effects model for the same transaction.
   *
   * When supplied, every attributed transfer is required to appear in it with an
   * instruction-stated amount, and the user's spend enumeration is checked for
   * completeness against it; when omitted, those checks are `not-checkable` and no
   * leg can be `proven`.
   */
  readonly effects?: TransactionEffects | null;
}

const UNKNOWN = 'unknown';

/** The value the instruction uses to say "no binding limit stated". */
const U64_MAX = 18_446_744_073_709_551_615n;

/* --------------------------------------------------------------- role access */

function rolesFrom(
  accounts: readonly string[] | null,
  notes: string[],
): Record<PumpBuyRole, string | null> {
  return accounts === null
    ? (Object.fromEntries(PUMP_AMM_BUY_ACCOUNT_ROLES.map(role => [role, null])) as Record<
        PumpBuyRole,
        string | null
      >)
    : takeAccountRoles(accounts, PUMP_AMM_BUY_ACCOUNT_ROLES, notes);
}

function pumpRoles(
  roles: Record<PumpBuyRole, string | null>,
  accounts: readonly string[] | null,
): PumpBuyRoles {
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
    tailAccountCount: accounts === null ? 0 : Math.max(0, accounts.length - PUMP_AMM_BUY_ACCOUNT_ROLES.length),
  };
}

/** The IDL name of an outflow destination, or `other` when no named slot matches. */
function feeRoleOf(destination: string | null, roles: PumpBuyRoles): PumpBuyFeeTransferRole {
  if (destination !== null && destination === roles.protocolFeeRecipientTokenAccount) {
    return 'protocol-fee-recipient';
  }
  if (destination !== null && destination === roles.coinCreatorVaultAta) {
    return 'coin-creator-vault';
  }
  return 'other';
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

/** Stable identity of one attributed user-quote outflow, for set comparison. */
function outflowKey(entry: {
  readonly ref: InstructionRef;
  readonly source: string | null;
  readonly destination: string | null;
  readonly amount: bigint | null;
}): string {
  return `${refKey(entry.ref)}|${entry.source ?? '-'}|${entry.destination ?? '-'}|${entry.amount ?? '-'}`;
}

/* ------------------------------------------------------------ one instruction */

interface RecognizePumpBuyInput {
  readonly transaction: NormalizedTransaction;
  readonly instruction: NormalizedInstruction;
  readonly ref: InstructionRef;
  readonly args: PumpBuyArgs;
  readonly commitState: ReturnType<typeof commitStateOf>;
  readonly owners: ReadonlyMap<string, OwnerFact>;
  readonly effects: TransactionEffects | null;
  readonly actionsByRef: ReadonlyMap<string, DecodedAction[]>;
}

function recognizeBuy(input: RecognizePumpBuyInput): PumpBuyLeg {
  const { transaction, instruction, ref, args, commitState, owners, effects } = input;
  const accounts = instruction.accounts;
  const roleNotes: string[] = [];
  const roleMap = rolesFrom(accounts, roleNotes);
  const roles = pumpRoles(roleMap, accounts);
  const checks: SwapCheck[] = [];
  const unknowns: string[] = [];
  const legDiagnostics: SwapDiagnostic[] = [];
  const reverted = commitState === 'reverted';

  checks.push(pass('pump-program-id', `program is ${PUMP_AMM_PROGRAM_ID}`));
  checks.push(pass('buy-discriminator', `8-byte discriminator ${PUMP_AMM_BUY_DISCRIMINATOR} (IDL: buy)`));
  checks.push(
    pass(
      'args-decode-exact',
      `base_amount_out=${args.baseAmountOut}, max_quote_amount_in=${args.maxQuoteAmountIn}; ` +
        (args.trackVolumeByte === 'absent'
          ? '24-byte payload: no trailing OptionBool byte (recorded as absent — both forms are live, so the ' +
            'absence is not read as a value)'
          : `25-byte payload: trailing OptionBool byte ${args.trackVolumeByte} (recorded verbatim, never used as evidence)`) +
        `; ${instruction.data === null ? 0 : instruction.data.length} base58 char(s) consumed exactly`,
    ),
  );
  const namedCount = PUMP_AMM_BUY_ACCOUNT_ROLES.length;
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

  /* 1–2: the one base-output transfer, the one payment into the pool vault. */
  const baseOutputCandidates: TransferLeg[] = [];
  const quoteInputCandidates: TransferLeg[] = [];
  const userQuoteOutflows: TransferLeg[] = [];
  if (subtree.ok) {
    for (const sibling of subtree.instructions) {
      const actions = input.actionsByRef.get(refKey(refOf(sibling))) ?? [];
      for (const action of actions) {
        const leg = transferLeg(action);
        if (leg === null) continue;
        if (
          roles.userBaseTokenAccount !== null &&
          leg.destination === roles.userBaseTokenAccount &&
          leg.source !== roles.userBaseTokenAccount
        ) {
          baseOutputCandidates.push(leg);
        }
        if (
          roles.poolQuoteTokenAccount !== null &&
          leg.destination === roles.poolQuoteTokenAccount &&
          leg.source !== roles.poolQuoteTokenAccount
        ) {
          quoteInputCandidates.push(leg);
        }
        if (roles.userQuoteTokenAccount !== null && leg.source === roles.userQuoteTokenAccount && leg.destination !== roles.userQuoteTokenAccount) {
          userQuoteOutflows.push(leg);
        }
      }
    }
  }
  const baseLeg = baseOutputCandidates.length === 1 ? baseOutputCandidates[0] ?? null : null;
  const quoteLeg = quoteInputCandidates.length === 1 ? quoteInputCandidates[0] ?? null : null;

  // A missing subtree is not a contradiction — it is evidence that does not exist.
  // A *reverted* transaction with no transfer is not a contradiction either: the
  // program checks the bound before it moves anything (the real `ExceededSlippage`
  // vector executes zero transfers), so those checks are `not-checkable`.
  checks.push(
    baseLeg !== null
      ? pass(
          'base-output-transfer-found',
          `${baseLeg.kind} ${baseLeg.amount ?? UNKNOWN} raw units into user_base_token_account ` +
            `(${roles.userBaseTokenAccount ?? UNKNOWN}) at ${refLabel(baseLeg.ref)}`,
        )
      : !subtree.ok
        ? unchecked('base-output-transfer-found', subtree.detail)
        : baseOutputCandidates.length === 0 && reverted
          ? unchecked(
              'base-output-transfer-found',
              'the transaction failed, so the instruction executed no transfer at all: nothing was received, and ' +
                'the absence is not a contradiction',
            )
          : fail(
              'base-output-transfer-found',
              baseOutputCandidates.length === 0
                ? `no token transfer into user_base_token_account (${roles.userBaseTokenAccount ?? UNKNOWN}) inside the instruction's CPI subtree`
                : `${baseOutputCandidates.length} candidate transfers into user_base_token_account: ${baseOutputCandidates
                    .map(leg => refLabel(leg.ref))
                    .join(', ')} — ambiguous, so none is used`,
            ),
  );
  checks.push(
    quoteLeg !== null
      ? pass(
          'quote-input-transfer-found',
          `${quoteLeg.kind} ${quoteLeg.amount ?? UNKNOWN} raw units into pool_quote_token_account ` +
            `(${roles.poolQuoteTokenAccount ?? UNKNOWN}) at ${refLabel(quoteLeg.ref)}`,
        )
      : !subtree.ok
        ? unchecked('quote-input-transfer-found', subtree.detail)
        : quoteInputCandidates.length === 0 && reverted
          ? unchecked(
              'quote-input-transfer-found',
              'the transaction failed, so the instruction executed no transfer at all: nothing was paid, and ' +
                'the absence is not a contradiction',
            )
          : fail(
              'quote-input-transfer-found',
              quoteInputCandidates.length === 0
                ? `no token transfer into pool_quote_token_account (${roles.poolQuoteTokenAccount ?? UNKNOWN}) inside the instruction's CPI subtree`
                : `${quoteInputCandidates.length} candidate transfers into pool_quote_token_account: ${quoteInputCandidates
                    .map(leg => refLabel(leg.ref))
                    .join(', ')} — ambiguous, so none is used`,
            ),
  );

  /* 3–4: the mints, from the named roles. */
  checks.push(
    baseLeg !== null && baseLeg.mint !== null && baseLeg.mint === roles.baseMint
      ? pass(
          'base-output-mint-matches-named-role',
          `base mint ${baseLeg.mint} is base_mint (${roles.baseMint ?? UNKNOWN})`,
        )
      : baseLeg === null
        ? unchecked(
            'base-output-mint-matches-named-role',
            'no base output transfer was attributed, so its mint could not be compared with base_mint',
          )
        : baseLeg.mint === null
          ? unchecked(
              'base-output-mint-matches-named-role',
              `${baseLeg.kind} at ${refLabel(baseLeg.ref)} does not state a mint (only transferChecked does)`,
            )
          : fail(
              'base-output-mint-matches-named-role',
              `base output mint ${baseLeg.mint} is not base_mint (${roles.baseMint ?? UNKNOWN})`,
            ),
  );
  checks.push(
    quoteLeg !== null && quoteLeg.mint !== null && quoteLeg.mint === roles.quoteMint
      ? pass(
          'quote-input-mint-matches-named-role',
          `quote mint ${quoteLeg.mint} is quote_mint (${roles.quoteMint ?? UNKNOWN})`,
        )
      : quoteLeg === null
        ? unchecked(
            'quote-input-mint-matches-named-role',
            'no payment transfer was attributed, so its mint could not be compared with quote_mint',
          )
        : quoteLeg.mint === null
          ? unchecked(
              'quote-input-mint-matches-named-role',
              `${quoteLeg.kind} at ${refLabel(quoteLeg.ref)} does not state a mint (only transferChecked does)`,
            )
          : fail(
              'quote-input-mint-matches-named-role',
              `payment mint ${quoteLeg.mint} is not quote_mint (${roles.quoteMint ?? UNKNOWN})`,
            ),
  );

  /* 5–6: where each side actually came from. */
  checks.push(
    baseLeg === null
      ? unchecked(
          'base-output-source-is-pool-vault',
          'no base output transfer was attributed, so its source could not be compared with pool_base_token_account',
        )
      : baseLeg.source !== null && baseLeg.source === roles.poolBaseTokenAccount
        ? pass(
            'base-output-source-is-pool-vault',
            `the base output came from ${baseLeg.source}, which is pool_base_token_account (${roles.poolBaseTokenAccount ?? UNKNOWN})`,
          )
        : fail(
            'base-output-source-is-pool-vault',
            `the base output came from ${baseLeg.source ?? UNKNOWN}, not pool_base_token_account (${roles.poolBaseTokenAccount ?? UNKNOWN})`,
          ),
  );
  checks.push(
    quoteLeg === null
      ? unchecked(
          'quote-input-source-is-user-quote-account',
          'no payment transfer was attributed, so its source could not be compared with user_quote_token_account',
        )
      : quoteLeg.source !== null && quoteLeg.source === roles.userQuoteTokenAccount
        ? pass(
            'quote-input-source-is-user-quote-account',
            `the payment came from ${quoteLeg.source}, which is user_quote_token_account (${roles.userQuoteTokenAccount ?? UNKNOWN})`,
          )
        : fail(
            'quote-input-source-is-user-quote-account',
            `the payment came from ${quoteLeg.source ?? UNKNOWN}, not user_quote_token_account (${roles.userQuoteTokenAccount ?? UNKNOWN})`,
          ),
  );

  /* 7: the argument against the transfer. */
  checks.push(
    baseLeg !== null && baseLeg.amount !== null && baseLeg.amount === args.baseAmountOut
      ? pass(
          'base-amount-out-matches-base-transfer',
          `the ${baseLeg.kind} delivers exactly base_amount_out (${args.baseAmountOut} raw units)`,
        )
      : baseLeg === null || baseLeg.amount === null
        ? unchecked(
            'base-amount-out-matches-base-transfer',
            baseLeg === null
              ? `base_amount_out is ${args.baseAmountOut} but no base output transfer was attributed`
              : `base_amount_out is ${args.baseAmountOut} but the base output transfer's amount is not observable`,
          )
        : fail(
            'base-amount-out-matches-base-transfer',
            `instruction base_amount_out ${args.baseAmountOut} does not equal the base transfer amount ${baseLeg.amount} at ${refLabel(baseLeg.ref)}`,
          ),
  );

  /* 8: the spend — the payment plus every other outflow, by destination identity. */
  const feeLegs = userQuoteOutflows.filter(leg => leg.destination !== roles.poolQuoteTokenAccount);
  const feeTransfers: PumpBuyFeeTransfer[] = feeLegs.map(leg => {
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
  const spendKnown =
    subtree.ok && quoteLeg !== null && quoteLeg.amount !== null && feeLegs.every(leg => leg.amount !== null);
  const quoteSpend = spendKnown
    ? (quoteLeg?.amount ?? 0n) + feeLegs.reduce((total, leg) => total + (leg.amount ?? 0n), 0n)
    : null;

  /* 9: the completeness gate — the spend must cover every M3 outflow at these refs. */
  const subtreeRefKeys = subtree.ok ? new Set(subtree.instructions.map(entry => refKey(refOf(entry)))) : null;
  const enumeratedKeys = subtree.ok
    ? [
        ...(quoteLeg === null ? [] : [outflowKey(quoteLeg)]),
        ...feeLegs.map(leg => outflowKey(leg)),
      ]
    : [];
  const effectOutflows =
    effects === null || subtreeRefKeys === null
      ? null
      : [...effects.tokenFlows, ...effects.uncommittedTokenFlows].filter(
          flow =>
            flow.ref !== null &&
            subtreeRefKeys.has(refKey(flow.ref)) &&
            flow.sourceTokenAccount === roles.userQuoteTokenAccount,
        );
  let spendComplete = false;
  let spendDetail: string;
  if (!subtree.ok) {
    spendDetail =
      `${subtree.detail}, so the user's outflows could not be enumerated and the spend is not established`;
  } else if (effectOutflows === null) {
    spendDetail =
      'no effects model was supplied, so the enumerated outflows could not be compared with the Milestone 3 flows';
  } else {
    const effectKeys = effectOutflows.map(flow =>
      outflowKey({
        ref: flow.ref as InstructionRef,
        source: flow.sourceTokenAccount,
        destination: flow.destinationTokenAccount,
        amount: flow.amount,
      }),
    );
    const missing = effectKeys.filter(key => !enumeratedKeys.includes(key));
    const extra = enumeratedKeys.filter(key => !effectKeys.includes(key));
    spendComplete = missing.length === 0 && extra.length === 0;
    spendDetail = spendComplete
      ? enumeratedKeys.length === 0
        ? `nothing left ${roles.userQuoteTokenAccount ?? UNKNOWN} inside this instruction and the effects model ` +
          'records nothing either, so there is no spend to enumerate'
        : `all ${enumeratedKeys.length} outflow(s) of ${roles.userQuoteTokenAccount ?? UNKNOWN} inside this ` +
          'instruction are present in the effects model, so the spend is fully enumerated'
      : `the enumeration does not match the effects model: ${missing.length} outflow(s) it records were not ` +
        `attributed here${missing.length === 0 ? '' : ` (${missing.join('; ')})`} and ${extra.length} ` +
        `attributed outflow(s) have no effects flow${extra.length === 0 ? '' : ` (${extra.join('; ')})`}`;
  }
  if (!spendComplete && effects !== null) unknowns.push('user-quote-spend-not-fully-enumerated');
  checks.push(
    spendComplete
      ? pass('user-quote-spend-enumerated', spendDetail)
      : unchecked('user-quote-spend-enumerated', spendDetail),
  );

  /* 10: the cap, which bounds the *total* spend — never treated as a sell floor. */
  const capStated = args.maxQuoteAmountIn !== U64_MAX;
  checks.push(
    capStated
      ? pass('max-quote-amount-in-stated', `max_quote_amount_in=${args.maxQuoteAmountIn}`, false)
      : unchecked(
          'max-quote-amount-in-stated',
          'max_quote_amount_in is the maximum u64: this instruction states no binding limit, so the spend cannot be ' +
            'tested against one (this is not a satisfied cap)',
          false,
        ),
  );
  if (!capStated) unknowns.push('max-quote-amount-in-unbounded');
  checks.push(
    !capStated
      ? unchecked(
          'max-quote-amount-in-satisfied',
          'max_quote_amount_in is the maximum u64 — no limit is stated, so this condition does not exist for this ' +
            'instruction (never reported as passed)',
          false,
        )
      : reverted
        ? unchecked(
            'max-quote-amount-in-satisfied',
            `max_quote_amount_in is ${args.maxQuoteAmountIn}, but the transaction failed: the bound describes ` +
              'attempted movement only, so nothing committed is compared against it',
          )
        : quoteSpend === null
          ? unchecked(
              'max-quote-amount-in-satisfied',
              `max_quote_amount_in is ${args.maxQuoteAmountIn} but the user's spend could not be attributed, so the ` +
                'bound cannot be tested',
            )
          : !spendComplete
            ? unchecked(
                'max-quote-amount-in-satisfied',
                `max_quote_amount_in is ${args.maxQuoteAmountIn} and the attributed spend is ${quoteSpend}, but the ` +
                  'enumeration is incomplete, so the bound is never reported as satisfied against it',
              )
            : quoteSpend <= args.maxQuoteAmountIn
              ? pass(
                  'max-quote-amount-in-satisfied',
                  `total spend ${quoteSpend} (payment + ${feeTransfers.length} other outflow(s)) satisfies ` +
                    `max_quote_amount_in ${args.maxQuoteAmountIn}`,
                )
              : fail(
                  'max-quote-amount-in-satisfied',
                  `total spend ${quoteSpend} (payment + ${feeTransfers.length} other outflow(s)) exceeds ` +
                    `max_quote_amount_in ${args.maxQuoteAmountIn}`,
                ),
  );

  /* Informational: who authorized the payment. */
  const quoteOwner = roles.userQuoteTokenAccount === null ? undefined : owners.get(roles.userQuoteTokenAccount);
  checks.push(
    quoteLeg === null
      ? unchecked('quote-leg-authority-is-account-owner', 'no payment transfer was attributed', false)
      : quoteOwner === undefined
        ? unchecked(
            'quote-leg-authority-is-account-owner',
            `no token balance row reports the owner of ${roles.userQuoteTokenAccount ?? UNKNOWN}`,
            false,
          )
        : quoteLeg.authority === quoteOwner.owner
          ? pass(
              'quote-leg-authority-is-account-owner',
              `the payment was authorized by ${quoteLeg.authority}, the account's reported owner`,
              false,
            )
          : fail(
              'quote-leg-authority-is-account-owner',
              `the payment was authorized by ${quoteLeg.authority ?? UNKNOWN} but ${roles.userQuoteTokenAccount ?? UNKNOWN} reports owner ${quoteOwner.owner}`,
              false,
            ),
  );

  /* 11: reconcile both main legs with the Milestone 3 effects model. */
  checks.push(
    reconcileWithEffects('base-output-reconciles-with-effects', baseLeg, baseLeg?.mint ?? null, commitState, effects),
  );
  checks.push(
    reconcileWithEffects('quote-input-reconciles-with-effects', quoteLeg, quoteLeg?.mint ?? null, commitState, effects),
  );

  /* 12: and every fee leg, because each one is part of the user's spend. */
  if (!subtree.ok) {
    checks.push(unchecked('fee-transfers-reconcile-with-effects', subtree.detail));
  } else if (effects === null) {
    checks.push(
      unchecked(
        'fee-transfers-reconcile-with-effects',
        'no effects model was supplied, so the fee transfers could not be reconciled',
      ),
    );
  } else if (feeLegs.length === 0) {
    checks.push(
      pass(
        'fee-transfers-reconcile-with-effects',
        quoteLeg === null
          ? "nothing left the user's quote account inside this instruction and the effects model records none, so " +
            'there is no fee transfer to reconcile'
          : "no other outflow of the user's quote account was attributed inside this instruction, so the payment is " +
            'the whole spend',
      ),
    );
  } else {
    const reconciliations = feeLegs.map(leg =>
      reconcileWithEffects('fee-transfers-reconcile-with-effects', leg, leg.mint ?? null, commitState, effects),
    );
    const failed = reconciliations.filter(entry => entry.outcome === 'fail');
    const unknown = reconciliations.filter(entry => entry.outcome === 'not-checkable');
    checks.push(
      failed.length > 0
        ? fail('fee-transfers-reconcile-with-effects', failed.map(entry => entry.detail).join('; '))
        : unknown.length > 0
          ? unchecked('fee-transfers-reconcile-with-effects', unknown.map(entry => entry.detail).join('; '))
          : pass(
              'fee-transfers-reconcile-with-effects',
              `all ${feeLegs.length} fee transfer(s) leaving the user's quote account reconcile exactly with the ` +
                'effects model',
            ),
    );
  }
  if (effects === null) unknowns.push('effects-model-absent');

  /* 13: commitment. */
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

  const inputSide = sideOf(quoteLeg, roles.userQuoteTokenAccount, owners);
  const outputSide = sideOf(baseLeg, roles.userBaseTokenAccount, owners);
  const conflicts = checks.filter(entry => entry.outcome === 'fail').map(entry => entry.id);
  const state: SwapState = resolveState(commitState, checks, conflicts);

  if (state === 'conflicting') {
    legDiagnostics.push({
      level: 'warning',
      code: 'pump-buy-conflicting',
      message: `${refLabel(ref)} is a recognized ` + '`buy`' + ` but two pieces of evidence disagree (${conflicts.join(', ')}); both values are reported and nothing is guessed.`,
      ref,
    });
  }
  if (state === 'not-committed') {
    legDiagnostics.push({
      level: 'warning',
      code: 'pump-buy-not-committed',
      message: `${refLabel(ref)} is a recognized ` + '`buy`' + ` but the transaction did not commit; the amounts described are attempted movement, not state.`,
      ref,
    });
  }
  for (const note of roleNotes) {
    legDiagnostics.push({
      level: 'warning',
      code: 'pump-buy-named-accounts-incomplete',
      message: `${refLabel(ref)}: ${note}`,
      ref,
    });
  }

  return {
    protocol: 'pump-amm',
    programId: PUMP_AMM_PROGRAM_ID,
    instructionName: 'buy',
    ref,
    commitState,
    state,
    input: inputSide,
    output: outputSide,
    baseAmountOut: args.baseAmountOut,
    maxQuoteAmountIn: args.maxQuoteAmountIn,
    trackVolumeByte: args.trackVolumeByte,
    roles,
    feeTransfers,
    quoteSpend,
    quoteSpendComplete: spendComplete,
    checks,
    conflicts,
    unknowns,
    diagnostics: legDiagnostics,
  };
}

/* -------------------------------------------------------------------- the scan */

export interface PumpBuyRecognition {
  readonly legs: readonly PumpBuyLeg[];
  readonly diagnostics: readonly SwapDiagnostic[];
}

export function recognizePumpBuys(
  transaction: NormalizedTransaction,
  options: RecognizePumpBuyOptions = {},
): PumpBuyRecognition {
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

  const legs: PumpBuyLeg[] = [];
  const diagnostics: SwapDiagnostic[] = [];

  for (const instruction of allInstructions(transaction)) {
    if (instruction.programId !== PUMP_AMM_PROGRAM_ID) continue;

    const ref = refOf(instruction);
    const bytes = instruction.data === null ? null : decodeBase58Data(instruction.data);
    if (bytes === null) {
      diagnostics.push({
        level: 'warning',
        code: 'pump-instruction-data-unreadable',
        message: `${refLabel(ref)} is a pump_amm instruction but its data is missing or not valid base58; nothing is claimed about it.`,
        ref,
      });
      continue;
    }
    if (instructionDiscriminator(bytes) !== PUMP_AMM_BUY_DISCRIMINATOR) {
      // Another pump_amm instruction (e.g. `sell`, or `buy_exact_quote_in`, whose
      // semantics are different): silently out of scope, never read as a buy.
      continue;
    }

    const argParse = parsePumpBuyArgs(bytes);
    if (!argParse.ok) {
      diagnostics.push({
        level: 'warning',
        code: 'pump-buy-args-not-recognized',
        message:
          `${refLabel(ref)} has the pump_amm buy discriminator but its arguments do not parse exactly ` +
          `(${argParse.detail}); it is left unrecognized rather than partially read.`,
        ref,
      });
      continue;
    }

    legs.push(
      recognizeBuy({
        transaction,
        instruction,
        ref,
        args: argParse.args,
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
        'No effects model was supplied, so the recognized pump_amm buy legs could not be reconciled against ' +
        'the Milestone 3 effects; those checks are not-checkable and the legs cannot be proven.',
      ref: null,
    });
  }

  return { legs, diagnostics };
}
