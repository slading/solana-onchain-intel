import { describe, expect, it } from 'vitest';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { describeAction, renderActionSection } from '../src/render/actions.ts';
import { renderSummary } from '../src/render/summary.ts';
import { normalizeFixture } from './helpers/fixtures.ts';
import { ACC, SYSTEM, TOKEN, rawInstruction, splToken, system } from './helpers/instructions.ts';
import { meta, syntheticTransaction } from './helpers/synthetic.ts';

const PROVENANCE = {
  rpcEndpoint: 'https://example.invalid',
  encoding: 'jsonParsed',
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 1,
} as const;

function render(parts: Parameters<typeof syntheticTransaction>[0], options?: Parameters<typeof renderActionSection>[1]) {
  const transaction = normalizeTransaction(syntheticTransaction(parts), { provenance: PROVENANCE });
  return renderActionSection(transaction.decoded, options).join('\n');
}

describe('the ACTIONS section', () => {
  it('reports counts of decoded and undecoded instructions', () => {
    const text = render({
      instructions: [
        rawInstruction(SYSTEM, system.transfer(1_000_000n), [ACC.funding, ACC.recipient]),
        rawInstruction('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', [1], [ACC.source]),
      ],
    });
    expect(text).toContain('ACTIONS (1 decoded, 1 not decoded, from 2 instruction(s))');
  });

  it('prints one line per action with its ref, kind and evidence', () => {
    const text = render({
      instructions: [
        rawInstruction(SYSTEM, system.transfer(100_000_000n), [ACC.funding, ACC.recipient]),
        rawInstruction(TOKEN, splToken.transferChecked(1_000n, 6), [
          ACC.source,
          ACC.mint,
          ACC.destination,
          ACC.authority,
        ]),
      ],
    });
    expect(text).toContain('system.transfer');
    expect(text).toContain('spl-token.transferChecked');
    expect(text).toContain('[bytes]');
    // A system transfer shows SOL as well as the exact lamport count.
    expect(text).toContain('0.1 SOL (100000000 lamports)');
    expect(text).toContain('decimals=6');
  });

  it('ties every action line to an INSTRUCTIONS ref', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const summary = renderSummary(transaction, { includeLogs: false, includeActions: false });
    const actions = renderActionSection(transaction.decoded).join('\n');

    for (const action of transaction.decoded.actions.slice(0, 5)) {
      const label = action.ref.path === 'inner' ? `[${action.ref.outerIndex}.${action.ref.index}]` : `[${action.ref.index}]`;
      expect(actions).toContain(label);
      expect(summary).toContain(label);
    }
  });

  it('lists unknown programs as not decoded, grouped by reason', () => {
    const text = render({
      instructions: [
        rawInstruction('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', [1], [ACC.source]),
        rawInstruction('ComputeBudget111111111111111111111111111111', [1], []),
        rawInstruction(TOKEN, splToken.setAuthority(), [ACC.source, ACC.other]),
      ],
    });
    expect(text).toContain('not decoded (3); unknown programs stay unknown:');
    expect(text).toContain('program not decoded by this layer');
    expect(text).toContain('outside the Milestone 2 target set');
    expect(text).toContain('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
  });

  it('abbreviates addresses by default and prints them in full on request', () => {
    const parts = {
      instructions: [rawInstruction(SYSTEM, system.transfer(1n), [ACC.funding, ACC.recipient])],
    };
    const short = render(parts, { abbreviateAddresses: true });
    const full = render(parts, { abbreviateAddresses: false });

    expect(short).toContain('E5JX…YTir');
    expect(short).not.toContain(ACC.funding);
    expect(full).toContain(ACC.funding);
    expect(full).toContain(ACC.recipient);
  });

  it('says so when nothing in the target set was found', () => {
    const text = render({ instructions: [] });
    expect(text).toContain('ACTIONS (0 decoded, 0 not decoded, from 0 instruction(s))');
    expect(text).toContain('no instructions in the Milestone 2 target set were found');
  });

  it('states that actions come from instruction data, not balances', () => {
    const text = render({
      instructions: [rawInstruction(SYSTEM, system.transfer(1n), [ACC.funding, ACC.recipient])],
    });
    expect(text).toContain('never from balance changes');
  });

  it('shows a decoded SOL transfer total only when there is one', () => {
    const withTransfer = render({
      instructions: [
        rawInstruction(SYSTEM, system.transfer(100_000_000n), [ACC.funding, ACC.recipient]),
        rawInstruction(SYSTEM, system.transfer(50_000_000n), [ACC.funding, ACC.other]),
      ],
    });
    expect(withTransfer).toContain('decoded system.transfer total: 0.15 SOL across 2 transfer(s)');

    const withoutTransfer = render({ instructions: [] });
    expect(withoutTransfer).not.toContain('decoded system.transfer total');
  });

  it('reports an unknown amount in the transfer total rather than counting it as zero', () => {
    const text = render({
      // Tag + only 2 of the 8 lamport bytes: the amount cannot be read.
      instructions: [rawInstruction(SYSTEM, [2, 0, 0, 0, 1, 2], [ACC.funding, ACC.recipient])],
    });
    expect(text).toContain('unknown');
    expect(text).toContain('decoded system.transfer total: 0 SOL across 1 transfer(s) (+1 with unknown amount)');
  });

  it('shows decoding notes for partial data', () => {
    const text = render({
      instructions: [rawInstruction(TOKEN, [3, 1, 2, 3], [ACC.source, ACC.destination, ACC.authority])],
    });
    expect(text).toContain('decoding notes (1):');
    expect(text).toContain('decode-partial');
    expect(text).toContain('expected 8 bytes of amount');
  });

  it('is deterministic', () => {
    const parts = {
      instructions: [
        rawInstruction(SYSTEM, system.transfer(1n), [ACC.funding, ACC.recipient]),
        rawInstruction('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', [1], []),
      ],
      meta: meta({ err: { InstructionError: [0, { Custom: 1 }] } }),
    };
    expect(render(parts)).toBe(render(parts));
  });
});

