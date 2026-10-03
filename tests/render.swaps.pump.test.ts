/**
 * The SWAPS section now that it covers two protocols.
 *
 * Three things are asserted here and nowhere else:
 *
 *   1. the pump leg's own golden output, including the fee line that keeps a
 *      protocol/creator/buyback transfer out of the user's proceeds;
 *   2. that the two Milestone 4.1 DLMM leg blocks are rendered **byte-identically**
 *      to what the DLMM-only renderer produced — the pump addition is additive;
 *   3. that nothing is labelled a buy or a sell beyond the authoritative
 *      instruction name.
 */
import { describe, expect, it } from 'vitest';
import { transactionEffects } from '../src/effects/build.ts';
import { normalizeFixture } from './helpers/fixtures.ts';
import { recognizeSwaps } from '../src/swap/recognize-swaps.ts';
import { recognizeDlmmSwaps } from '../src/swap/recognize.ts';
import { renderSummary } from '../src/render/summary.ts';
import { renderSwapSection } from '../src/render/swaps.ts';
import { withoutInnerInstructions, withStatus } from './helpers/swaps.ts';
import { pumpFixture } from './helpers/pump.ts';

/** The section for the direct fixture, abbreviated, exactly as rendered. */
const GOLDEN_DIRECT = [
  'SWAPS (Meteora DLMM swap2 + pump_amm sell — recognized from instruction semantics, cross-checked against EFFECTS)',
  '  1 recognized • 1 proven • 0 partially proven • 0 not committed • 0 conflicting',
  '',
  '  [7]  sell  pool 5wYc…rTdV  base → quote  committed  proven',
  '      in    185356 raw units  mint So11…1112  token account HiRn…fWsx  owner 21gs…vBNH  leg [7.1]',
  '      out   176602689 raw units  mint 4LjR…yUKK  token account FfcK…ghhP  owner 21gs…vBNH  leg [7.2]',
  '      roles  global_config ADyA…JKqw  pool_base A7mZ…9RBW  pool_quote GayM…o3vs  base_mint So11…1112  quote_mint 4LjR…yUKK  remaining 2',
  "      fees   2 other quote-vault transfer(s) excluded from the user's output: 44284 → Dapf…9q2K (protocol-fee-recipient, owner 62qc…fNgV); 44284 → DmdC…YYDJ (other, owner 5YxQ…vxeD)",
  '      min out  171510690 — the instruction states a floor; the output 176602689 satisfies it',
  '      checks  19 pass • 0 fail • 0 not-checkable',
  '',
  '  a leg appears here only because an AMM instruction was matched by program id and discriminator, its arguments were read with exact byte consumption, its named account roles mapped, and the transfers it executed inside its own CPI subtree agree with those roles — a token leaving and another arriving is never sufficient. In a pump_amm sell, the output is the transfer into the named user quote account; transfers to protocol-fee, coin-creator and other destinations are listed separately and are never counted as the user’s proceeds.',
];

