import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import type { NormalizedInstruction } from '../src/model/transaction.ts';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { PROGRAM_DECODERS, decodeTransaction } from '../src/decode/decode.ts';
import { refLabel } from '../src/decode/actions.ts';
import { allFixtureNames, normalizeFixture } from './helpers/fixtures.ts';
import { ACC, SYSTEM, TOKEN, parsedInstruction, rawInstruction } from './helpers/instructions.ts';
import { meta, syntheticTransaction } from './helpers/synthetic.ts';

const PROVENANCE = {
  rpcEndpoint: 'https://example.invalid',
  encoding: 'jsonParsed',
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 1,
} as const;

describe('decoding every recorded mainnet fixture', () => {
  const names = allFixtureNames();

  it.each(names)('%s accounts for every instruction exactly once', name => {
    const { transaction } = normalizeFixture(name);
    const decoded = transaction.decoded;

    // No instruction is silently dropped or double-counted.
    expect(decoded.actions.length + decoded.undecoded.length).toBe(decoded.instructionCount);

    // instructionCount matches what the model actually holds.
    const modelCount =
      transaction.instructions.length +
      transaction.innerInstructionGroups.reduce((n, group) => n + group.instructions.length, 0);
    expect(decoded.instructionCount).toBe(modelCount);
  });

  it.each(names)('%s points every action at a real instruction', name => {
    const { transaction } = normalizeFixture(name);
    const byRef = new Map<string, NormalizedInstruction>();
    for (const instruction of transaction.instructions) {
      byRef.set(refLabel({ path: 'top-level', index: instruction.index, outerIndex: null, stackHeight: null }), instruction);
    }
    for (const group of transaction.innerInstructionGroups) {
      for (const instruction of group.instructions) {
        byRef.set(refLabel({ path: 'inner', index: instruction.index, outerIndex: group.outerIndex, stackHeight: null }), instruction);
      }
    }

    for (const action of transaction.decoded.actions) {
      const instruction = byRef.get(refLabel(action.ref));
      expect(instruction, `action ${action.kind} references ${refLabel(action.ref)}`).toBeDefined();
      expect(instruction?.programId).toBe(action.programId);

      // Evidence must match what the instruction actually carried.
      const expectedEvidence = instruction?.data !== null ? 'instruction-data' : 'rpc-parsed';
      expect(action.evidence).toBe(expectedEvidence);
    }
  });

  it.each(names)('%s only ever produces actions for programs we implement', name => {
    const { transaction } = normalizeFixture(name);
    const implemented = new Set(PROGRAM_DECODERS.map(decoder => decoder.programId));
    for (const action of transaction.decoded.actions) {
      expect(implemented.has(action.programId)).toBe(true);
    }
  });

  it.each(names)('%s is deterministic', name => {
    const { transaction } = normalizeFixture(name);
    const again = decodeTransaction({
      instructions: transaction.instructions,
      innerInstructionGroups: transaction.innerInstructionGroups,
    });
    expect(stringifyJson(again)).toBe(stringifyJson(transaction.decoded));
  });

  it.each(names)('%s never invents an action for a program it cannot decode', name => {
    const { transaction } = normalizeFixture(name);
    // Any program id outside our set must be reported as undecoded, never decoded.
    const supported = new Set(PROGRAM_DECODERS.map(decoder => decoder.programId));
    for (const entry of transaction.decoded.undecoded) {
      if (entry.programId !== null && !supported.has(entry.programId)) {
        expect(entry.reason).toBe('program-not-supported');
      }
    }
  });
});

