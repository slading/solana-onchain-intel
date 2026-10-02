import { describe, expect, it } from 'vitest';
import { normalizeTransaction, NormalizationError } from '../src/normalize/transaction.ts';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  meta,
  parsedInstruction,
  rawInstruction,
  syntheticTransaction,
} from './helpers/synthetic.ts';
// (syntheticTransaction is also used directly below for the missing-version case.)

const PROVENANCE = {
  rpcEndpoint: 'https://example.invalid',
  encoding: 'jsonParsed',
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 1,
} as const;

function normalize(parts: Parameters<typeof syntheticTransaction>[0]) {
  return normalizeTransaction(syntheticTransaction(parts), { provenance: PROVENANCE });
}

const codes = (diagnostics: readonly { code: string }[]) => diagnostics.map(d => d.code);

describe('missing data stays unknown instead of being invented', () => {
  it('handles meta: null without guessing success or fee', () => {
    const transaction = normalize({ meta: null });

    expect(transaction.status).toBe('unknown');
    expect(transaction.feeLamports).toBeNull();
    expect(transaction.error).toBeNull();
    expect(transaction.logs).toBeNull();
    expect(transaction.computeUnitsConsumed).toBeNull();
    expect(transaction.solBalanceChanges).toEqual([]);
    // Empty + unavailable: the caller must not read this as "no token movements".
    expect(transaction.tokenBalanceChanges).toEqual([]);
    expect(transaction.tokenBalancesAvailable).toBe(false);
    expect(codes(transaction.diagnostics)).toContain('metadata-missing');
  });

  it('distinguishes "no CPIs" from "CPIs were not recorded"', () => {
    const recorded = normalize({ meta: meta({ innerInstructions: [] }) });
    expect(recorded.innerInstructionsAvailable).toBe(true);
    expect(codes(recorded.diagnostics)).not.toContain('inner-instructions-not-recorded');

    const notRecorded = normalize({ meta: meta({ innerInstructions: null }) });
    expect(notRecorded.innerInstructionsAvailable).toBe(false);
    expect(codes(notRecorded.diagnostics)).toContain('inner-instructions-not-recorded');
  });

  it('distinguishes empty logs from unavailable logs', () => {
    const empty = normalize({ meta: meta({ logMessages: [] }) });
    expect(empty.logs).toEqual([]);

    const unavailable = normalize({ meta: meta({ logMessages: null }) });
    expect(unavailable.logs).toBeNull();
    expect(codes(unavailable.diagnostics)).toContain('logs-unavailable');
  });

  it('flags token balances that the node did not report', () => {
    const transaction = normalize({ meta: meta({ preTokenBalances: null }) });
    expect(transaction.tokenBalancesAvailable).toBe(false);
    expect(codes(transaction.diagnostics)).toContain('token-balances-missing');
  });

  it('reports an unknown version rather than assuming legacy', () => {
    // Omitting `maxSupportedTransactionVersion` makes the node omit the field.
    const withoutVersion = syntheticTransaction() as Record<string, unknown>;
    delete withoutVersion['version'];
    const transaction = normalizeTransaction(withoutVersion, { provenance: PROVENANCE });

    expect(transaction.version).toEqual({ kind: 'unknown' });
    expect(codes(transaction.diagnostics)).toContain('version-missing');
  });

  it('reports an unrecognised version number without inventing semantics', () => {
    const transaction = normalize({ version: 2 });
    expect(transaction.version).toEqual({ kind: 'numbered', value: 2 });
  });

  it('reports a missing block time as unknown', () => {
    const transaction = normalize({ blockTime: null });
    expect(transaction.blockTimeUnix).toBeNull();
    expect(codes(transaction.diagnostics)).toContain('block-time-missing');
  });
});