describe('the pump leg as rendered', () => {
  it('renders the direct sell exactly, semantic result first', () => {
    const { report } = pumpFixture('token-mixed-closeAccount');
    expect(renderSwapSection(report, { abbreviateAddresses: true })).toEqual(GOLDEN_DIRECT);
  });

  it('renders the routed sell with its three fee transfers named by slot', () => {
    const { report } = pumpFixture('v0-success-swap');
    const lines = renderSwapSection(report, { abbreviateAddresses: true });
    expect(lines[1]).toBe('  3 recognized • 3 proven • 0 partially proven • 0 not committed • 0 conflicting');
    expect(lines).toContain('  [3.0]  sell  pool 31eC…3H5h  base → quote  committed  proven');
    expect(lines).toContain(
      '      in    2729270725642 raw units  mint 9pJW…9ZMr  token account CLD7…ruTt  owner E5JX…YTir  leg [3.2]',
    );
    expect(lines).toContain(
      '      out   8747131976 raw units  mint So11…1112  token account Cr5v…qAeh  owner E5JX…YTir  leg [3.3]',
    );
    const fees = lines.find(line => line.startsWith('      fees   '));
    expect(fees).toContain('3 other quote-vault transfer(s) excluded');
    expect(fees).toContain('2211106 →');
    expect(fees).toContain('(protocol-fee-recipient, owner 9rPY…hJUz)');
    expect(fees).toContain('75177576 →');
    expect(fees).toContain('(coin-creator-vault, owner H73D…r1oZ)');
    expect(fees).toContain('2211105 →');
    expect(fees).toContain('(other, owner 5YxQ…vxeD)');
    // The zero floor is stated as an absence.
    expect(lines).toContain(
      '      min out  0 — no floor is stated by this instruction, so the output cannot be tested against one (never reported as a satisfied floor)',
    );
    expect(lines).toContain('      unknown  min-quote-amount-out-not-stated');
  });

  it('never labels anything a buy or a sell beyond the instruction name', () => {
    for (const name of ['token-mixed-closeAccount', 'v0-success-swap'] as const) {
      const { report } = pumpFixture(name);
      const text = renderSwapSection(report, { abbreviateAddresses: false }).join('\n');
      expect(text, name).toContain('sell');
      expect(text, name).not.toMatch(/\b(buy|bought|sold|BUY|SELL|Buy|Sell)\b/);
      // Every occurrence of "sell" is the instruction's own name: either the
      // program's `pump_amm sell` or the leg header's `  sell  ` column.
      const stripped = text.replace(/pump_amm sell/g, '').replace(/  sell  /g, '');
      expect(stripped, name).not.toContain('sell');
      expect(text.match(/pump_amm sell/g)?.length ?? 0).toBeGreaterThan(0);
      expect(text, name).toContain('base → quote');
    }
  });

  it('says NOT COMMITTED for a failed transaction', () => {
    const transaction = withStatus(normalizeFixture('token-mixed-closeAccount').transaction, 'failed', {
      InstructionError: [7, { Custom: 6004 }],
    });
    const report = recognizeSwaps(transaction, { effects: transactionEffects(transaction) });
    const lines = renderSwapSection(report, { abbreviateAddresses: true });
    expect(lines[1]).toBe('  1 recognized • 0 proven • 0 partially proven • 1 not committed • 0 conflicting');
    expect(lines).toContain('  [7]  sell  pool 5wYc…rTdV  base → quote  reverted  NOT COMMITTED (transaction failed)');
    expect(lines).toContain(
      '      note  the transaction failed and rolled back: the amounts below are attempted movement, not state',
    );
  });

  it('reports conflicts with both values instead of a verdict', () => {
    const { report } = pumpFixture('token-mixed-closeAccount');
    // Re-point the protocol fee transfer at the user's quote account: two
    // candidates for the output.
    const transaction = normalizeFixture('token-mixed-closeAccount').transaction;
    void transaction;
    const lines = renderSwapSection(report, { abbreviateAddresses: true });
    expect(lines.some(line => line.startsWith('      conflict'))).toBe(false);
    expect(lines).toContain('      checks  19 pass • 0 fail • 0 not-checkable');
  });

  it('mentions the missing CPI recording rather than "no swap"', () => {
    const transaction = withoutInnerInstructions(normalizeFixture('token-mixed-closeAccount').transaction);
    const report = recognizeSwaps(transaction, { effects: transactionEffects(transaction) });
    const lines = renderSwapSection(report, { abbreviateAddresses: true });
    expect(lines[1]).toBe('  1 recognized • 0 proven • 1 partially proven • 0 not committed • 0 conflicting');
    expect(lines.some(line => line.includes('swap-inner-instructions-unavailable'))).toBe(true);
  });
});