describe('what the real fixtures actually decode to', () => {
  it('a legacy vote transaction yields no actions at all', () => {
    const { transaction } = normalizeFixture('legacy-success-vote');
    expect(transaction.decoded.actions).toEqual([]);
    expect(transaction.decoded.undecoded).toHaveLength(1);
    expect(transaction.decoded.undecoded[0]?.reason).toBe('program-not-supported');
  });

  it('the v0 swap decodes its ATA creation, account creation, transfers and close', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const kinds = transaction.decoded.actions.map(action => action.kind);

    expect(kinds).toContain('associated-token-account.create');
    expect(kinds).toContain('system.createAccount');
    expect(kinds.filter(k => k === 'spl-token.transferChecked').length).toBe(9);
    expect(kinds.filter(k => k === 'spl-token.transfer').length).toBe(1);
    expect(kinds).toContain('spl-token.closeAccount');

    // The ATA creation is idempotent in this transaction.
    const ata = transaction.decoded.actions.find(a => a.kind === 'associated-token-account.create');
    expect(ata).toMatchObject({ idempotent: true });

    // Its CPI sibling really is a System Program account creation.
    const createAccount = transaction.decoded.actions.find(a => a.kind === 'system.createAccount');
    expect(createAccount?.ref).toMatchObject({ path: 'inner', outerIndex: 2 });
    expect(createAccount).toMatchObject({ space: 165n, owner: TOKEN });
  });

  it('decoded values match the RPC payload they came from', () => {
    const { envelope, transaction } = normalizeFixture('v0-success-swap');
    const raw = envelope.response as {
      meta: { innerInstructions: { index: number; instructions: unknown[] }[] };
    };

    // Ground truth: the parsed instruction the node returned at [3.2].
    const group = raw.meta.innerInstructions.find(g => g.index === 3);
    const rawInner = group?.instructions[2] as {
      parsed: { info: { source: string; destination: string; mint: string; tokenAmount: { amount: string } } };
    };

    const action = transaction.decoded.actions.find(
      a => a.kind === 'spl-token.transferChecked' && a.ref.outerIndex === 3 && a.ref.index === 2,
    );
    expect(action).toMatchObject({
      source: rawInner.parsed.info.source,
      destination: rawInner.parsed.info.destination,
      mint: rawInner.parsed.info.mint,
      amount: BigInt(rawInner.parsed.info.tokenAmount.amount),
    });
  });

  it('decodes a real approve instruction', () => {
    const { envelope, transaction } = normalizeFixture('token-mixed-approve');
    const approve = transaction.decoded.actions.find(a => a.kind === 'spl-token.approve');
    expect(approve).toBeDefined();
    expect(approve).toMatchObject({ amount: 16_300n });

    const raw = envelope.response as { meta: { innerInstructions: { index: number; instructions: unknown[] }[] } };
    const info = (
      raw.meta.innerInstructions.flatMap(g => g.instructions).find(
        (ix): ix is { parsed: { info: Record<string, unknown> } } =>
          typeof ix === 'object' && ix !== null && (ix as { parsed?: { type?: string } }).parsed?.type === 'approve',
      ) as { parsed: { info: { source: string; delegate: string; owner: string } } }
    ).parsed.info;

    expect(approve).toMatchObject({
      source: info.source,
      delegate: info.delegate,
      authority: info.owner,
    });
  });

  it('decodes a real closeAccount plus its System Program transfer', () => {
    const { transaction } = normalizeFixture('token-mixed-closeAccount');
    const kinds = transaction.decoded.actions.map(a => a.kind);
    expect(kinds).toContain('spl-token.closeAccount');
    expect(kinds).toContain('system.transfer');
    expect(kinds.filter(k => k === 'associated-token-account.create').length).toBe(3);
  });

  it('reports recognized-but-out-of-scope Token instructions separately from unknown programs', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const reasons = new Set(transaction.decoded.undecoded.map(entry => entry.reason));
    expect(reasons.has('instruction-not-in-scope')).toBe(true); // getAccountDataSize, initializeAccount3, …
    expect(reasons.has('program-not-supported')).toBe(true); // ComputeBudget, Jupiter, …
  });
});