describe('instruction honesty', () => {
  it('keeps an undecoded instruction undecoded, with raw data preserved', () => {
    const transaction = normalize({
      instructions: [rawInstruction('UnknownProgram11111111111111111111111', 'Qk9uZQ', [ACCOUNT_A])],
    });

    const [instruction] = transaction.instructions;
    expect(instruction).toBeDefined();
    expect(instruction?.decoding).toBe('rpc-partially-decoded');
    expect(instruction?.programId).toBe('UnknownProgram11111111111111111111111');
    // The whole point: we do not guess what this program does.
    expect(instruction?.parsedType).toBeNull();
    expect(instruction?.programName).toBeNull();
    expect(instruction?.parsedInfo).toBeNull();
    expect(instruction?.data).toBe('Qk9uZQ');
    expect(instruction?.dataEncoding).toBe('base58');
    expect(instruction?.accounts).toEqual([ACCOUNT_A]);
  });

  it('keeps the RPC-parsed type and info verbatim', () => {
    const transaction = normalize({
      instructions: [
        parsedInstruction('11111111111111111111111111111111', 'system', 'transfer', {
          lamports: 42,
        }),
      ],
    });

    const [instruction] = transaction.instructions;
    expect(instruction?.decoding).toBe('rpc-parsed');
    expect(instruction?.parsedType).toBe('transfer');
    expect(instruction?.parsedInfo).toEqual({ lamports: 42 });
    expect(instruction?.programName).toBe('system');
    // Parsed instructions carry no raw data in the response, so we keep null.
    expect(instruction?.data).toBeNull();
    expect(instruction?.accounts).toBeNull();
  });

  it('marks an instruction that is neither parsed nor decodable', () => {
    const transaction = normalize({ instructions: [{ programId: 'X' }] });
    expect(transaction.instructions[0]?.decoding).toBe('unrecognized-shape');
    expect(codes(transaction.diagnostics)).toContain('instruction-shape-unrecognized');
  });

  it('records an out-of-range inner-instruction index instead of dropping the group', () => {
    const transaction = normalize({
      instructions: [rawInstruction('P1111111111111111111111111111111111111111')],
      meta: meta({
        innerInstructions: [
          { index: 7, instructions: [rawInstruction('P2222222222222222222222222222222222222222')] },
        ],
      }),
    });

    const [group] = transaction.innerInstructionGroups;
    expect(group?.outerIndex).toBe(7);
    expect(group?.outerIndexOutOfRange).toBe(true);
    // Still present, and still carrying the instruction itself.
    expect(group?.instructions).toHaveLength(1);
    expect(codes(transaction.diagnostics)).toContain('inner-instruction-outer-index-out-of-range');
  });

  it('orders inner-instruction groups by outer index', () => {
    const transaction = normalize({
      instructions: [
        rawInstruction('P1111111111111111111111111111111111111111'),
        rawInstruction('P2222222222222222222222222222222222222222'),
      ],
      meta: meta({
        innerInstructions: [
          { index: 1, instructions: [rawInstruction('P2222222222222222222222222222222222222222')] },
          { index: 0, instructions: [rawInstruction('P3333333333333333333333333333333333333333')] },
        ],
      }),
    });

    expect(transaction.innerInstructionGroups.map(g => g.outerIndex)).toEqual([0, 1]);
  });
});

describe('accounts', () => {
  it('supports plain-string account keys and reports the unknown flags', () => {
    // The `json` encoding returns bare base58 strings and no signer/writable flags.
    const transaction = normalize({ accountKeys: [ACCOUNT_A, ACCOUNT_B] });

    expect(transaction.accounts.map(a => a.address)).toEqual([ACCOUNT_A, ACCOUNT_B]);
    expect(transaction.accounts[0]?.signer).toBeNull();
    expect(transaction.accounts[0]?.source).toBeNull();
    // Signers cannot be derived, so the answer is "unknown", not an empty list.
    expect(transaction.signers).toBeNull();
    expect(codes(transaction.diagnostics)).toContain('signer-flags-missing');
  });

  it('keeps index alignment when an account entry is malformed', () => {
    const transaction = normalize({
      accountKeys: [{ pubkey: ACCOUNT_A, signer: true, writable: true, source: 'transaction' }, {}],
    });

    expect(transaction.accounts).toHaveLength(2);
    expect(transaction.accounts[1]?.address).toBe('');
    expect(codes(transaction.diagnostics)).toContain('account-entry-malformed');
  });

  it('identifies the fee payer positionally', () => {
    const transaction = normalize({});
    expect(transaction.feePayerAddress).toBe(ACCOUNT_A);
    expect(transaction.signers).toEqual([ACCOUNT_A]);
  });

  it('warns when the balance arrays are shorter than the account list', () => {
    const transaction = normalize({
      accountKeys: [
        { pubkey: ACCOUNT_A, signer: true, writable: true, source: 'transaction' },
        { pubkey: ACCOUNT_B, signer: false, writable: true, source: 'transaction' },
        { pubkey: 'Sysvar1111111111111111111111111111111111111', signer: false, writable: false, source: 'transaction' },
      ],
      meta: meta({ preBalances: [10], postBalances: [5] }),
    });

    expect(codes(transaction.diagnostics)).toContain('sol-balances-account-mismatch');
    expect(transaction.solBalanceChanges).toHaveLength(1);
  });
});

