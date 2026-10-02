/**
 * Renders the ACTIONS section.
 *
 * Concise by design: one line per decoded action, then the instructions that
 * produced no action, grouped by reason. Same determinism rules as the rest of
 * the renderer — fixed field order, no colours, no locale formatting, and
 * `unknown` for anything the decoder could not establish.
 *
 * Addresses are printed in full (never truncated): they are the point of the
 * section, and the elision used for account *lists* would make them unusable.
 */
import { formatLamportsWithSol, formatSol, padEnd } from '../lib/format.ts';
import type {
  DecodedAction,
  DecodedTransaction,
  UndecodedInstruction,
  UndecodedReason,
} from '../decode/actions.ts';
import { refLabel } from '../decode/actions.ts';

const UNKNOWN = 'unknown';
const REF_WIDTH = 10;
const ADDRESS_PREFIX = 4;
const ADDRESS_SUFFIX = 4;

/**
 * Display width control.
 *
 * ACTIONS prints abbreviated addresses by default so the section stays scannable;
 * the full address is one line above in INSTRUCTIONS (same `[ref]`), and `--json`
 * always has the exact value. `--full-addresses` turns the abbreviation off.
 * Abbreviation is display-only and always marked with an ellipsis.
 */
export interface ActionRenderOptions {
  readonly maxUndecodedPerReason?: number;
  readonly abbreviateAddresses?: boolean;
}

/**
 * Abbreviates an address for display (`4…4`). Exported so every section uses one
 * convention; the full value is always in the model and in `--json`.
 */
export function abbreviateAddress(value: string): string {
  return abbreviate(value);
}

function abbreviate(value: string): string {
  if (value.length <= ADDRESS_PREFIX + ADDRESS_SUFFIX + 1) return value;
  return `${value.slice(0, ADDRESS_PREFIX)}…${value.slice(-ADDRESS_SUFFIX)}`;
}

const amount = (value: bigint | null): string => (value === null ? UNKNOWN : value.toString());
const decimals = (value: number | null): string => (value === null ? UNKNOWN : value.toString());

/** Human description of one action. Field order is fixed per kind. */
function describeActionWith(action: DecodedAction, show: (value: string | null) => string): string {
  switch (action.kind) {
    case 'system.transfer':
      return (
        `${action.lamports === null ? UNKNOWN : formatLamportsWithSol(action.lamports)}  ` +
        `from=${show(action.from)}  to=${show(action.to)}`
      );
    case 'system.createAccount':
      return (
        `${action.lamports === null ? UNKNOWN : formatLamportsWithSol(action.lamports)}  ` +
        `space=${amount(action.space)} bytes  owner=${show(action.owner)}  ` +
        `from=${show(action.from)}  newAccount=${show(action.newAccount)}`
      );
    case 'spl-token.transfer':
      // A plain transfer carries no mint and no decimals by design; the ledger
      // has them, the instruction does not, so they are simply absent here.
      return (
        `${amount(action.amount)} raw units  ` +
        `source=${show(action.source)}  destination=${show(action.destination)}  ` +
        `authority=${show(action.authority)}`
      );
    case 'spl-token.transferChecked':
      return (
        `${amount(action.amount)} raw units  decimals=${decimals(action.decimals)}  ` +
        `mint=${show(action.mint)}  source=${show(action.source)}  ` +
        `destination=${show(action.destination)}  authority=${show(action.authority)}`
      );
    case 'spl-token.mintTo':
      return (
        `${amount(action.amount)} raw units  mint=${show(action.mint)}  ` +
        `destination=${show(action.destination)}  authority=${show(action.authority)}`
      );
    case 'spl-token.mintToChecked':
      return (
        `${amount(action.amount)} raw units  decimals=${decimals(action.decimals)}  ` +
        `mint=${show(action.mint)}  destination=${show(action.destination)}  ` +
        `authority=${show(action.authority)}`
      );
    case 'spl-token.burn':
      return (
        `${amount(action.amount)} raw units  account=${show(action.account)}  ` +
        `mint=${show(action.mint)}  authority=${show(action.authority)}`
      );
    case 'spl-token.burnChecked':
      return (
        `${amount(action.amount)} raw units  decimals=${decimals(action.decimals)}  ` +
        `account=${show(action.account)}  mint=${show(action.mint)}  ` +
        `authority=${show(action.authority)}`
      );
    case 'spl-token.approve':
      return (
        `${amount(action.amount)} raw units  source=${show(action.source)}  ` +
        `delegate=${show(action.delegate)}  authority=${show(action.authority)}`
      );
    case 'spl-token.revoke':
      return `source=${show(action.source)}  authority=${show(action.authority)}`;
    case 'spl-token.closeAccount':
      return (
        `account=${show(action.account)}  destination=${show(action.destination)}  ` +
        `authority=${show(action.authority)}`
      );
    case 'associated-token-account.create':
      return (
        `${action.idempotent ? 'CreateIdempotent' : 'Create'}  ata=${show(action.associatedTokenAccount)}  ` +
        `wallet=${show(action.wallet)}  mint=${show(action.mint)}  ` +
        `payer=${show(action.payer)}  tokenProgram=${show(action.tokenProgram)}`
      );
  }
}