describe('meaning comes from instructions, never from balances', () => {
  it('produces no actions when there are no instructions, however the balances move', () => {
    const transaction = normalizeTransaction(
      syntheticTransaction({
        instructions: [],
        meta: meta({
          preBalances: [100_000_000_000, 1],
          postBalances: [1, 100_000_000_000],
          preTokenBalances: [
            {
              accountIndex: 1,
              mint: ACC.mint,
              owner: ACC.authority,
              programId: TOKEN,
              uiTokenAmount: { amount: '999999999999', decimals: 6, uiAmount: null, uiAmountString: '1' },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: ACC.mint,
              owner: ACC.authority,
              programId: TOKEN,
              uiTokenAmount: { amount: '0', decimals: 6, uiAmount: null, uiAmountString: '0' },
            },
          ],
        }),
      }),
      { provenance: PROVENANCE },
    );

    // Huge SOL and token movements… and no instruction to prove anything.
    expect(transaction.solBalanceChanges.some(change => (change.deltaLamports ?? 0n) > 0n)).toBe(true);
    expect(transaction.tokenBalanceChanges.some(change => (change.deltaAmount ?? 0n) < 0n)).toBe(true);
    expect(transaction.decoded.actions).toEqual([]);
  });

  it('produces no actions when every instruction belongs to an unknown program', () => {
    const transaction = normalizeTransaction(
      syntheticTransaction({
        instructions: [
          rawInstruction('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', [1, 2, 3], [ACC.source]),
        ],
        meta: meta({
          preBalances: [10_000_000_000, 0],
          postBalances: [0, 10_000_000_000],
        }),
      }),
      { provenance: PROVENANCE },
    );

    expect(transaction.decoded.actions).toEqual([]);
    expect(transaction.decoded.undecoded).toHaveLength(1);
    expect(transaction.decoded.undecoded[0]?.reason).toBe('program-not-supported');
  });

  it('ignores balance data entirely: same instructions + different balances ⇒ identical decode', () => {
    const instructions = [
      parsedInstruction(TOKEN, 'spl-token', 'transfer', {
        source: ACC.source,
        destination: ACC.destination,
        authority: ACC.authority,
        amount: '1',
      }),
    ];
    const quiet = normalizeTransaction(
      syntheticTransaction({
        instructions,
        meta: meta({
          preBalances: [0, 0],
          postBalances: [0, 0],
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      }),
      { provenance: PROVENANCE },
    );
    const loud = normalizeTransaction(
      syntheticTransaction({
        instructions,
        meta: meta({
          preBalances: [999_999_999_999, 1],
          postBalances: [1, 999_999_999_999],
          preTokenBalances: [
            {
              accountIndex: 0,
              mint: ACC.mint,
              owner: ACC.authority,
              programId: TOKEN,
              uiTokenAmount: { amount: '5', decimals: 6, uiAmount: null, uiAmountString: '5' },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 0,
              mint: ACC.mint,
              owner: ACC.authority,
              programId: TOKEN,
              uiTokenAmount: { amount: '999999', decimals: 6, uiAmount: null, uiAmountString: '999999' },
            },
          ],
        }),
      }),
      { provenance: PROVENANCE },
    );

    expect(stringifyJson(loud.decoded)).toBe(stringifyJson(quiet.decoded));
  });

  it('does not attach a mint or decimals to a plain transfer, even when token balances reveal them', () => {
    const transaction = normalizeTransaction(
      syntheticTransaction({
        instructions: [
          rawInstruction(TOKEN, [3, 1, 0, 0, 0, 0, 0, 0, 0], [ACC.source, ACC.destination, ACC.authority]),
        ],
        meta: meta({
          preTokenBalances: [
            {
              accountIndex: 0,
              mint: ACC.mint,
              owner: ACC.authority,
              programId: TOKEN,
              uiTokenAmount: { amount: '1000', decimals: 6, uiAmount: null, uiAmountString: '1000' },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 0,
              mint: ACC.mint,
              owner: ACC.authority,
              programId: TOKEN,
              uiTokenAmount: { amount: '999', decimals: 6, uiAmount: null, uiAmountString: '999' },
            },
          ],
        }),
      }),
      { provenance: PROVENANCE },
    );

    const action = transaction.decoded.actions[0];
    expect(action).toMatchObject({ kind: 'spl-token.transfer', amount: 1n });
    expect(action).not.toHaveProperty('mint');
    expect(action).not.toHaveProperty('decimals');
    // The balance layer still knows the mint — it is simply not instruction data.
    expect(transaction.tokenBalanceChanges[0]?.mint).toBe(ACC.mint);
  });

  it('decodes a system transfer into a different account than the fee payer without help from balances', () => {
    const transaction = normalizeTransaction(
      syntheticTransaction({
        instructions: [rawInstruction(SYSTEM, [2, 0, 0, 0, 64, 66, 15, 0, 0, 0, 0, 0], [ACC.funding, ACC.recipient])],
      }),
      { provenance: PROVENANCE },
    );
    expect(transaction.decoded.actions[0]).toMatchObject({
      kind: 'system.transfer',
      from: ACC.funding,
      to: ACC.recipient,
      lamports: 1_000_000n,
    });
  });
});
