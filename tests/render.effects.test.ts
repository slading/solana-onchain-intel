/**
 * The EFFECTS section: what it prints, in what order, and what it refuses to say.
 *
 * Rendering is deliberately dumb: it prints the model it is handed and computes
 * nothing itself, so these tests hand it a model (built from a synthetic
 * transaction through the real pipeline) and check the text.
 */

import { describe, expect, it } from 'vitest';
import { transactionEffects } from '../src/effects/build.ts';
import { NATIVE_MINT } from '../src/effects/native.ts';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { renderEffectsSection } from '../src/render/effects.ts';
import { renderSummary } from '../src/render/summary.ts';
import { effectsOf } from './helpers/effects.ts';
import { normalizeFixture } from './helpers/fixtures.ts';
import { ACC, TOKEN, bytesOf, rawInstruction, splToken } from './helpers/instructions.ts';
import { account, tokenRow as effectsTokenRow } from './helpers/effects.ts';
import { meta, syntheticTransaction } from './helpers/synthetic.ts';

const PROVENANCE = {
  rpcEndpoint: 'https://example.invalid',
  encoding: 'jsonParsed',
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 1,
} as const;

const PAYER = 'FeePayer111111111111111111111111111111111111';
const SOURCE_TA = 'SourceToken11111111111111111111111111111111';
const DEST_TA = 'DestToken1111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const OWNER = 'OwnerAccount111111111111111111111111111111';
const CREATED_ATA = 'CreatedAta11111111111111111111111111111111';
const RECIPIENT = 'Recipient111111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const UNKNOWN_PROGRAM = 'UnknownProgram11111111111111111111111';
const FEE = 5_000n;
const RENT = 2_039_280n;

/** base58 of the bytes, without pulling a dependency into this file. */
function b58(bytes: readonly number[]): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

function u64le(value: bigint): number[] {
  const out: number[] = [];
  let rest = value;
  for (let index = 0; index < 8; index += 1) {
    out.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return out;
}

function key(pubkey: string, signer: boolean, writable: boolean) {
  return { pubkey, signer, writable, source: 'transaction' };
}

function tokenRow(accountIndex: number, owner: string, amount: string) {
  return {
    accountIndex,
    mint: MINT,
    owner,
    programId: TOKEN_PROGRAM,
    uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: '' },
  };
}

/**
 * One transaction that exercises every section: an ATA create with its inner
 * System deposit, a `transferChecked`, and a plain System transfer. All amounts
 * are stated by an instruction or reproduced exactly by the balances (and the
 * test asserts both), so nothing here is guessed.
 */
