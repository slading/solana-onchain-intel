/**
 * The SWAPS section: what the swap layer prints, and — just as important — what it
 * does not.
 *
 * The section is a report of a proof, so these tests are about the *shape* of that
 * report: the semantic result first, the raw amounts and roles as evidence, every
 * condition that did not pass named, and no verdict the layer has not earned.
 * No BUY/SELL verdict is ever printed: the only places those words appear are the
 * instruction names the programs themselves declare (`pump_amm buy` / `pump_amm
 * sell`, since 4.2/4.3), because whether a swap *is* a "buy" depends on what the
 * reader considers the quote asset, which is not a fact this layer has.
 */
import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { renderSummary } from '../src/render/summary.ts';
import { renderSwapSection } from '../src/render/swaps.ts';
import { recognizeDlmmSwaps } from '../src/swap/recognize.ts';
import { allFixtureNames, normalizeFixture } from './helpers/fixtures.ts';
import { base58, patchInstruction, swap2Payload, swapFixture } from './helpers/swaps.ts';

/** The section for `v0-success-dlmm-minout`, abbreviated, exactly as rendered. */
const GOLDEN_MINOUT = [
  'SWAPS (Meteora DLMM swap2 — recognized from instruction semantics, cross-checked against EFFECTS)',
  '  1 recognized • 1 proven • 0 partially proven • 0 not committed • 0 conflicting',
  '',
  '  [3.1]  swap2  pool Cqc2…jN7C  token Y in  committed  proven',
  '      in    250000000 raw units  mint So11…1112  token account Hk5B…Pvuq  owner 7bCA…MbVg  leg [3.3]',
  '      out   14512360 raw units  mint 4k3D…kX6R  token account 6qgL…CfcM  owner 7bCA…MbVg  leg [3.5]',
  '      roles  reserve_x 4M9Z…FTQM  reserve_y FaGE…z1i9  token_x_mint 4k3D…kX6R  token_y_mint So11…1112  remaining 3',
  '      min out  1 — the instruction states a floor; the output 14512360 satisfies it',
  '      checks  19 pass • 0 fail • 0 not-checkable',
  '',
  '  a leg appears here only because a DLMM swap2 instruction was matched by program id and discriminator, its arguments were read with exact byte consumption, its named account roles mapped, and the transfers it executed inside its own CPI subtree agree with those roles — a token leaving and another arriving is never sufficient.',
];

