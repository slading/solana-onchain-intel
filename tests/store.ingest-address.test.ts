/**
 * Bounded address ingestion: `store run <ADDRESS>`.
 *
 * Ingestion is pull-based and resumable, and the ways it can go wrong are all about *state*:
 * a duplicated signature across pages, a signature already stored, a rate limit in the
 * middle of a page, a page request that fails outright. Each test below asserts the same
 * invariant from a different angle: the corpus never holds a fact twice, never holds a
 * signature it did not persist, and never advances past work it did not do.
 */

import { describe, expect, it } from 'vitest';
import {
  api,
  artifactText,
  FakeRpc,
  fetchRows,
  fixtureObservation,
  fixtureSignature,
  rateLimitError,
  tableCounts,
  transportError,
  withTempStoreAsync,
} from './helpers/store.ts';
import { sqliteAvailable } from './helpers/store.ts';

const FIRST = 'v0-success-pump-buy-24b';
const SECOND = 'legacy-success-vote';
const THIRD = 'v0-success-swap';
const ADDRESS = 'uLhhyDHziqGRF2GLhJnSCu4AcRkWhF2rWBYLAncheVT';

function pageOf(...names: readonly string[]): readonly { readonly signature: string; readonly slot: number }[] {
  return names.map((name, index) => ({ signature: fixtureSignature(name), slot: 1000 - index }));
}

function inputFor(name: string): { readonly raw: unknown; readonly provenance: ReturnType<typeof fixtureObservation>['provenance'] } {
  const observation = fixtureObservation(name);
  return { raw: observation.raw, provenance: observation.provenance };
}

