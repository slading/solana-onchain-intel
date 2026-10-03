/**
 * The swap layer against real mainnet fixtures.
 *
 * `v0-success-swap` is the milestone's primary vector: a Jupiter `route_v2` that
 * routes through two different Meteora DLMM pools, each a real `swap2`. Both legs
 * must be recognized independently, on the transaction's own instruction data,
 * and both must reconcile exactly with the Milestone 3 effects.
 *
 * `v0-success-dlmm-minout` is a second real vector captured for the one thing the
 * first cannot show: a non-zero `min_amount_out`.
 */
import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { recognizeDlmmSwaps } from '../src/swap/recognize.ts';
import { DLMM_PROGRAM_ID, DLMM_SWAP2_ACCOUNT_ROLES } from '../src/swap/dlmm.ts';
import { normalizeFixture } from './helpers/fixtures.ts';
import { checkOf, innerInstructionsOf, legAt, outcomeOf, swapFixture } from './helpers/swaps.ts';

const USER = 'E5JXp4obkiAcYNf1noBJyYkqJSdwnreBfYaX7vPbYTir';
const WSOL = 'So11111111111111111111111111111111111111112';
const X_MINT = '9pJWJdpPebyANys45eetpemLJo8yTz4n5B9zbpYw9ZMr';
const X_ACCOUNT = 'CLD7C8D2yiwCpGQ8e2HvcVwVti8Puc22wXYLqn6EruTt';
const WSOL_ACCOUNT = 'Cr5vxXJTC4vu8PraDANEGLfE1YStzQo8JHYJ7K8qqAeh';

/** The 19 checks, in the fixed order the model emits them. */
const CHECK_ORDER = [
  'dlmm-program-id',
  'swap2-discriminator',
  'args-decode-exact',
  'named-accounts-present',
  'cpi-subtree-available',
  'input-transfer-found',
  'output-transfer-found',
  'input-mint-matches-named-role',
  'output-mint-matches-named-role',
  'direction-established',
  'input-reserve-is-pool-vault',
  'output-reserve-is-pool-vault',
  'input-amount-matches-amount-in',
  'min-amount-out-stated',
  'min-amount-out-satisfied',
  'input-leg-authority-is-account-owner',
  'input-reconciles-with-effects',
  'output-reconciles-with-effects',
  'transaction-committed',
];

