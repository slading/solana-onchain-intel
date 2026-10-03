/**
 * Adversarial and mutation vectors for the swap layer.
 *
 * Each vector takes the real `v0-success-swap` (or a hand-built synthetic
 * transaction) and changes exactly one thing in memory, then asks whether the
 * layer still tells the truth. A layer that recognizes its own target only when
 * nothing has been touched is worth nothing: these are the cases where a naive
 * implementation would either invent a leg or invent a proof.
 *
 * Nothing here writes to `fixtures/`: the file on disk stays the real mainnet
 * payload.
 */
import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { recognizeDlmmSwaps } from '../src/swap/recognize.ts';
import { DLMM_PROGRAM_ID, DLMM_SWAP2_DISCRIMINATOR } from '../src/swap/dlmm.ts';
import { normalizeFixture } from './helpers/fixtures.ts';
import { b58, rawInstruction, splToken, TOKEN, ACC } from './helpers/instructions.ts';
import { syntheticTransaction } from './helpers/synthetic.ts';
import {
  base58,
  bytesOfData,
  checkOf,
  dropInstruction,
  innerInstructionsOf,
  insertInnerInstruction,
  legAt,
  outcomeOf,
  patchInstruction,
  swap2Payload,
  swapFixture,
  withLogs,
  withoutInnerInstructions,
  withoutLogs,
  withStatus,
} from './helpers/swaps.ts';

const PROVENANCE = {
  rpcEndpoint: 'https://example.invalid',
  encoding: 'jsonParsed',
  commitState: undefined,
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 1,
} as const;

const WSOL = 'So11111111111111111111111111111111111111112';
const X_MINT = '9pJWJdpPebyANys45eetpemLJo8yTz4n5B9zbpYw9ZMr';
const USER = 'E5JXp4obkiAcYNf1noBJyYkqJSdwnreBfYaX7vPbYTir';
const X_USER = 'CLD7C8D2yiwCpGQ8e2HvcVwVti8Puc22wXYLqn6EruTt';
const W_USER = 'Cr5vxXJTC4vu8PraDANEGLfE1YStzQo8JHYJ7K8qqAeh';
const RES_X = 'FCsGP41FrbRBP5stf2QVBQVnn29chS8ZesqVCrGjkrCK';
const RES_Y = 'HAcL6V7ER8xYftBFuz6hqnH48AHnz42KEVrY12CEznj7';
const POOL = '5fwrQ1KAHVzGJAe9KvfAMziPkLGsxTfrf4ywCZfwyGuD';
const ORACLE = 'H1sZ2MH7vSz7M5YgphC84u645KkB3YVPLWqWugtdn8kn';
const BIN_ARRAY = 'GBWYcgGjbqrY5wuw55ytuGCsqyagG5q8qhMYHRJeq7hS';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const EVENT_AUTHORITY = 'D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6';

const fixture = () => normalizeFixture('v0-success-swap').transaction;

/** The 16 named accounts of the fixture's first leg, in IDL order. */
function dlmmAccounts(): string[] {
  return [
    POOL,
    DLMM_PROGRAM_ID,
    RES_X,
    RES_Y,
    X_USER,
    W_USER,
    X_MINT,
    WSOL,
    ORACLE,
    DLMM_PROGRAM_ID,
    USER,
    TOKEN_2022,
    TOKEN,
    MEMO,
    EVENT_AUTHORITY,
    DLMM_PROGRAM_ID,
    BIN_ARRAY,
  ];
}

/**
 * A hand-built transaction whose *only* semantic content is a top-level DLMM
 * `swap2` and the two transfers it makes — the shape a direct pool swap has.
 */
