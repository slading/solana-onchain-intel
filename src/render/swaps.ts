/**
 * Renders the SWAPS section.
 *
 * Same determinism rules as every other section: fixed field order, no clock, no
 * locale, no colour, addresses abbreviated by default (the full value is one line
 * up in INSTRUCTIONS at the same `[ref]`, and always in `--json`).
 *
 * The human-facing output leads with the semantic result (state, pool, direction,
 * the two amounts) and keeps implementation detail — check ids, the effects
 * cross-reference — on the lines below it. It never labels a leg "buy" or "sell":
 * the DLMM instruction has an X/Y axis, not a side, and the layer reports what the
 * instruction states.
 */

import { refLabel } from '../decode/actions.ts';
import { abbreviateAddress } from './actions.ts';
import type { PumpBuyLeg, SwapCheck, SwapLeg, SwapProtocol, SwapReport } from '../swap/model.ts';

const MAX_LISTED_CHECKS = 3;

export interface SwapRenderOptions {
  readonly abbreviateAddresses: boolean;
}

/**
 * The section's wording follows the protocols the report covers.
 *
 * A report **without** `scannedProtocols` is the 4.1 DLMM-only model, and it must
 * keep rendering byte-for-byte what it rendered then — that is what makes the
 * 4.1 golden tests meaningful. A report that names its protocols gets wording that
 * matches them.
 */
function wording(protocols: readonly SwapProtocol[] | undefined) {
  const dlmm = protocols === undefined || protocols.includes('meteora-dlmm');
  const pump = protocols !== undefined && protocols.includes('pump-amm');
  const named = [dlmm ? 'Meteora DLMM swap2' : null, pump ? 'pump_amm buy/sell' : null]
    .filter((entry): entry is string => entry !== null)
    .join(' + ');
  const long = [dlmm ? 'Meteora DLMM swap2' : null, pump ? 'pump_amm buy/sell' : null]
    .filter((entry): entry is string => entry !== null)
    .join(' or ');
  return {
    header: `SWAPS (${named} — recognized from instruction semantics, cross-checked against EFFECTS)`,
    empty: `  (no ${long} instruction was recognized in this transaction)`,
    footer: dlmm && !pump
      ? '  a leg appears here only because a DLMM swap2 instruction was matched by program id and discriminator, its ' +
        'arguments were read with exact byte consumption, its named account roles mapped, and the transfers it executed ' +
        'inside its own CPI subtree agree with those roles — a token leaving and another arriving is never sufficient.'
      : '  a leg appears here only because an AMM instruction was matched by program id and discriminator, its arguments ' +
        'were read with exact byte consumption, its named account roles mapped, and the transfers it executed inside its ' +
        'own CPI subtree agree with those roles — a token leaving and another arriving is never sufficient.' +
        (pump
          ? ' In a pump_amm sell, the output is the transfer into the named user quote account; transfers to ' +
            'protocol-fee, coin-creator and other destinations are listed separately and are never counted as ' +
            'the user\u2019s proceeds.' +
            ' In a pump_amm buy, the payment is every outflow of the named user quote account inside the ' +
            'instruction — the transfer into the pool quote vault and the fee transfers listed with it — and ' +
            'the instruction\u2019s max_quote_amount_in bounds that total.'
          : ''),
  };
}

function stateLabel(leg: SwapLeg): string {
  switch (leg.state) {
    case 'proven':
      return 'proven';
    case 'partially-proven':
      return 'partially proven';
    case 'not-committed':
      return leg.commitState === 'reverted' ? 'NOT COMMITTED (transaction failed)' : 'NOT COMMITTED (commitment unknown)';
    case 'conflicting':
      return 'CONFLICTING — evidence disagrees';
  }
}

function amount(value: bigint | null): string {
  return value === null ? 'not observable' : `${value} raw units`;
}

/** The value `max_quote_amount_in` uses to say "no binding limit stated". */
const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * The `max_quote_amount_in` line for a pump `buy`.
 *
 * A cap is only ever reported as satisfied when the spend is attributed *and* its
 * enumeration is complete; `u64::MAX` is stated as the absence of a bound rather
 * than rendered as a trivially satisfied one.
 */