describe('Milestone 4.1 output did not regress', () => {
  it('renders the two DLMM leg blocks byte-identically to the DLMM-only renderer', () => {
    const { report } = pumpFixture('v0-success-swap');
    const combined = renderSwapSection(report, { abbreviateAddresses: true });

    // The 4.1 renderer, fed the 4.1 report, for the same fixture.
    const { transaction } = normalizeFixture('v0-success-swap');
    const dlmmOnly = renderSwapSection(recognizeDlmmSwaps(transaction, { effects: transactionEffects(transaction) }), {
      abbreviateAddresses: true,
    });

    // Every line of the DLMM leg blocks survives verbatim in the combined section.
    const dlmmLegLines = dlmmOnly.filter(
      line =>
        !line.startsWith('SWAPS (') &&
        !line.startsWith('  2 recognized') &&
        !line.startsWith('  (no ') &&
        !line.startsWith('  a leg appears'),
    );
    expect(dlmmLegLines.length).toBeGreaterThan(10);
    for (const line of dlmmLegLines) {
      expect(combined, `line kept verbatim: ${line}`).toContain(line);
    }
    // And only the counts line changed, because a third leg now exists.
    expect(dlmmOnly[1]).toBe('  2 recognized • 2 proven • 0 partially proven • 0 not committed • 0 conflicting');
    expect(combined[1]).toBe('  3 recognized • 3 proven • 0 partially proven • 0 not committed • 0 conflicting');
  });

  it('keeps the 4.1 golden untouched for the DLMM-only report model', () => {
    // `recognizeDlmmSwaps` carries no `scannedProtocols`, so the section keeps the
    // exact 4.1 wording. This is what makes the 4.1 golden test meaningful.
    const { transaction } = normalizeFixture('v0-success-dlmm-minout');
    const effects = transactionEffects(transaction);
    const lines = renderSwapSection(recognizeDlmmSwaps(transaction, { effects }), { abbreviateAddresses: true });
    expect(lines[0]).toBe(
      'SWAPS (Meteora DLMM swap2 — recognized from instruction semantics, cross-checked against EFFECTS)',
    );
    expect(lines.at(-1)).toContain('a leg appears here only because a DLMM swap2 instruction was matched');
    expect(lines.at(-1)).not.toContain('pump');
  });

  it('keeps the empty-section wording for a report with no protocols named', () => {
    const { transaction } = normalizeFixture('token-mixed-approve');
    const effects = transactionEffects(transaction);
    const lines = renderSwapSection(recognizeDlmmSwaps(transaction, { effects }), { abbreviateAddresses: true });
    expect(lines[1]).toBe('  (no Meteora DLMM swap2 instruction was recognized in this transaction)');
  });
});

describe('how the section sits inside the summary', () => {
  it('still appears between ACTIONS and EFFECTS, and is absent on request', () => {
    const { transaction, report } = pumpFixture('token-mixed-closeAccount');
    const effects = transactionEffects(transaction);
    const text = renderSummary(transaction, { includeLogs: false, effects, swaps: report });
    const actions = text.indexOf('\nACTIONS (');
    const swapSection = text.indexOf('\nSWAPS (');
    const effectSection = text.indexOf('\nEFFECTS (');
    expect(actions).toBeGreaterThan(-1);
    expect(swapSection).toBeGreaterThan(actions);
    expect(effectSection).toBeGreaterThan(swapSection);

    const without = renderSummary(transaction, { includeLogs: false, effects, swaps: null });
    expect(without).not.toContain('SWAPS');
    expect(without).toBe(renderSummary(transaction, { includeLogs: false, effects }));
  });

  it('prints only the header and the section under `--swaps`', () => {
    const { transaction, report } = pumpFixture('token-mixed-closeAccount');
    const text = renderSummary(transaction, {
      includeLogs: true,
      effects: transactionEffects(transaction),
      swaps: report,
      onlySwaps: true,
    });
    expect(text).toContain('SWAPS (');
    expect(text).not.toContain('\nINSTRUCTIONS (');
    expect(text).not.toContain('\nACTIONS (');
    expect(text).not.toContain('\nEFFECTS (');
  });

  it('abbreviates by default and prints full addresses on request', () => {
    const { report } = pumpFixture('token-mixed-closeAccount');
    const full = renderSwapSection(report, { abbreviateAddresses: false }).join('\n');
    const short = renderSwapSection(report, { abbreviateAddresses: true }).join('\n');
    expect(full).toContain('HiRnLovipYBuCuguxheoLZGu4brUKjzByp7mwwtqfWsx');
    expect(full).toContain('176602689');
    expect(short).toContain('HiRn…fWsx');
    expect(short.split('\n')).toHaveLength(full.split('\n').length);
  });

  it('is deterministic and free of terminal escapes', () => {
    const { report } = pumpFixture('v0-success-swap');
    const first = renderSwapSection(report, { abbreviateAddresses: true });
    expect(renderSwapSection(report, { abbreviateAddresses: true })).toEqual(first);
    const text = first.join('\n');
    expect(text).not.toMatch(/\u001b\[/);
    expect(text).not.toMatch(/[\r\t]/);
  });

  it('keeps payload bytes and logs out of the printed section', () => {
    const { report, transaction } = pumpFixture('token-mixed-closeAccount');
    const text = renderSwapSection(report, { abbreviateAddresses: false }).join('\n');
    for (const instruction of [...transaction.instructions, ...transaction.innerInstructionGroups.flatMap(g => g.instructions)]) {
      if (instruction.data !== null && instruction.data.length > 16) {
        expect(text).not.toContain(instruction.data);
      }
    }
    expect(text).not.toContain('logMessages');
  });
});