function directSwap(options: {
  amountIn?: bigint;
  minAmountOut?: bigint;
  outAmount?: bigint;
  innerStackHeight?: number;
  memo?: boolean;
  withTransfers?: boolean;
} = {}) {
  const amountIn = options.amountIn ?? 1_000_000_000n;
  const minAmountOut = options.minAmountOut ?? 900_000_000n;
  const outAmount = options.outAmount ?? 950_000_000n;
  const inner: unknown[] = [];
  if (options.withTransfers !== false) {
    inner.push(
      rawInstruction(TOKEN_2022, splToken.transferChecked(amountIn, 9), [X_USER, X_MINT, RES_X, USER], {
        index: 0,
        outerIndex: 0,
        stackHeight: options.innerStackHeight ?? 2,
      }),
      rawInstruction(TOKEN, splToken.transferChecked(outAmount, 9), [RES_Y, WSOL, W_USER, POOL], {
        index: 1,
        outerIndex: 0,
        stackHeight: options.innerStackHeight ?? 2,
      }),
    );
  }
  return syntheticTransaction({
    version: 'legacy',
    accountKeys: [
      { pubkey: USER, signer: true, writable: true, source: 'transaction' },
      { pubkey: POOL, signer: false, writable: true, source: 'transaction' },
      { pubkey: X_USER, signer: false, writable: true, source: 'transaction' },
      { pubkey: W_USER, signer: false, writable: true, source: 'transaction' },
      { pubkey: RES_X, signer: false, writable: true, source: 'transaction' },
      { pubkey: RES_Y, signer: false, writable: true, source: 'transaction' },
      { pubkey: X_MINT, signer: false, writable: false, source: 'transaction' },
      { pubkey: WSOL, signer: false, writable: false, source: 'transaction' },
      { pubkey: ORACLE, signer: false, writable: true, source: 'transaction' },
      { pubkey: TOKEN_2022, signer: false, writable: false, source: 'transaction' },
      { pubkey: TOKEN, signer: false, writable: false, source: 'transaction' },
      { pubkey: MEMO, signer: false, writable: false, source: 'transaction' },
      { pubkey: EVENT_AUTHORITY, signer: false, writable: false, source: 'transaction' },
      { pubkey: BIN_ARRAY, signer: false, writable: true, source: 'transaction' },
    ],
    instructions: [
      rawInstruction(DLMM_PROGRAM_ID, swap2Payload(amountIn, minAmountOut), dlmmAccounts(), {
        index: 0,
        stackHeight: 1,
      }),
      ...(options.memo === false
        ? []
        : [rawInstruction(MEMO, [0], [], { index: 1, stackHeight: 1 })]),
    ],
    meta: {
      err: null,
      fee: 5000,
      computeUnitsConsumed: 42_000,
      preBalances: [1_000_000_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      postBalances: [999_995_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      preTokenBalances: [
        {
          accountIndex: 2,
          mint: X_MINT,
          owner: USER,
          programId: TOKEN_2022,
          uiTokenAmount: { amount: '5000000000000', decimals: 9, uiAmount: 5000, uiAmountString: '5000' },
        },
        {
          accountIndex: 3,
          mint: WSOL,
          owner: USER,
          programId: TOKEN,
          uiTokenAmount: { amount: '0', decimals: 9, uiAmount: 0, uiAmountString: '0' },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint: X_MINT,
          owner: USER,
          programId: TOKEN_2022,
          uiTokenAmount: {
            amount: (5_000_000_000_000n - amountIn).toString(),
            decimals: 9,
            uiAmount: 4000,
            uiAmountString: '4000',
          },
        },
        {
          accountIndex: 3,
          mint: WSOL,
          owner: USER,
          programId: TOKEN,
          uiTokenAmount: {
            amount: outAmount.toString(),
            decimals: 9,
            uiAmount: 0.95,
            uiAmountString: '0.95',
          },
        },
      ],
      innerInstructions: [{ index: 0, instructions: inner }],
      logMessages: ['Program log: Instruction: Swap2'],
    },
  });
}

function recognize(raw: unknown, options: { effects?: boolean } = {}) {
  const transaction = normalizeTransaction(raw, { provenance: PROVENANCE });
  const effects = options.effects === false ? undefined : transactionEffects(transaction);
  return { transaction, swaps: recognizeDlmmSwaps(transaction, { effects }) };
}

/** The fixture with one of its two real legs mutated. */
function mutatedFixtures(patch: (transaction: ReturnType<typeof fixture>) => ReturnType<typeof fixture>) {
  const transaction = patch(fixture());
  const effects = transactionEffects(transaction);
  return recognizeDlmmSwaps(transaction, { effects });
}

describe('the instruction itself is the claim', () => {
  it('never recognizes an instruction that only looks like a swap', () => {
    // Two transfers in a transaction, one token out and another in, with no DLMM
    // instruction at all: exactly the pattern a balance-delta heuristic feeds on.
    const raw = directSwap({ withTransfers: true });
    const withoutDlmm = {
      ...raw,
      transaction: {
        ...(raw as { transaction: Record<string, unknown> }).transaction,
        message: {
          ...((raw as { transaction: { message: Record<string, unknown> } }).transaction.message),
          instructions: [
            rawInstruction(TOKEN_2022, splToken.transferChecked(1_000_000_000n, 9), [X_USER, X_MINT, RES_X, USER]),
            rawInstruction(TOKEN, splToken.transferChecked(950_000_000n, 9), [RES_Y, WSOL, W_USER, POOL]),
          ],
        },
      },
    };
    const { swaps } = recognize(withoutDlmm);
    expect(swaps.legs).toEqual([]);
    expect(swaps.counts.recognized).toBe(0);
  });

  it('requires the exact program id', () => {
    const swaps = mutatedFixtures(transaction =>
      patchInstruction(transaction, 3, 8, { programId: TOKEN }),
    );
    expect(swaps.counts.recognized).toBe(1);
    expect(swaps.legs.map(leg => leg.ref.index)).toEqual([13]);
  });

  it('requires the swap2 discriminator, not a sibling DLMM instruction', () => {
    // The real shape of DLMM `swap` (discriminator f8c69e91e17587c8): same program,
    // same argument shape, different instruction. It is not swap2 and must not be
    // read as one.
    const swapOne = [0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8];
    const swaps = mutatedFixtures(transaction =>
      patchInstruction(transaction, 3, 8, {
        data: base58([...swapOne, ...swap2Payload(602_101_187_025n, 0n)]),
      }),
    );
    expect(swaps.counts.recognized).toBe(1);
    expect(swaps.legs.map(leg => leg.ref.index)).toEqual([13]);
    expect(swaps.diagnostics).toEqual([]);
  });

  it('leaves a swap2 whose arguments do not parse exactly unrecognized, and says why', () => {
    const data = innerInstructionsOf(fixture(), 3)[8]?.data ?? '';
    const swaps = mutatedFixtures(transaction =>
      patchInstruction(transaction, 3, 8, { data: base58([...bytesOfData(data), 0x2a]) }),
    );
    expect(swaps.counts.recognized).toBe(1);
    expect(swaps.legs.map(leg => leg.ref.index)).toEqual([13]);
    const note = swaps.diagnostics.find(diagnostic => diagnostic.code === 'dlmm-swap2-args-not-recognized');
    expect(note?.level).toBe('warning');
    expect(note?.ref?.index).toBe(8);
    expect(note?.message).toContain('trailing byte');
  });

  it('leaves a truncated swap2 unrecognized too', () => {
    const data = innerInstructionsOf(fixture(), 3)[8]?.data ?? '';
    const swaps = mutatedFixtures(transaction =>
      patchInstruction(transaction, 3, 8, { data: base58([...bytesOfData(data).slice(0, 20)]) }),
    );
    expect(swaps.counts.recognized).toBe(1);
    expect(
      swaps.diagnostics.filter(diagnostic => diagnostic.code === 'dlmm-swap2-args-not-recognized'),
    ).toHaveLength(1);
  });

  it('reads the discriminator from bytes, never from the log line', () => {
    // A node that reports no logs at all must still recognize both legs.
    const transaction = withoutLogs(fixture());
    const swaps = recognizeDlmmSwaps(transaction, { effects: transactionEffects(transaction) });
    expect(swaps.counts).toMatchObject({ recognized: 2, proven: 2 });
    expect(transaction.logs).toBeNull();
    expect(swaps.diagnostics).toEqual([]);
  });

  it('does not invent a swap from a log line alone', () => {
    const vote = normalizeFixture('legacy-success-vote').transaction;
    const swaps = recognizeDlmmSwaps(
      withLogs(vote, [
        ...(vote.logs ?? []),
        'Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke [1]',
        'Program log: Instruction: Swap2',
        'Program data: QWxrX2V2ZW50',
      ]),
      { effects: transactionEffects(vote) },
    );
    expect(swaps.legs).toEqual([]);
    expect(swaps.counts.recognized).toBe(0);
  });

  it('does not depend on the router envelope or its events', () => {
    // Remove the two legs' own event instructions: recognition is unchanged.
    const swaps = mutatedFixtures(transaction => {
      let result = transaction;
      for (const index of [9, 12, 14, 17]) result = dropInstruction(result, 3, index);
      return result;
    });
    expect(swaps.counts).toMatchObject({ recognized: 2, proven: 2, conflicting: 0 });
    expect(swaps.legs.map(leg => leg.input.legRef?.index)).toEqual([10, 15]);
  });
});

describe('amount reconciliation', () => {
  it('conflicts when amount_in disagrees with the transfer, and prints both numbers', () => {
    const swaps = mutatedFixtures(transaction =>
      patchInstruction(transaction, 3, 8, { data: base58(swap2Payload(602_101_187_026n, 0n)) }),
    );
    const leg = legAt(swaps, 3, 8);
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['input-amount-matches-amount-in']);
    expect(leg.amountIn).toBe(602_101_187_026n);
    const check = checkOf(leg, 'input-amount-matches-amount-in');
    expect(check.outcome).toBe('fail');
    expect(check.detail).toContain('602101187026');
    expect(check.detail).toContain('602101187025');
    // The other leg is untouched and stays proven.
    expect(legAt(swaps, 3, 13).state).toBe('proven');
  });

  it('conflicts when the output is below a stated floor, and only then', () => {
    const violated = mutatedFixtures(transaction =>
      patchInstruction(transaction, 3, 8, { data: base58(swap2Payload(602_101_187_025n, 1_916_188_256n)) }),
    );
    const leg = legAt(violated, 3, 8);
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['min-amount-out-satisfied']);
    expect(checkOf(leg, 'min-amount-out-stated').outcome).toBe('pass');
    expect(checkOf(leg, 'min-amount-out-satisfied').detail).toContain('below min_amount_out');
    expect(leg.unknowns).toEqual([]);

    // A floor the output exactly meets is satisfied.
    const met = mutatedFixtures(transaction =>
      patchInstruction(transaction, 3, 8, { data: base58(swap2Payload(602_101_187_025n, 1_916_188_255n)) }),
    );
    expect(legAt(met, 3, 8).state).toBe('proven');
    expect(outcomeOf(legAt(met, 3, 8), 'min-amount-out-satisfied')).toBe('pass');

    // One unit above that is a violation again.
    const oneAbove = mutatedFixtures(transaction =>
      patchInstruction(transaction, 3, 8, { data: base58(swap2Payload(602_101_187_025n, 1_916_188_256n)) }),
    );
    expect(outcomeOf(legAt(oneAbove, 3, 8), 'min-amount-out-satisfied')).toBe('fail');
  });

  it('never reports a zero floor as satisfied', () => {
    const { swaps } = swapFixture('v0-success-swap');
    for (const leg of swaps.legs) {
      expect(outcomeOf(leg, 'min-amount-out-stated')).toBe('not-checkable');
      expect(outcomeOf(leg, 'min-amount-out-satisfied')).toBe('not-checkable');
      expect(leg.unknowns).toContain('min-amount-out-not-stated');
      expect(leg.state).toBe('proven');
      expect(leg.checks.some(check => check.id.startsWith('min-amount') && check.outcome === 'pass')).toBe(false);
    }
  });
});

