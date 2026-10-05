/**
 * Evidence quality, and the rule that keeps a weaker observation from overwriting a
 * stronger one (Milestone 5.1).
 *
 * The same signature can be observed more than once, and the responses differ in ways
 * that decide what can be *derived* from them:
 *
 *  - `meta` absent            -> no status, no fee, no balances, no CPIs: almost nothing
 *  - `innerInstructions: null` -> the CPI instructions were not recorded by that node
 *  - `pre/postTokenBalances` absent -> no token movement at all
 *  - `blockTime` absent       -> no wall-clock time
 *  - `logs: null`             -> no program logs (supplemental, but evidence)
 *  - `commitment`             -> how final the observation is (`processed` … `finalized`)
 *
 * The order below is deliberate, and it is the whole rule:
 *
 *  1. **`meta` presence** first. Without it the response cannot support a status, a fee
 *     or any balance reconciliation, so it is not comparable to one that can.
 *  2. **completeness** (inner instructions, token balances, block time, logs), weighted
 *     8/4/2/1. A `processed` response that recorded the CPI tree is strictly more useful
 *     for re-analysis than a `finalized` one that recorded nothing.
 *  3. **commitment** last, because it decides *finality claims*, not how much can be
 *     derived — and it is the only dimension that is not a property of the payload
 *     itself (it comes from how we asked).
 *
 * Ties are resolved by keeping what is already stored: the first observation of a given
 * quality wins, so repeated ingestion is deterministic and never rewrites evidence.
 */

import type { NormalizedTransaction } from '../model/transaction.ts';
import type { CommitmentLevel } from '../rpc/client.ts';

/** The dimensions compared, in the order they are compared. */
export const QUALITY_DIMENSIONS = [
  'metaPresent',
  'innerInstructionsAvailable',
  'tokenBalancesAvailable',
  'blockTimeAvailable',
  'logsPresent',
  'commitment',
] as const;

export interface EvidenceQuality {
  /** `meta` was present, i.e. the response carries status/fee/balances. */
  readonly metaPresent: boolean;
  /** `meta.innerInstructions` was recorded (not `null`). */
  readonly innerInstructionsAvailable: boolean;
  /** Token balance data was reported. */
  readonly tokenBalancesAvailable: boolean;
  /** `blockTime` was reported. */
  readonly blockTimeAvailable: boolean;
  /** Logs were reported (`null` = the node sent none, `[]` = the program logged nothing). */
  readonly logsPresent: boolean;
  /** How final this observation is. Not a property of the payload — it is how we asked. */
  readonly commitment: CommitmentLevel;
}

/** Commitment ordering, lowest to highest. */
export const COMMITMENT_RANK: Readonly<Record<CommitmentLevel, number>> = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
};

/** Bit weights of the completeness dimensions; the maximum is 15. */
export const COMPLETENESS_WEIGHTS = {
  innerInstructionsAvailable: 8,
  tokenBalancesAvailable: 4,
  blockTimeAvailable: 2,
  logsPresent: 1,
} as const;

/** How much of the derivable evidence this observation carries, 0…15. */
export function completenessScore(quality: EvidenceQuality): number {
  return (
    (quality.innerInstructionsAvailable ? COMPLETENESS_WEIGHTS.innerInstructionsAvailable : 0) +
    (quality.tokenBalancesAvailable ? COMPLETENESS_WEIGHTS.tokenBalancesAvailable : 0) +
    (quality.blockTimeAvailable ? COMPLETENESS_WEIGHTS.blockTimeAvailable : 0) +
    (quality.logsPresent ? COMPLETENESS_WEIGHTS.logsPresent : 0)
  );
}

/**
 * Reads the quality dimensions out of a normalized transaction.
 *
 * `commitment` is not in the payload, so it is passed in from the provenance of the
 * observation — which is exactly how `normalizeTransaction` records it too.
 */
export function evidenceQualityOf(
  transaction: NormalizedTransaction,
  commitment: CommitmentLevel,
): EvidenceQuality {
  return {
    // `status: 'unknown'` is how the normalizer reports an absent `meta` block.
    metaPresent: transaction.status !== 'unknown',
    innerInstructionsAvailable: transaction.innerInstructionsAvailable,
    tokenBalancesAvailable: transaction.tokenBalancesAvailable,
    blockTimeAvailable: transaction.blockTimeUnix !== null,
    logsPresent: transaction.logs !== null,
    commitment,
  };
}

export type QualityComparison = 'stronger' | 'equal' | 'weaker';

/**
 * Compares a new observation against the stored preference.
 *
 * Deterministic and total: every pair of qualities maps to exactly one of the three
 * outcomes, so ingestion order cannot change the stored evidence.
 */
export function compareEvidenceQuality(next: EvidenceQuality, stored: EvidenceQuality): QualityComparison {
  if (next.metaPresent !== stored.metaPresent) return next.metaPresent ? 'stronger' : 'weaker';
  const nextCompleteness = completenessScore(next);
  const storedCompleteness = completenessScore(stored);
  if (nextCompleteness !== storedCompleteness) {
    return nextCompleteness > storedCompleteness ? 'stronger' : 'weaker';
  }
  const nextCommitment = COMMITMENT_RANK[next.commitment];
  const storedCommitment = COMMITMENT_RANK[stored.commitment];
  if (nextCommitment !== storedCommitment) {
    return nextCommitment > storedCommitment ? 'stronger' : 'weaker';
  }
  return 'equal';
}

/**
 * One-line description used in `fetches.detail` and in CLI output, so an operator can
 * see *why* an ingest replaced or kept evidence without reading the columns.
 */
export function describeEvidenceQuality(quality: EvidenceQuality): string {
  const present: string[] = [];
  const absent: string[] = [];
  const push = (label: string, has: boolean): void => {
    (has ? present : absent).push(label);
  };
  push('meta', quality.metaPresent);
  push('inner-instructions', quality.innerInstructionsAvailable);
  push('token-balances', quality.tokenBalancesAvailable);
  push('block-time', quality.blockTimeAvailable);
  push('logs', quality.logsPresent);
  return (
    `${quality.commitment}; completeness ${completenessScore(quality)}/15 ` +
    `(${present.length === 0 ? 'nothing' : present.join('+')}` +
    `${absent.length === 0 ? '' : `; missing ${absent.join(',')}`})`
  );
}