describe('amounts are exact', () => {
  it('keeps lamport precision beyond Number.MAX_SAFE_INTEGER', () => {
    const transaction = normalize({
      meta: meta({
        preBalances: ['9007199254740993'],
        postBalances: ['9007199254740994'],
      }),
    });

    // A float would round both to the same value and report a zero delta.
    expect(transaction.solBalanceChanges[0]?.deltaLamports).toBe(1n);
  });

  it('refuses to trust an unsafely large JSON number for lamports', () => {
    const transaction = normalize({
      meta: meta({ preBalances: [Number.MAX_SAFE_INTEGER + 2], postBalances: [0] }),
    });

    expect(transaction.solBalanceChanges[0]?.beforeLamports).toBeNull();
    expect(transaction.solBalanceChanges[0]?.deltaLamports).toBeNull();
  });

  it('computes exact raw token deltas', () => {
    const tokenEntry = (accountIndex: number, amount: string) => ({
      accountIndex,
      mint: ACCOUNT_B,
      owner: ACCOUNT_A,
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      uiTokenAmount: { amount, decimals: 9, uiAmount: null, uiAmountString: amount },
    });

    const transaction = normalize({
      meta: meta({
        preTokenBalances: [tokenEntry(0, '1000000000000000001')],
        postTokenBalances: [tokenEntry(0, '999999999999999999')],
      }),
    });

    const [change] = transaction.tokenBalanceChanges;
    expect(change?.deltaAmount).toBe(-2n);
    expect(change?.decimals).toBe(9);
    expect(change?.presence).toBe('both');
  });

  it('does not assume a token account started at zero', () => {
    const transaction = normalize({
      meta: meta({
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: ACCOUNT_B,
            owner: ACCOUNT_A,
            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            uiTokenAmount: { amount: '500', decimals: 6, uiAmount: null, uiAmountString: '500' },
          },
        ],
      }),
    });

    const [change] = transaction.tokenBalanceChanges;
    expect(change?.presence).toBe('only-after');
    expect(change?.beforeAmount).toBeNull();
    // No before -> no delta. We do not silently treat it as 0 and report +500.
    expect(change?.deltaAmount).toBeNull();
    expect(codes(transaction.diagnostics)).toContain('token-account-created');
  });

  it('reports a closed token account as only-before', () => {
    const transaction = normalize({
      meta: meta({
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: ACCOUNT_B,
            owner: ACCOUNT_A,
            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            uiTokenAmount: { amount: '7', decimals: 0, uiAmount: null, uiAmountString: '7' },
          },
        ],
        postTokenBalances: [],
      }),
    });

    expect(transaction.tokenBalanceChanges[0]?.presence).toBe('only-before');
    expect(transaction.tokenBalanceChanges[0]?.deltaAmount).toBeNull();
    expect(codes(transaction.diagnostics)).toContain('token-account-closed');
  });

  it('warns and leaves the address null when a token balance index is out of range', () => {
    const transaction = normalize({
      meta: meta({
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: 99,
            mint: ACCOUNT_B,
            uiTokenAmount: { amount: '1', decimals: 0, uiAmount: null, uiAmountString: '1' },
          },
        ],
      }),
    });

    expect(transaction.tokenBalanceChanges[0]?.address).toBeNull();
    expect(codes(transaction.diagnostics)).toContain('token-balance-account-index-out-of-range');
  });

  it('sorts token changes deterministically regardless of response order', () => {
    const entry = (accountIndex: number, mint: string) => ({
      accountIndex,
      mint,
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      uiTokenAmount: { amount: '1', decimals: 0, uiAmount: null, uiAmountString: '1' },
    });

    const transaction = normalize({
      meta: meta({
        preTokenBalances: [],
        postTokenBalances: [
          entry(1, 'MintZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'),
          entry(0, 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'),
          entry(0, 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        ],
      }),
    });

    expect(
      transaction.tokenBalanceChanges.map(c => `${c.accountIndex}|${c.mint}`),
    ).toEqual([
      '0|MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '0|MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      '1|MintZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
    ]);
  });
});

describe('error handling', () => {
  it('preserves the error object verbatim', () => {
    const error = { InstructionError: [3, { Custom: 6001 }] };
    const transaction = normalize({ meta: meta({ err: error }) });

    expect(transaction.status).toBe('failed');
    expect(transaction.error).toEqual(error);
  });

  it('preserves a simple string error variant', () => {
    const transaction = normalize({ meta: meta({ err: 'BlockhashNotFound' }) });
    expect(transaction.status).toBe('failed');
    expect(transaction.error).toBe('BlockhashNotFound');
  });

  it.each([
    ['a non-object payload', 'not json', /not a JSON object/],
    ['a payload without a slot', { transaction: { message: { instructions: [] } } }, /slot/],
    ['a payload without a transaction', { slot: 1 }, /"transaction" object/],
    ['a payload without a message', { slot: 1, transaction: {} }, /"message" object/],
    [
      'a payload without instructions',
      { slot: 1, transaction: { message: {} } },
      /"instructions" array/,
    ],
  ])('rejects %s', (_label, payload, pattern) => {
    expect(() => normalizeTransaction(payload, { provenance: PROVENANCE })).toThrow(
      NormalizationError,
    );
    expect(() => normalizeTransaction(payload, { provenance: PROVENANCE })).toThrow(pattern);
  });

  it('records the provenance it was given', () => {
    const transaction = normalize({});
    expect(transaction.provenance).toEqual(PROVENANCE);
  });
});
