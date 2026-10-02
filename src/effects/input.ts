/**
 * The narrow view of the canonical model the effects layer is allowed to see.
 *
 * Building this view is the only place that touches `NormalizedTransaction`.
 * Everything downstream (`claims.ts`, `reconcile.ts`, `build.ts`) works on this
 * value, which has no raw payload, no logs, and no instruction data — so the
 * effects layer physically cannot start decoding instructions on its own, and
 * cannot reach for the raw RPC response to fill a gap.
 */

import type { UndecodedInstruction } from '../decode/actions.ts';
import type { NormalizedTransaction } from '../model/transaction.ts';
import type { EffectsAccountRow, EffectsInput, EffectsTokenRow } from './model.ts';

/** Projects the canonical model onto the fields the effects layer needs. */
export function toEffectsInput(transaction: NormalizedTransaction): EffectsInput {
  const accounts: EffectsAccountRow[] = transaction.accounts.map(account => {
    const change = changeByIndex(transaction, account.index);
    return {
      index: account.index,
      address: account.address,
      signer: account.signer,
      beforeLamports: change?.beforeLamports ?? null,
      afterLamports: change?.afterLamports ?? null,
    };
  });

  const tokenRows: EffectsTokenRow[] = transaction.tokenBalanceChanges.map(change => ({
    accountIndex: change.accountIndex,
    address: change.address,
    mint: change.mint,
    owner: change.owner,
    programId: change.programId,
    decimals: change.decimals,
    beforeAmount: change.beforeAmount,
    afterAmount: change.afterAmount,
    presence: change.presence,
  }));

  const undecoded: readonly UndecodedInstruction[] = transaction.decoded.undecoded;

  return {
    status: transaction.status,
    feeLamports: transaction.feeLamports,
    feePayer: transaction.feePayerAddress,
    accounts,
    tokenRows,
    tokenBalancesAvailable: transaction.tokenBalancesAvailable,
    undecoded,
  };
}

function changeByIndex(
  transaction: NormalizedTransaction,
  index: number,
): NormalizedTransaction['solBalanceChanges'][number] | undefined {
  // `solBalanceChanges` is ordered by account index, but the transaction's account
  // list is not guaranteed to line up positionally with a sparse change list, so
  // this stays a lookup rather than an index guess.
  return transaction.solBalanceChanges.find(change => change.accountIndex === index);
}
