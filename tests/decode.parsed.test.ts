import { describe, expect, it } from 'vitest';
import { decodeInstruction } from '../src/decode/decode.ts';
import { ACC, ATA, SYSTEM, TOKEN, TOKEN_2022, parsedInstruction } from './helpers/instructions.ts';

/**
 * The RPC-parsed path: mapping the node's own `parsed.type`/`parsed.info` into our
 * model.
 *
 * Every `info` shape below is copied from the node's parser source
 * (`transaction-status/src/parse_token.rs`, `parse_system.rs`,
 * `parse_associated_token.rs` in Agave) — including the `tokenAmount` wrapper on
 * the *Checked variants, the bare `amount` string on the others, and the
 * `multisigAuthority`-style spellings.
 */
function decode(instruction: Parameters<typeof decodeInstruction>[0]) {
  return decodeInstruction(instruction);
}

function expectAction(instruction: Parameters<typeof decodeInstruction>[0]) {
  const outcome = decode(instruction);
  expect(outcome.action, `no action; reason=${outcome.undecoded?.reason} ${outcome.undecoded?.note}`).not.toBeNull();
  return outcome;
}

describe('System Program: mapped from the RPC parse', () => {
  it('maps a transfer', () => {
    const outcome = expectAction(
      parsedInstruction(SYSTEM, 'system', 'transfer', {
        source: ACC.funding,
        destination: ACC.recipient,
        lamports: 5_000, // the node emits a u64; kit hands it to us as bigint
      }),
    );
    expect(outcome.action).toMatchObject({
      kind: 'system.transfer',
      evidence: 'rpc-parsed',
      program: 'system',
      from: ACC.funding,
      to: ACC.recipient,
      lamports: 5_000n,
    });
  });

  it('maps a createAccount', () => {
    const outcome = expectAction(
      parsedInstruction(SYSTEM, 'system', 'createAccount', {
        source: ACC.funding,
        newAccount: ACC.other,
        lamports: 1_488_440n,
        space: 165n,
        owner: TOKEN,
      }),
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

  it('reports a recognized System instruction outside the target set', () => {
    const outcome = decode(parsedInstruction(SYSTEM, 'system', 'advanceNonce', { nonceAccount: ACC.other }));
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('instruction-not-in-scope');
    expect(outcome.undecoded?.note).toContain('advanceNonce');
  });

  it('reports a System type that does not exist', () => {
    const outcome = decode(parsedInstruction(SYSTEM, 'system', 'teleport', {}));
    expect(outcome.undecoded?.reason).toBe('unknown-instruction-tag');
  });
});

describe('SPL Token: mapped from the RPC parse', () => {
  it('maps a transfer, keeping the amount as a bigint', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN, 'spl-token', 'transfer', {
        source: ACC.source,
        destination: ACC.destination,
        authority: ACC.authority,
        amount: '15235813',
      }),
    );
    expect(outcome.action).toEqual({
      kind: 'spl-token.transfer',
      program: 'spl-token',
      programId: TOKEN,
      evidence: 'rpc-parsed',
      ref: { path: 'top-level', index: 0, outerIndex: null, stackHeight: 1 },
      source: ACC.source,
      destination: ACC.destination,
      authority: ACC.authority,
      amount: 15_235_813n,
    });
    // Even the node does not report a mint for a plain transfer; neither do we.
    expect(outcome.action).not.toHaveProperty('mint');
  });

  it('maps a transferChecked from the tokenAmount wrapper', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN, 'spl-token', 'transferChecked', {
        source: ACC.source,
        mint: ACC.mint,
        destination: ACC.destination,
        authority: ACC.authority,
        tokenAmount: { amount: '2729270725642', decimals: 6, uiAmount: null, uiAmountString: '2729270.725642' },
      }),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.transferChecked',
      source: ACC.source,
      mint: ACC.mint,
      destination: ACC.destination,
      authority: ACC.authority,
      amount: 2_729_270_725_642n,
      decimals: 6,
    });
  });

  it('maps mintTo, which uses a bare amount and the `account` key', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN, 'spl-token', 'mintTo', {
        mint: ACC.mint,
        account: ACC.destination,
        mintAuthority: ACC.authority,
        amount: '500',
      }),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.mintTo',
      mint: ACC.mint,
      destination: ACC.destination,
      authority: ACC.authority,
      amount: 500n,
    });
  });

  it('maps mintToChecked from tokenAmount', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN, 'spl-token', 'mintToChecked', {
        mint: ACC.mint,
        account: ACC.destination,
        mintAuthority: ACC.authority,
        tokenAmount: { amount: '500', decimals: 9, uiAmount: null, uiAmountString: '500' },
      }),
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

  it('maps burn', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN, 'spl-token', 'burn', {
        account: ACC.other,
        mint: ACC.mint,
        authority: ACC.authority,
        amount: '7',
      }),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.burn',
      account: ACC.other,
      mint: ACC.mint,
      authority: ACC.authority,
      amount: 7n,
    });
  });

  it('maps burnChecked from tokenAmount', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN, 'spl-token', 'burnChecked', {
        account: ACC.other,
        mint: ACC.mint,
        authority: ACC.authority,
        tokenAmount: { amount: '7', decimals: 2, uiAmount: null, uiAmountString: '7' },
      }),
    );
    expect(outcome.action).toMatchObject({ kind: 'spl-token.burnChecked', amount: 7n, decimals: 2 });
  });

  it('maps approve, whose authority key is `owner`', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN, 'spl-token', 'approve', {
        source: ACC.source,
        delegate: ACC.other,
        owner: ACC.authority,
        amount: '16300',
      }),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.approve',
      source: ACC.source,
      delegate: ACC.other,
      authority: ACC.authority,
      amount: 16_300n,
    });
  });

  it('maps revoke, which has no amount', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN, 'spl-token', 'revoke', { source: ACC.source, owner: ACC.authority }),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.revoke',
      source: ACC.source,
      authority: ACC.authority,
    });
    expect(outcome.action).not.toHaveProperty('amount');
  });

  it('maps closeAccount', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN, 'spl-token', 'closeAccount', {
        account: ACC.other,
        destination: ACC.funding,
        owner: ACC.authority,
      }),
    );
    expect(outcome.action).toMatchObject({
      kind: 'spl-token.closeAccount',
      account: ACC.other,
      destination: ACC.funding,
      authority: ACC.authority,
    });
  });

  it('maps Token-2022 core instructions too, labelled as Token-2022', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN_2022, 'spl-token', 'transferChecked', {
        source: ACC.source,
        mint: ACC.mint,
        destination: ACC.destination,
        authority: ACC.authority,
        tokenAmount: { amount: '1', decimals: 6 },
      }),
    );
    expect(outcome.action).toMatchObject({ program: 'spl-token-2022', programId: TOKEN_2022 });
  });

  it('accepts the multisig spelling of the authority and records it', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN, 'spl-token', 'transfer', {
        source: ACC.source,
        destination: ACC.destination,
        multisigAuthority: ACC.other,
        signers: [ACC.authority, ACC.funding],
        amount: '10',
      }),
    );
    // The multisig account is the authority, exactly as in the account list.
    expect(outcome.action).toMatchObject({ authority: ACC.other, amount: 10n });
    expect(outcome.diagnostics.some(d => d.message.includes('multisig authority'))).toBe(true);
    expect(outcome.diagnostics.some(d => d.message.includes('2 signer account(s)'))).toBe(true);
  });

  it('handles the mintAuthority multisig spelling', () => {
    const outcome = expectAction(
      parsedInstruction(TOKEN, 'spl-token', 'mintTo', {
        mint: ACC.mint,
        account: ACC.destination,
        multisigMintAuthority: ACC.other,
        amount: '1',
      }),
    );
    expect(outcome.action).toMatchObject({ authority: ACC.other });
  });

  it('reports recognized Token instructions outside the target set', () => {
    for (const type of ['getAccountDataSize', 'initializeAccount3', 'syncNative', 'setAuthority']) {
      const outcome = decode(parsedInstruction(TOKEN, 'spl-token', type, {}));
      expect(outcome.action).toBeNull();
      expect(outcome.undecoded?.reason).toBe('instruction-not-in-scope');
    }
  });

  it('reports a Token-2022 extension instruction as out of scope', () => {
    const outcome = decode(parsedInstruction(TOKEN_2022, 'spl-token', 'initializeMetadataPointer', {}));
    expect(outcome.undecoded?.reason).toBe('instruction-not-in-scope');
    expect(outcome.undecoded?.note).toContain('Token-2022');
  });

  it('reports a type that is not a Token instruction at all', () => {
    const outcome = decode(parsedInstruction(TOKEN, 'spl-token', 'swap', {}));
    expect(outcome.undecoded?.reason).toBe('unknown-instruction-tag');
  });

  it('keeps the kind and nulls fields when the info object is missing', () => {
    const outcome = expectAction(parsedInstruction(TOKEN, 'spl-token', 'closeAccount', null));
    expect(outcome.action).toMatchObject({ kind: 'spl-token.closeAccount', account: null, destination: null });
    expect(outcome.diagnostics.some(d => d.message.includes('without an info object'))).toBe(true);
  });
});