/** Human description of one action with exact addresses. */
export function describeAction(action: DecodedAction): string {
  return describeActionWith(action, value => value ?? UNKNOWN);
}

/** Short, factual explanation of why an instruction produced no action. */
function reasonLabel(reason: UndecodedReason): string {
  switch (reason) {
    case 'program-id-missing':
      return 'no program id';
    case 'program-not-supported':
      return 'program not decoded by this layer';
    case 'instruction-not-in-scope':
      return 'recognized instruction, outside the Milestone 2 target set';
    case 'unknown-instruction-tag':
      return 'discriminator is not a known instruction of that program';
    case 'malformed-instruction-data':
      return 'malformed or truncated instruction data';
    case 'no-decoding-evidence':
      return 'no raw data and no RPC parse';
  }
}

/** One-line summary of an undecoded instruction: ref + what it was, factually. */
function describeUndecoded(entry: UndecodedInstruction): string {
  const program = entry.programId ?? '(no program id)';
  const rpcLabel = entry.parsedType === null ? '' : `  rpc-parsed-as=${entry.parsedType}`;
  const name = entry.programName === null ? '' : ` [${entry.programName}]`;
  return `${refLabel(entry.ref)} ${program}${name}${rpcLabel}`;
}

/**
 * Builds the ACTIONS section.
 *
 * `maxUndecodedPerReason` keeps the section concise; the model always holds the
 * complete list, and `--json` prints all of it.
 */
export function renderActionSection(
  decoded: DecodedTransaction,
  options: ActionRenderOptions = {},
): string[] {
  const maxPerReason = options.maxUndecodedPerReason ?? 3;
  const abbreviateAddresses = options.abbreviateAddresses ?? true;
  const show = (value: string | null): string =>
    value === null ? UNKNOWN : abbreviateAddresses ? abbreviate(value) : value;
  const lines: string[] = [];

  const decodedCount = decoded.actions.length;
  const undecodedCount = decoded.undecoded.length;
  lines.push(
    `ACTIONS (${decodedCount} decoded, ${undecodedCount} not decoded, from ` +
      `${decoded.instructionCount} instruction(s))`,
  );

  if (decodedCount === 0) {
    lines.push('  (no instructions in the Milestone 2 target set were found)');
  }

  decoded.actions.forEach(action => {
    // `refLabel` ties every action back to its line in the INSTRUCTIONS section.
    lines.push(
      `  ${padEnd(refLabel(action.ref), REF_WIDTH)}${padEnd(action.kind, 34)}` +
        `${describeActionWith(action, show)}  [${action.evidence === 'instruction-data' ? 'bytes' : 'rpc-parsed'}]`,
    );
  });

  if (undecodedCount > 0) {
    lines.push('');
    lines.push(`  not decoded (${undecodedCount}); unknown programs stay unknown:`);

    // Group by reason, preserving first-appearance order for determinism.
    const order: UndecodedReason[] = [];
    const groups = new Map<UndecodedReason, UndecodedInstruction[]>();
    for (const entry of decoded.undecoded) {
      const bucket = groups.get(entry.reason);
      if (bucket === undefined) {
        order.push(entry.reason);
        groups.set(entry.reason, [entry]);
      } else {
        bucket.push(entry);
      }
    }

    for (const reason of order) {
      const bucket = groups.get(reason) ?? [];
      const shown = bucket.slice(0, maxPerReason);
      const summary = shown.map(describeUndecoded).join('  •  ');
      const more = bucket.length - shown.length;
      lines.push(
        `    (${bucket.length}) ${reasonLabel(reason)}: ${summary}` +
          (more > 0 ? `  •  (+${more} more)` : ''),
      );
    }
  }

  // Notes raised while decoding real instructions (partial data, multisig, …).
  if (decoded.diagnostics.length > 0) {
    lines.push('');
    lines.push(`  decoding notes (${decoded.diagnostics.length}):`);
    for (const diagnostic of decoded.diagnostics) {
      lines.push(`    ${refLabel(diagnostic.ref)} [${diagnostic.level}] ${diagnostic.code}`);
      lines.push(`        ${diagnostic.message}`);
    }
  }

  lines.push('');
  lines.push('  decoded from instruction data only — never from balance changes.');
  const solTotal = totalSolTransferred(decoded);
  if (solTotal !== null) {
    lines.push(`  decoded system.transfer total: ${solTotal}`);
  }

  return lines;
}

/**
 * Sum of decoded SOL transfers, shown only when there is at least one — so a
 * token-only transaction does not display a confusing "0 SOL".
 */
function totalSolTransferred(decoded: DecodedTransaction): string | null {
  let total = 0n;
  let unknown = 0;
  let count = 0;
  for (const action of decoded.actions) {
    if (action.kind !== 'system.transfer') continue;
    count += 1;
    if (action.lamports === null) unknown += 1;
    else total += action.lamports;
  }
  if (count === 0) return null;
  const suffix = unknown > 0 ? ` (+${unknown} with unknown amount)` : '';
  return `${formatSol(total)} SOL across ${count} transfer(s)${suffix}`;
}
