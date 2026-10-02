/**
 * Assembling a transaction's effects.
 *
 * The commit state is decided here, once, from the transaction's own status:
 *
 *  - **success** → instruction effects are committed.
 *  - **failed** → Solana transactions are atomic. The runtime deducts the fee
 *    before execution and rolls every state change back when any instruction
 *    fails, so a failed transaction's only committed effect is the fee. Every
 *    instruction-derived effect is reported in the `uncommitted*` collections with
 *    `commitState: 'reverted'` — visible, never counted as state.
 *    (Solana docs, *Fee Structure*: "The total fee is deducted from the fee payer
 *    before execution begins. If the transaction fails, the fee is still charged."
 *    And the transactions doc: transactions are atomic — either all instructions
 *    succeed, or the transaction fails and no changes are made.)
 *  - **unknown** (`meta` absent) → nothing is claimed as committed; instruction
 *    effects carry `commitState: 'unknown'`.
 *
 * The fee itself is a proven effect either way, and it is the only one: the RPC
 * reports the total charged, so the base/priority split (part burned, part paid to
 * the validator) is deliberately not claimed.
 */

import type { DecodedAction } from '../decode/actions.ts';
import type { NormalizedTransaction } from '../model/transaction.ts';
import { claimsFromActions, type Claims } from './claims.ts';
import { toEffectsInput } from './input.ts';
import type {
  AccountLifecycleEffect,
  EffectCommitState,
  EffectsCounts,
  EffectsDiagnostic,
  EffectsInput,
  SolFlow,
  TokenFlow,
  TransactionEffects,
} from './model.ts';
import { reconcile } from './reconcile.ts';

const FEE_ON_FAILURE_NOTE =
  'Solana transactions are atomic: the fee is deducted before execution and every state change is rolled back when any ' +
  'instruction fails, so the instructions above are reported as attempted-but-uncommitted.';

