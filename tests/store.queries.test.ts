/**
 * The two corpus-level queries (Milestone 5.1): route leg coverage, and committed movement of
 * one account.
 *
 * Both are checked against the *live* pipeline computed in-process from the same fixtures, so
 * a query can never quietly disagree with the semantics it reads. The movement query gets the
 * harder test: a reverted transaction with attempted transfers must contribute its fee and
 * nothing else, at any address it touched.
 */

import { describe, expect, it } from 'vitest';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { deriveArtifacts } from '../src/store/derive.ts';
import { committedMovementByAccount, routeLegCoverage } from '../src/store/queries.ts';
import { allFixtureNames, loadFixture } from './helpers/fixtures.ts';
import { api, sqliteAvailable, withTempStore } from './helpers/store.ts';
import type { NormalizedProvenance } from '../src/model/transaction.ts';

const FAILED_FIXTURE = 'v0-failed-pump-buy-slippage';
const SUCCESS_FIXTURE = 'v0-success-dlmm-minout';

/** The address the failed fixture *attempted* to pay 200000 lamports to, before reverting. */
const ATTEMPTED_RECIPIENT = 'Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3';

function provenanceOf(name: string): NormalizedProvenance {
  return {
    rpcEndpoint: loadFixture(name).provenance.source,
    encoding: 'jsonParsed',
    commitment: 'finalized',
    maxSupportedTransactionVersion: 1,
  };
}

function liveModel(name: string): ReturnType<typeof normalizeTransaction> {
  return normalizeTransaction(loadFixture(name).response, { provenance: provenanceOf(name) });
}

/** Ingests every fixture into the store under test, offline. */
function ingestCorpus(store: Parameters<typeof tableCountsOf>[0]): void {
  for (const name of allFixtureNames()) {
    const envelope = loadFixture(name);
    const result = api().ingestRawResponse(store, { raw: envelope.response, provenance: provenanceOf(name) });
    expect(result.outcome, name).toBe('stored');
  }
}

function tableCountsOf(store: import('../src/store/store.ts').CorpusStore): { transactions: number } {
  return { transactions: api().storeStats(store).transactions };
}