describe('v0-success-swap: two real DLMM legs under a router', () => {
  const { transaction, effects, swaps } = swapFixture('v0-success-swap');
  const first = legAt(swaps, 3, 8);
  const second = legAt(swaps, 3, 13);

  it('recognizes exactly the two swap2 instructions and nothing else', () => {
    expect(swaps.counts).toEqual({
      recognized: 2,
      proven: 2,
      partiallyProven: 0,
      notCommitted: 0,
      conflicting: 0,
    });
    expect(swaps.legs.map(leg => `[${leg.ref.outerIndex}.${leg.ref.index}]`)).toEqual(['[3.8]', '[3.13]']);
    expect(swaps.diagnostics).toEqual([]);
  });

  it('recognizes the first leg from its own bytes, not from the router envelope', () => {
    expect(first.protocol).toBe('meteora-dlmm');
    expect(first.programId).toBe(DLMM_PROGRAM_ID);
    expect(first.instructionName).toBe('swap2');
    expect(first.state).toBe('proven');
    expect(first.commitState).toBe('committed');
    expect(first.amountIn).toBe(602_101_187_025n);
    expect(first.minAmountOut).toBe(0n);
    expect(first.xToY).toBe(true);
    expect(first.conflicts).toEqual([]);
    // A stated zero floor is carried as an unknown, never as a satisfied bound.
    expect(first.unknowns).toEqual(['min-amount-out-not-stated']);
    expect(outcomeOf(first, 'min-amount-out-stated')).toBe('not-checkable');
    expect(outcomeOf(first, 'min-amount-out-satisfied')).toBe('not-checkable');
  });

  it('recognizes the second leg independently, against a different pool', () => {
    expect(second.state).toBe('proven');
    expect(second.amountIn).toBe(1_443_419_419_808n);
    expect(second.minAmountOut).toBe(0n);
    expect(second.roles.pool).toBe('BSi8jfQzokSAca9ZeBpaZbCvWHe4oUF2nwD6xByVvcBG');
    expect(first.roles.pool).toBe('5fwrQ1KAHVzGJAe9KvfAMziPkLGsxTfrf4ywCZfwyGuD');
    expect(second.roles.pool).not.toBe(first.roles.pool);
  });

  it('maps the named account roles in IDL order for both legs', () => {
    const common = {
      bitmapExtension: DLMM_PROGRAM_ID,
      tokenXProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      tokenYProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      memoProgram: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
      eventAuthority: 'D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6',
      program: DLMM_PROGRAM_ID,
    };
    const expected: readonly (readonly [number, readonly string[]])[] = [
      [
        8,
        [
          '5fwrQ1KAHVzGJAe9KvfAMziPkLGsxTfrf4ywCZfwyGuD',
          'FCsGP41FrbRBP5stf2QVBQVnn29chS8ZesqVCrGjkrCK',
          'HAcL6V7ER8xYftBFuz6hqnH48AHnz42KEVrY12CEznj7',
          X_ACCOUNT,
          WSOL_ACCOUNT,
          X_MINT,
          WSOL,
          'H1sZ2MH7vSz7M5YgphC84u645KkB3YVPLWqWugtdn8kn',
          USER,
        ],
      ],
      [
        13,
        [
          'BSi8jfQzokSAca9ZeBpaZbCvWHe4oUF2nwD6xByVvcBG',
          '7j8q9rbpK8xUi22A411SEdEyGFrXc4LPAcKsi4SSN4ie',
          '7ugzWKtSuqrJiMpPFS2quiUCBKEtJwDtgGQTBWyVoXPk',
          X_ACCOUNT,
          WSOL_ACCOUNT,
          X_MINT,
          WSOL,
          'CKZbprrBEjVWqR4ipXcsq5ymEWJcVnHjLrP5f1wuPn7r',
          USER,
        ],
      ],
    ];
    for (const [index, roles] of expected) {
      const instruction = innerInstructionsOf(transaction, 3)[index];
      const accounts = [...(instruction?.accounts ?? [])];
      // 16 named roles, then the bin-array tail the IDL does not enumerate.
      expect(accounts.slice(0, 16)).toEqual([
        roles[0],
        common.bitmapExtension,
        roles[1],
        roles[2],
        roles[3],
        roles[4],
        roles[5],
        roles[6],
        roles[7],
        // `host_fee_in` is optional and unused here: the program id stands in.
        DLMM_PROGRAM_ID,
        roles[8],
        common.tokenXProgram,
        common.tokenYProgram,
        common.memoProgram,
        common.eventAuthority,
        common.program,
      ]);
      expect(accounts.length).toBeGreaterThan(16);
    }
    expect(first.roles.reserveX).toBe('FCsGP41FrbRBP5stf2QVBQVnn29chS8ZesqVCrGjkrCK');
    expect(first.roles.reserveY).toBe('HAcL6V7ER8xYftBFuz6hqnH48AHnz42KEVrY12CEznj7');
    expect(first.roles.tokenXMint).toBe(X_MINT);
    expect(first.roles.tokenYMint).toBe(WSOL);
    expect(first.roles.tailAccountCount).toBe(2);
    expect(second.roles.tailAccountCount).toBe(3);
    expect(first.roles.hookSliceCount).toBe(0);
    // Token X is the Token-2022 mint in this pool; WSOL is a legacy SPL mint.
    expect(innerInstructionsOf(transaction, 3)[8]?.accounts?.[11]).toBe(common.tokenXProgram);
    expect(innerInstructionsOf(transaction, 3)[8]?.accounts?.[12]).toBe(common.tokenYProgram);
  });

  it('attributes the transfers from inside each instruction\u2019s own CPI subtree', () => {
    // The router's own stack-2 siblings ([3.18], [3.19]) are not in either subtree.
    expect(innerInstructionsOf(transaction, 3)[18]?.index).toBe(18);
    expect([first.input.legRef, first.output.legRef].map(ref => `[${ref?.outerIndex}.${ref?.index}]`)).toEqual([
      '[3.10]',
      '[3.11]',
    ]);
    expect([second.input.legRef, second.output.legRef].map(ref => `[${ref?.outerIndex}.${ref?.index}]`)).toEqual([
      '[3.15]',
      '[3.16]',
    ]);
    expect(first.input.legKind).toBe('spl-token.transferChecked');
    expect(first.output.legKind).toBe('spl-token.transferChecked');
  });

  it('reads both sides of each leg and the direction from the pool\u2019s two mints', () => {
    expect(first.input.tokenAccount).toBe(X_ACCOUNT);
    expect(first.input.mint).toBe(X_MINT);
    expect(first.input.amount).toBe(602_101_187_025n);
    expect(first.input.amountEvidence).toBe('transfer-leg');
    expect(first.input.owner).toBe(USER);
    expect(first.input.ownerEvidence).toBe('account-metadata');
    expect(first.output.tokenAccount).toBe(WSOL_ACCOUNT);
    expect(first.output.mint).toBe(WSOL);
    expect(first.output.amount).toBe(1_916_188_255n);
    expect(first.output.amountEvidence).toBe('transfer-leg');
    // The WSOL account is created and closed inside this transaction, so the RPC
    // never reports a balance row for it: the owner comes from the ATA `create`.
    expect(first.output.owner).toBe(USER);
    expect(first.output.ownerEvidence).toBe('ata-create-instruction');

    expect(second.input.amount).toBe(1_443_419_419_808n);
    expect(second.output.amount).toBe(4_572_493_603n);
    expect(second.xToY).toBe(true);
  });

  it('reconciles each leg against the effects model, transfer by transfer', () => {
    for (const leg of [first, second]) {
      for (const [side, legRef] of [
        ['input', leg.input.legRef],
        ['output', leg.output.legRef],
      ] as const) {
        if (legRef === null) throw new Error(`${side} side has no attributed transfer`);
        const check = checkOf(leg, `${side}-reconciles-with-effects`);
        expect(check.outcome).toBe('pass');
        const flow = effects.tokenFlows.find(
          candidate =>
            candidate.ref?.path === legRef.path &&
            candidate.ref?.outerIndex === legRef.outerIndex &&
            candidate.ref?.index === legRef.index,
        );
        expect(flow, `${side} flow at the leg's own reference`).toBeDefined();
        expect(flow?.commitState).toBe('committed');
        expect(flow?.amountSource).toBe('instruction-data');
        expect(flow?.amount).toBe(side === 'input' ? leg.input.amount : leg.output.amount);
        expect(flow?.mint).toBe(side === 'input' ? leg.input.mint : leg.output.mint);
        // The input side pays the user's token account into the pool vault; the
        // output side pays the other pool vault out to the user's token account.
        expect(flow?.sourceTokenAccount).toBe(
          side === 'input' ? leg.input.tokenAccount : leg.roles.reserveY,
        );
        expect(flow?.destinationTokenAccount).toBe(
          side === 'input' ? leg.roles.reserveX : leg.output.tokenAccount,
        );
        // The movement crosses the pool boundary in the direction the leg claims.
        expect(flow?.sourceOwner).toBe(side === 'input' ? USER : leg.roles.pool);
        expect(flow?.destinationOwner).toBe(side === 'input' ? leg.roles.pool : USER);
        // The user signs their own deposit; the pool vault is spent by the pool.
        expect(flow?.authority).toBe(side === 'input' ? USER : leg.roles.pool);
        expect(flow?.authorityIsSigner).toBe(side === 'input');
      }
    }
  });

  it('proves the vaults from the roles, not from the movement alone', () => {
    expect(checkOf(first, 'input-reserve-is-pool-vault').outcome).toBe('pass');
    expect(checkOf(first, 'output-reserve-is-pool-vault').outcome).toBe('pass');
    expect(checkOf(first, 'input-mint-matches-named-role').outcome).toBe('pass');
    expect(checkOf(first, 'output-mint-matches-named-role').outcome).toBe('pass');
    expect(checkOf(first, 'direction-established').detail).toContain('swap_for_y=true');
  });

  it('ties the input authority to the account\u2019s reported owner', () => {
    const check = checkOf(first, 'input-leg-authority-is-account-owner');
    expect(check.outcome).toBe('pass');
    expect(check.detail).toContain(USER);
    // A secondary check for the report: the input side is signed by the user and
    // the output side is spent by the pool itself, never by the user.
    const flows = effects.tokenFlows.filter(
      flow => flow.ref?.path === 'inner' && flow.ref.outerIndex === 3,
    );
    const at = (index: number) => flows.find(flow => flow.ref?.index === index);
    expect(at(10)?.authority).toBe(USER);
    expect(at(10)?.authorityIsSigner).toBe(true);
    expect(at(11)?.authority).toBe(first.roles.pool);
    expect(at(11)?.authorityIsSigner).toBe(false);
  });

  it('passes every check but the two that do not exist for a zero floor', () => {
    for (const leg of [first, second]) {
      expect(leg.checks.map(check => check.id)).toEqual(CHECK_ORDER);
      expect(leg.checks.filter(check => check.outcome === 'pass')).toHaveLength(17);
      expect(leg.checks.filter(check => check.outcome === 'not-checkable').map(check => check.id)).toEqual([
        'min-amount-out-stated',
        'min-amount-out-satisfied',
      ]);
      expect(checkOf(leg, 'transaction-committed').outcome).toBe('pass');
      expect(checkOf(leg, 'input-leg-authority-is-account-owner').outcome).toBe('pass');
    }
  });

  it('keeps the whole effects model green alongside the new layer', () => {
    expect(effects.counts).toMatchObject({ proven: 20, reconciled: 3, unattributed: 0 });
    // The only note the effects layer raises on this transaction is the ATA
    // `create` whose deposit is recorded by the `system.createAccount` it makes.
    expect(effects.diagnostics.map(note => note.code)).toEqual(['effects-create-deposit-stated-elsewhere']);
    expect(effects.diagnostics.every(note => note.level === 'info')).toBe(true);
  });
});

