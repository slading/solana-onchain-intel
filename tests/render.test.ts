import { describe, expect, it } from 'vitest';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { renderSummary } from '../src/render/summary.ts';
import { normalizeFixture } from './helpers/fixtures.ts';
import { meta, rawInstruction, syntheticTransaction } from './helpers/synthetic.ts';

const PROVENANCE = {
  rpcEndpoint: 'https://example.invalid',
  encoding: 'jsonParsed',
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 1,
} as const;

function normalize(parts: Parameters<typeof syntheticTransaction>[0]) {
  return normalizeTransaction(syntheticTransaction(parts), { provenance: PROVENANCE });
}

describe('deterministic, human-readable rendering', () => {
  it('renders a complete transaction exactly as recorded', () => {
    const transaction = normalize({
      slot: 250,
      blockTime: 1_700_000_123,
      version: 0,
      signatures: ['5' + 'x'.repeat(63)],
      accountKeys: [
        {
          pubkey: 'FeePayer111111111111111111111111111111111111',
          signer: true,
          writable: true,
          source: 'transaction',
        },
        {
          pubkey: 'TokenAccount11111111111111111111111111111111',
          signer: false,
          writable: true,
          source: 'lookupTable',
        },
      ],
      instructions: [
        rawInstruction('UnknownProgram11111111111111111111111', 'Qk9uZQ', [
          'TokenAccount11111111111111111111111111111111',
        ]),
      ],
      meta: meta({
        fee: 5000,
        computeUnitsConsumed: 1234,
        preBalances: [1_000_000_000, 2_039_280],
        postBalances: [999_995_000, 0],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: 'Mint111111111111111111111111111111111111111',
            owner: 'FeePayer111111111111111111111111111111111111',
            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            uiTokenAmount: { amount: '1000', decimals: 6, uiAmount: 0.001, uiAmountString: '0.001' },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: 'Mint111111111111111111111111111111111111111',
            owner: 'FeePayer111111111111111111111111111111111111',
            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            uiTokenAmount: { amount: '0', decimals: 6, uiAmount: null, uiAmountString: '0' },
          },
        ],
        innerInstructions: [
          { index: 0, instructions: [rawInstruction('InnerProgram111111111111111111111111111', 'aW5uZXI', [])] },
        ],
        logMessages: [
          'Program UnknownProgram11111111111111111111111 invoke [1]',
          'Program InnerProgram111111111111111111111111111 invoke [2]',
        ],
      }),
    });

    // Milestone 1 sections, unchanged: with ACTIONS suppressed this reproduces the
    // frozen Milestone 1 golden byte for byte.
    expect(renderSummary(transaction, { includeLogs: true, includeActions: false })).toBe(
      GOLDEN_SUMMARY,
    );
    // The same transaction with the Milestone 2 ACTIONS section appended.
    expect(renderSummary(transaction, { includeLogs: true })).toBe(GOLDEN_SUMMARY_WITH_ACTIONS);
  });

  it('renders byte-identically on repeated runs', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const first = renderSummary(transaction, { includeLogs: true });
    const second = renderSummary(transaction, { includeLogs: true });
    expect(second).toBe(first);
  });

  it('never emits ANSI escapes, so output is pipe- and diff-safe', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const text = renderSummary(transaction, { includeLogs: true });
    // The only ESC-like sequence we could produce is a colour code; there are none.
    expect(text).not.toMatch(/\u001b\[/);
    // Every line is text, with no carriage returns or tabs to break diffs.
    expect(text).not.toMatch(/[\r\t]/);
  });

  it('omits logs on request', () => {
    const { transaction } = normalizeFixture('legacy-success-vote');
    expect(renderSummary(transaction, { includeLogs: true })).toContain('LOGS');
    expect(renderSummary(transaction, { includeLogs: false })).not.toContain('\nLOGS\n');
  });

  it('says UNKNOWN for instructions the RPC did not decode', () => {
    const transaction = normalize({
      instructions: [rawInstruction('UnknownProgram11111111111111111111111')],
    });
    const text = renderSummary(transaction, { includeLogs: false });
    expect(text).toContain('UNKNOWN — the RPC did not decode this instruction');
    expect(text).toContain('meaning is not inferred');
  });

  it('reports unavailable data as unavailable, not as zero', () => {
    const transaction = normalize({ meta: null });
    const text = renderSummary(transaction, { includeLogs: true });
    expect(text).toContain('Status       UNKNOWN');
    expect(text).toContain('Fee          unknown');
    expect(text).toContain('unknown — this node did not report token balances');
    expect(text).toContain('unknown — the RPC did not report logs for this transaction');
    expect(text).toContain('metadata-missing');
  });

  it('shows a failure with its raw error', () => {
    const transaction = normalize({
      meta: meta({ err: { InstructionError: [3, { Custom: 6001 }] } }),
    });
    const text = renderSummary(transaction, { includeLogs: false });
    expect(text).toContain('FAILED');
    expect(text).toContain('{"InstructionError":[3,{"Custom":6001}]}');
  });

  it('marks a token delta it cannot compute', () => {
    const transaction = normalize({
      meta: meta({
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: 'Mint111111111111111111111111111111111111111',
            uiTokenAmount: { amount: '5', decimals: 6, uiAmount: null, uiAmountString: '5' },
          },
        ],
      }),
    });
    const text = renderSummary(transaction, { includeLogs: false });
    expect(text).toContain('before not reported');
    expect(text).toContain('delta  not computable');
    expect(text).toContain('created in this transaction');
  });
});

