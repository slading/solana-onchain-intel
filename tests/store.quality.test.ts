/**
 * The evidence-quality rule, on its own (no store, no SQLite, no network).
 *
 * This is the rule that decides whether a new observation of a transaction may replace the
 * evidence already stored for it, so it is small enough to be pinned exactly:
 *
 *   1. `meta` presence, then
 *   2. completeness (inner instructions 8, token balances 4, block time 2, logs 1), then
 *   3. commitment (`processed` < `confirmed` < `finalized`).
 *
 * A tie means "keep what is stored", which is what makes repeated ingestion deterministic.
 */

import { describe, expect, it } from 'vitest';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import {
  COMMITMENT_RANK,
  COMPLETENESS_WEIGHTS,
  compareEvidenceQuality,
  completenessScore,
  describeEvidenceQuality,
  evidenceQualityOf,
  type EvidenceQuality,
} from '../src/store/quality.ts';
import { fixtureObservation, fixtureRaw, degrade } from './helpers/store.ts';

function quality(overrides: Partial<EvidenceQuality> = {}): EvidenceQuality {
  return {
    metaPresent: true,
    innerInstructionsAvailable: false,
    tokenBalancesAvailable: false,
    blockTimeAvailable: false,
    logsPresent: false,
    commitment: 'confirmed',
    ...overrides,
  };
}

describe('evidence quality: the comparison rule', () => {
  it('weights completeness exactly as documented, up to 15', () => {
    expect(COMPLETENESS_WEIGHTS).toEqual({
      innerInstructionsAvailable: 8,
      tokenBalancesAvailable: 4,
      blockTimeAvailable: 2,
      logsPresent: 1,
    });
    expect(completenessScore(quality())).toBe(0);
    expect(completenessScore(quality({ logsPresent: true }))).toBe(1);
    expect(completenessScore(quality({ blockTimeAvailable: true, logsPresent: true }))).toBe(3);
    expect(completenessScore(quality({ tokenBalancesAvailable: true, blockTimeAvailable: true, logsPresent: true }))).toBe(7);
    expect(
      completenessScore(
        quality({
          innerInstructionsAvailable: true,
          tokenBalancesAvailable: true,
          blockTimeAvailable: true,
          logsPresent: true,
        }),
      ),
    ).toBe(15);
  });

  it('treats an absent meta block as strictly weaker than any present one', () => {
    const withoutMeta = quality({
      metaPresent: false,
      innerInstructionsAvailable: true,
      tokenBalancesAvailable: true,
      blockTimeAvailable: true,
      logsPresent: true,
      commitment: 'finalized',
    });
    expect(compareEvidenceQuality(withoutMeta, quality())).toBe('weaker');
    expect(compareEvidenceQuality(quality(), withoutMeta)).toBe('stronger');
  });

  it('compares completeness before commitment', () => {
    // Fewer dimensions but fully final must not outrank a richer, less final observation.
    const richProcessed = quality({ innerInstructionsAvailable: true, commitment: 'processed' });
    const poorFinalized = quality({ logsPresent: true, commitment: 'finalized' });
    expect(compareEvidenceQuality(richProcessed, poorFinalized)).toBe('stronger');
    expect(compareEvidenceQuality(poorFinalized, richProcessed)).toBe('weaker');
  });

  it('falls back to commitment only when everything else is equal', () => {
    expect(COMMITMENT_RANK).toEqual({ processed: 0, confirmed: 1, finalized: 2 });
    expect(compareEvidenceQuality(quality({ commitment: 'finalized' }), quality())).toBe('stronger');
    expect(compareEvidenceQuality(quality({ commitment: 'processed' }), quality())).toBe('weaker');
  });

  it('is total: the same quality compares equal, and comparison is antisymmetric', () => {
    const base = quality({ innerInstructionsAvailable: true, commitment: 'finalized' });
    expect(compareEvidenceQuality(base, base)).toBe('equal');
    const other = quality({ innerInstructionsAvailable: true, commitment: 'finalized', logsPresent: true });
    expect(compareEvidenceQuality(other, base)).toBe('stronger');
    expect(compareEvidenceQuality(base, other)).toBe('weaker');
  });

  it('reads the dimensions from an observation without inventing any', () => {
    const observation = fixtureObservation('v0-success-pump-buy-24b');
    const full = normalizeTransaction(observation.raw, { provenance: observation.provenance });
    const fullQuality = evidenceQualityOf(full, 'finalized');
    expect(fullQuality).toEqual({
      metaPresent: true,
      innerInstructionsAvailable: true,
      tokenBalancesAvailable: true,
      blockTimeAvailable: true,
      logsPresent: true,
      commitment: 'finalized',
    });

    const degradedRaw = degrade(fixtureRaw('v0-success-pump-buy-24b'), {
      dropInnerInstructions: true,
      dropLogs: true,
    });
    const degraded = normalizeTransaction(degradedRaw, { provenance: observation.provenance });
    const degradedQuality = evidenceQualityOf(degraded, 'finalized');
    expect(degradedQuality.innerInstructionsAvailable).toBe(false);
    expect(degradedQuality.logsPresent).toBe(false);
    expect(compareEvidenceQuality(degradedQuality, fullQuality)).toBe('weaker');
    expect(compareEvidenceQuality(fullQuality, degradedQuality)).toBe('stronger');
    expect(completenessScore(degradedQuality)).toBeLessThan(completenessScore(fullQuality));
  });

  it('describes a quality in the same words the store records in fetch history', () => {
    const text = describeEvidenceQuality(
      quality({ innerInstructionsAvailable: true, blockTimeAvailable: true, commitment: 'processed' }),
    );
    expect(text).toContain('processed');
    expect(text).toContain('completeness 10/15');
    expect(text).toContain('inner-instructions');
    expect(text).toContain('missing token-balances');
  });
});
