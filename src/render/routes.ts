/**
 * Renders the ROUTES section.
 *
 * Same determinism rules as every other section: fixed field order, no clock, no
 * locale, no colour, addresses abbreviated by default (the full value is one line
 * up in INSTRUCTIONS at the same `[ref]`, and always in `--json`).
 *
 * The wording is the point of this section. A route is an **envelope**: the text
 * says "intent", "quote", "plan", "legs" — never "in"/"out" amounts, because the
 * route owns none. Every number on an `intent`/`policy` line comes from the
 * instruction's own bytes, and the lines below say what is not established (the
 * comparison target of the minimum output, the space the plan's indices point into,
 * who receives a platform fee). A reader must be able to tell a route from a swap
 * without knowing the model.
 */

import { refLabel } from '../decode/actions.ts';
import { abbreviateAddress } from './actions.ts';
import type { JupiterRouteEnvelope, RouteCheck, RouteReport } from '../route/model.ts';

const MAX_LISTED_CHECKS = 3;

export interface RouteRenderOptions {
  readonly abbreviateAddresses: boolean;
}

const HEADER =
  'ROUTES (Jupiter route_v2 — a route envelope: intent, quote and plan only; movement stays with the legs)';

const EMPTY = '  (no Jupiter route_v2 instruction was recognized in this transaction)';

const FOOTER =
  '  a route appears here only because a JUP6 instruction carried the route_v2 discriminator and its header ' +
  'parsed with exact byte consumption. The envelope owns the declared input, the quote, the slippage ' +
  'tolerance, the platform-fee rate and the decoded plan — never an executed amount: every movement stays ' +
  'owned by the inner legs (and by EFFECTS), so a route is never counted into a swap or movement total. ' +
  'Plan weights are reported verbatim: a split\u2019s weights sum to 10000 while chained steps each carry ' +
  '10000, so no global-sum rule is applied. The space input_index/output_index point into is not ' +
  'established, so they stay opaque topology indices.';

function stateLabel(envelope: JupiterRouteEnvelope): string {
  switch (envelope.state) {
    case 'proven':
      return 'proven';
    case 'partially-proven':
      return 'partially proven';
    case 'not-committed':
      return envelope.commitState === 'reverted'
        ? 'NOT COMMITTED (transaction failed)'
        : 'NOT COMMITTED (commitment unknown)';
    case 'conflicting':
      return 'CONFLICTING — evidence disagrees';
  }
}

function amount(value: bigint | null): string {
  return value === null ? 'not readable' : `${value} raw units`;
}

function summarizeChecks(checks: readonly RouteCheck[]): string {
  const passed = checks.filter(entry => entry.outcome === 'pass').length;
  const failed = checks.filter(entry => entry.outcome === 'fail').length;
  const notCheckable = checks.filter(entry => entry.outcome === 'not-checkable');
  const listed = notCheckable.slice(0, MAX_LISTED_CHECKS).map(entry => entry.id);
  const more = notCheckable.length - listed.length;
  const suffix = notCheckable.length === 0 ? '' : ` (${listed.join(', ')}${more > 0 ? `, +${more} more` : ''})`;
  return `${passed} pass • ${failed} fail • ${notCheckable.length} not-checkable${suffix}`;
}

/** One plan step: the raw tag, its proven name (or the absence of one), and the verbatim fields. */
function stepLine(step: JupiterRouteEnvelope['plan']['steps'][number]): string {
  const identity =
    step.swapName === null
      ? `swap tag ${step.swapTag} (no name in any available ABI)`
      : `swap tag ${step.swapTag} ${step.swapName}`;
  return (
    `        step ${step.index}  ${identity}  variant payload ${step.swapFieldBytes} byte(s)  ` +
    `bps ${step.bps}  input_index ${step.inputIndex}  output_index ${step.outputIndex}`
  );
}