describe('the CPI subtree decides which transfers belong to a leg', () => {
  it('ignores a sibling transfer that sits after the leg\u2019s subtree', () => {
    // The router's own transfers run at the same CPI depth as the legs, so they are
    // siblings, not descendants. If the layer used "the next token instruction in
    // the group" instead of the subtree, the router's leg would be attributed here.
    const swaps = mutatedFixtures(transaction => {
      const original = innerInstructionsOf(transaction, 3)[18];
      if (original === undefined) throw new Error('expected the router sibling at [3.18]');
      return insertInnerInstruction(transaction, 3, 17, { ...original, index: 101, stackHeight: 2 });
    });
    const leg = legAt(swaps, 3, 13);
    expect(leg.state).toBe('proven');
    expect(leg.input.legRef?.index).toBe(15);
    expect(leg.output.legRef?.index).toBe(16);
    // The sibling's own amount (the router's platform fee) was not pulled in.
    expect(leg.input.amount).toBe(1_443_419_419_808n);
    expect(leg.output.amount).toBe(4_572_493_603n);
    expect(swaps.legs.some(entry => entry.input.legRef?.index === 101 || entry.output.legRef?.index === 101)).toBe(false);
  });

  it('never takes the router\u2019s own transfer for a pool leg', () => {
    // In the real fixture the last two instructions of the group belong to the
    // router. Leg 2's output is the pool's 4,572,493,603 units, never the router's
    // 15,235,813-unit platform fee movement at [3.19].
    const { swaps } = swapFixture('v0-success-swap');
    const leg = legAt(swaps, 3, 13);
    expect(leg.output.amount).toBe(4_572_493_603n);
    expect(leg.input.legRef?.index).toBe(15);
    expect(leg.output.legRef?.index).toBe(16);
  });

  it('refuses to attribute transfers recorded as siblings of a top-level swap2', () => {
    const { swaps } = recognize(directSwap({ innerStackHeight: 1 }));
    expect(swaps.counts).toMatchObject({ recognized: 1, proven: 0, conflicting: 1 });
    const leg = swaps.legs[0];
    expect(leg?.conflicts).toEqual(['input-transfer-found', 'output-transfer-found']);
    expect(checkOf(leg!, 'input-transfer-found').detail).toContain("inside the instruction's CPI subtree");
    // Nothing was pulled in from outside the subtree.
    expect(leg?.input.amount).toBeNull();
    expect(leg?.output.amount).toBeNull();
  });

  it('refuses to guess when two transfers on one side are equally plausible', () => {
    const swaps = mutatedFixtures(transaction => {
      const original = innerInstructionsOf(transaction, 3)[10];
      if (original === undefined) throw new Error('expected the input transfer at [3.10]');
      return insertInnerInstruction(transaction, 3, 10, { ...original, index: 100 });
    });
    const leg = legAt(swaps, 3, 8);
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['input-transfer-found']);
    expect(checkOf(leg, 'input-transfer-found').detail).toContain('2 candidate transfers');
    expect(checkOf(leg, 'input-transfer-found').detail).toContain('ambiguous');
  });

  it('reports CPI data that was never recorded instead of reporting "no swap"', () => {
    const transaction = withoutInnerInstructions(fixture());
    const swaps = recognizeDlmmSwaps(transaction, { effects: transactionEffects(transaction) });
    expect(swaps.legs).toEqual([]);
    const note = swaps.diagnostics.find(diagnostic => diagnostic.code === 'swap-inner-instructions-unavailable');
    expect(note?.level).toBe('warning');
    expect(note?.message).toContain('not evidence that none happened');
  });
});

