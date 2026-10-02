/**
 * Raw-unit bookkeeping, wrapped SOL, and what this layer refuses to infer from a
 * token-program instruction.
 *
 * The balance rows are written by hand and the expected numbers are derived from
 * conservation (units leaving one account arrive at another, and supply changes
 * only through mint/burn), never from the implementation.
 */

import { describe, expect, it } from 'vitest';
import { NATIVE_MINT } from '../src/effects/native.ts';
import { stringifyJson } from '../src/lib/format.ts';
import { ACC, TOKEN, TOKEN_2022, rawInstruction, splToken } from './helpers/instructions.ts';
import { account, effectsOf, scenario, tokenRow } from './helpers/effects.ts';

const FEE = 5000n;
const FUNDER = ACC.other;
const MINT = ACC.mint;

/** A fee payer row that only pays the fee, so lamport balance does not distract. */
function funderRow(): ReturnType<typeof account> {
  return account(9, FUNDER, { signer: true, before: 10_000_000n, after: 10_000_000n - FEE });
}

describe('SPL token transfers', () => {
  it('moves raw units between two token accounts and sizes both nets exactly', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [
        tokenRow(0, ACC.source, MINT, ACC.authority, { before: 1_000n, after: 900n, decimals: 6 }),
        tokenRow(1, ACC.destination, MINT, ACC.recipient, { before: 0n, after: 100n, decimals: 6 }),
      ],
      instructions: [rawInstruction(TOKEN, splToken.transfer(100n), [ACC.source, ACC.destination, ACC.authority])],
    });

    expect(effects.tokenFlows).toHaveLength(1);
    expect(effects.tokenFlows[0]).toMatchObject({
      kind: 'transfer',
      confidence: 'proven',
      amount: 100n,
      amountSource: 'instruction-data',
      sourceTokenAccount: ACC.source,
      destinationTokenAccount: ACC.destination,
      // The owner of each account is what the token account reports, kept apart
      // from the accounts themselves and from the mint.
      sourceOwner: ACC.authority,
      destinationOwner: ACC.recipient,
      // A plain `transfer` does not carry a mint, so this one comes from the
      // accounts' own metadata.
      mint: MINT,
      mintEvidence: 'account-metadata',
      decimals: 6,
      nativeLamportLeg: false,
    });

    const source = effects.netTokenByAccountMint.find(row => row.tokenAccount === ACC.source);
    const destination = effects.netTokenByAccountMint.find(row => row.tokenAccount === ACC.destination);
    expect(source?.netAmount).toBe(-100n);
    expect(destination?.netAmount).toBe(100n);
    expect(source?.reconciliation).toBe('exact');
    expect(destination?.reconciliation).toBe('exact');
    expect(effects.unattributedEffects).toEqual([]);
    expect(effects.diagnostics).toEqual([]);
  });

  it('takes mint and decimals from a checked instruction instead of metadata', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [
        tokenRow(0, ACC.source, MINT, ACC.authority, { before: 1_000n, after: 500n }),
        tokenRow(1, ACC.destination, MINT, ACC.recipient, { before: 0n, after: 500n }),
      ],
      instructions: [
        rawInstruction(TOKEN, splToken.transferChecked(500n, 6), [ACC.source, MINT, ACC.destination, ACC.authority]),
      ],
    });

    expect(effects.tokenFlows[0]).toMatchObject({
      amount: 500n,
      mint: MINT,
      mintEvidence: 'instruction-data',
      decimals: 6,
      decimalsEvidence: 'instruction-data',
    });
  });

  it('covers Token-2022 accounts with the same model', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [
        tokenRow(0, ACC.source, MINT, ACC.authority, { before: 1_000n, after: 500n, programId: TOKEN_2022 }),
        tokenRow(1, ACC.destination, MINT, ACC.recipient, { before: 0n, after: 500n, programId: TOKEN_2022 }),
      ],
      instructions: [
        rawInstruction(TOKEN_2022, splToken.transferChecked(500n, 6), [ACC.source, MINT, ACC.destination, ACC.authority]),
      ],
    });

    expect(effects.tokenFlows[0]).toMatchObject({ amount: 500n, mint: MINT, nativeLamportLeg: false });
    expect(effects.netTokenByAccountMint.every(row => row.reconciliation === 'exact')).toBe(true);
  });

  it('refuses to name a mint when the two token accounts report different ones', () => {
    const otherMint = ACC.authority;
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [
        tokenRow(0, ACC.source, MINT, ACC.authority, { before: 1_000n, after: 900n }),
        tokenRow(1, ACC.destination, otherMint, ACC.recipient, { before: 0n, after: 100n }),
      ],
      instructions: [rawInstruction(TOKEN, splToken.transfer(100n), [ACC.source, ACC.destination, ACC.authority])],
    });

    // A plain `transfer` does not check the mint against anything, so two
    // different mints is a real possibility: the flow is still proven, the mint
    // label is not, and the disagreement is a warning rather than a pick.
    expect(effects.tokenFlows[0]?.mint).toBeNull();
    expect(effects.tokenFlows[0]?.mintEvidence).toBe('none');
    expect(effects.diagnostics.some(note => note.code === 'effects-transfer-mint-conflict')).toBe(true);
    expect(effects.tokenFlows[0]?.amount).toBe(100n);
  });

  it('says so when a plain transfer has no metadata to name a mint', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [],
      instructions: [rawInstruction(TOKEN, splToken.transfer(100n), [ACC.source, ACC.destination, ACC.authority])],
    });

    expect(effects.tokenFlows[0]?.mint).toBeNull();
    expect(effects.diagnostics.some(note => note.code === 'effects-transfer-mint-unknown')).toBe(true);
  });

  it('carries a CPI transfer with the inner instruction that made it', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [
        tokenRow(0, ACC.source, MINT, ACC.authority, { before: 1_000n, after: 900n }),
        tokenRow(1, ACC.destination, MINT, ACC.recipient, { before: 0n, after: 100n }),
      ],
      instructions: [rawInstruction(ACC.other, [7, 7, 7], [])],
      inner: new Map([
        [
          0,
          [
            rawInstruction(TOKEN, splToken.transfer(100n), [ACC.source, ACC.destination, ACC.authority], {
              outerIndex: 0,
              stackHeight: 2,
            }),
          ],
        ],
      ]),
    });

    expect(effects.tokenFlows[0]?.ref).toMatchObject({ path: 'inner', outerIndex: 0, index: 0, stackHeight: 2 });
  });
});