describe('describeAction', () => {
  it('prints exact addresses and marks unreadable fields unknown', () => {
    const transaction = normalizeTransaction(
      syntheticTransaction({
        instructions: [rawInstruction(TOKEN, [3, 1, 2], [ACC.source])],
      }),
      { provenance: PROVENANCE },
    );
    const action = transaction.decoded.actions[0];
    if (action === undefined) throw new Error('expected an action');
    const line = describeAction(action);
    expect(line).toContain(`source=${ACC.source}`);
    expect(line).toContain('destination=unknown');
    expect(line).toContain('authority=unknown');
    expect(line).toContain('unknown raw units');
  });
});

describe('summary integration', () => {
  it('includes ACTIONS between INSTRUCTIONS and SOL BALANCE CHANGES', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const text = renderSummary(transaction, { includeLogs: false });
    const instructionsAt = text.indexOf('INSTRUCTIONS (');
    const actionsAt = text.indexOf('ACTIONS (');
    const balancesAt = text.indexOf('SOL BALANCE CHANGES');
    expect(instructionsAt).toBeGreaterThan(-1);
    expect(actionsAt).toBeGreaterThan(instructionsAt);
    expect(balancesAt).toBeGreaterThan(actionsAt);
  });

  it('can print only the ACTIONS section', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const text = renderSummary(transaction, { includeLogs: true, onlyActions: true });
    expect(text).toContain('ACTIONS (');
    expect(text).not.toContain('SOL BALANCE CHANGES');
    expect(text).not.toContain('TOKEN BALANCE CHANGES');
    expect(text).not.toContain('\nLOGS\n');
    expect(text).toContain(transaction.signature);
  });

  it('can omit the ACTIONS section, leaving the Milestone 1 output shape', () => {
    const { transaction } = normalizeFixture('v0-success-swap');
    const text = renderSummary(transaction, { includeLogs: false, includeActions: false });
    expect(text).not.toContain('\nACTIONS (');
    expect(text).toContain('INSTRUCTIONS (');
    expect(text).toContain('SOL BALANCE CHANGES');
  });
});
