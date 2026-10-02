/**
 * Renders the deterministic EFFECTS section.
 *
 * Same rules as the Milestone 1 summary and the Milestone 2 ACTIONS section: no
 * clock, no locale, no colour, fixed order, and every list elided for readability
 * only (the model and `--json` stay complete). Addresses are abbreviated by
 * default so the section stays scannable; `--full-addresses` prints them whole.
 *
 * The section is deliberately explicit about three things a reader could otherwise
 * misread: that a value came from instruction data rather than from a balance, that
 * a failed transaction committed nothing but the fee, and that anything left over
 * is unattributed rather than quietly dropped.
 */

import { refLabel, type InstructionRef } from '../decode/actions.ts';
import { formatLamportsWithSol, formatSigned, formatSol } from '../lib/format.ts';
import { abbreviateAddress } from './actions.ts';
import type {
  AccountLifecycleEffect,
  SolFlow,
  TokenFlow,
  TransactionEffects,
  UnattributedEffect,
} from '../effects/model.ts';

/** Display-only limits; the model and `--json` are always complete. */
const MAX_LISTED_FLOWS = 8;
const MAX_LISTED_NETS = 8;
const MAX_LISTED_LIFECYCLE = 8;
const MAX_LISTED_UNATTRIBUTED = 6;
const MAX_LISTED_UNCOMMITTED = 8;
const MAX_LISTED_NOTES = 6;

export interface EffectsRenderOptions {
  readonly abbreviateAddresses: boolean;
}

/**
 * Exact raw-units -> decimal string via integer math (no floats), so a token
 * amount is never rounded. `1234n` at 6 decimals -> `0.001234`.
 */