function goldenTransaction() {
  return normalizeTransaction(
    syntheticTransaction({
      accountKeys: [
        key(PAYER, true, true),
        key(SOURCE_TA, false, true),
        key(DEST_TA, false, true),
        key(MINT, false, false),
        key(OWNER, false, false),
        key(CREATED_ATA, false, true),
        key(RECIPIENT, false, true),
        key(SYSTEM_PROGRAM, false, false),
        key(TOKEN_PROGRAM, false, false),
        key(ATA_PROGRAM, false, false),
        key(UNKNOWN_PROGRAM, false, false),
      ],
      instructions: [
        {
          programId: ATA_PROGRAM,
          accounts: [PAYER, CREATED_ATA, OWNER, MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM],
          data: '',
        },
        {
          programId: TOKEN_PROGRAM,
          accounts: [SOURCE_TA, MINT, DEST_TA, PAYER],
          // transferChecked: tag 12 | amount 250000 | decimals 6
          data: b58([12, ...u64le(250_000n), 6]),
        },
        {
          programId: SYSTEM_PROGRAM,
          accounts: [PAYER, RECIPIENT],
          // system transfer: tag 2 | lamports 2500
          data: b58([2, 0, 0, 0, ...u64le(2_500n)]),
        },
        { programId: UNKNOWN_PROGRAM, accounts: [MINT], data: b58([1, 2, 3]) },
      ],
      meta: meta({
        fee: Number(FEE),
        preBalances: [
          10_000_000_000, // payer
          Number(RENT), // source token account
          Number(RENT), // destination token account
          0,
          0,
          0, // the ATA does not exist yet
          0, // recipient
          0,
          0,
          0,
          0,
        ],
        postBalances: [
          10_000_000_000 - Number(FEE) - Number(RENT) - 2_500,
          Number(RENT),
          Number(RENT),
          0,
          0,
          Number(RENT),
          2_500,
          0,
          0,
          0,
          0,
        ],
        preTokenBalances: [tokenRow(1, PAYER, '1000000'), tokenRow(2, OWNER, '0')],
        postTokenBalances: [tokenRow(1, PAYER, '750000'), tokenRow(2, OWNER, '250000'), tokenRow(5, OWNER, '0')],
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                programId: SYSTEM_PROGRAM,
                // Unlike `accountKeys`, the RPC's *instructions* carry addresses as
                // plain strings, inner instructions included.
                accounts: [PAYER, CREATED_ATA],
                // createAccount: tag 0 | lamports | space | owner (32 bytes)
                data: b58([0, 0, 0, 0, ...u64le(RENT), ...u64le(165n), ...bytesOf(TOKEN_PROGRAM)]),
              },
            ],
          },
        ],
        logMessages: [
          `Program ${ATA_PROGRAM} invoke [1]`,
          `Program ${SYSTEM_PROGRAM} invoke [2]`,
          `Program ${SYSTEM_PROGRAM} success`,
        ],
      }),
    }),
    { provenance: PROVENANCE },
  );
}

describe('a wrapped-SOL close prints both sides of the same movement', () => {
  const RENT = 2_039_280n;
  const WRAPPED = 500n;

  function closing(history: 'agrees' | 'disagrees') {
    // A wrapped-SOL account closed by its owner. When its lamport history and its
    // wrapped-balance history describe the same events the units are sized; when
    // they do not (a `syncNative` this layer cannot decode wrapped 700 lamports
    // that were sent to it), the units are not.
    const transferred = history === 'disagrees' ? 700n : 0n;
    const returnValue = RENT + WRAPPED + transferred;
    return effectsOf({
      fee: 5_000n,
      accounts: [
        account(0, ACC.funding, {
          signer: true,
          before: 10_000_000_000n,
          after: 10_000_000_000n - 5_000n - transferred,
        }),
        account(1, ACC.source, { before: RENT + WRAPPED, after: 0n }),
        account(2, ACC.destination, { before: 0n, after: returnValue }),
      ],
      tokenRows: [
        effectsTokenRow(1, ACC.source, NATIVE_MINT, ACC.authority, {
          before: WRAPPED,
          after: null,
          presence: 'only-before',
          decimals: 9,
        }),
      ],
      instructions: [
        ...(history === 'disagrees'
          ? [rawInstruction('11111111111111111111111111111111', [2, 0, 0, 0, 183, 2, 0, 0, 0, 0, 0, 0], [
              ACC.funding,
              ACC.source,
            ])]
          : []),
        rawInstruction(TOKEN, splToken.closeAccount(), [ACC.source, ACC.destination, ACC.authority]),
      ],
    });
  }

  it('shows the units leaving the token system and says what the returned lamports stood for', () => {
    const text = renderEffectsSection(closing('agrees'), { abbreviateAddresses: true }).join('\n');
    expect(text).toContain('TOKEN (raw units; decimals are labels, not arithmetic)');
    expect(text).toContain('-500 raw units (0.0000005)');
    expect(text).toContain('the units it held when it was closed');
    expect(text).toContain('NET TOKEN');
    expect(text).toContain('[exactly explained]');
  });

  it('says the units are unknown rather than printing a number it cannot support', () => {
    const text = renderEffectsSection(closing('disagrees'), { abbreviateAddresses: true }).join('\n');
    const tokenLines = text.slice(text.indexOf('  TOKEN ('), text.indexOf('  NET SOL'));
    expect(tokenLines).toContain('amount not observable');
    expect(tokenLines).not.toContain('raw units (');
    expect(tokenLines).not.toContain('-amount not observable');
    // The residual stays visible, named as the close's own unreadable movement.
    expect(text).toContain('UNATTRIBUTED (no instruction proves who moved this; not turned into a flow)');
    expect(text).toContain('-500 raw units of mint');
    expect(text).toContain('amounts-not-separable • candidate proven flows: [1]');
  });
});