describe('supply changes', () => {
  it('records a mint as an increase with no source account', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [tokenRow(0, ACC.destination, MINT, ACC.recipient, { before: 100n, after: 600n })],
      instructions: [rawInstruction(TOKEN, splToken.mintTo(500n), [MINT, ACC.destination, ACC.authority])],
    });

    expect(effects.tokenFlows[0]).toMatchObject({
      kind: 'mint',
      amount: 500n,
      sourceTokenAccount: null,
      destinationTokenAccount: ACC.destination,
      mint: MINT,
      mintEvidence: 'instruction-data',
    });
    expect(effects.netTokenByAccountMint[0]?.reconciliation).toBe('exact');
    expect(effects.diagnostics.some(note => note.code === 'effects-token-conservation-violated')).toBe(false);
  });

  it('records a burn as a decrease with no destination account', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [tokenRow(0, ACC.source, MINT, ACC.authority, { before: 600n, after: 100n })],
      instructions: [rawInstruction(TOKEN, splToken.burn(500n), [ACC.source, MINT, ACC.authority])],
    });

    expect(effects.tokenFlows[0]).toMatchObject({
      kind: 'burn',
      amount: 500n,
      sourceTokenAccount: ACC.source,
      destinationTokenAccount: null,
    });
    expect(effects.diagnostics.some(note => note.code === 'effects-token-conservation-violated')).toBe(false);
  });

  it('checks that raw-unit changes equal minted minus burned', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      // 500 units appeared in an account of this mint, but nothing minted them.
      tokenRows: [tokenRow(0, ACC.destination, MINT, ACC.recipient, { before: 0n, after: 500n })],
      instructions: [],
    });

    const warning = effects.diagnostics.find(note => note.code === 'effects-token-conservation-violated');
    expect(warning?.level).toBe('warning');
    expect(effects.unattributedEffects).toHaveLength(1);
    expect(effects.unattributedEffects[0]).toMatchObject({ side: 'token', reason: 'not-explained', amount: 500n });
  });

  it('warns when a mint or burn targets a wrapped-SOL account, which the program rejects', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [tokenRow(0, ACC.destination, NATIVE_MINT, ACC.recipient, { before: 0n, after: 500n })],
      instructions: [rawInstruction(TOKEN, splToken.mintTo(500n), [NATIVE_MINT, ACC.destination, ACC.authority])],
    });

    const warning = effects.diagnostics.find(note => note.code === 'effects-native-mint-or-burn');
    expect(warning?.level).toBe('warning');
    expect(warning?.message).toContain('NativeNotSupported');
  });
});