/** Builds the effects model from the narrow input view plus the decoded actions. */
export function buildTransactionEffects(
  input: EffectsInput,
  actions: readonly DecodedAction[],
): TransactionEffects {
  const diagnostics: EffectsDiagnostic[] = [];
  const batchState: EffectCommitState =
    input.status === 'success' ? 'committed' : input.status === 'failed' ? 'reverted' : 'unknown';

  const claims: Claims = claimsFromActions(input, actions, batchState);
  diagnostics.push(...claims.diagnostics);

  // ------------------------------------------------------------------- the fee

  const committedFee: SolFlow[] = [];
  if (input.feeLamports !== null && input.feePayer !== null) {
    committedFee.push({
      confidence: 'proven',
      // The fee is charged whether or not the transaction succeeded.
      commitState: batchState === 'unknown' ? 'unknown' : 'committed',
      ref: null,
      actionKind: null,
      kind: 'fee',
      from: input.feePayer,
      to: null,
      lamports: input.feeLamports,
      amountSource: 'transaction-metadata',
    });
  } else if (input.feeLamports !== null) {
    diagnostics.push({
      level: 'warning',
      code: 'effects-fee-payer-unknown',
      message:
        `the RPC reported a ${input.feeLamports} lamport fee but no account list, so the fee payer is unknown and no fee flow ` +
        'is claimed.',
      ref: null,
    });
  } else {
    diagnostics.push({
      level: 'warning',
      code: 'effects-fee-unknown',
      message: 'the response does not report the transaction fee, so no fee flow is claimed.',
      ref: null,
    });
  }

  // ------------------------------------------------- committed vs uncommitted

  const split = <T extends { readonly commitState: EffectCommitState }>(
    effects: readonly T[],
  ): { readonly committed: readonly T[]; readonly uncommitted: readonly T[] } => ({
    committed: effects.filter(effect => effect.commitState === 'committed'),
    uncommitted: effects.filter(effect => effect.commitState !== 'committed'),
  });

  const solSplit = split(claims.solFlows);
  const tokenSplit = split(claims.tokenFlows);
  const lifecycleSplit = split<AccountLifecycleEffect>(claims.lifecycle);

  const committedSolFlows = [...committedFee, ...solSplit.committed];

  // ------------------------------------------------------------- reconciling

  const reconciled = reconcile(input, {
    ...claims,
    solFlows: committedSolFlows,
    tokenFlows: tokenSplit.committed,
    lifecycle: lifecycleSplit.committed,
  });
  diagnostics.push(...reconciled.diagnostics);

  // ------------------------------------------------------- transaction-level

  if (input.status === 'failed') {
    const attempted =
      solSplit.uncommitted.length + tokenSplit.uncommitted.length + lifecycleSplit.uncommitted.length;
    diagnostics.push({
      level: 'info',
      code: 'effects-transaction-reverted',
      message:
        `the transaction failed, so ${attempted} instruction-derived effect(s) did not commit; only the ${input.feeLamports ?? 'unknown'}-lamport fee did. ` +
        FEE_ON_FAILURE_NOTE,
      ref: null,
    });
    // A rollback restores everything except the fee. Any other committed change
    // therefore contradicts the failure it came with, and is worth surfacing
    // rather than silently using.
    const straySol = reconciled.netSolByAccount.filter(
      net => !net.isFeePayer && net.netLamports !== null && net.netLamports !== 0n,
    );
    const strayToken = reconciled.netTokenByAccountMint.filter(
      net => net.netAmount !== null && net.netAmount !== 0n,
    );
    if (straySol.length === 0 && strayToken.length === 0) {
      // The positive form of the same check, so a reader can see that the rollback
      // was verified rather than assumed.
      diagnostics.push({
        level: 'info',
        code: 'effects-rollback-confirmed',
        message:
          'the balances confirm the rollback: no account changed lamports except the fee payer, and no token balance row moved.',
        ref: null,
      });
    } else {
      diagnostics.push({
        level: 'warning',
        code: 'effects-reverted-state-changed',
        message:
          `the transaction failed, yet ${straySol.length} account(s) changed lamports and ${strayToken.length} token row(s) changed ` +
          'units outside the fee. A failed transaction rolls back every account, so this contradicts the reported error and the ' +
          'balances should not be trusted as committed state.',
        ref: null,
      });
    }
  } else if (input.status === 'unknown') {
    diagnostics.push({
      level: 'warning',
      code: 'effects-commitment-unknown',
      message:
        'the response carries no `meta`, so neither success nor failure is known: instruction-derived effects are reported as ' +
        'uncommitted and nothing is claimed about committed state.',
      ref: null,
    });
  }

  const counts: EffectsCounts = {
    proven:
      reconciled.solFlows.filter(flow => flow.confidence === 'proven').length +
      reconciled.tokenFlows.filter(flow => flow.confidence === 'proven').length +
      reconciled.lifecycle.filter(effect => effect.confidence === 'proven').length,
    reconciled:
      reconciled.solFlows.filter(flow => flow.confidence === 'reconciled').length +
      reconciled.tokenFlows.filter(flow => flow.confidence === 'reconciled').length +
      reconciled.lifecycle.filter(effect => effect.confidence === 'reconciled').length,
    uncommitted:
      solSplit.uncommitted.length + tokenSplit.uncommitted.length + lifecycleSplit.uncommitted.length,
    unattributed: reconciled.unattributed.length,
    // Counted after reconciliation, so a flow whose amount was filled in later is
    // not counted as unobservable.
    amountNotObservable: [...reconciled.solFlows, ...reconciled.tokenFlows].filter(
      flow => ('lamports' in flow ? flow.lamports : flow.amount) === null,
    ).length,
  };

  return {
    commitState: batchState,
    solFlows: reconciled.solFlows,
    tokenFlows: reconciled.tokenFlows,
    accountLifecycleEffects: reconciled.lifecycle,
    uncommittedSolFlows: solSplit.uncommitted,
    uncommittedTokenFlows: tokenSplit.uncommitted as readonly TokenFlow[],
    uncommittedLifecycleEffects: lifecycleSplit.uncommitted,
    netSolByAccount: reconciled.netSolByAccount,
    netTokenByAccountMint: reconciled.netTokenByAccountMint,
    netTokenByOwnerMint: reconciled.netTokenByOwnerMint,
    unattributedEffects: reconciled.unattributed,
    diagnostics,
    counts,
  };
}

/**
 * Convenience entry point: the canonical model in, effects out.
 *
 * This is the whole integration surface — the rest of the project only ever sees
 * `TransactionEffects`, and the effects layer only ever sees the narrow input view
 * plus the decoded actions.
 */
export function transactionEffects(transaction: NormalizedTransaction): TransactionEffects {
  return buildTransactionEffects(toEffectsInput(transaction), transaction.decoded.actions);
}
