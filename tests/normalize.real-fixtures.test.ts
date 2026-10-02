import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { allFixtureNames, loadFixture, normalizeFixture } from './helpers/fixtures.ts';

/**
 * Every fixture under ./fixtures is a real mainnet getTransaction response, so
 * these tests pin the normalizer to data shapes Solana actually produces.
 */
describe('each recorded mainnet fixture', () => {
  const names = allFixtureNames();

  it('has fixtures to test', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)('%s normalizes deterministically and preserves raw', name => {
    const first = normalizeFixture(name);
    const second = normalizeFixture(name);

    // Determinism: normalizing the same response twice yields identical output.
    expect(stringifyJson(second.transaction)).toBe(stringifyJson(first.transaction));

    // Raw is always reachable and byte-identical to what the RPC sent.
    expect(stringifyJson(first.transaction.raw)).toBe(stringifyJson(first.envelope.response));

    // The model's signature is the transaction id the fixture was requested with.
    expect(first.transaction.signature).toBe(first.envelope.request.signature);
    expect(first.transaction.signatures[0]).toBe(first.transaction.signature);
  });

  /**
   * Lamports are conserved: every lamport moved out of one account lands in
   * another, except for the fee, which leaves the accounts entirely. So the sum
   * of all deltas must be exactly `-fee`. This doubles as a strong check that our
   * account/balance index alignment matches the RPC's.
   */
  it.each(names)('%s conserves lamports (sum of deltas === -fee)', name => {
    const { transaction } = normalizeFixture(name);
    const total = transaction.solBalanceChanges.reduce(
      (sum, change) => sum + (change.deltaLamports ?? 0n),
      0n,
    );
    expect(total).toBe(-(transaction.feeLamports ?? 0n));
  });

  it.each(names)('%s keeps account indices aligned with balances', name => {
    const { transaction } = normalizeFixture(name);

    transaction.accounts.forEach((account, index) => {
      expect(account.index).toBe(index);
      expect(account.address.length).toBeGreaterThan(0);
    });
    transaction.solBalanceChanges.forEach(change => {
      expect(change.accountIndex).toBeGreaterThanOrEqual(0);
      expect(change.accountIndex).toBeLessThan(transaction.accounts.length);
      // The account list and the balance arrays come from the same node, so the
      // address must have been resolvable.
      expect(change.address).toBe(transaction.accounts[change.accountIndex]?.address);
    });
    transaction.tokenBalanceChanges.forEach(change => {
      expect(change.address).toBe(transaction.accounts[change.accountIndex]?.address);
      if (change.beforeAmount !== null && change.afterAmount !== null) {
        expect(change.deltaAmount).toBe(change.afterAmount - change.beforeAmount);
      } else {
        expect(change.deltaAmount).toBeNull();
      }
    });
  });

  it.each(names)('%s resolves every inner-instruction group to a real outer instruction', name => {
    const { transaction } = normalizeFixture(name);
    for (const group of transaction.innerInstructionGroups) {
      expect(group.outerIndexOutOfRange).toBe(false);
      expect(transaction.instructions[group.outerIndex]).toBeDefined();
      group.instructions.forEach((inner, index) => {
        expect(inner.index).toBe(index);
        expect(inner.outerIndex).toBe(group.outerIndex);
      });
    }
  });

  it.each(names)('%s never claims to understand an instruction the RPC did not decode', name => {
    const { transaction } = normalizeFixture(name);
    const all = [
      ...transaction.instructions,
      ...transaction.innerInstructionGroups.flatMap(group => group.instructions),
    ];
    for (const instruction of all) {
      if (instruction.decoding === 'rpc-parsed') {
        // A parsed instruction must have a type; we never fabricate one.
        expect(instruction.parsedType).not.toBeNull();
        expect(instruction.data).toBeNull();
      } else {
        expect(instruction.parsedType).toBeNull();
        expect(instruction.parsedInfo).toBeNull();
      }
      expect(instruction.programId).not.toBeNull();
    }
  });

  it.each(names)('%s produces no unexpected anomalies', name => {
    const { transaction } = normalizeFixture(name);
    // Fixtures are well-formed real responses: nothing should look wrong.
    expect(transaction.diagnostics.filter(d => d.level === 'warning')).toEqual([]);
  });
});