describe('Associated Token Account: mapped from the RPC parse', () => {
  const info = {
    source: ACC.funding,
    account: ACC.other,
    wallet: ACC.authority,
    mint: ACC.mint,
    systemProgram: SYSTEM,
    tokenProgram: TOKEN,
  };

  it('maps create', () => {
    const outcome = expectAction(parsedInstruction(ATA, 'spl-associated-token-account', 'create', info));
    expect(outcome.action).toMatchObject({
      kind: 'associated-token-account.create',
      idempotent: false,
      payer: ACC.funding,
      associatedTokenAccount: ACC.other,
      wallet: ACC.authority,
      mint: ACC.mint,
      systemProgram: SYSTEM,
      tokenProgram: TOKEN,
    });
  });

  it('maps createIdempotent', () => {
    const outcome = expectAction(
      parsedInstruction(ATA, 'spl-associated-token-account', 'createIdempotent', info),
    );
    expect(outcome.action).toMatchObject({ idempotent: true, mint: ACC.mint });
  });

  it('reports recoverNested as out of scope', () => {
    const outcome = decode(parsedInstruction(ATA, 'spl-associated-token-account', 'recoverNested', info));
    expect(outcome.undecoded?.reason).toBe('instruction-not-in-scope');
  });

  it('reports an unknown ATA type', () => {
    const outcome = decode(parsedInstruction(ATA, 'spl-associated-token-account', 'teleport', info));
    expect(outcome.undecoded?.reason).toBe('unknown-instruction-tag');
  });
});

describe('program id decides the decoder, not the label', () => {
  it('uses the program id even when the RPC label is unexpected', () => {
    // A system-program transfer mislabeled by the node is still a system transfer.
    const outcome = expectAction(
      parsedInstruction(SYSTEM, 'mystery-program', 'transfer', {
        source: ACC.funding,
        destination: ACC.recipient,
        lamports: 1,
      }),
    );
    expect(outcome.action).toMatchObject({ program: 'system', kind: 'system.transfer' });
  });

  it('does not decode a known instruction type sent to an unsupported program', () => {
    const outcome = decode(
      parsedInstruction('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'jupiter', 'transfer', {
        source: ACC.source,
        destination: ACC.destination,
        amount: '1',
      }),
    );
    expect(outcome.action).toBeNull();
    expect(outcome.undecoded?.reason).toBe('program-not-supported');
  });
});