describe('v0-success-dlmm-minout: a real non-zero floor', () => {
  const { swaps } = swapFixture('v0-success-dlmm-minout');

  it('reads the floor from the instruction and tests the output against it', () => {
    const leg = swaps.legs[0];
    expect(leg, 'exactly one recognized leg').toBeDefined();
    if (leg === undefined) return;
    expect(swaps.counts).toMatchObject({ recognized: 1, proven: 1, conflicting: 0 });
    expect(leg.state).toBe('proven');
    expect(leg.minAmountOut).toBe(1n);
    expect(leg.amountIn).toBe(250_000_000n);
    expect(leg.input.mint).toBe(WSOL);
    expect(leg.output.amount).toBe(14_512_360n);
    expect(leg.xToY).toBe(false);
    expect(checkOf(leg, 'min-amount-out-stated').outcome).toBe('pass');
    expect(checkOf(leg, 'min-amount-out-satisfied').outcome).toBe('pass');
    expect(checkOf(leg, 'min-amount-out-satisfied').detail).toContain('14512360');
    expect(leg.unknowns).toEqual([]);
    expect(leg.checks.filter(check => check.outcome !== 'pass')).toEqual([]);
  });
});

describe('fixtures with no DLMM swap2', () => {
  const names = [
    'token-mixed-closeAccount',
    'token-mixed-approve',
    'v1-failed-custom11',
    'v1-failed-custom6001',
    'legacy-success-vote',
  ] as const;

  it('recognizes nothing, and says so with an empty model rather than a guess', () => {
    for (const name of names) {
      const { swaps } = swapFixture(name);
      expect(swaps.legs, name).toEqual([]);
      expect(swaps.counts, name).toEqual({
        recognized: 0,
        proven: 0,
        partiallyProven: 0,
        notCommitted: 0,
        conflicting: 0,
      });
      expect(swaps.diagnostics, name).toEqual([]);
    }
  });
});