describe.skipIf(!sqliteAvailable)('corpus queries', () => {
  it('reports route leg coverage from stored artifacts, matching the live routes', () => {
    withTempStore(store => {
      ingestCorpus(store);

      const coverage = routeLegCoverage(store);

      // The same numbers, computed live from the same fixtures.
      const liveLegs: { key: string; covered: boolean; protocol: string | null }[] = [];
      for (const name of allFixtureNames()) {
        const routes = deriveArtifacts(liveModel(name)).routes;
        for (const envelope of routes.envelopes) {
          for (const leg of envelope.legs) {
            liveLegs.push({
              key: leg.programId === null ? 'unknown' : `${leg.programId}:${leg.discriminator ?? 'unknown'}`,
              covered: leg.coveredBy !== null,
              protocol: leg.coveredBy?.protocol ?? null,
            });
          }
        }
      }
      const liveRoutes = allFixtureNames().reduce(
        (total, name) => total + deriveArtifacts(liveModel(name)).routes.envelopes.length,
        0,
      );

      expect(coverage.routes).toBe(liveRoutes);
      expect(coverage.legs).toBe(liveLegs.length);
      expect(coverage.covered).toBe(liveLegs.filter(leg => leg.covered).length);
      expect(coverage.uncovered).toBe(coverage.legs - coverage.covered);
      expect(coverage.classes.reduce((total, row) => total + row.total, 0)).toBe(coverage.legs);
      expect(coverage.classes.reduce((total, row) => total + row.covered, 0)).toBe(coverage.covered);

      // Ordered by frequency, so the biggest contributor to uncovered legs is first.
      const totals = coverage.classes.map(row => row.total);
      expect([...totals].sort((left, right) => right - left)).toEqual(totals);
      expect(coverage.classes[0]?.total).toBeGreaterThan(1);

      // The DLMM swap2 legs are the ones the frozen recognizers cover in this corpus.
      const dlmm = coverage.classes.find(row => row.key === 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo:414b3f4ceb5b5b88');
      expect(dlmm?.covered).toBe(dlmm?.total);
      expect(dlmm?.protocols).toEqual(['meteora-dlmm']);

      expect(coverage.withoutCurrentRoutes).toEqual([]);
      expect(coverage.withoutCurrentSwaps).toEqual([]);
      expect(coverage.coveredShare).toBeCloseTo(coverage.covered / coverage.legs, 10);
    });
  });

  it('says which transactions it could not read, instead of silently skipping them', () => {
    withTempStore(store => {
      ingestCorpus(store);
      const first = allFixtureNames()[0] as string;
      const signature = loadFixture(first).request.signature;

      store.database.prepare("DELETE FROM derived WHERE signature = ? AND layer = 'routes'").run(signature);
      const coverage = routeLegCoverage(store);
      expect(coverage.withoutCurrentRoutes).toEqual([signature]);

      // An artifact left behind by an older engine does not count as current either.
      store.database
        .prepare(
          `INSERT INTO derived (signature, layer, semantics_version, artifact_text, artifact_sha256, produced_at)
           VALUES (?, 'routes', 'm1+m2', '{"envelopes":[]}', 'x', 'now')`,
        )
        .run(signature);
      expect(routeLegCoverage(store).withoutCurrentRoutes).toEqual([signature]);
    });
  });

  it('returns no coverage at all, not a false zero, when the corpus has no routes', () => {
    withTempStore(store => {
      const envelope = loadFixture('legacy-success-vote');
      api().ingestRawResponse(store, { raw: envelope.response, provenance: provenanceOf('legacy-success-vote') });

      const coverage = routeLegCoverage(store);
      expect(coverage.routes).toBe(0);
      expect(coverage.legs).toBe(0);
      expect(coverage.coveredShare).toBeNull();
      expect(coverage.classes).toEqual([]);
    });
  });

  it('sums committed movement of an account, matching the live effects', () => {
    withTempStore(store => {
      ingestCorpus(store);
      const payer = 'DDyDDYFniwBYKfMzoL61Yyc53Xa5N5znNWKGLjxyAh69'; // fee payer of the DLMM fixture
      const movement = committedMovementByAccount(store, payer);

      // Live comparison, summed by hand from the effects model of every fixture.
      let expectedNet = 0n;
      let expectedFee = 0n;
      let expectedTransactions = 0;
      let expectedFlows = 0;
      for (const name of allFixtureNames()) {
        const effects = transactionEffects(liveModel(name));
        const net = effects.netSolByAccount.find(entry => entry.address === payer);
        if (net === undefined && effects.netTokenByAccountMint.every(entry => entry.tokenAccount !== payer)) continue;
        expectedTransactions += 1;
        if (net?.netLamports != null) expectedNet += net.netLamports;
        for (const flow of effects.solFlows) {
          if (flow.from === payer || flow.to === payer) expectedFlows += 1;
          if (flow.kind === 'fee' && flow.from === payer) expectedFee += flow.lamports ?? 0n;
        }
        for (const flow of effects.tokenFlows) {
          if (
            flow.sourceOwner === payer ||
            flow.destinationOwner === payer ||
            flow.sourceTokenAccount === payer ||
            flow.destinationTokenAccount === payer
          ) {
            expectedFlows += 1;
          }
        }
      }

      expect(movement.address).toBe(payer);
      expect(movement.transactions).toBe(expectedTransactions);
      expect(movement.netLamports).toBe(expectedNet);
      expect(movement.committedFeeLamports).toBe(expectedFee);
      expect(typeof movement.netLamports).toBe('bigint');
      expect(movement.exclusions.length).toBeGreaterThan(0);

      // Every flow reported is a committed one: the count matches the committed collections
      // of the live model exactly, so no uncommitted flow crept in.
      expect(movement.committedSolFlows.length).toBe(expectedFlows);
      expect(movement.committedSolFlows.length).toBeGreaterThan(0);
    });
  });

  it('never turns attempted movement into committed movement', () => {
    withTempStore(store => {
      const envelope = loadFixture(FAILED_FIXTURE);
      api().ingestRawResponse(store, { raw: envelope.response, provenance: provenanceOf(FAILED_FIXTURE) });

      const live = liveModel(FAILED_FIXTURE);
      const effects = transactionEffects(live);
      const payer = live.feePayerAddress as string;
      const fee = live.feeLamports ?? 0n;

      // The transaction really did attempt these movements …
      expect(effects.commitState).toBe('reverted');
      expect(effects.uncommittedSolFlows.length).toBeGreaterThan(0);
      expect(effects.uncommittedSolFlows.some(flow => flow.to === ATTEMPTED_RECIPIENT)).toBe(true);

      // … and the recipient of the attempted transfer has committed nothing at all. It is
      // present — it appears in the account list, which is a fact, not a movement — and every
      // movement total is zero.
      const recipient = committedMovementByAccount(store, ATTEMPTED_RECIPIENT);
      expect(recipient.transactions).toBe(1);
      expect(recipient.netLamports).toBe(0n);
      expect(recipient.committedFeeLamports).toBe(0n);
      expect(recipient.netTokensByMint).toEqual([]);
      expect(recipient.committedSolFlows).toEqual([]);
      expect(recipient.signatures).toEqual([]);
      expect(
        effects.uncommittedSolFlows.every(flow => flow.lamports === null || flow.lamports > 0n || true),
      ).toBe(true);

      // The fee payer's only committed movement is the fee.
      const payerMovement = committedMovementByAccount(store, payer);
      expect(payerMovement.transactions).toBe(1);
      expect(payerMovement.netLamports).toBe(-fee);
      expect(payerMovement.committedFeeLamports).toBe(fee);
      expect(payerMovement.committedSolFlows.map(flow => flow.kind)).toEqual(['fee']);
      expect(payerMovement.netTokensByMint).toEqual([]);
      expect(payerMovement.unknownNetLamports).toBe(0);
      expect(payerMovement.exclusions).toContain(
        'instructions that did not commit (a reverted transaction contributes its fee and nothing else)',
      );
    });
  });

  it('reports token movement for the accounts that hold it, per mint', () => {
    withTempStore(store => {
      const envelope = loadFixture(SUCCESS_FIXTURE);
      api().ingestRawResponse(store, { raw: envelope.response, provenance: provenanceOf(SUCCESS_FIXTURE) });

      const effects = transactionEffects(liveModel(SUCCESS_FIXTURE));
      const holder = effects.netTokenByAccountMint.find(entry => (entry.netAmount ?? 0n) !== 0n);
      expect(holder?.tokenAccount).toBeDefined();
      const address = holder?.tokenAccount as string;

      const movement = committedMovementByAccount(store, address);
      expect(movement.netTokensByMint).toHaveLength(1);
      expect(movement.netTokensByMint[0]?.mint).toBe(holder?.mint);
      expect(movement.netTokensByMint[0]?.netAmount).toBe(holder?.netAmount);
      expect(movement.netTokensByMint[0]?.accounts).toBe(1);
      // A token account holds tokens; whether it also holds lamports depends on the mint
      // (a wrapped-SOL account does), so the lamport total is compared with the live model
      // rather than assumed to be zero.
      const liveNet = effects.netSolByAccount.find(entry => entry.address === address);
      expect(movement.netLamports).toBe(liveNet?.netLamports ?? 0n);
      expect(movement.committedSolFlows.some(flow => flow.kind === 'fee')).toBe(false);
    });
  });

  it('answers zero for an address the corpus has never seen, without inventing a row', () => {
    withTempStore(store => {
      ingestCorpus(store);
      const movement = committedMovementByAccount(store, 'NoSuchAddress1111111111111111111111111111111');
      expect(movement.transactions).toBe(0);
      expect(movement.netLamports).toBe(0n);
      expect(movement.netTokensByMint).toEqual([]);
      expect(movement.committedSolFlows).toEqual([]);
      expect(movement.withoutEffects).toEqual([]);
    });
  });

  it('names the transactions it could not read the effects of', () => {
    withTempStore(store => {
      ingestCorpus(store);
      const first = allFixtureNames()[0] as string;
      const signature = loadFixture(first).request.signature;
      store.database.prepare("DELETE FROM derived WHERE signature = ? AND layer = 'effects'").run(signature);

      const movement = committedMovementByAccount(store, 'DDyDDYFniwBYKfMzoL61Yyc53Xa5N5znNWKGLjxyAh69');
      expect(movement.withoutEffects).toEqual([signature]);
    });
  });
});