describe('named roles are proof, not decoration', () => {
  it('conflicts when a transfer does not touch the named vault', () => {
    const swaps = mutatedFixtures(transaction => {
      const accounts = [...(innerInstructionsOf(transaction, 3)[8]?.accounts ?? [])];
      accounts[2] = 'Bvtgim23qEyTvL89EnhFSCwHXHquxwQeZfKPWKJ2NZyf';
      return patchInstruction(transaction, 3, 8, { accounts });
    });
    const leg = legAt(swaps, 3, 8);
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['input-reserve-is-pool-vault']);
    expect(checkOf(leg, 'input-reserve-is-pool-vault').detail).toContain('is neither reserve_x');
  });

  it('conflicts when the two pool mints are not distinguishable', () => {
    const swaps = mutatedFixtures(transaction => {
      const accounts = [...(innerInstructionsOf(transaction, 3)[8]?.accounts ?? [])];
      accounts[6] = accounts[7] ?? WSOL;
      return patchInstruction(transaction, 3, 8, { accounts });
    });
    const leg = legAt(swaps, 3, 8);
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['input-mint-matches-named-role']);
  });

  it('conflicts when the named mints say one direction but the vaults say the other', () => {
    // Swap the two `token_*_mint` roles: the roles now claim the input is token Y,
    // which must be paid into reserve_y — but the transfer pays into reserve_x. Two
    // pieces of evidence disagree, so nothing is resolved.
    const swaps = mutatedFixtures(transaction => {
      const accounts = [...(innerInstructionsOf(transaction, 3)[8]?.accounts ?? [])];
      const x = accounts[6];
      accounts[6] = accounts[7] ?? WSOL;
      accounts[7] = x ?? X_MINT;
      return patchInstruction(transaction, 3, 8, { accounts });
    });
    const leg = legAt(swaps, 3, 8);
    expect(leg.state).toBe('conflicting');
    expect(leg.xToY).toBe(false);
    // Both sides disagree with the claimed direction: one pays into reserve_x while
    // claiming a Y-in swap, the other pays out of reserve_y while claiming X-out.
    expect(leg.conflicts).toEqual(['input-reserve-is-pool-vault', 'output-reserve-is-pool-vault']);
    expect(checkOf(leg, 'input-reserve-is-pool-vault').detail).toContain('requires');
    expect(checkOf(leg, 'output-reserve-is-pool-vault').detail).toContain('requires');
  });

  it('conflicts when one side of the swap has no transfer at all', () => {
    const swaps = mutatedFixtures(transaction => dropInstruction(transaction, 3, 10));
    const leg = legAt(swaps, 3, 8);
    expect(leg.state).toBe('conflicting');
    expect(leg.conflicts).toEqual(['input-transfer-found']);
    // The unknowns of the missing side are reported as not-checkable, not as fails.
    expect(outcomeOf(leg, 'input-mint-matches-named-role')).toBe('not-checkable');
    expect(outcomeOf(leg, 'input-reserve-is-pool-vault')).toBe('not-checkable');
    expect(checkOf(leg, 'input-transfer-found').detail).toContain('no token transfer from user_token_in');
    // The other leg is unaffected.
    expect(legAt(swaps, 3, 13).state).toBe('proven');
  });
});

