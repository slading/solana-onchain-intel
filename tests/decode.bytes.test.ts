import { describe, expect, it } from 'vitest';
import { decodeInstruction } from '../src/decode/decode.ts';
import { SPL_TOKEN_PROGRAM_ID } from '../src/decode/programs.ts';
import {
  ACC,
  ATA,
  SYSTEM,
  TOKEN,
  TOKEN_2022,
  ata,
  rawInstruction,
  splToken,
  system,
  u64le,
  b58,
} from './helpers/instructions.ts';

/**
 * The instruction-bytes path: semantics read from the instruction's own data and
 * account list, independent of whatever the RPC node decided to parse.
 */
function decodeAction(instruction: Parameters<typeof decodeInstruction>[0]) {
  const outcome = decodeInstruction(instruction);
  expect(outcome.action, `expected an action; got ${JSON.stringify(outcome.undecoded)}`).not.toBeNull();
  return outcome;
}

describe('System Program: decoded from instruction bytes', () => {
  it('decodes Transfer with an exact lamport amount', () => {
    const outcome = decodeAction(
      rawInstruction(SYSTEM, system.transfer(100_000_000n), [ACC.funding, ACC.recipient]),
    );
    expect(outcome.action).toEqual({
      kind: 'system.transfer',
      program: 'system',
      programId: SYSTEM,
      evidence: 'instruction-data',
      ref: { path: 'top-level', index: 0, outerIndex: null, stackHeight: 1 },
      from: ACC.funding,
      to: ACC.recipient,
      lamports: 100_000_000n,
    });
  });

  it('reads the full bincode CreateAccount payload (tag, lamports, space, owner)', () => {
    const outcome = decodeAction(
      rawInstruction(SYSTEM, system.createAccount(1_488_440n, 165n, TOKEN), [
        ACC.funding,
        ACC.other,
      ]),
    );
    expect(outcome.action).toMatchObject({
      kind: 'system.createAccount',
      from: ACC.funding,
      newAccount: ACC.other,
      lamports: 1_488_440n,
      space: 165n,
      owner: TOKEN,
    });
  });

  it('accepts a lamport amount beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const huge = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    const outcome = decodeAction(rawInstruction(SYSTEM, system.transfer(huge), [ACC.funding, ACC.recipient]));
    expect(outcome.action).toMatchObject({ lamports: huge });
  });

  it('requires 4 bytes before claiming any System instruction', () => {
    // Two bytes cannot prove a bincode u32 discriminant.
    const outcome = decodeInstruction(rawInstruction(SYSTEM, [2, 0], [ACC.funding, ACC.recipient]));
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('malformed-instruction-data');
    expect(outcome.undecoded?.note).toContain('4-byte little-endian integer');
  });

  it('reports a recognized-but-undecoded System instruction as out of scope', () => {
    const outcome = decodeInstruction(rawInstruction(SYSTEM, system.assign(ACC.other), [ACC.funding]));
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('instruction-not-in-scope');
    expect(outcome.undecoded?.note).toContain('Assign');
  });

  it('reports a tag outside the instruction set as unknown', () => {
    const outcome = decodeInstruction(rawInstruction(SYSTEM, [...u64le(99n)], [ACC.funding]));
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('unknown-instruction-tag');
    expect(outcome.undecoded?.note).toContain('tag 99');
  });

  it('keeps a truncated CreateAccount but leaves unreadable fields null', () => {
    // Tag + only 4 of the 8 lamport bytes.
    const outcome = decodeAction(rawInstruction(SYSTEM, [0, 0, 0, 0, 1, 2, 3, 4], [ACC.funding, ACC.other]));
    expect(outcome.action).toMatchObject({
      kind: 'system.createAccount',
      from: ACC.funding,
      newAccount: ACC.other,
      lamports: null,
      space: null,
      owner: null,
    });
    expect(outcome.diagnostics.map(d => d.code)).toContain('decode-partial');
  });
});