describe('wrapped SOL', () => {
  it('records the lamport leg of a wrapped-SOL transfer and reconciles both sides', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [
        funderRow(),
        account(0, ACC.source, { before: 1_000_000n, after: 999_900n }),
        account(1, ACC.destination, { before: 0n, after: 100n }),
      ],
      tokenRows: [
        tokenRow(0, ACC.source, NATIVE_MINT, ACC.authority, { before: 1_000n, after: 900n, decimals: 9 }),
        tokenRow(1, ACC.destination, NATIVE_MINT, ACC.recipient, { before: 0n, after: 100n, decimals: 9 }),
      ],
      instructions: [
        rawInstruction(TOKEN, splToken.transferChecked(100n, 9), [ACC.source, NATIVE_MINT, ACC.destination, ACC.authority]),
      ],
    });

    expect(effects.tokenFlows[0]?.nativeLamportLeg).toBe(true);
    const leg = effects.solFlows.find(flow => flow.kind === 'native-token-leg');
    expect(leg).toMatchObject({
      from: ACC.source,
      to: ACC.destination,
      lamports: 100n,
      amountSource: 'instruction-data',
      actionKind: 'spl-token.transferChecked',
    });
    // Lamports and units describe the same movement, so both accounts reconcile.
    for (const address of [ACC.source, ACC.destination]) {
      expect(effects.netSolByAccount.find(net => net.address === address)?.reconciliation).toBe('exact');
    }
    expect(effects.diagnostics.some(note => note.code === 'effects-native-lamport-identity-broken')).toBe(false);
  });

  it('notices when a wrapped-SOL account moved lamports for another reason', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [
        funderRow(),
        // 100 units moved, but 400 lamports left the account.
        account(0, ACC.source, { before: 1_000_000n, after: 999_600n }),
        account(1, ACC.destination, { before: 0n, after: 100n }),
      ],
      tokenRows: [
        tokenRow(0, ACC.source, NATIVE_MINT, ACC.authority, { before: 1_000n, after: 900n, decimals: 9 }),
        tokenRow(1, ACC.destination, NATIVE_MINT, ACC.recipient, { before: 0n, after: 100n, decimals: 9 }),
      ],
      instructions: [
        rawInstruction(TOKEN, splToken.transferChecked(100n, 9), [ACC.source, NATIVE_MINT, ACC.destination, ACC.authority]),
      ],
    });

    const note = effects.diagnostics.find(entry => entry.code === 'effects-native-lamport-identity-broken');
    expect(note?.level).toBe('info');
    // The extra 300 lamports are reported as unexplained, not folded into the flow.
    expect(effects.netSolByAccount.find(net => net.address === ACC.source)?.residualLamports).toBe(-300n);
    expect(effects.unattributedEffects.map(entry => entry.amount)).toEqual([-300n]);
  });

  it('does not claim a lamport leg when the mint is not knowable', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [
        funderRow(),
        account(0, ACC.source, { before: 1_000_000n, after: 999_900n }),
        account(1, ACC.destination, { before: 0n, after: 100n }),
      ],
      // No token rows at all: the flow is proven, its mint is not — so no lamport
      // leg is asserted and the missing lamports stay unexplained.
      instructions: [rawInstruction(TOKEN, splToken.transfer(100n), [ACC.source, ACC.destination, ACC.authority])],
    });

    expect(effects.tokenFlows[0]?.nativeLamportLeg).toBe(false);
    expect(effects.solFlows.some(flow => flow.kind === 'native-token-leg')).toBe(false);
    expect(effects.unattributedEffects.map(entry => [entry.amount, entry.side])).toEqual([
      [-100n, 'sol'],
      [100n, 'sol'],
    ]);
  });

  it('excludes wrapped SOL from the token conservation check', () => {
    // `syncNative` creates wrapped units without moving lamports, which the token
    // program's own model allows for the native mint only. Local supply accounting
    // is therefore not asserted for wrapped-SOL accounts.
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow(), account(1, ACC.destination, { before: 500n, after: 500n })],
      tokenRows: [
        tokenRow(1, ACC.destination, NATIVE_MINT, ACC.recipient, { before: 100n, after: 600n, decimals: 9 }),
      ],
      instructions: [],
    });

    expect(effects.diagnostics.some(note => note.code === 'effects-token-conservation-violated')).toBe(false);
  });
});

