import { renderActionSection } from './actions.ts';
import { renderEffectsSection } from './effects.ts';
import { renderSwapSection } from './swaps.ts';
import { renderRouteSection } from './routes.ts';
import {
  formatLamportsWithSol,
  formatSigned,
  formatSol,
  formatUnixSeconds,
  padEnd,
  stringifyJson,
} from '../lib/format.ts';
import type {
  NormalizedInstruction,
  NormalizedTransaction,
  NormalizedTransactionVersion,
} from '../model/transaction.ts';
import type { TransactionEffects } from '../effects/model.ts';
import type { SwapReport } from '../swap/model.ts';
import type { RouteReport } from '../route/model.ts';

/**
 * Renders the deterministic, human-readable summary.
 *
 * Determinism rules: no timestamps of "now", no colours, no locale-dependent
 * formatting, no environment lookups, fixed field order, and every collection
 * rendered in the order the model defines. The same transaction always renders
 * byte-identically.
 *
 * Long lists are elided for readability only (`MAX_LISTED_ADDRESSES`); the full
 * values are always available via `--json`.
 *
 * Sections appear in a fixed order: header, INSTRUCTIONS, ACTIONS, SWAPS, ROUTES,
 * EFFECTS, SOL BALANCE CHANGES, TOKEN BALANCE CHANGES, LOGS, DIAGNOSTICS. SWAPS
 * (Milestone 4.1) and ROUTES (Milestone 4.4) are present only when their model is
 * supplied, so a caller that omits them renders exactly what it rendered before.
 */
const MAX_LISTED_ADDRESSES = 4;
const LABEL_WIDTH = 13;
/** Display-only limits; every value stays complete in the model and in `--json`. */
const MAX_INLINE_DATA = 88;
const MAX_INLINE_INFO = 300;