describe('the SWAPS section', () => {
  it('renders a recognized leg exactly, semantic result first', () => {
    const { swaps } = swapFixture('v0-success-dlmm-minout');
    expect(renderSwapSection(swaps, { abbreviateAddresses: true })).toEqual(GOLDEN_MINOUT);
  });

  it('renders both real legs of the primary fixture', () => {
    const { swaps } = swapFixture('v0-success-swap');
    const lines = renderSwapSection(swaps, { abbreviateAddresses: true });
    expect(lines[0]).toContain('SWAPS (Meteora DLMM swap2');
    expect(lines[1]).toBe('  2 recognized • 2 proven • 0 partially proven • 0 not committed • 0 conflicting');
    const headers = lines.filter(line => line.startsWith('  [3.'));
    expect(headers).toEqual([
      '  [3.8]  swap2  pool 5fwr…yGuD  token X in  committed  proven',
      '  [3.13]  swap2  pool BSi8…vcBG  token X in  committed  proven',
    ]);
    // Each leg names its input, output and the two transfers it was proven from.
    expect(lines).toContain(
      '      in    602101187025 raw units  mint 9pJW…9ZMr  token account CLD7…ruTt  owner E5JX…YTir  leg [3.10]',
    );
    expect(lines).toContain(
      '      out   1916188255 raw units  mint So11…1112  token account Cr5v…qAeh  owner E5JX…YTir  leg [3.11]',
    );
    expect(lines).toContain(
      '      in    1443419419808 raw units  mint 9pJW…9ZMr  token account CLD7…ruTt  owner E5JX…YTir  leg [3.15]',
    );
    expect(lines).toContain(
      '      out   4572493603 raw units  mint So11…1112  token account Cr5v…qAeh  owner E5JX…YTir  leg [3.16]',
    );
  });

  it('states a zero floor as absence of a floor, never as a satisfied one', () => {
    const { swaps } = swapFixture('v0-success-swap');
    const lines = renderSwapSection(swaps, { abbreviateAddresses: true });
    const minOutLines = lines.filter(line => line.trimStart().startsWith('min out'));
    expect(minOutLines).toHaveLength(2);
    for (const line of minOutLines) {
      expect(line).toContain('min out  0');
      expect(line).toContain('no floor is stated');
      // The one sentence about "satisfied" is the denial, not a verdict.
      expect(line).toContain('(never reported as a satisfied floor)');
      expect(line).not.toMatch(/satisfies|satisfied:/);
    }
    expect(lines.filter(line => line.includes('unknown  min-amount-out-not-stated'))).toHaveLength(2);
    expect(lines.filter(line => line.includes('17 pass • 0 fail • 2 not-checkable'))).toHaveLength(2);
  });

  it('never labels a swap a buy or a sell', () => {
    for (const name of ['v0-success-swap', 'v0-success-dlmm-minout']) {
      const { swaps } = swapFixture(name);
      const text = renderSwapSection(swaps, { abbreviateAddresses: false }).join('\n');
      expect(text, name).toContain('swap2');
      expect(text, name).not.toMatch(/\b(buy|sell|bought|sold|BUY|SELL)\b/);
      // It says which side of the pool moved, not what that "means".
      expect(text, name).toMatch(/token (X|Y) in/);
    }
  });

  it('shows the conflicts a mutated instruction produced instead of a verdict', () => {
    const transaction = patchInstruction(
      normalizeFixture('v0-success-swap').transaction,
      3,
      8,
      { data: base58(swap2Payload(602_101_187_025n, 1_916_188_256n)) },
    );
    const mutated = recognizeDlmmSwaps(transaction, { effects: transactionEffects(transaction) });
    const lines = renderSwapSection(mutated, { abbreviateAddresses: true });
    expect(lines[1]).toBe('  2 recognized • 1 proven • 0 partially proven • 0 not committed • 1 conflicting');
    const header = lines.find(line => line.startsWith('  [3.8]'));
    expect(header).toBe('  [3.8]  swap2  pool 5fwr…yGuD  token X in  committed  CONFLICTING — evidence disagrees');
    expect(lines).toContain('      checks  18 pass • 1 fail • 0 not-checkable');
    expect(lines).toContain(
      '      conflict  min-amount-out-satisfied: output 1916188255 is below min_amount_out 1916188256',
    );
    // The untouched leg is still reported as proven in the same section.
    expect(lines.find(line => line.startsWith('  [3.13]'))).toContain('proven');
  });

  it('says so plainly when nothing was recognized', () => {
    const { swaps } = swapFixture('token-mixed-approve');
    const lines = renderSwapSection(swaps, { abbreviateAddresses: true });
    expect(lines[0]).toContain('SWAPS (Meteora DLMM swap2');
    expect(lines[1]).toBe('  (no Meteora DLMM swap2 instruction was recognized in this transaction)');
  });

  it('is deterministic and free of terminal escapes', () => {
    const { swaps } = swapFixture('v0-success-swap');
    const first = renderSwapSection(swaps, { abbreviateAddresses: true });
    const second = renderSwapSection(swaps, { abbreviateAddresses: true });
    expect(second).toEqual(first);
    const text = first.join('\n');
    expect(text).not.toMatch(/\u001b\[/);
    expect(text).not.toMatch(/[\r\t]/);
  });
});

describe('how the section sits inside the summary', () => {
  it('appears between ACTIONS and EFFECTS', () => {
    const { transaction, effects, swaps } = swapFixture('v0-success-swap');
    const text = renderSummary(transaction, { includeLogs: false, effects, swaps });
    const actions = text.indexOf('\nACTIONS (');
    const swapSection = text.indexOf('\nSWAPS (');
    const effectSection = text.indexOf('\nEFFECTS (');
    expect(actions).toBeGreaterThan(-1);
    expect(swapSection).toBeGreaterThan(actions);
    expect(effectSection).toBeGreaterThan(swapSection);
  });

  it('omits the section entirely when the caller does not supply one', () => {
    const { transaction, effects } = swapFixture('v0-success-swap');
    const without = renderSummary(transaction, { includeLogs: true, effects });
    const explicitNull = renderSummary(transaction, { includeLogs: true, effects, swaps: null });
    expect(without).not.toContain('SWAPS');
    expect(explicitNull).not.toContain('SWAPS');
    // `--no-swaps` is exactly this: the layer is not consulted, and the bytes are
    // identical to the output before the section existed.
    expect(explicitNull).toBe(without);
  });

  it('reproduces the frozen output byte-for-byte for every fixture with `swaps: null`', () => {
    for (const name of allFixtureNames()) {
      const { transaction } = normalizeFixture(name);
      const effects = transactionEffects(transaction);
      const frozen = renderSummary(transaction, { includeLogs: true, effects });
      const noSwaps = renderSummary(transaction, { includeLogs: true, effects, swaps: null });
      expect(noSwaps, name).toBe(frozen);
      expect(noSwaps, name).not.toContain('SWAPS');
    }
  });

  it('prints only the header and the section under `--swaps`', () => {
    const { transaction, effects, swaps } = swapFixture('v0-success-swap');
    const text = renderSummary(transaction, { includeLogs: true, effects, swaps, onlySwaps: true });
    expect(text).toContain('SWAPS (');
    expect(text).not.toContain('\nINSTRUCTIONS (');
    expect(text).not.toContain('\nACTIONS (');
    expect(text).not.toContain('\nEFFECTS (');
    expect(text).not.toContain('\nLOGS\n');
    expect(text).not.toContain('\nSOL BALANCE CHANGES\n');
    expect(text).not.toContain('\nTOKEN BALANCE CHANGES\n');
  });

  it('renders an unrecognizing fixture with an empty section rather than silence', () => {
    const { transaction } = normalizeFixture('legacy-success-vote');
    const effects = transactionEffects(transaction);
    const text = renderSummary(transaction, {
      includeLogs: false,
      effects,
      swaps: recognizeDlmmSwaps(transaction, { effects }),
    });
    expect(text).toContain('\nSWAPS (');
    expect(text).toContain('(no Meteora DLMM swap2 instruction was recognized in this transaction)');
  });
});

describe('what the section never carries', () => {
  it('keeps payload bytes, logs and the raw response out of the printed section', () => {
    const { transaction, swaps } = swapFixture('v0-success-swap');
    const text = renderSwapSection(swaps, { abbreviateAddresses: false }).join('\n');
    const instructions = transaction.innerInstructionGroups
      .find(group => group.outerIndex === 3)
      ?.instructions ?? [];
    for (const instruction of instructions) {
      if (instruction.data !== null) expect(text).not.toContain(instruction.data);
    }
    expect(text).not.toContain('logMessages');
    expect(text).not.toContain('"raw"');
  });

  it('prints the full addresses on request and abbreviates otherwise', () => {
    const { swaps } = swapFixture('v0-success-swap');
    const full = renderSwapSection(swaps, { abbreviateAddresses: false }).join('\n');
    const short = renderSwapSection(swaps, { abbreviateAddresses: true }).join('\n');
    expect(full).toContain('5fwrQ1KAHVzGJAe9KvfAMziPkLGsxTfrf4ywCZfwyGuD');
    expect(full).toContain('602101187025');
    expect(short).toContain('5fwr…yGuD');
    // The section is the same length either way: only addresses change.
    expect(short.split('\n')).toHaveLength(full.split('\n').length);
  });

  it('has no clock in it', () => {
    const { swaps } = swapFixture('v0-success-swap');
    expect(stringifyJson(swaps)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