describe('SPL Token: decoded from instruction bytes', () => {
  it('decodes Transfer (tag 3) and refuses to invent mint/decimals', () => {
    const outcome = decodeAction(
      rawInstruction(TOKEN, splToken.transfer(1_000_000n), [ACC.source, ACC.destination, ACC.authority]),
    );
    expect(outcome.action).toEqual({
      kind: 'spl-token.transfer',
      program: 'spl-token',
      programId: TOKEN,
      evidence: 'instruction-data',
      ref: { path: 'top-level', index: 0, outerIndex: null, stackHeight: 1 },
      source: ACC.source,
      destination: ACC.destination,
      authority: ACC.authority,
      amount: 1_000_000n,
    });
    // The instruction does not carry these; they must not appear at all.
    expect(outcome.action).not.toHaveProperty('mint');
    expect(outcome.action).not.toHaveProperty('decimals');
  });

  it('decodes TransferChecked (tag 12) with amount then decimals', () => {
    const outcome = decodeAction(
      rawInstruction(TOKEN, splToken.transferChecked(1_000_000n, 6), [
        ACC.source,
        ACC.mint,
        ACC.destination,
        ACC.authority,
      ]),
    );
    expect(outcome.action).toEqual({
      kind: 'spl-token.transferChecked',
      program: 'spl-token',
      programId: TOKEN,
      evidence: 'instruction-data',
      ref: { path: 'top-level', index: 0, outerIndex: null, stackHeight: 1 },
      source: ACC.source,
      mint: ACC.mint,
      destination: ACC.destination,
      authority: ACC.authority,
      amount: 1_000_000n,
      decimals: 6,
    });
  });

  it('decodes MintTo (tag 7) with the spec account order', () => {
    const outcome = decodeAction(
      rawInstruction(TOKEN, splToken.mintTo(500n), [ACC.mint, ACC.destination, ACC.authority]),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.mintTo',
      mint: ACC.mint,
      destination: ACC.destination,
      authority: ACC.authority,
      amount: 500n,
    });
  });

  it('decodes MintToChecked (tag 14)', () => {
    const outcome = decodeAction(
      rawInstruction(TOKEN, splToken.mintToChecked(500n, 9), [ACC.mint, ACC.destination, ACC.authority]),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.mintToChecked',
      mint: ACC.mint,
      destination: ACC.destination,
      authority: ACC.authority,
      amount: 500n,
      decimals: 9,
    });
  });

  it('decodes Burn (tag 8) with the account before the mint', () => {
    const outcome = decodeAction(
      rawInstruction(TOKEN, splToken.burn(7n), [ACC.other, ACC.mint, ACC.authority]),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.burn',
      account: ACC.other,
      mint: ACC.mint,
      authority: ACC.authority,
      amount: 7n,
    });
  });

  it('decodes BurnChecked (tag 15)', () => {
    const outcome = decodeAction(
      rawInstruction(TOKEN, splToken.burnChecked(7n, 2), [ACC.other, ACC.mint, ACC.authority]),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.burnChecked',
      account: ACC.other,
      mint: ACC.mint,
      amount: 7n,
      decimals: 2,
    });
  });

  it('decodes Approve (tag 4)', () => {
    const outcome = decodeAction(
      rawInstruction(TOKEN, splToken.approve(16300n), [ACC.source, ACC.other, ACC.authority]),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.approve',
      source: ACC.source,
      delegate: ACC.other,
      authority: ACC.authority,
      amount: 16300n,
    });
  });

  it('decodes Revoke (tag 5), which carries no amount', () => {
    const outcome = decodeAction(rawInstruction(TOKEN, splToken.revoke(), [ACC.source, ACC.authority]));
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.revoke',
      source: ACC.source,
      authority: ACC.authority,
    });
    expect(outcome.action).not.toHaveProperty('amount');
  });

  it('decodes CloseAccount (tag 9)', () => {
    const outcome = decodeAction(
      rawInstruction(TOKEN, splToken.closeAccount(), [ACC.other, ACC.funding, ACC.authority]),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.closeAccount',
      account: ACC.other,
      destination: ACC.funding,
      authority: ACC.authority,
    });
  });

  it('decodes the same tags for Token-2022 and labels the program differently', () => {
    const outcome = decodeAction(
      rawInstruction(TOKEN_2022, splToken.transferChecked(1n, 6), [
        ACC.source,
        ACC.mint,
        ACC.destination,
        ACC.authority,
      ]),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.transferChecked',
      program: 'spl-token-2022',
      programId: TOKEN_2022,
      decimals: 6,
    });
  });

  it('reports SetAuthority as recognized but out of scope', () => {
    const outcome = decodeInstruction(rawInstruction(TOKEN, splToken.setAuthority(), [ACC.other, ACC.other]));
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('instruction-not-in-scope');
    expect(outcome.undecoded?.note).toContain('SetAuthority');
  });

  it('reports a tag above the defined range as unknown', () => {
    const outcome = decodeInstruction(rawInstruction(TOKEN, [200], [ACC.other]));
    expect(outcome.undecoded?.reason).toBe('unknown-instruction-tag');
    expect(outcome.undecoded?.note).toContain('tag 200');
  });

  it('reports instruction data that is not valid base58', () => {
    // '0', 'O', 'I' and 'l' are not in the base58 alphabet.
    const instruction = rawInstruction(TOKEN, [3], [ACC.source]);
    const outcome = decodeInstruction({ ...instruction, data: '0OIl' });
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('malformed-instruction-data');
    expect(outcome.undecoded?.note).toContain('not valid base58');
  });

  it('keeps the proven kind when the amount is truncated', () => {
    // Tag 3 with only 3 of the 8 amount bytes.
    const outcome = decodeAction(rawInstruction(TOKEN, [3, 1, 2, 3], [ACC.source, ACC.destination, ACC.authority]));
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.transfer',
      source: ACC.source,
      destination: ACC.destination,
      authority: ACC.authority,
      amount: null,
    });
    expect(outcome.diagnostics.map(d => d.code)).toContain('decode-partial');
  });

  it('keeps the proven kind when decimals are truncated on a Checked instruction', () => {
    // Tag 12 + full amount, but the decimals byte is missing.
    const outcome = decodeAction(
      rawInstruction(TOKEN, [12, ...u64le(42n)], [ACC.source, ACC.mint, ACC.destination, ACC.authority]),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.transferChecked',
      amount: 42n,
      decimals: null,
    });
  });

  it('leaves roles null when the account list is too short, keeping the kind', () => {
    const outcome = decodeAction(rawInstruction(TOKEN, splToken.transferChecked(9n, 6), [ACC.source, ACC.mint]));
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.transferChecked',
      source: ACC.source,
      mint: ACC.mint,
      destination: null,
      authority: null,
      amount: 9n,
      decimals: 6,
    });
    expect(outcome.diagnostics.some(d => d.message.includes('expected at least 4 account(s)'))).toBe(true);
  });

  it('decodes an instruction with no data at all as a failure, not a guess', () => {
    const outcome = decodeInstruction(rawInstruction(TOKEN, [], [ACC.source]));
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('malformed-instruction-data');
  });
});

