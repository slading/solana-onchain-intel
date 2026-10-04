/**
 * What the SWAPS section prints for a pump_amm `buy`.
 *
 * The section is a report of a proof, so the tests are about the shape of that
 * report: the instruction's own name and direction, the payment with its fee
 * outflows, the cap with its verdict, and the proof state — never a generic
 * "BUY" label, and never a number that was not established. The 4.1 DLMM blocks and
 * the 4.2 sell blocks are asserted byte-identically elsewhere; here they are only
 * checked for surviving the buy addition.
 */
import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { normalizeFixture } from './helpers/fixtures.ts';
import { recognizeDlmmSwaps } from '../src/swap/recognize.ts';
import { recognizeSwaps } from '../src/swap/recognize-swaps.ts';
import { renderSwapSection } from '../src/render/swaps.ts';

const DIRECT = 'v0-success-pump-buy-24b-direct';

function sectionOf(fixture: string, abbreviateAddresses = true): readonly string[] {
  const { transaction } = normalizeFixture(fixture);
  const report = recognizeSwaps(transaction, { effects: transactionEffects(transaction) });
  return renderSwapSection(report, { abbreviateAddresses });
}

/** The section for the direct 24-byte buy, abbreviated, exactly as rendered. */
const GOLDEN_DIRECT = [
  'SWAPS (Meteora DLMM swap2 + pump_amm buy/sell — recognized from instruction semantics, cross-checked against EFFECTS)',
  '  1 recognized • 1 proven • 0 partially proven • 0 not committed • 0 conflicting',
  '',
  '  [6]  buy  pool CzTw…nk8y  quote → base  committed  proven',
  '      in    2343923556 raw units  mint So11…1112  token account ARBC…fjCJ  owner 9KHS…evjp  leg [6.2]',
  '      out   4734094242460 raw units  mint AJAa…pump  token account 4DeB…ZS5c  owner 9KHS…evjp  leg [6.1]',
  '      roles  global_config ADyA…JKqw  pool_base 5S1e…faPk  pool_quote 4Up7…GaQd  base_mint AJAa…pump  quote_mint So11…1112  remaining 3',
  "      fees   3 other outflow(s) of the user's quote account, counted in the spend: 584812 → 94qW…YDjb (protocol-fee-recipient, owner 62qc…fNgV); 22222829 → B8T8…xWK7 (coin-creator-vault, owner C69k…Re9b); 584811 → HjQj…Sr8i (other, owner 5YxQ…vxeD)",
  "      cap  max_quote_amount_in 2980000000 — an upper bound on the user's total quote spend; the spend 2367316008 (2343923556 into the pool quote vault + 23392452 in 3 other outflow(s)) satisfies it",
  '      checks  20 pass • 0 fail • 0 not-checkable',
  '',
  '  a leg appears here only because an AMM instruction was matched by program id and discriminator, its arguments were read with exact byte consumption, its named account roles mapped, and the transfers it executed inside its own CPI subtree agree with those roles — a token leaving and another arriving is never sufficient. In a pump_amm sell, the output is the transfer into the named user quote account; transfers to protocol-fee, coin-creator and other destinations are listed separately and are never counted as the user\u2019s proceeds. In a pump_amm buy, the payment is every outflow of the named user quote account inside the instruction — the transfer into the pool quote vault and the fee transfers listed with it — and the instruction\u2019s max_quote_amount_in bounds that total.',
];