function capLine(leg: PumpBuyLeg): string {
  const cap = leg.maxQuoteAmountIn;
  if (cap === null) {
    return "      cap  max_quote_amount_in unknown — the instruction's bound could not be read";
  }
  const spend = leg.quoteSpend;
  const vault = leg.input.amount;
  const fees = spend === null || vault === null ? null : spend - vault;
  if (cap === U64_MAX) {
    return (
      `      cap  max_quote_amount_in ${cap} — the maximum u64: the instruction states no binding limit, so the ` +
      `spend ${spend === null ? 'could not be compared against one' : `of ${spend} is not tested against it`} ` +
      '(never reported as a satisfied cap)'
    );
  }
  if (leg.commitState !== 'committed') {
    return (
      `      cap  max_quote_amount_in ${cap} — stated, but the transaction did not commit, so the bound describes ` +
      'attempted movement only (never reported as satisfied)'
    );
  }
  if (spend === null) {
    return (
      `      cap  max_quote_amount_in ${cap} — stated, but the user's spend could not be attributed, so the bound ` +
      'cannot be tested (never reported as satisfied)'
    );
  }
  if (!leg.quoteSpendComplete) {
    return (
      `      cap  max_quote_amount_in ${cap} — stated, but the spend enumeration is incomplete (${spend} attributed), ` +
      'so the bound cannot be tested against it (never reported as satisfied)'
    );
  }
  const breakdown =
    fees === null ? 'the whole spend' : `${vault} into the pool quote vault + ${fees} in ${leg.feeTransfers.length} other outflow(s)`;
  return (
    `      cap  max_quote_amount_in ${cap} — an upper bound on the user's total quote spend; the spend ${spend} ` +
    `(${breakdown}) ${spend <= cap ? 'satisfies it' : 'exceeds it'}`
  );
}

function summarizeChecks(checks: readonly SwapCheck[]): string {
  const passed = checks.filter(entry => entry.outcome === 'pass').length;
  const failed = checks.filter(entry => entry.outcome === 'fail').length;
  const notCheckable = checks.filter(entry => entry.outcome === 'not-checkable');
  const listed = notCheckable.slice(0, MAX_LISTED_CHECKS).map(entry => entry.id);
  const more = notCheckable.length - listed.length;
  const suffix =
    notCheckable.length === 0
      ? ''
      : ` (${listed.join(', ')}${more > 0 ? `, +${more} more` : ''})`;
  return `${passed} pass • ${failed} fail • ${notCheckable.length} not-checkable${suffix}`;
}