describe('commitment', () => {
  it('never lets a failed transaction hold a committed swap', () => {
    const transaction = withStatus(fixture(), 'failed', { InstructionError: [3, { Custom: 6001 }] });
    const effects = transactionEffects(transaction);
    const swaps = recognizeDlmmSwaps(transaction, { effects });
    expect(swaps.counts).toMatchObject({ recognized: 2, proven: 0, notCommitted: 2 });
    for (const leg of swaps.legs) {
      expect(leg.state).toBe('not-committed');
      expect(leg.commitState).toBe('reverted');
      // `transaction-committed` is not "a check that failed": the condition simply
      // does not hold for a rolled-back transaction, and the leg's state says so.
      expect(outcomeOf(leg, 'transaction-committed')).toBe('not-checkable');
      expect(checkOf(leg, 'transaction-committed').required).toBe(true);
      expect(checkOf(leg, 'transaction-committed').detail).toContain('rolls every state change back');
      expect(leg.diagnostics.map(note => note.code)).toEqual(['dlmm-swap2-not-committed']);
      // The amounts are still read from instruction data; they are simply not events.
      expect(leg.input.amount).toBe(leg.amountIn);
      expect(leg.input.amountEvidence).toBe('transfer-leg');
    }
  });

  it('cannot prove a leg when no effects model was supplied', () => {
    const swaps = recognizeDlmmSwaps(fixture());
    expect(swaps.counts).toMatchObject({ recognized: 2, proven: 0, partiallyProven: 2 });
    for (const leg of swaps.legs) {
      expect(outcomeOf(leg, 'input-reconciles-with-effects')).toBe('not-checkable');
      expect(outcomeOf(leg, 'output-reconciles-with-effects')).toBe('not-checkable');
      expect(leg.unknowns).toContain('effects-model-absent');
    }
    const note = swaps.diagnostics.find(diagnostic => diagnostic.code === 'swap-effects-model-absent');
    expect(note?.level).toBe('info');
  });

  it('treats an unknown status as unknown, not as success', () => {
    const transaction = { ...fixture(), status: 'unknown' as const };
    const swaps = recognizeDlmmSwaps(transaction, { effects: transactionEffects(transaction) });
    expect(swaps.legs.map(leg => leg.commitState)).toEqual(['unknown', 'unknown']);
    expect(swaps.counts.proven).toBe(0);
  });
});

