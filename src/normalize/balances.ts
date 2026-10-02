import { asBigIntLike, asNumber, asRecord, asString, at, pick } from '../lib/read-json.ts';
import type {
  NormalizedAccount,
  NormalizedSolBalanceChange,
  NormalizedTokenBalanceChange,
} from '../model/transaction.ts';
import type { DiagnosticCollector } from './diagnostics.ts';

/**
 * Lamport deltas.
 *
 * `preBalances`/`postBalances` are index-aligned with the account list, so the
 * change for account `i` is `post[i] - pre[i]`. Note this includes the
 * transaction fee for the fee payer — we do not try to net it out.
 */
export function normalizeSolBalanceChanges(
  accounts: readonly NormalizedAccount[],
  preBalances: readonly unknown[] | null,
  postBalances: readonly unknown[] | null,
  diagnostics: DiagnosticCollector,
): readonly NormalizedSolBalanceChange[] {
  if (preBalances === null || postBalances === null) {
    diagnostics.warn(
      'sol-balances-missing',
      'meta.preBalances or meta.postBalances is absent; SOL balance changes cannot be computed.',
    );
    return [];
  }

  if (preBalances.length !== postBalances.length) {
    diagnostics.warn(
      'sol-balances-length-mismatch',
      `meta.preBalances has ${preBalances.length} entries but meta.postBalances has ` +
        `${postBalances.length}; missing values are left as null.`,
    );
  }
  if (preBalances.length !== accounts.length) {
    diagnostics.warn(
      'sol-balances-account-mismatch',
      `meta.preBalances has ${preBalances.length} entries but the transaction has ` +
        `${accounts.length} accounts; out-of-range entries are reported with a null address.`,
    );
  }

  const count = Math.max(preBalances.length, postBalances.length);
  const changes: NormalizedSolBalanceChange[] = [];
  for (let index = 0; index < count; index += 1) {
    const before = asBigIntLike(at(preBalances, index));
    const after = asBigIntLike(at(postBalances, index));
    changes.push({
      accountIndex: index,
      address: at(accounts, index)?.address ?? null,
      beforeLamports: before,
      afterLamports: after,
      deltaLamports: before !== null && after !== null ? after - before : null,
    });
  }
  return changes;
}

interface RawTokenAmount {
  readonly amount: bigint | null;
  readonly decimals: number | null;
  readonly uiAmountString: string | null;
}

function readTokenAmount(entry: Record<string, unknown>): RawTokenAmount {
  const uiTokenAmount = asRecord(pick(entry, 'uiTokenAmount'));
  return {
    // `amount` is the exact integer amount in the token's smallest unit.
    amount: asBigIntLike(uiTokenAmount === null ? undefined : pick(uiTokenAmount, 'amount')),
    decimals: asNumber(uiTokenAmount === null ? undefined : pick(uiTokenAmount, 'decimals')),
    uiAmountString: asString(
      uiTokenAmount === null ? undefined : pick(uiTokenAmount, 'uiAmountString'),
    ),
  };
}

/**
 * Token deltas, computed per (token account, mint).
 *
 * The RPC reports two independent lists. A token account that was created by the
 * transaction appears only in `postTokenBalances`; a closed one only in
 * `preTokenBalances`. In those cases there is no delta to compute, so we leave
 * `deltaAmount` null and record which side was reported instead of assuming 0.
 */
