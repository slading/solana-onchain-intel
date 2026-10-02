import { describe, expect, it } from 'vitest';
import { decodeInstruction } from '../src/decode/decode.ts';
import type { DecodedAction } from '../src/decode/actions.ts';
import type { NormalizedInstruction } from '../src/model/transaction.ts';
import {
  ACC,
  ATA,
  SYSTEM,
  TOKEN,
  ata,
  parsedInstruction,
  rawInstruction,
  splToken,
  system,
} from './helpers/instructions.ts';

/**
 * The two decode paths must agree.
 *
 * The same logical instruction can reach us either as raw bytes (the node did not
 * parse it) or as an RPC parse (the node did). Evidence differs by nature, but the
 * *meaning* must not: if the tables drifted, the same on-chain instruction would
 * be described differently depending on which node served the response.
 *
 * Each case below pairs a spec-derived byte encoding with the node-parser-derived
 * `info` shape for the same instruction.
 */

interface Pair {
  readonly name: string;
  readonly bytes: NormalizedInstruction;
  readonly parsed: NormalizedInstruction;
  readonly kind: DecodedAction['kind'];
}

const scalar = {
  funding: ACC.funding,
  source: ACC.source,
  destination: ACC.destination,
  authority: ACC.authority,
  mint: ACC.mint,
  other: ACC.other,
};

const PAIRS: readonly Pair[] = [
  {
    name: 'system.transfer',
    kind: 'system.transfer',
    bytes: rawInstruction(SYSTEM, system.transfer(5_000n), [scalar.funding, scalar.destination]),
    parsed: parsedInstruction(SYSTEM, 'system', 'transfer', {
      source: scalar.funding,
      destination: scalar.destination,
      lamports: 5_000,
    }),
  },
  {
    name: 'system.createAccount',
    kind: 'system.createAccount',
    bytes: rawInstruction(SYSTEM, system.createAccount(1_488_440n, 165n, TOKEN), [
      scalar.funding,
      scalar.other,
    ]),
    parsed: parsedInstruction(SYSTEM, 'system', 'createAccount', {
      source: scalar.funding,
      newAccount: scalar.other,
      lamports: 1_488_440,
      space: 165,
      owner: TOKEN,
    }),
  },
  {
    name: 'spl-token.transfer',
    kind: 'spl-token.transfer',
    bytes: rawInstruction(TOKEN, splToken.transfer(15_235_813n), [
      scalar.source,
      scalar.destination,
      scalar.authority,
    ]),
    parsed: parsedInstruction(TOKEN, 'spl-token', 'transfer', {
      source: scalar.source,
      destination: scalar.destination,
      authority: scalar.authority,
      amount: '15235813',
    }),
  },
  {
    name: 'spl-token.transferChecked',
    kind: 'spl-token.transferChecked',
    bytes: rawInstruction(TOKEN, splToken.transferChecked(2_729_270_725_642n, 6), [
      scalar.source,
      scalar.mint,
      scalar.destination,
      scalar.authority,
    ]),
    parsed: parsedInstruction(TOKEN, 'spl-token', 'transferChecked', {
      source: scalar.source,
      mint: scalar.mint,
      destination: scalar.destination,
      authority: scalar.authority,
      tokenAmount: { amount: '2729270725642', decimals: 6 },
    }),
  },
  {
    name: 'spl-token.mintTo',
    kind: 'spl-token.mintTo',
    bytes: rawInstruction(TOKEN, splToken.mintTo(500n), [scalar.mint, scalar.destination, scalar.authority]),
    parsed: parsedInstruction(TOKEN, 'spl-token', 'mintTo', {
      mint: scalar.mint,
      account: scalar.destination,
      mintAuthority: scalar.authority,
      amount: '500',
    }),
  },
  {
    name: 'spl-token.mintToChecked',
    kind: 'spl-token.mintToChecked',
    bytes: rawInstruction(TOKEN, splToken.mintToChecked(500n, 9), [
      scalar.mint,
      scalar.destination,
      scalar.authority,
    ]),
    parsed: parsedInstruction(TOKEN, 'spl-token', 'mintToChecked', {
      mint: scalar.mint,
      account: scalar.destination,
      mintAuthority: scalar.authority,
      tokenAmount: { amount: '500', decimals: 9 },
    }),
  },
  {
    name: 'spl-token.burn',
    kind: 'spl-token.burn',
    bytes: rawInstruction(TOKEN, splToken.burn(7n), [scalar.other, scalar.mint, scalar.authority]),
    parsed: parsedInstruction(TOKEN, 'spl-token', 'burn', {
      account: scalar.other,
      mint: scalar.mint,
      authority: scalar.authority,
      amount: '7',
    }),
  },
  {
    name: 'spl-token.burnChecked',
    kind: 'spl-token.burnChecked',
    bytes: rawInstruction(TOKEN, splToken.burnChecked(7n, 2), [scalar.other, scalar.mint, scalar.authority]),
    parsed: parsedInstruction(TOKEN, 'spl-token', 'burnChecked', {
      account: scalar.other,
      mint: scalar.mint,
      authority: scalar.authority,
      tokenAmount: { amount: '7', decimals: 2 },
    }),
  },
  {
    name: 'spl-token.approve',
    kind: 'spl-token.approve',
    bytes: rawInstruction(TOKEN, splToken.approve(16_300n), [scalar.source, scalar.other, scalar.authority]),
    parsed: parsedInstruction(TOKEN, 'spl-token', 'approve', {
      source: scalar.source,
      delegate: scalar.other,
      owner: scalar.authority,
      amount: '16300',
    }),
  },
  {
    name: 'spl-token.revoke',
    kind: 'spl-token.revoke',
    bytes: rawInstruction(TOKEN, splToken.revoke(), [scalar.source, scalar.authority]),
    parsed: parsedInstruction(TOKEN, 'spl-token', 'revoke', {
      source: scalar.source,
      owner: scalar.authority,
    }),
  },
  {
    name: 'spl-token.closeAccount',
    kind: 'spl-token.closeAccount',
    bytes: rawInstruction(TOKEN, splToken.closeAccount(), [scalar.other, scalar.funding, scalar.authority]),
    parsed: parsedInstruction(TOKEN, 'spl-token', 'closeAccount', {
      account: scalar.other,
      destination: scalar.funding,
      owner: scalar.authority,
    }),
  },
  {
    name: 'associated-token-account.create',
    kind: 'associated-token-account.create',
    bytes: rawInstruction(ATA, ata.create(), [
      scalar.funding,
      scalar.other,
      scalar.authority,
      scalar.mint,
      SYSTEM,
      TOKEN,
    ]),
    parsed: parsedInstruction(ATA, 'spl-associated-token-account', 'create', {
      source: scalar.funding,
      account: scalar.other,
      wallet: scalar.authority,
      mint: scalar.mint,
      systemProgram: SYSTEM,
      tokenProgram: TOKEN,
    }),
  },
  {
    name: 'associated-token-account.create (idempotent)',
    kind: 'associated-token-account.create',
    bytes: rawInstruction(ATA, ata.createIdempotent(), [
      scalar.funding,
      scalar.other,
      scalar.authority,
      scalar.mint,
      SYSTEM,
      TOKEN,
    ]),
    parsed: parsedInstruction(ATA, 'spl-associated-token-account', 'createIdempotent', {
      source: scalar.funding,
      account: scalar.other,
      wallet: scalar.authority,
      mint: scalar.mint,
      systemProgram: SYSTEM,
      tokenProgram: TOKEN,
    }),
  },
];