function elide(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (truncated)`;
}

export interface RenderOptions {
  readonly includeLogs: boolean;
  /** ACTIONS section (Milestone 2). Defaults to on when omitted. */
  readonly includeActions?: boolean;
  readonly onlyActions?: boolean;
  /** Print exact addresses in ACTIONS/EFFECTS instead of the readable abbreviation. */
  readonly fullAddresses?: boolean;
  /**
   * The Milestone 3 effects model to render. The section appears exactly when an
   * effects model is supplied — the renderer never computes one itself, so the
   * text output and the model can never disagree about what was reconciled.
   */
  readonly effects?: TransactionEffects | null;
  /** Print only the EFFECTS section (the CLI's `--effects`). */
  readonly onlyEffects?: boolean;
  /**
   * The swap model to render: the 4.1 DLMM-only model, or the aggregate report of
   * Milestones 4.1 + 4.2. As with `effects`, the renderer never computes it itself,
   * and the section appears exactly when a model is supplied — so `--no-swaps`
   * reproduces the previous output byte-for-byte.
   */
  readonly swaps?: SwapReport | null;
  /** Print only the SWAPS section (the CLI's `--swaps`). */
  readonly onlySwaps?: boolean;
  /**
   * The route model to render (Milestone 4.4): Jupiter `route_v2` envelopes. As
   * with `effects` and `swaps`, the renderer never computes it itself, and the
   * section appears exactly when a model is supplied — so `--no-routes` reproduces
   * the previous output byte-for-byte.
   */
  readonly routes?: RouteReport | null;
  /** Print only the ROUTES section (the CLI's `--routes`). */
  readonly onlyRoutes?: boolean;
}

function field(label: string, value: string): string {
  return `  ${padEnd(label, LABEL_WIDTH)}${value}`;
}

function renderVersion(version: NormalizedTransactionVersion): string {
  switch (version.kind) {
    case 'legacy':
      return 'legacy';
    case 'numbered':
      return `v${version.value}`;
    case 'unknown':
      return 'unknown (RPC omitted it)';
  }
}

function renderAddressList(addresses: readonly string[]): string {
  if (addresses.length === 0) return '(none)';
  if (addresses.length <= MAX_LISTED_ADDRESSES * 2) return addresses.join(', ');
  const head = addresses.slice(0, MAX_LISTED_ADDRESSES).join(', ');
  return `${head}, … (+${addresses.length - MAX_LISTED_ADDRESSES} more)`;
}

function renderInstruction(instruction: NormalizedInstruction, prefix: string, indent: string): string[] {
  const lines: string[] = [];
  const programLabel = instruction.programId ?? '(program id unknown)';
  const nameSuffix = instruction.programName === null ? '' : ` [${instruction.programName}]`;
  lines.push(`${indent}${prefix} ${programLabel}${nameSuffix}`);

  const detailIndent = `${indent}    `;
  if (instruction.decoding === 'rpc-parsed') {
    lines.push(`${detailIndent}type   ${instruction.parsedType ?? '(none reported)'} (parsed by RPC)`);
    if (instruction.parsedInfo !== null) {
      // `parsedInfo` is verbatim from the response, so it may hold bigints (kit upcasts
      // integers). Serialize with the bigint-safe helper rather than JSON.stringify.
      lines.push(`${detailIndent}info   ${elide(stringifyJson(instruction.parsedInfo, 0), MAX_INLINE_INFO)}`);
    }
  } else {
    // The important case: we do not know what this instruction does, and we say so.
    lines.push(
      `${detailIndent}type   UNKNOWN — the RPC did not decode this instruction; ` +
        `meaning is not inferred`,
    );
    if (instruction.data !== null) {
      // Undecoded data is an opaque base58 blob; show a prefix and keep the rest for --json.
      lines.push(`${detailIndent}data   ${elide(instruction.data, MAX_INLINE_DATA)} (base58, raw)`);
    }
    if (instruction.accounts !== null) {
      lines.push(
        `${detailIndent}accts  (${instruction.accounts.length}) ${renderAddressList(instruction.accounts)}`,
      );
    }
  }
  if (instruction.stackHeight !== null) {
    lines.push(`${detailIndent}depth  ${instruction.stackHeight}`);
  }
  return lines;
}

export function renderSummary(
  transaction: NormalizedTransaction,
  options: RenderOptions,
): string {
  const lines: string[] = [];

  // `--actions` prints just the semantic layer: the fastest way to see what a
  // transaction *does* without reading nine balances sections.
  if (options.onlyActions === true) {
    lines.push('');
    lines.push(`TRANSACTION ${transaction.signature === '' ? '(no signature)' : transaction.signature}`);
    lines.push('');
    lines.push(...renderActionSection(transaction.decoded, { abbreviateAddresses: options.fullAddresses !== true }));
    return lines.join('\n');
  }

  if (options.onlySwaps === true) {
    lines.push('');
    lines.push(`TRANSACTION ${transaction.signature === '' ? '(no signature)' : transaction.signature}`);
    if (options.swaps !== undefined && options.swaps !== null) {
      lines.push('');
      lines.push(
        ...renderSwapSection(options.swaps, { abbreviateAddresses: options.fullAddresses !== true }),
      );
    } else {
      lines.push('');
      lines.push('SWAPS (not computed)');
    }
    return lines.join('\n');
  }

  if (options.onlyRoutes === true) {
    lines.push('');
    lines.push(`TRANSACTION ${transaction.signature === '' ? '(no signature)' : transaction.signature}`);
    if (options.routes !== undefined && options.routes !== null) {
      lines.push('');
      lines.push(
        ...renderRouteSection(options.routes, { abbreviateAddresses: options.fullAddresses !== true }),
      );
    } else {
      lines.push('');
      lines.push('ROUTES (not computed)');
    }
    return lines.join('\n');
  }

  if (options.onlyEffects === true) {
    lines.push('');
    lines.push(`TRANSACTION ${transaction.signature === '' ? '(no signature)' : transaction.signature}`);
    if (options.effects !== undefined && options.effects !== null) {
      lines.push('');
      lines.push(
        ...renderEffectsSection(options.effects, { abbreviateAddresses: options.fullAddresses !== true }),
      );
    } else {
      lines.push('');
      lines.push('EFFECTS (not computed)');
    }
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`TRANSACTION ${transaction.signature === '' ? '(no signature)' : transaction.signature}`);
  lines.push('');
  lines.push(field('Slot', transaction.slot.toString()));
  const iso = formatUnixSeconds(transaction.blockTimeUnix);
  lines.push(
    field(
      'Block time',
      iso === null
        ? 'unknown'
        : `${iso} (unix ${transaction.blockTimeUnix})`,
    ),
  );
  lines.push(field('Version', renderVersion(transaction.version)));
  lines.push(
    field(
      'Status',
      transaction.status === 'failed'
        ? `FAILED — ${stringifyJson(transaction.error, 0)}`
        : transaction.status.toUpperCase(),
    ),
  );
  lines.push(
    field('Fee', transaction.feeLamports === null ? 'unknown' : formatLamportsWithSol(transaction.feeLamports)),
  );
  lines.push(
    field(
      'Compute',
      transaction.computeUnitsConsumed === null
        ? 'unknown'
        : `${transaction.computeUnitsConsumed} CU consumed` +
            (transaction.costUnits === null ? '' : ` (cost units ${transaction.costUnits})`),
    ),
  );
  lines.push(field('Signatures', `${transaction.signatures.length}`));
  lines.push(field('Fee payer', transaction.feePayerAddress ?? 'unknown'));
  lines.push(
    field(
      'Signers',
      transaction.signers === null
        ? 'unknown (RPC omitted signer flags)'
        : renderAddressList(transaction.signers),
    ),
  );
  lines.push(field('Recent bh', transaction.recentBlockhash ?? 'unknown'));

  const lookupCount = transaction.accounts.filter(a => a.source === 'lookupTable').length;
  lines.push(
    field(
      'Accounts',
      `${transaction.accounts.length} (${lookupCount} resolved from address lookup tables)`,
    ),
  );
  if (transaction.transactionConfig !== null) {
    lines.push(field('Msg limits', stringifyJson(transaction.transactionConfig, 0)));
  }

  // ---------------------------------------------------------------- instructions
  const innerCount = transaction.innerInstructionGroups.reduce(
    (total, group) => total + group.instructions.length,
    0,
  );
  lines.push('');
  lines.push(
    `INSTRUCTIONS (${transaction.instructions.length} top-level, ${innerCount} inner` +
      `${transaction.innerInstructionsAvailable ? '' : ' — inner instructions NOT RECORDED by this node'})`,
  );
  if (transaction.instructions.length === 0) {
    lines.push('  (none)');
  }

  const groupsByOuter = new Map(
    transaction.innerInstructionGroups.map(group => [group.outerIndex, group]),
  );

  transaction.instructions.forEach(instruction => {
    lines.push(...renderInstruction(instruction, `[${instruction.index}]`, '  '));
    const group = groupsByOuter.get(instruction.index);
    if (group === undefined) return;
    group.instructions.forEach(inner => {
      lines.push(...renderInstruction(inner, `[${instruction.index}.${inner.index}]`, '      '));
    });
  });

  // Unmatched inner groups (RPC reported an outer index we cannot resolve) are
  // still printed, because dropping them would hide real data.
  transaction.innerInstructionGroups
    .filter(group => !transaction.instructions.some(i => i.index === group.outerIndex))
    .forEach(group => {
      lines.push(
        `  [outer ${group.outerIndex}] (no matching top-level instruction; shown as reported)`,
      );
      group.instructions.forEach(inner => {
        lines.push(...renderInstruction(inner, `[${group.outerIndex}.${inner.index}]`, '      '));
      });
    });

  // ------------------------------------------------------------------- actions
  if (options.includeActions !== false) {
    lines.push('');
    lines.push(
      ...renderActionSection(transaction.decoded, {
        abbreviateAddresses: options.fullAddresses !== true,
      }),
    );
  }

  // -------------------------------------------------------------------- swaps
  if (options.swaps !== undefined && options.swaps !== null) {
    lines.push('');
    lines.push(
      ...renderSwapSection(options.swaps, {
        abbreviateAddresses: options.fullAddresses !== true,
      }),
    );
  }

  // -------------------------------------------------------------------- routes
  if (options.routes !== undefined && options.routes !== null) {
    lines.push('');
    lines.push(
      ...renderRouteSection(options.routes, {
        abbreviateAddresses: options.fullAddresses !== true,
      }),
    );
  }

  // ------------------------------------------------------------------- effects
  if (options.effects !== undefined && options.effects !== null) {
    lines.push('');
    lines.push(
      ...renderEffectsSection(options.effects, {
        abbreviateAddresses: options.fullAddresses !== true,
      }),
    );
  }

  // ------------------------------------------------------------- SOL balance changes
  lines.push('');
  lines.push('SOL BALANCE CHANGES (including the fee; unchanged accounts omitted)');
  const solChanges = transaction.solBalanceChanges.filter(
    change => change.deltaLamports !== null && change.deltaLamports !== 0n,
  );
  if (solChanges.length === 0) {
    lines.push(
      `  (none across ${transaction.solBalanceChanges.length} account(s))`,
    );
  }
  solChanges.forEach(change => {
    const address = change.address ?? `account #${change.accountIndex} (address unknown)`;
    const before = change.beforeLamports ?? 0n;
    const after = change.afterLamports ?? 0n;
    lines.push(
      `  ${address}  ${formatSol(before)} -> ${formatSol(after)} SOL  ` +
        `(${formatSigned(change.deltaLamports ?? 0n)} lamports)`,
    );
  });

  // ----------------------------------------------------------- token balance changes
  lines.push('');
  lines.push('TOKEN BALANCE CHANGES');
  if (!transaction.tokenBalancesAvailable) {
    lines.push('  unknown — this node did not report token balances');
  } else if (transaction.tokenBalanceChanges.length === 0) {
    lines.push('  (none)');
  }

  transaction.tokenBalanceChanges.forEach(change => {
    const address = change.address ?? `account #${change.accountIndex} (address unknown)`;
    lines.push(
      `  [${change.accountIndex}] ${address}  mint=${change.mint ?? 'unknown'}  ` +
        `program=${change.programId ?? 'unknown'}`,
    );
    if (change.owner !== null) lines.push(`      owner  ${change.owner}`);
    if (change.decimals !== null && change.decimals !== undefined) {
      lines.push(`      decimals ${change.decimals}`);
    }
    lines.push(
      `      before ${change.beforeAmount === null ? 'not reported' : change.beforeAmount.toString()}` +
        ` (ui ${change.beforeUiAmountString ?? 'unknown'})`,
    );
    lines.push(
      `      after  ${change.afterAmount === null ? 'not reported' : change.afterAmount.toString()}` +
        ` (ui ${change.afterUiAmountString ?? 'unknown'})`,
    );
    lines.push(
      `      delta  ${change.deltaAmount === null ? 'not computable' : formatSigned(change.deltaAmount)} raw units` +
        ` (${change.presence === 'both' ? 'pre and post reported' : change.presence === 'only-after' ? 'created in this transaction' : 'closed in this transaction'})`,
    );
  });

  // ------------------------------------------------------------------------- logs
  if (options.includeLogs) {
    lines.push('');
    lines.push('LOGS');
    if (transaction.logs === null) {
      lines.push('  unknown — the RPC did not report logs for this transaction');
    } else if (transaction.logs.length === 0) {
      lines.push('  (the program logged nothing)');
    } else {
      transaction.logs.forEach((log, index) => {
        lines.push(`  ${padEnd(String(index), 4)}${log}`);
      });
    }
  }

  // ------------------------------------------------------------------ diagnostics
  if (transaction.diagnostics.length > 0) {
    lines.push('');
    lines.push('DIAGNOSTICS');
    transaction.diagnostics.forEach(diagnostic => {
      lines.push(`  [${diagnostic.level}] ${diagnostic.code}`);
      lines.push(`      ${diagnostic.message}`);
    });
  }

  lines.push('');
  return lines.join('\n');
}