const GOLDEN_SUMMARY: string = "\nTRANSACTION 5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n\n  Slot         250\n  Block time   2023-11-14T22:15:23.000Z (unix 1700000123)\n  Version      v0\n  Status       SUCCESS\n  Fee          0.000005 SOL (5000 lamports)\n  Compute      1234 CU consumed\n  Signatures   1\n  Fee payer    FeePayer111111111111111111111111111111111111\n  Signers      FeePayer111111111111111111111111111111111111\n  Recent bh    BH1111111111111111111111111111111111111111\n  Accounts     2 (1 resolved from address lookup tables)\n\nINSTRUCTIONS (1 top-level, 1 inner)\n  [0] UnknownProgram11111111111111111111111\n      type   UNKNOWN — the RPC did not decode this instruction; meaning is not inferred\n      data   Qk9uZQ (base58, raw)\n      accts  (1) TokenAccount11111111111111111111111111111111\n      [0.0] InnerProgram111111111111111111111111111\n          type   UNKNOWN — the RPC did not decode this instruction; meaning is not inferred\n          data   aW5uZXI (base58, raw)\n          accts  (0) (none)\n\nSOL BALANCE CHANGES (including the fee; unchanged accounts omitted)\n  FeePayer111111111111111111111111111111111111  1 -> 0.999995 SOL  (-5000 lamports)\n  TokenAccount11111111111111111111111111111111  0.00203928 -> 0 SOL  (-2039280 lamports)\n\nTOKEN BALANCE CHANGES\n  [1] TokenAccount11111111111111111111111111111111  mint=Mint111111111111111111111111111111111111111  program=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\n      owner  FeePayer111111111111111111111111111111111111\n      decimals 6\n      before 1000 (ui 0.001)\n      after  0 (ui 0)\n      delta  -1000 raw units (pre and post reported)\n\nLOGS\n  0   Program UnknownProgram11111111111111111111111 invoke [1]\n  1   Program InnerProgram111111111111111111111111111 invoke [2]\n";

/** Same transaction, with the Milestone 2 ACTIONS section appended. */
const GOLDEN_SUMMARY_WITH_ACTIONS: string = "\nTRANSACTION 5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n\n  Slot         250\n  Block time   2023-11-14T22:15:23.000Z (unix 1700000123)\n  Version      v0\n  Status       SUCCESS\n  Fee          0.000005 SOL (5000 lamports)\n  Compute      1234 CU consumed\n  Signatures   1\n  Fee payer    FeePayer111111111111111111111111111111111111\n  Signers      FeePayer111111111111111111111111111111111111\n  Recent bh    BH1111111111111111111111111111111111111111\n  Accounts     2 (1 resolved from address lookup tables)\n\nINSTRUCTIONS (1 top-level, 1 inner)\n  [0] UnknownProgram11111111111111111111111\n      type   UNKNOWN \u2014 the RPC did not decode this instruction; meaning is not inferred\n      data   Qk9uZQ (base58, raw)\n      accts  (1) TokenAccount11111111111111111111111111111111\n      [0.0] InnerProgram111111111111111111111111111\n          type   UNKNOWN \u2014 the RPC did not decode this instruction; meaning is not inferred\n          data   aW5uZXI (base58, raw)\n          accts  (0) (none)\n\nACTIONS (0 decoded, 2 not decoded, from 2 instruction(s))\n  (no instructions in the Milestone 2 target set were found)\n\n  not decoded (2); unknown programs stay unknown:\n    (2) program not decoded by this layer: [0] UnknownProgram11111111111111111111111  \u2022  [0.0] InnerProgram111111111111111111111111111\n\n  decoded from instruction data only \u2014 never from balance changes.\n\nSOL BALANCE CHANGES (including the fee; unchanged accounts omitted)\n  FeePayer111111111111111111111111111111111111  1 -> 0.999995 SOL  (-5000 lamports)\n  TokenAccount11111111111111111111111111111111  0.00203928 -> 0 SOL  (-2039280 lamports)\n\nTOKEN BALANCE CHANGES\n  [1] TokenAccount11111111111111111111111111111111  mint=Mint111111111111111111111111111111111111111  program=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\n      owner  FeePayer111111111111111111111111111111111111\n      decimals 6\n      before 1000 (ui 0.001)\n      after  0 (ui 0)\n      delta  -1000 raw units (pre and post reported)\n\nLOGS\n  0   Program UnknownProgram11111111111111111111111 invoke [1]\n  1   Program InnerProgram111111111111111111111111111 invoke [2]\n";