describe('v0 swap fixture (real mainnet, versioned with address lookup tables)', () => {
  it('maps the fields Milestone 1 asks for', () => {
    const { envelope, transaction } = normalizeFixture('v0-success-swap');
    const raw = envelope.response as {
      slot: number;
      meta: { fee: number; logMessages: string[]; preBalances: number[] };
    };

    expect(transaction.version).toEqual({ kind: 'numbered', value: 0 });
    expect(transaction.status).toBe('success');
    expect(transaction.error).toBeNull();
    expect(transaction.slot).toBe(BigInt(raw.slot));
    expect(transaction.feeLamports).toBe(BigInt(raw.meta.fee));
    expect(transaction.logs).toHaveLength(raw.meta.logMessages.length);
    expect(transaction.logs?.[0]).toBe(raw.meta.logMessages[0]);
  });

  it('includes lookup-table accounts with their source preserved', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const fromLookup = transaction.accounts.filter(a => a.source === 'lookupTable');
    expect(fromLookup.length).toBeGreaterThan(0);
    expect(transaction.accounts.filter(a => a.source === 'transaction').length).toBeGreaterThan(0);
    // Resolved addresses, not indices: they must be base58 addresses.
    expect(fromLookup.every(a => a.address.length >= 32)).toBe(true);
  });

  it('keeps inner instructions grouped under the top-level instruction that made them', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    expect(transaction.innerInstructionGroups.length).toBeGreaterThan(0);
    const total = transaction.innerInstructionGroups.reduce(
      (count, group) => count + group.instructions.length,
      0,
    );
    expect(total).toBeGreaterThan(0);
    // CPI instructions report a deeper stack height than the top-level call.
    const inner = transaction.innerInstructionGroups[0]?.instructions[0];
    expect(inner?.stackHeight).toBe(2);
    expect(transaction.instructions[0]?.stackHeight).toBe(1);
  });

  it('leaves genuinely undecoded programs undecoded, with raw data intact', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const undecoded = transaction.instructions.filter(i => i.decoding === 'rpc-partially-decoded');
    expect(undecoded.length).toBeGreaterThan(0);
    for (const instruction of undecoded) {
      expect(instruction.programName).toBeNull();
      expect(instruction.parsedType).toBeNull();
      expect(typeof instruction.data).toBe('string');
      expect(instruction.data?.length).toBeGreaterThan(0);
    }
    // But the instructions the RPC *did* decode keep its parsed type verbatim.
    const parsed = transaction.instructions.filter(i => i.decoding === 'rpc-parsed');
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.map(i => i.programName)).toContain('spl-token');
  });

  it('reports token deltas and SOL deltas involving the fee payer', () => {
    const { transaction } = normalizeFixture('v0-success-swap');

    expect(transaction.tokenBalancesAvailable).toBe(true);
    expect(transaction.tokenBalanceChanges.length).toBeGreaterThan(0);
    expect(transaction.tokenBalanceChanges.every(c => c.deltaAmount !== null)).toBe(true);
    expect(transaction.tokenBalanceChanges.some(c => c.deltaAmount !== 0n)).toBe(true);

    const feePayerChange = transaction.solBalanceChanges[0];
    expect(feePayerChange?.address).toBe(transaction.feePayerAddress);
    // Note: the fee payer is not necessarily *down*. Here it is a wallet that
    // received the proceeds of a swap, so its balance rises despite paying the
    // fee. We therefore assert the arithmetic, not the direction.
    const raw = (loadFixture('v0-success-swap').response as {
      meta: { preBalances: number[]; postBalances: number[] };
    }).meta;
    expect(feePayerChange?.beforeLamports).toBe(BigInt(raw.preBalances[0] ?? 0));
    expect(feePayerChange?.afterLamports).toBe(BigInt(raw.postBalances[0] ?? 0));
    expect(feePayerChange?.deltaLamports).toBe(
      BigInt(raw.postBalances[0] ?? 0) - BigInt(raw.preBalances[0] ?? 0),
    );
  });
});

describe('v1 fixtures (the new wire format, live on mainnet)', () => {
  it.each(['v1-failed-custom11', 'v1-failed-custom6001'])(
    '%s is recognized as v1 and keeps its message resource limits',
    name => {
      const { transaction } = normalizeFixture(name);
      expect(transaction.version).toEqual({ kind: 'numbered', value: 1 });
      // v1 carries resource limits in the message instead of ComputeBudget ixs.
      expect(transaction.transactionConfig).toMatchObject({
        computeUnitLimit: expect.any(Number),
      });
    },
  );

  it('reports a failed transaction without pretending it succeeded', () => {
    const { envelope, transaction } = normalizeFixture('v1-failed-custom11');
    const raw = envelope.response as { meta: { err: unknown } };

    expect(transaction.status).toBe('failed');
    // The error is preserved verbatim, not translated into our own vocabulary.
    expect(transaction.error).toEqual(raw.meta.err);
    expect(transaction.error).toEqual({ InstructionError: [0, { Custom: 11 }] });
    // A failed transaction still has instructions and logs.
    expect(transaction.instructions.length).toBeGreaterThan(0);
    expect(transaction.logs?.some(log => log.includes('failed'))).toBe(true);
  });

  it('still reports pre/post token balances for a failed transaction', () => {
    const { transaction } = normalizeFixture('v1-failed-custom11');
    expect(transaction.tokenBalancesAvailable).toBe(true);
    expect(transaction.tokenBalanceChanges.length).toBeGreaterThan(0);
    // Everything rolled back, so no token moved.
    expect(transaction.tokenBalanceChanges.every(c => c.deltaAmount === 0n)).toBe(true);
  });
});

describe('legacy fixture (unversioned transaction)', () => {
  it('reads a legacy transaction with no lookup tables and no CPIs', () => {
    const { envelope, transaction } = normalizeFixture('legacy-success-vote');
    const raw = envelope.response as { meta: { innerInstructions: unknown[] } };

    expect(transaction.version).toEqual({ kind: 'legacy' });
    expect(transaction.status).toBe('success');
    expect(transaction.accounts.every(a => a.source === 'transaction')).toBe(true);
    // An empty innerInstructions array is "no CPIs", which is different from null.
    expect(transaction.innerInstructionsAvailable).toBe(true);
    expect(transaction.innerInstructionGroups).toEqual([]);
    expect(raw.meta.innerInstructions).toEqual([]);
    expect(transaction.transactionConfig).toBeNull();
    expect(transaction.logs).not.toBeNull();
  });
});

describe('fixture provenance', () => {
  it.each(allFixtureNames())('%s records where it came from', name => {
    const envelope = loadFixture(name);
    expect(envelope.provenance.source).toMatch(/^https?:\/\//);
    expect(envelope.provenance.note.length).toBeGreaterThan(0);
    expect(envelope.request.config).toMatchObject({ encoding: 'jsonParsed' });
  });
});