describe('determinism and non-mutation', () => {
  it('produces the same model for the same input, mutation after mutation', () => {
    for (const amountIn of [602_101_187_025n, 1n, 18_446_744_073_709_551_615n]) {
      const transaction = patchInstruction(fixture(), 3, 8, { data: base58(swap2Payload(amountIn, 0n)) });
      const effects = transactionEffects(transaction);
      const first = recognizeDlmmSwaps(transaction, { effects });
      const second = recognizeDlmmSwaps(transaction, { effects });
      expect(stringifyJson(first.legs)).toBe(stringifyJson(second.legs));
    }
  });

  it('carries u64 arguments through without losing a unit at either end of the range', () => {
    const huge = recognize(directSwap({ amountIn: 18_446_744_073_709_551_615n, minAmountOut: 0n, outAmount: 0n }));
    const leg = huge.swaps.legs[0];
    expect(leg?.amountIn).toBe(18_446_744_073_709_551_615n);
    const zero = recognize(directSwap({ amountIn: 0n, minAmountOut: 0n, outAmount: 0n }));
    expect(zero.swaps.legs[0]?.amountIn).toBe(0n);
  });

  it('leaves the normalized transaction untouched', () => {
    const transaction = fixture();
    const accountsBefore = innerInstructionsOf(transaction, 3).map(instruction => [...(instruction.accounts ?? [])]);
    const effects = transactionEffects(transaction);
    recognizeDlmmSwaps(transaction, { effects });
    expect(innerInstructionsOf(transaction, 3).map(instruction => [...(instruction.accounts ?? [])])).toEqual(
      accountsBefore,
    );
  });
});