describe('the EFFECTS section', () => {
  it('renders exactly as recorded, in the layout the other sections use', () => {
    const transaction = goldenTransaction();
    const effects = transactionEffects(transaction);
    expect(renderSummary(transaction, { includeLogs: false, effects })).toBe(GOLDEN_EFFECTS_SUMMARY);
  });

  it('only prints when a model is handed to it', () => {
    const transaction = goldenTransaction();
    // The renderer never computes effects itself: without a model the summary is
    // byte-identical to what Milestone 2 produced.
    expect(renderSummary(transaction, { includeLogs: false })).not.toContain('EFFECTS (');
    expect(renderSummary(transaction, { includeLogs: false, effects: null })).not.toContain('EFFECTS (');
  });

  it('sits between ACTIONS and the raw balance sections', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const effects = transactionEffects(transaction);
    const text = renderSummary(transaction, { includeLogs: false, effects });
    const actionsAt = text.indexOf('ACTIONS (');
    const effectsAt = text.indexOf('EFFECTS (');
    const balancesAt = text.indexOf('SOL BALANCE CHANGES');
    expect(effectsAt).toBeGreaterThan(actionsAt);
    expect(balancesAt).toBeGreaterThan(effectsAt);
  });

  it('can print only the EFFECTS section', () => {
    const { transaction } = normalizeFixture('token-mixed-closeAccount');
    const effects = transactionEffects(transaction);
    const text = renderSummary(transaction, { includeLogs: true, onlyEffects: true, effects });
    expect(text).toContain('EFFECTS (');
    expect(text).toContain('LIFECYCLE');
    expect(text).not.toContain('INSTRUCTIONS (');
    expect(text).not.toContain('SOL BALANCE CHANGES');
    expect(text).not.toContain('\nLOGS\n');
  });

  it('uses the same address abbreviations as ACTIONS, and full addresses on request', () => {
    const { transaction } = normalizeFixture('token-mixed-closeAccount');
    const effects = transactionEffects(transaction);
    const abbreviated = renderSummary(transaction, { includeLogs: false, onlyEffects: true, effects });
    const full = renderSummary(transaction, {
      includeLogs: false,
      onlyEffects: true,
      effects,
      fullAddresses: true,
    });
    expect(abbreviated).toContain('…');
    expect(full).not.toContain('…');
    expect(full).toContain(transaction.feePayerAddress ?? '');
  });

  it('prints a failed transaction as a rollback, kept out of the committed sections', () => {
    const { transaction } = normalizeFixture('v1-failed-custom11');
    const effects = transactionEffects(transaction);
    const text = renderSummary(transaction, { includeLogs: false, onlyEffects: true, effects });

    expect(text).toBe(GOLDEN_FAILED_EFFECTS);
    // The attempted movements are shown, but never inside the committed sections.
    const committedSolAt = text.indexOf('  SOL\n');
    const didNotCommitAt = text.indexOf('DID NOT COMMIT');
    const feeLineAt = text.indexOf('[fee]');
    expect(committedSolAt).toBeGreaterThan(-1);
    expect(didNotCommitAt).toBeGreaterThan(committedSolAt);
    expect(feeLineAt).toBeLessThan(didNotCommitAt);
    expect(text.slice(committedSolAt, didNotCommitAt)).not.toContain('spl-token.transfer');
  });

  it('elides very long sections instead of dropping them silently', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const effects = transactionEffects(transaction);
    const text = renderSummary(transaction, { includeLogs: false, onlyEffects: true, effects });
    // The swap has 20 instruction-proven effects and 11 changed accounts: the
    // sections stay readable and say how many lines they left out.
    expect(text).toContain('… (+2 more)');
    expect(text).toContain('… (+3 more)');
    expect(text.split('\n').length).toBeLessThan(70);
  });

  it('never emits ANSI escapes or tabs', () => {
    for (const name of ['v0-success-swap', 'token-mixed-closeAccount', 'v1-failed-custom11']) {
      const { transaction } = normalizeFixture(name);
      const text = renderSummary(transaction, { includeLogs: false, effects: transactionEffects(transaction) });
      expect(text, name).not.toMatch(/\u001b\[/);
      expect(text, name).not.toMatch(/[\r\t]/);
    }
  });
});