describe.skipIf(!sqliteAvailable)('corpus store: bounded address ingestion', () => {
  it('ingests a page, skipping signatures it already holds without spending a request', async () => {
    const present = fixtureObservation(FIRST);
    const rpc = new FakeRpc(
      new Map([
        [fixtureSignature(FIRST), present.raw],
        [fixtureSignature(SECOND), inputFor(SECOND).raw],
      ]),
      [pageOf(FIRST, SECOND)],
    );

    await withTempStoreAsync(async store => {
      // Pre-seed one transaction, then sweep an address whose page starts with it.
      api().ingestRawResponse(store, present);

      const result = await api().ingestAddress(store, {
        rpc,
        address: ADDRESS,
        max: 10,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });

      expect(result.examined).toBe(2);
      expect(result.skippedPresent).toBe(1);
      expect(result.stored).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.halted).toBe(false);
      expect(tableCounts(store)).toEqual({
        transactions: 2,
        raw_responses: 2,
        fetches: 2,
        derived: 8,
        ingest_cursors: 1,
      });

      // The already-stored signature cost no `getTransaction` call at all.
      const requested = rpc.transactionCalls.map(call => call.signature);
      expect(requested).toEqual([fixtureSignature(SECOND)]);
      const cursor = api().readCursor(store, ADDRESS);
      expect(cursor?.beforeSignature).toBe(fixtureSignature(SECOND));
      expect(cursor?.complete).toBe(true);
    });
  });

  it('stays idempotent when a page repeats a signature, and across repeated runs', async () => {
    const rpc = new FakeRpc(
      new Map([
        [fixtureSignature(FIRST), inputFor(FIRST).raw],
        [fixtureSignature(SECOND), inputFor(SECOND).raw],
      ]),
      // The same second signature appears on both pages, exactly like a moving ledger does.
      [pageOf(FIRST, SECOND), [{ signature: fixtureSignature(SECOND), slot: 999 }], pageOf(FIRST, SECOND)],
    );

    await withTempStoreAsync(async store => {
      const first = await api().ingestAddress(store, {
        rpc,
        address: ADDRESS,
        max: 10,
        pageLimit: 2,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });
      expect(first.stored).toBe(2);
      expect(tableCounts(store)).toEqual({
        transactions: 2,
        raw_responses: 2,
        fetches: 2,
        derived: 8,
        ingest_cursors: 1,
      });

      // A second run over the same address adds nothing new: everything is already stored.
      const second = await api().ingestAddress(store, {
        rpc,
        address: ADDRESS,
        max: 10,
        pageLimit: 2,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });
      expect(second.stored).toBe(0);
      expect(second.skippedPresent).toBe(2);
      expect(tableCounts(store)).toEqual({
        transactions: 2,
        raw_responses: 2,
        fetches: 2,
        derived: 8,
        ingest_cursors: 1,
      });
      expect(rpc.transactionCalls).toHaveLength(2);
    });
  });

  it('stops on a retryable failure with the cursor before it, and resumes without skipping', async () => {
    const rpc = new FakeRpc(
      new Map([
        [fixtureSignature(FIRST), inputFor(FIRST).raw],
        [fixtureSignature(SECOND), rateLimitError()],
        [fixtureSignature(THIRD), inputFor(THIRD).raw],
      ]),
      [pageOf(FIRST, SECOND, THIRD)],
    );

    await withTempStoreAsync(async store => {
      const result = await api().ingestAddress(store, {
        rpc,
        address: ADDRESS,
        max: 10,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });

      expect(result.halted).toBe(true);
      expect(result.retryable).toBe(true);
      expect(result.errors).toBe(1);
      expect(result.detail).toContain(fixtureSignature(SECOND));

      // The failed signature is not in the corpus, and its attempt is recorded as retryable.
      expect(api().hasTransaction(store, fixtureSignature(SECOND))).toBe(false);
      const failed = fetchRows(store, fixtureSignature(SECOND));
      expect(failed.map(row => row.outcome)).toEqual(['rpc-error']);
      expect(failed[0]?.retryable).toBe(1);

      // The cursor points at the last signature that was handled, so the retry returns to
      // the one that failed — and the third signature on the page was not persisted, so it
      // was not skipped either.
      const cursor = api().readCursor(store, ADDRESS);
      expect(cursor?.beforeSignature).toBe(fixtureSignature(FIRST));
      expect(cursor?.complete).toBe(false);
      expect(api().hasTransaction(store, fixtureSignature(THIRD))).toBe(false);
      expect(rpc.transactionCalls.map(call => call.signature)).toEqual([
        fixtureSignature(FIRST),
        fixtureSignature(SECOND),
      ]);
    });
  });

  it('leaves the cursor untouched when the page request itself fails, then resumes', async () => {
    const rpc = new FakeRpc(new Map([[fixtureSignature(FIRST), inputFor(FIRST).raw]]), [
      pageOf(FIRST),
      transportError(),
      pageOf(FIRST),
    ]);

    await withTempStoreAsync(async store => {
      const ok = await api().ingestAddress(store, {
        rpc,
        address: ADDRESS,
        max: 10,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });
      expect(ok.stored).toBe(1);
      const afterOk = api().readCursor(store, ADDRESS);

      const failed = await api().ingestAddress(store, {
        rpc,
        address: ADDRESS,
        max: 10,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });
      expect(failed.halted).toBe(true);
      expect(failed.retryable).toBe(true);
      expect(failed.pages).toBe(0);
      expect(failed.detail).toContain('page request failed');
      expect(api().readCursor(store, ADDRESS)?.beforeSignature).toBe(afterOk?.beforeSignature);

      // The third attempt gets the same page again and finds the work already done.
      const resumed = await api().ingestAddress(store, {
        rpc,
        address: ADDRESS,
        max: 10,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });
      expect(resumed.skippedPresent).toBe(1);
      expect(tableCounts(store)).toEqual({
        transactions: 1,
        raw_responses: 1,
        fetches: 1,
        derived: 4,
        ingest_cursors: 1,
      });
    });
  });

  it('honours the bound, one page at a time', async () => {
    const rpc = new FakeRpc(
      new Map([
        [fixtureSignature(FIRST), inputFor(FIRST).raw],
        [fixtureSignature(SECOND), inputFor(SECOND).raw],
        [fixtureSignature(THIRD), inputFor(THIRD).raw],
      ]),
      [pageOf(FIRST, SECOND), pageOf(THIRD)],
    );

    await withTempStoreAsync(async store => {
      const result = await api().ingestAddress(store, {
        rpc,
        address: ADDRESS,
        max: 2,
        pageLimit: 2,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });
      expect(result.examined).toBe(2);
      expect(result.stored).toBe(2);
      expect(result.complete).toBe(false);
      expect(result.cursor).toBe(fixtureSignature(SECOND));
      expect(tableCounts(store).transactions).toBe(2);
      expect(api().readCursor(store, ADDRESS)?.complete).toBe(false);

      // A second bounded run continues from the cursor rather than restarting.
      const next = await api().ingestAddress(store, {
        rpc,
        address: ADDRESS,
        max: 2,
        pageLimit: 2,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });
      expect(next.stored).toBe(1);
      expect(next.complete).toBe(true);
      expect(rpc.pageCalls[1]?.['config']['before']).toBe(fixtureSignature(SECOND));
      expect(tableCounts(store).transactions).toBe(3);
    });
  });

  it('records a not-found inside a page as history and carries on', async () => {
    const rpc = new FakeRpc(
      new Map([[fixtureSignature(FIRST), null]]),
      [pageOf(FIRST, SECOND)],
    );

    await withTempStoreAsync(async store => {
      const result = await api().ingestAddress(store, {
        rpc,
        address: ADDRESS,
        max: 10,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });

      expect(result.notFound).toBe(2);
      expect(result.halted).toBe(false);
      expect(result.complete).toBe(true);
      expect(tableCounts(store).transactions).toBe(0);
      expect(fetchRows(store, fixtureSignature(FIRST)).map(row => row.outcome)).toEqual(['not-found']);
      // A not-found is a definitive outcome, so the cursor advances past it.
      expect(api().readCursor(store, ADDRESS)?.beforeSignature).toBe(fixtureSignature(SECOND));
    });
  });

  it('rejects a page response it does not understand instead of treating it as empty', async () => {
    const rpc = new FakeRpc(new Map(), [{ signature: fixtureSignature(FIRST), slot: 1 } as never]);

    await withTempStoreAsync(async store => {
      // A page that is an array of objects without a signature is a protocol error, not a
      // history that happens to be empty.
      const broken = new FakeRpc(new Map(), [[{ slot: 7 } as never]]);
      const result = await api().ingestAddress(store, {
        rpc: broken,
        address: ADDRESS,
        max: 10,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });
      expect(result.halted).toBe(true);
      expect(result.detail).toContain('no signature');
      expect(tableCounts(store).transactions).toBe(0);
      expect(rpc.pageCalls).toHaveLength(0);
    });
  });

  it('never re-writes evidence for a signature that is already stored', async () => {
    const rpc = new FakeRpc(
      new Map([[fixtureSignature(FIRST), inputFor(FIRST).raw]]),
      [pageOf(FIRST)],
    );

    await withTempStoreAsync(async store => {
      api().ingestRawResponse(store, fixtureObservation(FIRST));
      const rawBefore = store.database.prepare('SELECT raw_text, raw_sha256, observed_at FROM raw_responses').get();

      await api().ingestAddress(store, {
        rpc,
        address: ADDRESS,
        max: 10,
        rpcEndpoint: 'https://fixture.invalid',
        commitment: 'finalized',
      });

      expect(store.database.prepare('SELECT raw_text, raw_sha256, observed_at FROM raw_responses').get()).toEqual(
        rawBefore,
      );
      // No fetch history row either: the signature was never requested.
      expect(fetchRows(store, fixtureSignature(FIRST))).toHaveLength(1);
      expect(artifactText(store, fixtureSignature(FIRST), 'normalized')).not.toBeNull();
    });
  });
});