describe('the buy leg as rendered', () => {
  it('renders the direct 24-byte buy exactly, direction and cap first', () => {
    expect(sectionOf(DIRECT)).toEqual(GOLDEN_DIRECT);
  });

  it('states the cap verdict from the total, and the binding case as satisfied', () => {
    const routed = sectionOf('v0-success-pump-buy-24b');
    const cap = routed.find(line => line.startsWith('      cap  '));
    expect(cap).toBe(
      "      cap  max_quote_amount_in 22914125 — an upper bound on the user's total quote spend; the spend 22914125 " +
        '(22635760 into the pool quote vault + 278365 in 3 other outflow(s)) satisfies it',
    );
    // The vault transfer alone is below the cap: the sentence is about the total.
    expect(cap).not.toContain('22635760 (22635760');
  });

  it('never reports u64::MAX as a satisfied cap', () => {
    const unbounded = sectionOf('v0-success-pump-buy-unbounded');
    const cap = unbounded.find(line => line.startsWith('      cap  '));
    expect(cap).toContain('max_quote_amount_in 18446744073709551615');
    expect(cap).toContain('states no binding limit');
    expect(cap).toContain('never reported as a satisfied cap');
    expect(cap).not.toContain('satisfies it');
    expect(unbounded).toContain('      unknown  max-quote-amount-in-unbounded');
  });

  it('says a failed buy committed nothing, and tests no cap against it', () => {
    const failed = sectionOf('v0-failed-pump-buy-slippage');
    expect(failed).toContain('  1 recognized • 0 proven • 0 partially proven • 1 not committed • 0 conflicting');
    expect(failed).toContain('  [5]  buy  pool 2kje…6Gzr  quote → base  reverted  NOT COMMITTED (transaction failed)');
    expect(failed).toContain(
      '      note  the transaction failed and rolled back: the amounts below are attempted movement, not state',
    );
    expect(failed.join('\n')).toContain('      in    not observable  mint unknown');
    const cap = failed.find(line => line.startsWith('      cap  '));
    expect(cap).toContain('did not commit');
    expect(cap).toContain('never reported as satisfied');
    expect(failed.join('\n')).toContain(
      "      fees   no transfer out of the user's quote account was attributed, so there is nothing to list",
    );
  });

  it('names the two pumps instructions it covers, and labels nothing else', () => {
    const text = sectionOf(DIRECT, false).join('\n');
    expect(text).toContain('pump_amm buy/sell');
    // The only occurrences of the words are the instruction names and the section's
    // own naming of them: no generic BUY/SELL verdict is printed.
    const stripped = text
      .replace(/pump_amm buy\/sell/g, '')
      .replace(/pump_amm (buy|sell)/g, '')
      .replace(/  (buy|sell)  /g, '');
    expect(stripped).not.toMatch(/\b(buy|bought|sold|BUY|SELL|Buy|Sell)\b/);
    expect(text).toContain('quote → base');
  });

  it('renders a transaction holding both a buy and a sell, in ref order', () => {
    const both = sectionOf('v0-success-pump-buy-unbounded');
    expect(both).toContain('  2 recognized • 2 proven • 0 partially proven • 0 not committed • 0 conflicting');
    const sell = both.findIndex(line => line.includes('  sell  '));
    const buy = both.findIndex(line => line.includes('  buy  '));
    expect(sell).toBeGreaterThan(-1);
    expect(buy).toBeGreaterThan(sell as number);
    expect(both[buy]).toContain('quote → base');
  });

  it('keeps the DLMM leg blocks byte-identical to the DLMM-only renderer', () => {
    // The 4.3 addition is additive: a transaction that also holds a `swap2` renders
    // that block exactly as the 4.1 renderer did.
    const { transaction } = normalizeFixture('v0-success-dlmm-minout');
    const effects = transactionEffects(transaction);
    const combined = renderSwapSection(recognizeSwaps(transaction, { effects }), { abbreviateAddresses: true });
    const dlmmOnly = renderSwapSection(
      { scannedProtocols: ['meteora-dlmm'], legs: recognizeDlmmSwaps(transaction, { effects }).legs, diagnostics: [], counts: {
        recognized: 1, proven: 1, partiallyProven: 0, notCommitted: 0, conflicting: 0,
      } },
      { abbreviateAddresses: true },
    );
    const blockOf = (lines: readonly string[], ref: string) => {
      const start = lines.findIndex(line => line.startsWith(`  ${ref}  `));
      return lines.slice(start, lines.findIndex((line, index) => index > start && line.startsWith('  [')));
    };
    expect(blockOf(combined, '[3.1]')).toEqual(blockOf(dlmmOnly, '[3.1]'));
  });

  it('prints full addresses on request and abbreviates by default', () => {
    const long = sectionOf(DIRECT, false).join('\n');
    expect(long).toContain('4Up7JiPYD2xC8eLiG76PEDnA872StnuwCHSF5ChjGaQd');
    expect(long).not.toContain('4Up7…GaQd');
  });

  it('is deterministic and free of terminal escapes', () => {
    const first = stringifyJson(sectionOf(DIRECT));
    const second = stringifyJson(sectionOf(DIRECT));
    expect(first).toBe(second);
    expect(first).not.toContain('\u001b');
  });
});
