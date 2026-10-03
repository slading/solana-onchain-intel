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
import type { DlmmSwapCheck, DlmmSwapLeg, TransactionSwaps } from '../swap/model.ts';

const MAX_LISTED_CHECKS = 3;

export interface SwapRenderOptions {
  readonly abbreviateAddresses: boolean;
}

function stateLabel(leg: DlmmSwapLeg): string {
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

function summarizeChecks(checks: readonly DlmmSwapCheck[]): string {
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
  swaps: TransactionSwaps,
  options: SwapRenderOptions,
): string[] {
  const show = (value: string | null): string =>
    value === null ? 'unknown' : options.abbreviateAddresses ? abbreviateAddress(value) : value;

  const lines: string[] = [];
  lines.push('SWAPS (Meteora DLMM swap2 — recognized from instruction semantics, cross-checked against EFFECTS)');

  const { counts, legs } = swaps;
  if (legs.length === 0) {
    lines.push('  (no Meteora DLMM swap2 instruction was recognized in this transaction)');
  } else {
    lines.push(
      `  ${counts.recognized} recognized • ${counts.proven} proven • ${counts.partiallyProven} partially proven • ` +
        `${counts.notCommitted} not committed • ${counts.conflicting} conflicting`,
    );
  }

  for (const leg of legs) {
    const direction = leg.xToY === null ? 'direction unknown' : `token ${leg.xToY ? 'X' : 'Y'} in`;
    lines.push('');
    lines.push(
      `  ${refLabel(leg.ref)}  ${leg.instructionName}  pool ${show(leg.roles.pool)}  ${direction}  ` +
        `${leg.commitState}  ${stateLabel(leg)}`,
    );
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
    lines.push(
      '  a leg appears here only because a DLMM swap2 instruction was matched by program id and discriminator, its ' +
        'arguments were read with exact byte consumption, its named account roles mapped, and the transfers it executed ' +
        'inside its own CPI subtree agree with those roles — a token leaving and another arriving is never sufficient.',
    );
  }

  return lines;
}