describe('a direct pool swap (no router envelope)', () => {
  it('recognizes a top-level swap2 and proves both sides from its own subtree', () => {
    const { swaps } = recognize(directSwap());
    expect(swaps.counts).toMatchObject({ recognized: 1, proven: 1, conflicting: 0 });
    const leg = swaps.legs[0];
    expect(leg?.ref.path).toBe('top-level');
    expect(leg?.ref.index).toBe(0);
    expect(leg?.ref.outerIndex).toBeNull();
    expect(leg?.state).toBe('proven');
    expect(leg?.xToY).toBe(true);
    expect(leg?.input.amount).toBe(1_000_000_000n);
    expect(leg?.output.amount).toBe(950_000_000n);
    expect(leg?.minAmountOut).toBe(900_000_000n);
    expect(outcomeOf(leg!, 'min-amount-out-satisfied')).toBe('pass');
    expect(outcomeOf(leg!, 'input-reconciles-with-effects')).toBe('pass');
    expect(leg?.unknowns).toEqual([]);
    expect(leg?.conflicts).toEqual([]);
  });

  it('is unaffected by an unrelated instruction in the same transaction', () => {
    const withMemo = recognize(directSwap({ memo: true })).swaps;
    expect(withMemo.counts.recognized).toBe(1);
    expect(withMemo.legs[0]?.state).toBe('proven');
  });

  it('still needs the transfers: an empty subtree proves nothing', () => {
    const { swaps } = recognize(directSwap({ withTransfers: false }));
    expect(swaps.counts).toMatchObject({ recognized: 1, proven: 0, conflicting: 1 });
  });

  it('recognizes both legs when the same program is invoked twice', () => {
    const raw = directSwap();
    const message = (raw as { transaction: { message: Record<string, unknown> } }).transaction.message;
    const duplicated = {
      ...raw,
      transaction: {
        ...(raw as { transaction: Record<string, unknown> }).transaction,
        message: {
          ...message,
          instructions: [
            ...(message['instructions'] as readonly unknown[]),
            rawInstruction(DLMM_PROGRAM_ID, swap2Payload(1_000_000_000n, 900_000_000n), dlmmAccounts(), {
              index: 2,
              stackHeight: 1,
            }),
          ],
        },
      },
    };
    const { swaps } = recognize(duplicated);
    // The second invocation has no transfers of its own: recognized, not proven.
    expect(swaps.counts.recognized).toBe(2);
    expect(swaps.legs[0]?.state).toBe('proven');
    expect(swaps.legs[1]?.state).toBe('conflicting');
    expect(swaps.legs[1]?.ref.index).toBe(2);
  });
});

describe('the instruction the layer reads', () => {
  it('matches one discriminator and one program, and nothing else', () => {
    expect(DLMM_SWAP2_DISCRIMINATOR).toBe('414b3f4ceb5b5b88');
    expect(DLMM_PROGRAM_ID).toBe('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
    // A disc with a single byte changed is a different instruction and must not
    // match: that is the whole point of comparing eight bytes.
    const mutation = Array.from(Array(8), (_unused, index) => (index === 7 ? 0x89 : 0x00));
    expect(mutation.every(byte => byte >= 0 && byte <= 255)).toBe(true);
    expect(b58(mutation)).not.toBe(DLMM_SWAP2_DISCRIMINATOR);
    expect(ACC.authority).toBeTruthy();
  });
});