export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = abs % scale;
  const sign = negative ? '-' : '';
  if (decimals === 0 || fraction === 0n) return `${sign}${whole}`;
  return `${sign}${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

/** `1234 raw units (0.001234)` — units are the truth, the decimal form is a courtesy. */
function tokenAmount(amount: bigint | null, decimals: number | null): string {
  if (amount === null) return 'amount not observable';
  if (decimals === null) return `${amount} raw units`;
  return `${amount} raw units (${formatUnits(amount, decimals)})`;
}

export function renderEffectsSection(
  effects: TransactionEffects,
  options: EffectsRenderOptions,
): string[] {
  const show = (value: string | null): string =>
    value === null ? 'unknown' : options.abbreviateAddresses ? abbreviateAddress(value) : value;

  const lines: string[] = [];
  const { counts } = effects;

  // ------------------------------------------------------------------- header

  const reverted = effects.commitState === 'reverted';
  const unknown = effects.commitState === 'unknown';
  lines.push(
    reverted
      ? `EFFECTS (NOT COMMITTED — the transaction failed and rolled back)`
      : unknown
        ? `EFFECTS (commitment unknown — the response has no meta)`
        : `EFFECTS (committed)`,
  );
  lines.push(
    `  ${counts.proven} proven by instruction data • ${counts.reconciled} sized by balance reconciliation • ` +
      `${counts.unattributed} unattributed • ${counts.amountNotObservable} with an unobservable amount` +
      (counts.uncommitted > 0 ? ` • ${counts.uncommitted} instruction effect(s) did not commit` : ''),
  );
  if (reverted) {
    lines.push(
      '  A failed transaction commits nothing except the fee: Solana deducts the fee before execution and rolls every ' +
        'state change back. The attempted movements are listed below, marked, and never counted as state.',
    );
  }

  // ------------------------------------------------------------- sol flows

  const committedSol = effects.solFlows;
  if (committedSol.length > 0) {
    lines.push('');
    lines.push('  SOL');
    for (const flow of committedSol.slice(0, MAX_LISTED_FLOWS)) lines.push(`    ${solFlowLine(flow, show)}`);
    if (committedSol.length > MAX_LISTED_FLOWS) {
      lines.push(`    … (+${committedSol.length - MAX_LISTED_FLOWS} more)`);
    }
  }

  // ----------------------------------------------------------- token flows

  if (effects.tokenFlows.length > 0) {
    lines.push('');
    lines.push('  TOKEN (raw units; decimals are labels, not arithmetic)');
    for (const flow of effects.tokenFlows.slice(0, MAX_LISTED_FLOWS)) lines.push(`    ${tokenFlowLine(flow, show)}`);
    if (effects.tokenFlows.length > MAX_LISTED_FLOWS) {
      lines.push(`    … (+${effects.tokenFlows.length - MAX_LISTED_FLOWS} more)`);
    }
  }

  // ------------------------------------------------------------- net change

  const movedSol = effects.netSolByAccount.filter(
    net => (net.netLamports !== null && net.netLamports !== 0n) || net.unobservableFlowRefs.length > 0,
  );
  if (movedSol.length > 0) {
    lines.push('');
    lines.push('  NET SOL (exact, from the transaction\'s boundary balances)');
    for (const net of movedSol.slice(0, MAX_LISTED_NETS)) {
      const address = show(net.address) + (net.isFeePayer ? ' (fee payer)' : '');
      const net_ =
        net.netLamports === null
          ? 'net not observable'
          : `${formatSigned(net.netLamports)} lamports (${formatSol(net.netLamports)} SOL)`;
      lines.push(`    ${address}: ${net_}  [${netReconciliation(net.reconciliation, net.unobservableFlowRefs.length)}]`);
    }
    if (movedSol.length > MAX_LISTED_NETS) lines.push(`    … (+${movedSol.length - MAX_LISTED_NETS} more)`);
  }

  const movedToken = effects.netTokenByAccountMint.filter(
    net => (net.netAmount !== null && net.netAmount !== 0n) || net.unobservableFlowRefs.length > 0,
  );
  if (movedToken.length > 0) {
    lines.push('');
    lines.push('  NET TOKEN (per token account and mint)');
    for (const net of movedToken.slice(0, MAX_LISTED_NETS)) {
      const owner = net.owner === null ? 'owner unknown' : `owner ${show(net.owner)}`;
      lines.push(
        `    token account ${show(net.tokenAccount)} (mint ${show(net.mint)}, ${owner}): ` +
          `${net.netAmount === null ? 'net not observable' : `${formatSigned(net.netAmount)} raw units`}` +
          `  [${netReconciliation(net.reconciliation, net.unobservableFlowRefs.length)}]`,
      );
    }
    if (movedToken.length > MAX_LISTED_NETS) lines.push(`    … (+${movedToken.length - MAX_LISTED_NETS} more)`);
  }

  const movedOwners = effects.netTokenByOwnerMint.filter(net => net.netAmount !== null && net.netAmount !== 0n);
  if (movedOwners.length > 0) {
    lines.push('');
    lines.push('  NET TOKEN BY OWNER (aggregated over that owner\'s accounts of the mint; an owner is not a signer)');
    for (const net of movedOwners.slice(0, MAX_LISTED_NETS)) {
      lines.push(
        `    owner ${show(net.owner)}: ${formatSigned(net.netAmount ?? 0n)} raw units of mint ${show(net.mint)} ` +
          `across ${net.tokenAccountCount} token account(s)  [${net.reconciliation}]`,
      );
    }
    if (movedOwners.length > MAX_LISTED_NETS) lines.push(`    … (+${movedOwners.length - MAX_LISTED_NETS} more)`);
  }

  // ------------------------------------------------------------- lifecycle

  if (effects.accountLifecycleEffects.length > 0) {
    lines.push('');
    lines.push('  LIFECYCLE');
    for (const effect of effects.accountLifecycleEffects.slice(0, MAX_LISTED_LIFECYCLE)) {
      lines.push(`    ${lifecycleLine(effect, show)}`);
    }
    if (effects.accountLifecycleEffects.length > MAX_LISTED_LIFECYCLE) {
      lines.push(`    … (+${effects.accountLifecycleEffects.length - MAX_LISTED_LIFECYCLE} more)`);
    }
  }

  // ---------------------------------------------------------- unattributed

  if (effects.unattributedEffects.length > 0) {
    lines.push('');
    lines.push('  UNATTRIBUTED (no instruction proves who moved this; not turned into a flow)');
    for (const entry of effects.unattributedEffects.slice(0, MAX_LISTED_UNATTRIBUTED)) {
      lines.push(`    ${unattributedLine(entry, show)}`);
    }
    if (effects.unattributedEffects.length > MAX_LISTED_UNATTRIBUTED) {
      lines.push(`    … (+${effects.unattributedEffects.length - MAX_LISTED_UNATTRIBUTED} more)`);
    }
  }

  // -------------------------------------------------------- did not commit

  const uncommitted = [
    ...effects.uncommittedSolFlows.map(flow => solFlowLine(flow, show)),
    ...effects.uncommittedTokenFlows.map(flow => tokenFlowLine(flow, show)),
    ...effects.uncommittedLifecycleEffects.map(effect => lifecycleLine(effect, show)),
  ];
  if (uncommitted.length > 0) {
    lines.push('');
    lines.push(`  DID NOT COMMIT (${uncommitted.length}; proven from instruction data, but rolled back)`);
    for (const line of uncommitted.slice(0, MAX_LISTED_UNCOMMITTED)) lines.push(`    ${line}`);
    if (uncommitted.length > MAX_LISTED_UNCOMMITTED) {
      lines.push(`    … (+${uncommitted.length - MAX_LISTED_UNCOMMITTED} more)`);
    }
  }

  // ---------------------------------------------------------------- notes

  if (effects.diagnostics.length > 0) {
    lines.push('');
    lines.push(`  notes (${effects.diagnostics.length}):`);
    for (const note of effects.diagnostics.slice(0, MAX_LISTED_NOTES)) {
      lines.push(`    ${note.level}: ${note.message}`);
    }
    if (effects.diagnostics.length > MAX_LISTED_NOTES) {
      lines.push(`    … (+${effects.diagnostics.length - MAX_LISTED_NOTES} more)`);
    }
  }

  lines.push('');
  lines.push(
    '  amounts are exact integers (lamports / raw units); "proven" means the instruction states it, ' +
      '"reconciled" means an instruction proves the relationship and a balance shows the size.',
  );

  return lines;
}

function netReconciliation(reconciliation: string, unobservable: number): string {
  const base =
    reconciliation === 'exact'
      ? 'exactly explained'
      : reconciliation === 'residual'
        ? 'NOT fully explained'
        : 'net not observable';
  return unobservable > 0 ? `${base}, ${unobservable} flow(s) with unobservable amounts` : base;
}

/** `  [3.2 spl-token.transferChecked]` — refLabel already carries its brackets. */
function refSuffix(ref: InstructionRef | null, actionKind: string | null): string {
  if (ref === null) return '  [fee]';
  const kind = actionKind === null ? '' : ` ${actionKind}`;
  return `  ${refLabel(ref)}${kind}`;
}

function solFlowLine(flow: SolFlow, show: (value: string | null) => string): string {
  const amount =
    flow.lamports === null
      ? 'amount not observable'
      : `${formatLamportsWithSol(flow.lamports)}${flow.confidence === 'reconciled' ? ' (reconciled)' : ''}`;
  if (flow.kind === 'fee') {
    return (
      `${show(flow.from)}: -${formatSol(flow.lamports ?? 0n)} SOL charged by the network ` +
      '(no account in this transaction receives it; the burn/validator split is not claimed)' +
      refSuffix(flow.ref, null)
    );
  }
  return `${show(flow.from)} → ${show(flow.to)}: ${amount}  (${flow.kind})${refSuffix(flow.ref, flow.actionKind)}`;
}

function tokenFlowLine(flow: TokenFlow, show: (value: string | null) => string): string {
  const amount = tokenAmount(flow.amount, flow.decimals);
  // A sign is only printed when there is a number to sign: an unobservable amount
  // must not read as "-amount not observable".
  const signed = (sign: '+' | '-') => (flow.amount === null ? amount : `${sign}${amount}`);
  const route =
    flow.kind === 'mint'
      ? `mint ${show(flow.mint)} → token account ${show(flow.destinationTokenAccount)}: ${signed('+')}`
      : flow.kind === 'burn'
        ? `token account ${show(flow.sourceTokenAccount)} → burned: ${signed('-')}`
        : flow.kind === 'close-unwrap'
          ? `token account ${show(flow.sourceTokenAccount)}: ${signed('-')} (the units it held when it was closed; ` +
            'they leave the token system with the account and are what the lamports the close returned stood for)'
          : `token account ${show(flow.sourceTokenAccount)} → token account ${show(flow.destinationTokenAccount)}: ${amount}`;
  const mint =
    flow.mint === null
      ? 'mint unknown'
      : `mint ${show(flow.mint)}${flow.mintEvidence === 'account-metadata' ? ' (from account metadata)' : ''}`;
  const native = flow.nativeLamportLeg && flow.kind !== 'close-unwrap' ? ' • wrapped SOL: moved the same lamports too' : '';
  const authority =
    flow.authority === null
      ? ''
      : flow.authorityIsSigner === false
        ? ` • authority ${show(flow.authority)} (not a signer: multisig or program-derived)`
        : ` • authority ${show(flow.authority)}`;
  const owners =
    flow.kind === 'close-unwrap' || (flow.sourceOwner === null && flow.destinationOwner === null)
      ? ''
      : ` • owners ${show(flow.sourceOwner)} → ${show(flow.destinationOwner)}`;
  return `${route}  (${mint})${owners}${native}${authority}${refSuffix(flow.ref, flow.actionKind)}`;
}

function lifecycleLine(effect: AccountLifecycleEffect, show: (value: string | null) => string): string {
  switch (effect.kind) {
    case 'account-created':
      return (
        `created account ${show(effect.address)} (space ${effect.space ?? 'unknown'}, owner program ${show(effect.ownerProgram)}), ` +
        `funded by ${show(effect.funder)} with ${effect.lamportsDeposited ?? 'an unknown amount of'} lamports` +
        refSuffix(effect.ref, effect.actionKind)
      );
    case 'token-account-create':
      return (
        effect.outcome === 'no-op'
          ? `idempotent create did nothing: ${show(effect.address)} already was an initialised token account`
          : effect.outcome === 'created'
            ? `created associated token account ${show(effect.address)} for owner ${show(effect.owner)} (mint ${show(effect.mint)})` +
              `, paid by ${show(effect.funder)}: ` +
              (effect.lamportsDeposited === null
                ? 'deposit not observable'
                : `${effect.lamportsDeposited} lamports deposited`)
            : `associated token account create for ${show(effect.address)}: outcome not provable from this response` +
              ` (funded by ${show(effect.funder)})`
      ) + refSuffix(effect.ref, effect.actionKind);
    case 'token-account-closed': {
      const returned =
        effect.lamportsReturned === null
          ? 'lamports returned: not observable from boundary balances'
          : `${effect.lamportsReturned} lamports returned`;
      const composition =
        effect.unwrappedLamports === null
          ? effect.isNativeMint
            ? ' (composition not provable)'
            : ''
          : ` (= ${effect.unwrappedLamports} unwrapped wrapped-SOL + ${effect.otherLamports ?? 0} other lamports; ` +
            'rent and dust are not separated, that needs a rent value this layer will not hardcode)';
      // Recovered rent and lamports that arrived during the transaction are
      // different claims, so which one this is gets said out loud.
      const provenance =
        effect.returnComposition === 'own-lamports'
          ? ' — already in the account before this transaction (recovered rent and any dust, not a transfer to the destination)'
          : effect.returnComposition === 'in-transaction-lamports'
            ? ` — the transaction created it, so none of this is rent it held: ${effect.lamportsCredited} lamports were paid in and ${effect.lamportsSpent} spent`
            : effect.returnComposition === 'mixed'
              ? ` — some of it was already there (${effect.lamportsAtStart} lamports, rent and any dust), plus ${effect.lamportsCredited} paid in and ${effect.lamportsSpent} spent during the transaction`
              : ' — whether this is rent it held or lamports paid to it during the transaction is not stated';
      return (
        `closed token account ${show(effect.address)} (mint ${show(effect.mint)}, owner ${show(effect.owner)}); ` +
        `${returned} to ${show(effect.destination)}${provenance}${composition}` +
        refSuffix(effect.ref, effect.actionKind)
      );
    }
    case 'allowance-set':
      return (
        `allowance: token account ${show(effect.tokenAccount)} (owner ${show(effect.owner)}) delegated ` +
        `${effect.allowance === null ? 'an unknown amount' : `${effect.allowance} raw units`} to ${show(effect.delegate)}` +
        ` — a delegation, not a transfer` +
        refSuffix(effect.ref, effect.actionKind)
      );
    case 'allowance-cleared':
      return (
        `allowance cleared on token account ${show(effect.tokenAccount)} (owner ${show(effect.owner)})` +
        ` — a delegation removed, not a transfer` +
        refSuffix(effect.ref, effect.actionKind)
      );
  }
}

function unattributedLine(entry: UnattributedEffect, show: (value: string | null) => string): string {
  const where =
    entry.side === 'sol'
      ? `${entry.amount === null ? 'unknown lamports' : `${formatSigned(entry.amount)} lamports`} at ${show(entry.address)}`
      : `${entry.amount === null ? 'unknown raw units' : `${formatSigned(entry.amount)} raw units`} of mint ${show(entry.mint)}` +
        ` at token account ${show(entry.address)}`;
  const refs =
    entry.candidateRefs.length > 0
      ? ` • candidate proven flows: ${entry.candidateRefs.map(ref => refLabel(ref)).join(', ')}`
      : '';
  const undecoded =
    entry.undecodedRefs.length > 0
      ? ` • undecoded instructions of its program: ${entry.undecodedRefs.map(ref => refLabel(ref)).join(', ')}`
      : '';
  return `${where} — ${entry.reason}${refs}${undecoded}`;
}