describe('purity and determinism', () => {
  it('is a pure function of the normalized transaction', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const before = stringifyJson(transaction);
    const first = recognizeDlmmSwaps(transaction, { effects: transactionEffects(transaction) });
    const second = recognizeDlmmSwaps(transaction, { effects: transactionEffects(transaction) });
    expect(stringifyJson(first)).toBe(stringifyJson(second));
    expect(stringifyJson(transaction)).toBe(before);
  });

  it('reads no clock, no locale and no environment', () => {
    const { transaction, effects } = swapFixture('v0-success-swap');
    const swaps = recognizeDlmmSwaps(transaction, { effects });
    expect(stringifyJson(swaps)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(stringifyJson(swaps.legs)).toBe(stringifyJson(recognizeDlmmSwaps(transaction, { effects }).legs));
    expect(stringifyJson(swaps.legs[0]?.checks)).toBe(stringifyJson(swaps.legs[0]?.checks));
  });

  it('keeps the raw payload and the logs out of the model', () => {
    const { swaps } = swapFixture('v0-success-swap');
    const text = stringifyJson(swaps);
    expect(text).not.toContain('logMessages');
    expect(text).not.toContain('preTokenBalances');
    expect(text).not.toContain('"raw"');
    // Not one byte of the instruction payload is carried across: neither the raw
    // base58 nor the payload minus its discriminator. (The discriminator itself is
    // an IDL constant and may appear as hex in a check detail.)
    for (const instruction of innerInstructionsOf(
      normalizeFixture('v0-success-swap').transaction,
      3,
    )) {
      if (instruction.data === null) continue;
      expect(text).not.toContain(instruction.data);
    }
  });
});

describe('roles table', () => {
  it('re-uses the authoritative IDL order for every leg', () => {
    expect(DLMM_SWAP2_ACCOUNT_ROLES).toHaveLength(16);
    expect(DLMM_SWAP2_ACCOUNT_ROLES[0]).toBe('lb_pair');
    expect(DLMM_SWAP2_ACCOUNT_ROLES[15]).toBe('program');
  });
});