const GOLDEN_FAILED_EFFECTS: string =
  "\nTRANSACTION 23JgzJH8s6CYBZ63aB7s4x4kEcuXj4YTTCmPUmzNjwEP3naN4djdjVYTP4UVbxc25KYHuiaK3Dy7wLeE4hvK5xJK\n\nEFFECTS (NOT COMMITTED — the transaction failed and rolled back)\n  1 proven by instruction data • 0 sized by balance reconciliation • 0 unattributed • 0 with an unobservable amount • 9 instruction effect(s) did not commit\n  A failed transaction commits nothing except the fee: Solana deducts the fee before execution and rolls every state change back. The attempted movements are listed below, marked, and never counted as state.\n\n  SOL\n    9Zdi…XTgE: -0.000006632 SOL charged by the network (no account in this transaction receives it; the burn/validator split is not claimed)  [fee]\n\n  NET SOL (exact, from the transaction's boundary balances)\n    9Zdi…XTgE (fee payer): -6632 lamports (-0.000006632 SOL)  [exactly explained]\n\n  DID NOT COMMIT (9; proven from instruction data, but rolled back)\n    8MFb…xvQK → 3NYs…8Job: 1.481934375 SOL (1481934375 lamports)  (native-token-leg)  [0.5] spl-token.transfer\n    3NYs…8Job → C9jj…idMf: 1.481934375 SOL (1481934375 lamports)  (native-token-leg)  [0.7] spl-token.transfer\n    9Zdi…XTgE → wyvP…WkcF: 0.000005 SOL (5000 lamports)  (transfer)  [1] system.transfer\n    token account Bc4k…1uBS → token account GFcj…dha4: 180000000 raw units (180)  (mint EPjF…Dt1v (from account metadata)) • owners 9Zdi…XTgE → Akxu…ivmC • authority 9Zdi…XTgE  [0.1] spl-token.transfer\n    token account G39M…pwyd → token account 5Tgw…yHx2: 544350997 raw units (544.350997)  (mint JUPy…DvCN (from account metadata)) • owners Akxu…ivmC → 9Zdi…XTgE • authority Akxu…ivmC (not a signer: multisig or program-derived)  [0.2] spl-token.transfer\n    token account 5Tgw…yHx2 → token account HVJu…iXSb: 544350997 raw units (544.350997)  (mint JUPy…DvCN (from account metadata)) • owners 9Zdi…XTgE → C1Mg…W8Wz • authority 9Zdi…XTgE  [0.4] spl-token.transfer\n    token account 8MFb…xvQK → token account 3NYs…8Job: 1481934375 raw units (1.481934375)  (mint So11…1112 (from account metadata)) • owners C1Mg…W8Wz → 9Zdi…XTgE • wrapped SOL: moved the same lamports too • authority C1Mg…W8Wz (not a signer: multisig or program-derived)  [0.5] spl-token.transfer\n    token account 3NYs…8Job → token account C9jj…idMf: 1481934375 raw units (1.481934375)  (mint So11…1112 (from account metadata)) • owners 9Zdi…XTgE → FJna…F5LN • wrapped SOL: moved the same lamports too • authority 9Zdi…XTgE  [0.7] spl-token.transfer\n    … (+1 more)\n\n  notes (2):\n    info: the transaction failed, so 9 instruction-derived effect(s) did not commit; only the 6632-lamport fee did. Solana transactions are atomic: the fee is deducted before execution and every state change is rolled back when any instruction fails, so the instructions above are reported as attempted-but-uncommitted.\n    info: the balances confirm the rollback: no account changed lamports except the fee payer, and no token balance row moved.\n\n  amounts are exact integers (lamports / raw units); \"proven\" means the instruction states it, \"reconciled\" means an instruction proves the relationship and a balance shows the size.";