/** Everything except `evidence`, which by definition differs between paths. */
function meaning(action: DecodedAction): Record<string, unknown> {
  const { evidence: _evidence, ...rest } = action;
  return rest as Record<string, unknown>;
}

describe('instruction bytes and RPC parse produce the same meaning', () => {
  it.each(PAIRS.map(pair => [pair.name, pair] as const))('%s', (_name, pair) => {
    const fromBytes = decodeInstruction(pair.bytes);
    const fromParsed = decodeInstruction(pair.parsed);

    expect(fromBytes.action).not.toBeNull();
    expect(fromParsed.action).not.toBeNull();
    expect(fromBytes.action?.kind).toBe(pair.kind);
    expect(fromParsed.action?.kind).toBe(pair.kind);

    // Same program, same reference, same fields, same values.
    expect(meaning(fromBytes.action as DecodedAction)).toEqual(meaning(fromParsed.action as DecodedAction));

    // The evidence is reported honestly, and differs.
    expect(fromBytes.action?.evidence).toBe('instruction-data');
    expect(fromParsed.action?.evidence).toBe('rpc-parsed');
  });

  it('covers every target action kind', () => {
    const kinds = new Set(PAIRS.map(pair => pair.kind));
    expect([...kinds].sort()).toEqual(
      [
        'associated-token-account.create',
        'spl-token.approve',
        'spl-token.burn',
        'spl-token.burnChecked',
        'spl-token.closeAccount',
        'spl-token.mintTo',
        'spl-token.mintToChecked',
        'spl-token.revoke',
        'spl-token.transfer',
        'spl-token.transferChecked',
        'system.createAccount',
        'system.transfer',
      ].sort(),
    );
  });
});

describe('both paths agree on partial data too', () => {
  it('agrees that a plain transfer carries no mint', () => {
    const fromBytes = decodeInstruction(
      rawInstruction(TOKEN, splToken.transfer(1n), [scalar.source, scalar.destination, scalar.authority]),
    ).action;
    const fromParsed = decodeInstruction(
      parsedInstruction(TOKEN, 'spl-token', 'transfer', {
        source: scalar.source,
        destination: scalar.destination,
        authority: scalar.authority,
        amount: '1',
      }),
    ).action;

    expect(fromBytes).not.toHaveProperty('mint');
    expect(fromParsed).not.toHaveProperty('mint');
  });

  it('agrees on which roles are missing when the account list is short', () => {
    const fromBytes = decodeInstruction(
      rawInstruction(TOKEN, splToken.transfer(5n), [scalar.source]),
    ).action;
    // The node only ever reports resolved accounts, so a short list surfaces as
    // absent keys in `info`.
    const fromParsed = decodeInstruction(
      parsedInstruction(TOKEN, 'spl-token', 'transfer', { source: scalar.source, amount: '5' }),
    ).action;

    expect(fromBytes).toMatchObject({ source: scalar.source, destination: null, authority: null });
    expect(fromParsed).toMatchObject({ source: scalar.source, destination: null, authority: null });
  });
});