export function renderSwapSection(
  swaps: SwapReport,
  options: SwapRenderOptions,
): string[] {
  const show = (value: string | null): string =>
    value === null ? 'unknown' : options.abbreviateAddresses ? abbreviateAddress(value) : value;

  const text = wording(swaps.scannedProtocols);
  const lines: string[] = [];
  lines.push(text.header);

  const { counts, legs } = swaps;
  if (legs.length === 0) {
    lines.push(text.empty);
  } else {
    lines.push(
      `  ${counts.recognized} recognized • ${counts.proven} proven • ${counts.partiallyProven} partially proven • ` +
        `${counts.notCommitted} not committed • ${counts.conflicting} conflicting`,
    );
  }

  for (const leg of legs) {
    lines.push('');
    if (leg.protocol === 'meteora-dlmm') {
      const direction = leg.xToY === null ? 'direction unknown' : `token ${leg.xToY ? 'X' : 'Y'} in`;
      lines.push(
        `  ${refLabel(leg.ref)}  ${leg.instructionName}  pool ${show(leg.roles.pool)}  ${direction}  ` +
          `${leg.commitState}  ${stateLabel(leg)}`,
      );
    } else if (leg.instructionName === 'sell') {
      // The instruction's own name states the direction: base in, quote out.
      lines.push(
        `  ${refLabel(leg.ref)}  ${leg.instructionName}  pool ${show(leg.roles.pool)}  base → quote  ` +
          `${leg.commitState}  ${stateLabel(leg)}`,
      );
    } else {
      // `buy`: quote in, base out — again the instruction's own name, mirrored.
      lines.push(
        `  ${refLabel(leg.ref)}  ${leg.instructionName}  pool ${show(leg.roles.pool)}  quote → base  ` +
          `${leg.commitState}  ${stateLabel(leg)}`,
      );
    }
    if (leg.state === 'not-committed') {
      lines.push(
        leg.commitState === 'reverted'
          ? '      note  the transaction failed and rolled back: the amounts below are attempted movement, not state'
          : '      note  the response carries no meta: the amounts below are attempted movement, not state',
      );
    }

    lines.push(
      `      in    ${amount(leg.input.amount)}  mint ${show(leg.input.mint)}  ` +
        `token account ${show(leg.input.tokenAccount)}  owner ${show(leg.input.owner)}  ` +
        `leg ${leg.input.legRef === null ? 'not attributed' : refLabel(leg.input.legRef)}`,
    );
    lines.push(
      `      out   ${amount(leg.output.amount)}  mint ${show(leg.output.mint)}  ` +
        `token account ${show(leg.output.tokenAccount)}  owner ${show(leg.output.owner)}  ` +
        `leg ${leg.output.legRef === null ? 'not attributed' : refLabel(leg.output.legRef)}`,
    );

    if (leg.protocol === 'meteora-dlmm') {
      lines.push(
        `      roles  reserve_x ${show(leg.roles.reserveX)}  reserve_y ${show(leg.roles.reserveY)}  ` +
          `token_x_mint ${show(leg.roles.tokenXMint)}  token_y_mint ${show(leg.roles.tokenYMint)}  ` +
          `remaining ${leg.roles.tailAccountCount}`,
      );
      lines.push(
        leg.minAmountOut !== null && leg.minAmountOut > 0n
          ? `      min out  ${leg.minAmountOut} — the instruction states a floor; ` +
              `the output ${leg.output.amount === null ? 'could not be compared against it' : `${leg.output.amount} satisfies it`}`
          : `      min out  ${leg.minAmountOut ?? 'unknown'} — no floor is stated by this instruction, so the output cannot be ` +
              'tested against one (never reported as a satisfied floor)',
      );
    } else if (leg.instructionName === 'sell') {
      lines.push(
        `      roles  global_config ${show(leg.roles.globalConfig)}  pool_base ${show(leg.roles.poolBaseTokenAccount)}  ` +
          `pool_quote ${show(leg.roles.poolQuoteTokenAccount)}  base_mint ${show(leg.roles.baseMint)}  ` +
          `quote_mint ${show(leg.roles.quoteMint)}  remaining ${leg.roles.tailAccountCount}`,
      );
      lines.push(
        leg.feeTransfers.length === 0
          ? '      fees   no other transfer left the pool quote vault inside this instruction'
          : `      fees   ${leg.feeTransfers.length} other quote-vault transfer(s) excluded from the user's output: ` +
              leg.feeTransfers
                .map(
                  entry =>
                    `${entry.amount ?? 'amount not observable'} → ${show(entry.destTokenAccount)} (${entry.role}` +
                    `${entry.destOwner === null ? '' : `, owner ${show(entry.destOwner)}`})`,
                )
                .join('; '),
      );
      lines.push(
        leg.minQuoteAmountOut !== null && leg.minQuoteAmountOut > 0n
          ? `      min out  ${leg.minQuoteAmountOut} — the instruction states a floor; ` +
              `the output ${leg.output.amount === null ? 'could not be compared against it' : `${leg.output.amount} satisfies it`}`
          : `      min out  ${leg.minQuoteAmountOut ?? 'unknown'} — no floor is stated by this instruction, so the output cannot be ` +
              'tested against one (never reported as a satisfied floor)',
      );
    }

    if (leg.protocol === 'pump-amm' && leg.instructionName === 'buy') {
      lines.push(
        `      roles  global_config ${show(leg.roles.globalConfig)}  pool_base ${show(leg.roles.poolBaseTokenAccount)}  ` +
          `pool_quote ${show(leg.roles.poolQuoteTokenAccount)}  base_mint ${show(leg.roles.baseMint)}  ` +
          `quote_mint ${show(leg.roles.quoteMint)}  remaining ${leg.roles.tailAccountCount}`,
      );
      lines.push(
        leg.feeTransfers.length === 0
          ? leg.input.legRef === null
            ? "      fees   no transfer out of the user's quote account was attributed, so there is nothing to list"
            : "      fees   no other transfer left the user's quote account inside this instruction, so the payment is the whole spend"
          : `      fees   ${leg.feeTransfers.length} other outflow(s) of the user's quote account, counted in the spend: ` +
              leg.feeTransfers
                .map(
                  entry =>
                    `${entry.amount ?? 'amount not observable'} → ${show(entry.destTokenAccount)} (${entry.role}` +
                    `${entry.destOwner === null ? '' : `, owner ${show(entry.destOwner)}`})`,
                )
                .join('; '),
      );
      lines.push(capLine(leg));
    }

    lines.push(`      checks  ${summarizeChecks(leg.checks)}`);

    for (const entry of leg.checks) {
      if (entry.outcome !== 'fail') continue;
      lines.push(`      conflict  ${entry.id}: ${entry.detail}`);
    }

    if (leg.unknowns.length > 0) {
      lines.push(`      unknown  ${leg.unknowns.join(', ')}`);
    }
  }

  const notes = swaps.diagnostics;
  if (notes.length > 0) {
    lines.push('');
    lines.push(`  notes (${notes.length}):`);
    for (const note of notes) {
      lines.push(
        `    ${note.ref === null ? '(transaction)' : refLabel(note.ref)} [${note.level}] ${note.code}`,
      );
      lines.push(`        ${note.message}`);
    }
  }

  if (legs.length > 0) {
    lines.push('');
    lines.push(text.footer);
  }

  return lines;
}