describe('allowances are state, not value', () => {
  it('records an approve as a delegation without inventing a flow', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [tokenRow(0, ACC.source, MINT, ACC.authority, { before: 100n, after: 100n })],
      instructions: [rawInstruction(TOKEN, splToken.approve(42n), [ACC.source, ACC.other, ACC.authority])],
    });

    expect(effects.tokenFlows).toEqual([]);
    expect(effects.solFlows.map(flow => flow.kind)).toEqual(['fee']);
    expect(effects.accountLifecycleEffects).toHaveLength(1);
    expect(effects.accountLifecycleEffects[0]).toMatchObject({
      kind: 'allowance-set',
      tokenAccount: ACC.source,
      delegate: ACC.other,
      allowance: 42n,
      owner: ACC.authority,
      confidence: 'proven',
    });
    // Nothing changed hands: the account's net is exactly zero and explained.
    expect(effects.netTokenByAccountMint[0]?.netAmount).toBe(0n);
    expect(effects.netTokenByAccountMint[0]?.reconciliation).toBe('exact');
    expect(effects.unattributedEffects).toEqual([]);
  });

  it('records a revoke as clearing the delegation', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [tokenRow(0, ACC.source, MINT, ACC.authority, { before: 100n, after: 100n })],
      instructions: [rawInstruction(TOKEN, splToken.revoke(), [ACC.source, ACC.authority])],
    });

    expect(effects.tokenFlows).toEqual([]);
    expect(effects.accountLifecycleEffects[0]).toMatchObject({ kind: 'allowance-cleared', tokenAccount: ACC.source });
  });
});

describe('owners, accounts and mints stay separate', () => {
  it('keeps an account net and its owner net apart', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [
        tokenRow(0, ACC.source, MINT, ACC.authority, { before: 1_000n, after: 900n }),
        tokenRow(1, ACC.destination, MINT, ACC.authority, { before: 0n, after: 40n }),
        tokenRow(2, ACC.other, MINT, ACC.authority, { before: 200n, after: 260n }),
      ],
      instructions: [
        rawInstruction(TOKEN, splToken.transfer(100n), [ACC.source, ACC.destination, ACC.authority]),
        rawInstruction(TOKEN, splToken.transfer(60n), [ACC.destination, ACC.other, ACC.authority]),
      ],
    });

    expect(effects.netTokenByAccountMint.map(row => [row.tokenAccount, row.netAmount])).toEqual([
      [ACC.source, -100n],
      [ACC.destination, 40n],
      [ACC.other, 60n],
    ]);

    // One owner, one mint, three accounts: the aggregate is a statement about the
    // owner's holdings, and it names how many accounts it covers.
    const owner = effects.netTokenByOwnerMint.find(entry => entry.owner === ACC.authority && entry.mint === MINT);
    expect(owner?.netAmount).toBe(0n);
    expect(owner?.tokenAccountCount).toBe(3);
    expect(owner?.tokenAccounts).toEqual([ACC.source, ACC.destination, ACC.other]);
  });

  it('reports an unreadable starting amount as unknown instead of assuming zero', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow()],
      tokenRows: [tokenRow(0, ACC.source, MINT, ACC.authority, { before: null, after: 900n, presence: 'only-after' })],
      instructions: [],
    });

    const row = effects.netTokenByAccountMint[0];
    expect(row?.startingAmountSource).toBe('not-observable');
    expect(row?.netAmount).toBeNull();
    expect(row?.reconciliation).toBe('unknown');
    expect(effects.unattributedEffects[0]).toMatchObject({ side: 'token', reason: 'delta-not-observable', amount: null });
    expect(effects.unattributedEffects[0]?.explanation).toContain('not zero');
  });

  it('treats an account a committed create proves new as starting at zero', () => {
    const effects = effectsOf({
      fee: FEE,
      accounts: [funderRow(), account(0, ACC.destination, { before: 0n, after: 1_488_440n })],
      tokenRows: [tokenRow(0, ACC.destination, MINT, ACC.recipient, { before: null, after: 500n, presence: 'only-after' })],
      instructions: [
        rawInstruction(TOKEN, splToken.mintTo(500n), [MINT, ACC.destination, ACC.authority]),
        rawInstruction(ACC.authority, [1], [ACC.destination]),
      ],
      undecodedFrom: [],
    });

    // Here the account's creation is not proven by any decoded action, so this
    // layer does not assume the missing pre-transaction row means zero.
    expect(effects.netTokenByAccountMint[0]?.startingAmountSource).toBe('not-observable');
  });
});

describe('determinism', () => {
  it('is identical when built twice from the same input', () => {
    const parts = {
      fee: FEE,
      accounts: [funderRow(), account(1, ACC.destination, { before: 0n, after: 500n })],
      tokenRows: [tokenRow(0, ACC.destination, MINT, ACC.recipient, { before: 0n, after: 500n })],
      instructions: [rawInstruction(TOKEN, splToken.mintTo(500n), [MINT, ACC.destination, ACC.authority])],
    };
    const first = scenario(parts);
    const second = scenario(parts);
    expect(stringifyJson(second.effects)).toBe(stringifyJson(first.effects));
  });
});