const GOLDEN_EFFECTS_SUMMARY: string =
  "\nTRANSACTION 5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n\n  Slot         100\n  Block time   2023-11-14T22:13:20.000Z (unix 1700000000)\n  Version      legacy\n  Status       SUCCESS\n  Fee          0.000005 SOL (5000 lamports)\n  Compute      1500 CU consumed\n  Signatures   1\n  Fee payer    FeePayer111111111111111111111111111111111111\n  Signers      FeePayer111111111111111111111111111111111111\n  Recent bh    BH1111111111111111111111111111111111111111\n  Accounts     11 (0 resolved from address lookup tables)\n\nINSTRUCTIONS (4 top-level, 1 inner)\n  [0] ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL\n      type   UNKNOWN — the RPC did not decode this instruction; meaning is not inferred\n      data    (base58, raw)\n      accts  (6) FeePayer111111111111111111111111111111111111, CreatedAta11111111111111111111111111111111, OwnerAccount111111111111111111111111111111, Mint111111111111111111111111111111111111111, 11111111111111111111111111111111, TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\n      [0.0] 11111111111111111111111111111111\n          type   UNKNOWN — the RPC did not decode this instruction; meaning is not inferred\n          data   11119os1e9qSs2u7TsThXqkBSRVFxhmYaFKFZ1waB2X7armDmvK3p5GmLdUxYdg3h7QSrL (base58, raw)\n          accts  (2) FeePayer111111111111111111111111111111111111, CreatedAta11111111111111111111111111111111\n  [1] TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\n      type   UNKNOWN — the RPC did not decode this instruction; meaning is not inferred\n      data   hwrjUeemsbRc9 (base58, raw)\n      accts  (4) SourceToken11111111111111111111111111111111, Mint111111111111111111111111111111111111111, DestToken1111111111111111111111111111111111, FeePayer111111111111111111111111111111111111\n  [2] 11111111111111111111111111111111\n      type   UNKNOWN — the RPC did not decode this instruction; meaning is not inferred\n      data   3Bxs4ZeSsXcQLpf1 (base58, raw)\n      accts  (2) FeePayer111111111111111111111111111111111111, Recipient111111111111111111111111111111111\n  [3] UnknownProgram11111111111111111111111\n      type   UNKNOWN — the RPC did not decode this instruction; meaning is not inferred\n      data   Ldp (base58, raw)\n      accts  (1) Mint111111111111111111111111111111111111111\n\nACTIONS (4 decoded, 1 not decoded, from 5 instruction(s))\n  [0]       associated-token-account.create   Create  ata=Crea…1111  wallet=Owne…1111  mint=Mint…1111  payer=FeeP…1111  tokenProgram=Toke…Q5DA  [bytes]\n  [0.0]     system.createAccount              0.00203928 SOL (2039280 lamports)  space=165 bytes  owner=Toke…Q5DA  from=FeeP…1111  newAccount=Crea…1111  [bytes]\n  [1]       spl-token.transferChecked         250000 raw units  decimals=6  mint=Mint…1111  source=Sour…1111  destination=Dest…1111  authority=FeeP…1111  [bytes]\n  [2]       system.transfer                   0.0000025 SOL (2500 lamports)  from=FeeP…1111  to=Reci…1111  [bytes]\n\n  not decoded (1); unknown programs stay unknown:\n    (1) program not decoded by this layer: [3] UnknownProgram11111111111111111111111\n\n  decoded from instruction data only — never from balance changes.\n  decoded system.transfer total: 0.0000025 SOL across 1 transfer(s)\n\nEFFECTS (committed)\n  5 proven by instruction data • 1 sized by balance reconciliation • 0 unattributed • 0 with an unobservable amount\n\n  SOL\n    FeeP…1111: -0.000005 SOL charged by the network (no account in this transaction receives it; the burn/validator split is not claimed)  [fee]\n    FeeP…1111 → Crea…1111: 0.00203928 SOL (2039280 lamports)  (account-create-deposit)  [0.0] system.createAccount\n    FeeP…1111 → Reci…1111: 0.0000025 SOL (2500 lamports)  (transfer)  [2] system.transfer\n\n  TOKEN (raw units; decimals are labels, not arithmetic)\n    token account Sour…1111 → token account Dest…1111: 250000 raw units (0.25)  (mint Mint…1111) • owners FeeP…1111 → Owne…1111 • authority FeeP…1111  [1] spl-token.transferChecked\n\n  NET SOL (exact, from the transaction's boundary balances)\n    FeeP…1111 (fee payer): -2046780 lamports (-0.00204678 SOL)  [exactly explained]\n    Crea…1111: +2039280 lamports (0.00203928 SOL)  [exactly explained]\n    Reci…1111: +2500 lamports (0.0000025 SOL)  [exactly explained]\n\n  NET TOKEN (per token account and mint)\n    token account Sour…1111 (mint Mint…1111, owner FeeP…1111): -250000 raw units  [exactly explained]\n    token account Dest…1111 (mint Mint…1111, owner Owne…1111): +250000 raw units  [exactly explained]\n\n  NET TOKEN BY OWNER (aggregated over that owner's accounts of the mint; an owner is not a signer)\n    owner FeeP…1111: -250000 raw units of mint Mint…1111 across 1 token account(s)  [exact]\n    owner Owne…1111: +250000 raw units of mint Mint…1111 across 2 token account(s)  [exact]\n\n  LIFECYCLE\n    created associated token account Crea…1111 for owner Owne…1111 (mint Mint…1111), paid by FeeP…1111: 2039280 lamports deposited  [0] associated-token-account.create\n    created account Crea…1111 (space 165, owner program Toke…Q5DA), funded by FeeP…1111 with 2039280 lamports  [0.0] system.createAccount\n\n  notes (1):\n    info: [0] creates a token account; the lamport movement is the system.createAccount it makes at [0.0] (2039280 lamports), which is recorded as its own flow rather than counted twice.\n\n  amounts are exact integers (lamports / raw units); \"proven\" means the instruction states it, \"reconciled\" means an instruction proves the relationship and a balance shows the size.\n\nSOL BALANCE CHANGES (including the fee; unchanged accounts omitted)\n  FeePayer111111111111111111111111111111111111  10 -> 9.99795322 SOL  (-2046780 lamports)\n  CreatedAta11111111111111111111111111111111  0 -> 0.00203928 SOL  (+2039280 lamports)\n  Recipient111111111111111111111111111111111  0 -> 0.0000025 SOL  (+2500 lamports)\n\nTOKEN BALANCE CHANGES\n  [1] SourceToken11111111111111111111111111111111  mint=Mint111111111111111111111111111111111111111  program=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\n      owner  FeePayer111111111111111111111111111111111111\n      decimals 6\n      before 1000000 (ui )\n      after  750000 (ui )\n      delta  -250000 raw units (pre and post reported)\n  [2] DestToken1111111111111111111111111111111111  mint=Mint111111111111111111111111111111111111111  program=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\n      owner  OwnerAccount111111111111111111111111111111\n      decimals 6\n      before 0 (ui )\n      after  250000 (ui )\n      delta  +250000 raw units (pre and post reported)\n  [5] CreatedAta11111111111111111111111111111111  mint=Mint111111111111111111111111111111111111111  program=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\n      owner  OwnerAccount111111111111111111111111111111\n      decimals 6\n      before not reported (ui unknown)\n      after  0 (ui )\n      delta  not computable raw units (created in this transaction)\n\nDIAGNOSTICS\n  [info] token-account-created\n      Token account for accountIndex 5 appears only in postTokenBalances (created during this transaction); no delta is reported.\n";