export function renderRouteSection(routes: RouteReport, options: RouteRenderOptions): string[] {
  const show = (value: string | null): string =>
    value === null ? 'unknown' : options.abbreviateAddresses ? abbreviateAddress(value) : value;

  const lines: string[] = [];
  lines.push(HEADER);

  const { counts, envelopes } = routes;
  if (envelopes.length === 0) {
    lines.push(EMPTY);
  } else {
    lines.push(
      `  ${counts.recognized} recognized • ${counts.proven} proven • ` +
        `${counts.partiallyProven} partially proven • ${counts.notCommitted} not committed • ` +
        `${counts.conflicting} conflicting`,
    );
  }

  for (const envelope of envelopes) {
    lines.push('');
    lines.push(
      `  ${refLabel(envelope.ref)}  ${envelope.instructionName}  ${show(envelope.programId)}  ` +
        `${envelope.commitState}  ${stateLabel(envelope)}`,
    );
    if (envelope.state === 'not-committed') {
      lines.push(
        envelope.commitState === 'reverted'
          ? '      note  the transaction failed and rolled back: what follows is the ' +
            'route\u2019s intent, never settled movement'
          : '      note  the response carries no meta: what follows is the route\u2019s ' +
            'intent, never settled movement',
      );
    }

    const { accounts, intent, plan } = envelope;
    lines.push(
      `      route    ${show(accounts.userTransferAuthority)} authorizes ` +
        `${show(accounts.userSourceTokenAccount)} \u2192 ${show(accounts.userDestinationTokenAccount)}  ` +
        `mints ${show(accounts.sourceMint)} \u2192 ${show(accounts.destinationMint)}`,
    );
    lines.push(
      `      intent   declared in ${amount(intent.declaredInAmount)} (authorized, not proof of movement)  ` +
        `quoted out ${amount(intent.quotedOutAmount)}`,
    );
    lines.push(
      `      policy   slippage ${intent.slippageBps} bps  ` +
        `declared minimum out ${amount(intent.declaredMinOutAmount)} ` +
        '(route-level arithmetic on the quote; the value the program compares it against is not established)  ' +
        `platform fee ${intent.platformFeeBps} bps  positive slippage ${intent.positiveSlippageBps} bps`,
    );
    lines.push(
      `      accounts ${accounts.accountSlotCount} slot(s): 10 declared roles  ` +
        `${accounts.remainingAccountCount} remaining (opaque; no role is provable and none is used as evidence)`,
    );

    lines.push(
      plan.complete
        ? `      plan     ${plan.steps.length} step(s) decoded exactly (every payload byte consumed)`
        : `      plan     ${plan.steps.length} of ${plan.declaredStepCount} step(s) decoded — ${plan.detail}`,
    );
    for (const step of plan.steps) lines.push(stepLine(step));

    const { legAccounting, legs } = envelope;
    const covered = legs.filter(leg => leg.coveredBy !== null).length;
    lines.push(
      `      legs     ${legAccounting.legCount} dispatched instruction(s)  ` +
        `(${legAccounting.selfCallCount} self-call(s) and ${legAccounting.infrastructureCount} ` +
        `token/system/account instruction(s) excluded)  ${covered} recognized by the swap layer`,
    );
    for (const leg of legs) {
      const identity =
        leg.instructionName !== null
          ? leg.instructionName
          : leg.discriminator !== null
            ? `discriminator ${leg.discriminator} (name not proven)`
            : 'data too short for a discriminator';
      lines.push(
        `        ${refLabel(leg.ref)}  ${show(leg.programId)}  ${identity}  ` +
          `${leg.planStepIndex === null ? 'not referenced by the plan' : `plan step ${leg.planStepIndex}`}  ` +
          `${
            leg.coveredBy === null
              ? 'not recognized as a swap'
              : `recognized by the swap layer (${leg.coveredBy.protocol} ${leg.coveredBy.instructionName})`
          }`,
      );
    }
    lines.push(`      align    ${envelope.planAlignment.status} — ${envelope.planAlignment.detail}`);

    lines.push(`      checks  ${summarizeChecks(envelope.checks)}`);
    for (const entry of envelope.checks) {
      if (entry.outcome !== 'fail') continue;
      lines.push(`      conflict  ${entry.id}: ${entry.detail}`);
    }
    if (envelope.unknowns.length > 0) {
      lines.push(`      unknown  ${envelope.unknowns.join(', ')}`);
    }
  }

  const notes = routes.diagnostics;
  if (notes.length > 0) {
    lines.push('');
    lines.push(`  notes (${notes.length}):`);
    for (const note of notes) {
      lines.push(`    ${note.ref === null ? '(transaction)' : refLabel(note.ref)} [${note.level}] ${note.code}`);
      lines.push(`        ${note.message}`);
    }
  }

  if (envelopes.length > 0) {
    lines.push('');
    lines.push(FOOTER);
  }

  return lines;
}