export function normalizeTokenBalanceChanges(
  accounts: readonly NormalizedAccount[],
  preTokenBalances: readonly unknown[] | null,
  postTokenBalances: readonly unknown[] | null,
  diagnostics: DiagnosticCollector,
): { changes: readonly NormalizedTokenBalanceChange[]; available: boolean } {
  if (preTokenBalances === null || postTokenBalances === null) {
    diagnostics.warn(
      'token-balances-missing',
      'meta.preTokenBalances or meta.postTokenBalances is absent (the node may have inner ' +
        'instruction recording disabled); token balance changes are unknown, not empty.',
    );
    return { changes: [], available: false };
  }

  interface Side {
    entry: Record<string, unknown>;
    amount: RawTokenAmount;
  }
  interface Bucket {
    accountIndex: number;
    mint: string | null;
    before?: Side;
    after?: Side;
  }

  const buckets = new Map<string, Bucket>();

  const ingest = (
    list: readonly unknown[],
    side: 'before' | 'after',
    label: string,
  ): void => {
    for (const item of list) {
      const entry = asRecord(item);
      const accountIndex = entry === null ? null : asNumber(pick(entry, 'accountIndex'));
      if (entry === null || accountIndex === null) {
        diagnostics.warn(
          'token-balance-entry-malformed',
          `${label} contains an entry without a numeric accountIndex; preserved in raw only.`,
        );
        continue;
      }
      const mint = asString(pick(entry, 'mint'));
      const key = `${accountIndex}|${mint ?? ''}`;
      const bucket = buckets.get(key) ?? { accountIndex, mint };
      bucket[side] = { entry, amount: readTokenAmount(entry) };
      buckets.set(key, bucket);
    }
  };

  ingest(preTokenBalances, 'before', 'meta.preTokenBalances');
  ingest(postTokenBalances, 'after', 'meta.postTokenBalances');

  const changes: NormalizedTokenBalanceChange[] = [];
  for (const bucket of buckets.values()) {
    const { accountIndex, mint, before, after } = bucket;

    const address = at(accounts, accountIndex)?.address ?? null;
    if (address === null) {
      diagnostics.warn(
        'token-balance-account-index-out-of-range',
        `Token balance entry references account index ${accountIndex}, which is outside the ` +
          `${accounts.length}-account list; the address is left null.`,
      );
    }

    const beforeAmount = before?.amount.amount ?? null;
    const afterAmount = after?.amount.amount ?? null;
    if (before !== undefined && beforeAmount === null) {
      diagnostics.warn(
        'token-amount-unparsable',
        `meta.preTokenBalances amount for account ${accountIndex} is not an integer string.`,
      );
    }
    if (after !== undefined && afterAmount === null) {
      diagnostics.warn(
        'token-amount-unparsable',
        `meta.postTokenBalances amount for account ${accountIndex} is not an integer string.`,
      );
    }

    const presence =
      before !== undefined && after !== undefined
        ? 'both'
        : after !== undefined
          ? 'only-after'
          : 'only-before';
    if (presence === 'only-after') {
      diagnostics.info(
        'token-account-created',
        `Token account for accountIndex ${accountIndex} appears only in postTokenBalances ` +
          `(created during this transaction); no delta is reported.`,
      );
    } else if (presence === 'only-before') {
      diagnostics.info(
        'token-account-closed',
        `Token account for accountIndex ${accountIndex} appears only in preTokenBalances ` +
          `(closed during this transaction); no delta is reported.`,
      );
    }

    changes.push({
      accountIndex,
      address,
      mint,
      owner: asString(pick(before?.entry ?? after?.entry ?? {}, 'owner')),
      programId: asString(pick(before?.entry ?? after?.entry ?? {}, 'programId')),
      // Decimals come from whichever side reported them; both agree in practice.
      decimals: before?.amount.decimals ?? after?.amount.decimals ?? null,
      beforeAmount,
      afterAmount,
      deltaAmount:
        beforeAmount !== null && afterAmount !== null ? afterAmount - beforeAmount : null,
      beforeUiAmountString: before?.amount.uiAmountString ?? null,
      afterUiAmountString: after?.amount.uiAmountString ?? null,
      presence,
    });
  }

  changes.sort((a, b) =>
    a.accountIndex === b.accountIndex
      ? compareNullableStrings(a.mint, b.mint)
      : a.accountIndex - b.accountIndex,
  );

  return { changes, available: true };
}

function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}