describe('Associated Token Account: decoded from instruction bytes', () => {
  const accounts = [ACC.funding, ACC.other, ACC.authority, ACC.mint, SYSTEM, TOKEN];

  it('treats empty data as Create, matching the program itself', () => {
    const outcome = decodeAction(rawInstruction(ATA, ata.create(), accounts));
    expect(outcome.action).toEqual({
      kind: 'associated-token-account.create',
      program: 'associated-token-account',
      programId: ATA,
      evidence: 'instruction-data',
      ref: { path: 'top-level', index: 0, outerIndex: null, stackHeight: 1 },
      idempotent: false,
      payer: ACC.funding,
      associatedTokenAccount: ACC.other,
      wallet: ACC.authority,
      mint: ACC.mint,
      systemProgram: SYSTEM,
      tokenProgram: TOKEN,
    });
  });

  it('decodes CreateIdempotent (tag 1)', () => {
    const outcome = decodeAction(rawInstruction(ATA, ata.createIdempotent(), accounts));
    expect(outcome.action).toMatchObject({ kind: 'associated-token-account.create', idempotent: true });
  });

  it('decodes an explicit Create (tag 0) identically to empty data', () => {
    const explicit = decodeAction(rawInstruction(ATA, [0], accounts)).action;
    const empty = decodeAction(rawInstruction(ATA, [], accounts)).action;
    expect(explicit).toEqual({ ...empty, evidence: 'instruction-data' });
  });

  it('reports RecoverNested as recognized but out of scope', () => {
    const outcome = decodeInstruction(rawInstruction(ATA, ata.recoverNested(), accounts));
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('instruction-not-in-scope');
    expect(outcome.undecoded?.note).toContain('RecoverNested');
  });

  it('reports an unknown ATA tag', () => {
    const outcome = decodeInstruction(rawInstruction(ATA, [77], accounts));
    expect(outcome.undecoded?.reason).toBe('unknown-instruction-tag');
  });

  it('notes trailing bytes but does not treat them as meaning', () => {
    const outcome = decodeAction(rawInstruction(ATA, [1, 9, 9], accounts));
    expect(outcome.action).toMatchObject({ idempotent: true });
    expect(outcome.diagnostics.some(d => d.message.includes('trailing byte(s)'))).toBe(true);
  });
});

describe('programs and instructions we do not decode', () => {
  it('leaves an unknown program unknown, whatever it looks like', () => {
    const outcome = decodeInstruction(
      rawInstruction('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', splToken.transfer(1n), [ACC.source]),
    );
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('program-not-supported');
    expect(outcome.undecoded?.programId).toBe('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  });

  it('repeats the RPC label as a fact without turning it into an action', () => {
    const outcome = decodeInstruction(
      rawInstruction('Cm5b58d85L8S6rpzLhutQJg9FEhEQ3i6HWcH5DwWoQFC', [], [], {
        programName: 'saber-stableswap',
        parsedType: 'swap',
      }),
    );
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('program-not-supported');
    // The label is reported, and explicitly not treated as meaning.
    expect(outcome.undecoded?.note).toContain('saber-stableswap');
    expect(outcome.undecoded?.note).toContain('do not treat as meaning');
  });

  it('handles an instruction with no program id', () => {
    const outcome = decodeInstruction(rawInstruction(null, [1], []));
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('program-id-missing');
  });

  it('handles an instruction with neither data nor an RPC parse', () => {
    const outcome = decodeInstruction({
      index: 0,
      outerIndex: null,
      programId: TOKEN,
      programName: null,
      parsedType: null,
      parsedInfo: null,
      accounts: null,
      data: null,
      dataEncoding: 'base58',
      stackHeight: null,
      decoding: 'unrecognized-shape',
    });
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('no-decoding-evidence');
  });
});

describe('the decoder exposes the program ids it handles', () => {
  it('matches the official program ids', () => {
    expect(SYSTEM).toBe('11111111111111111111111111111111');
    expect(SPL_TOKEN_PROGRAM_ID).toBe(TOKEN);
  });

  it('round-trips a known base58 vector', () => {
    // [12] + 1000000 LE + decimals 6, as base58.
    expect(b58([12, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0, 6])).toBe('gvPShZQhKrzGM');
  });
});
