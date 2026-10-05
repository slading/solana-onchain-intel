/**
 * The two questions the corpus store exists to answer (Milestone 5.1).
 *
 * Both are computed **from stored artifacts** and nothing else: no RPC, no re-derivation, no
 * second implementation of anything. That is deliberate — a query over the store has to be a
 * query over what the store actually holds, so if an artifact is missing or belongs to an
 * older semantics version, the query says so instead of silently using something else.
 *
 * There are exactly two, because M5.1 has two questions that the frozen layers cannot answer
 * from a single transaction: *how much of a corpus's routed activity do the frozen recognizers
 * actually cover* (a corpus-level property), and *what did one account commit or spend across
 * the whole corpus* (also corpus-level, and the place where storage could silently corrupt
 * M3's committed-versus-attempted distinction if it were careless).
 */

import { decodeEvidence } from './codec.ts';
import { isDerivedLayer } from './version.ts';
import type { CorpusStore } from './store.ts';
import type { TransactionEffects, SolFlow, TokenFlow } from '../effects/model.ts';
import type { RouteReport, JupiterRouteEnvelope, RouteLeg } from '../route/model.ts';

/** One row of a corpus-wide answer, in a form the CLI can print. */
export interface RouteLegCoverageRow {
  /** `programId:discriminator`, or `unknown` when the leg could not be identified. */
  readonly key: string;
  readonly programId: string | null;
  readonly discriminator: string | null;
  readonly total: number;
  /** Legs a frozen swap recognizer recognized (`coveredBy`), i.e. coverage *of* the corpus. */
  readonly covered: number;
  readonly uncovered: number;
  /** Protocols that covered at least one of these legs. */
  readonly protocols: readonly string[];
}

export interface RouteLegCoverage {
  /** Route envelopes read from stored artifacts at the current semantics version. */
  readonly routes: number;
  readonly legs: number;
  readonly covered: number;
  readonly uncovered: number;
  /** `covered / legs`, or `null` when there are no legs at all (never `0` by convention). */
  readonly coveredShare: number | null;
  /** Every leg class, most frequent first, then by key for a stable order. */
  readonly classes: readonly RouteLegCoverageRow[];
  /** Signatures whose `routes` artifact is missing or from an older semantics version. */
  readonly withoutCurrentRoutes: readonly string[];
  /** Signatures whose `swaps` artifact is missing (coverage cannot be cross-checked). */
  readonly withoutCurrentSwaps: readonly string[];
}

function legKey(leg: RouteLeg): string {
  if (leg.programId === null) return 'unknown';
  return `${leg.programId}:${leg.discriminator ?? 'unknown'}`;
}

/**
 * How much of the routed activity in this corpus the frozen swap recognizers cover.
 *
 * A leg is *covered* when the route layer recorded a swap recognizer for that same instruction
 * (`coveredBy`), which is the only claim the M4.4 layer makes: that a program was invoked from
 * the route's own CPI subtree. Whether the recognizer proved the leg is a different question,
 * answered by the swap report itself.
 */
export function routeLegCoverage(store: CorpusStore): RouteLegCoverage {
  const routes: JupiterRouteEnvelope[] = [];
  const withoutCurrentRoutes: string[] = [];
  const withoutCurrentSwaps: string[] = [];

  const signatures = store.database.prepare('SELECT signature FROM transactions ORDER BY signature').all();
  for (const row of signatures) {
    const signature = String(row['signature']);
    const layers = store.database
      .prepare('SELECT layer FROM derived WHERE signature = ? AND semantics_version = ?')
      .all(signature, store.semanticsVersion)
      .map(entry => String(entry['layer']))
      .filter(isDerivedLayer);
    if (!layers.includes('routes')) withoutCurrentRoutes.push(signature);
    if (!layers.includes('swaps')) withoutCurrentSwaps.push(signature);
  }

  for (const signature of signatures.map(row => String(row['signature']))) {
    const artifact = loadArtifactFor(store, signature, 'routes');
    if (artifact === null) continue;
    routes.push(...(artifact as RouteReport).envelopes);
  }

  const classes = new Map<string, { programId: string | null; discriminator: string | null; total: number; covered: number; protocols: Set<string> }>();
  let legs = 0;
  let covered = 0;

  for (const envelope of routes) {
    for (const leg of envelope.legs) {
      legs += 1;
      const key = legKey(leg);
      const entry =
        classes.get(key) ??
        { programId: leg.programId, discriminator: leg.discriminator, total: 0, covered: 0, protocols: new Set<string>() };
      entry.total += 1;
      if (leg.coveredBy !== null) {
        covered += 1;
        entry.covered += 1;
        entry.protocols.add(leg.coveredBy.protocol);
      }
      classes.set(key, entry);
    }
  }

  const rows = [...classes.entries()]
    .map(([key, entry]) => ({
      key,
      programId: entry.programId,
      discriminator: entry.discriminator,
      total: entry.total,
      covered: entry.covered,
      uncovered: entry.total - entry.covered,
      protocols: [...entry.protocols].sort(),
    }))
    .sort((left, right) => right.total - left.total || (left.key < right.key ? -1 : 1));

  return {
    routes: routes.length,
    legs,
    covered,
    uncovered: legs - covered,
    coveredShare: legs === 0 ? null : covered / legs,
    classes: rows,
    withoutCurrentRoutes,
    withoutCurrentSwaps,
  };
}

/** Committed movement of one account, summed across the corpus, exact. */
export interface AccountMovement {
  readonly address: string;
  /** Transactions in which the account appears in the account list. */
  readonly transactions: number;
  /** Transactions where no effects artifact is stored at the current semantics version. */
  readonly withoutEffects: readonly string[];
  /** Summed net lamport change, exact. Never includes attempted movement. */
  readonly netLamports: bigint;
  /** Transactions where the net lamport change could not be computed (never guessed at). */
  readonly unknownNetLamports: number;
  /** Fees this account paid as fee payer. A fee commits even when the transaction reverts. */
  readonly committedFeeLamports: bigint;
  /** Net token movement by mint, for accounts this address holds directly. */
  readonly netTokensByMint: readonly AccountMintMovement[];
  /** Net token movement by mint, aggregated over accounts this address owns. */
  readonly netTokensByOwnedAccounts: readonly { readonly mint: string | null; readonly netAmount: bigint }[];
  /** Exact committed lamport flows this account is a named end of. */
  readonly committedSolFlows: readonly CommittedFlowSummary[];
  /**
   * Transactions that actually contribute to the totals — committed movement or a fee.
   *
   * This is narrower than `transactions` on purpose: an account that appears in the account
   * list but committed nothing (the recipient of a reverted transfer, an account that was only
   * touched by instructions that rolled back) is *involved* without contributing.
   */
  readonly signatures: readonly string[];
  /** Statement of what was *not* counted, so a reader never has to assume. */
  readonly exclusions: readonly string[];
}

export interface AccountMintMovement {
  readonly mint: string | null;
  readonly netAmount: bigint;
  /** How many of the account's token accounts hold this mint. */
  readonly accounts: number;
}

export interface CommittedFlowSummary {
  readonly signature: string;
  readonly kind: SolFlow['kind'] | TokenFlow['kind'];
  readonly amount: bigint | null;
  readonly mint: string | null;
  readonly counterparty: string | null;
}

const EXCLUSIONS = [
  'instructions that did not commit (a reverted transaction contributes its fee and nothing else)',
  'movement sized by balance reconciliation rather than by an instruction',
  'anything the effects layer reported as unattributed',
] as const;

/**
 * The committed movement of one account, across every stored transaction it appears in.
 *
 * Only committed collections are read — `solFlows`, `tokenFlows`, `netSolByAccount`,
 * `netTokenByAccountMint`, `netTokenByOwnedAccounts` — never the `uncommitted*` ones, so a
 * failed transaction can contribute its fee (which does commit) and nothing else. Amounts that
 * the effects layer could not compute stay `null` and are *counted*, never treated as zero.
 *
 * Sums are added up in JavaScript with `bigint` arithmetic: SQLite's `SUM()` over the TEXT
 * amount columns would coerce them to REAL and lose exactly the precision this store exists to
 * keep.
 */
export function committedMovementByAccount(store: CorpusStore, address: string): AccountMovement {
  let transactions = 0;
  let netLamports = 0n;
  let unknownNetLamports = 0;
  let committedFeeLamports = 0n;
  const byMint = new Map<string | null, { netAmount: bigint; accounts: number }>();
  const byOwnerMint = new Map<string | null, bigint>();
  const flows: CommittedFlowSummary[] = [];
  const signatures: string[] = [];
  const withoutEffects: string[] = [];

  const rows = store.database
    .prepare('SELECT signature FROM transactions ORDER BY signature')
    .all()
    .map(row => String(row['signature']));

  for (const signature of rows) {
    const effects = loadArtifactFor(store, signature, 'effects') as TransactionEffects | null;
    if (effects === null) {
      withoutEffects.push(signature);
      continue;
    }

    const net = effects.netSolByAccount.find(entry => entry.address === address);
    const tokens = effects.netTokenByAccountMint.filter(entry => entry.tokenAccount === address);
    const owned = effects.netTokenByOwnerMint.filter(entry => entry.owner === address);
    const solFlows = effects.solFlows.filter(
      flow => flow.from === address || flow.to === address || (flow.kind === 'fee' && flow.from === address),
    );
    const tokenFlows = effects.tokenFlows.filter(
      flow =>
        flow.sourceOwner === address ||
        flow.destinationOwner === address ||
        flow.sourceTokenAccount === address ||
        flow.destinationTokenAccount === address,
    );

    if (net === undefined && tokens.length === 0 && owned.length === 0 && solFlows.length === 0 && tokenFlows.length === 0) {
      continue;
    }

    if (net !== undefined || tokens.length > 0) transactions += 1;

    const contributes =
      (net?.netLamports ?? 0n) !== 0n ||
      solFlows.length > 0 ||
      tokenFlows.length > 0 ||
      tokens.some(entry => (entry.netAmount ?? 0n) !== 0n) ||
      owned.some(entry => (entry.netAmount ?? 0n) !== 0n);
    if (contributes) signatures.push(signature);

    if (net !== undefined) {
      if (net.netLamports === null) unknownNetLamports += 1;
      else netLamports += net.netLamports;
    }
    for (const flow of solFlows) {
      if (flow.kind === 'fee' && flow.from === address) committedFeeLamports += flow.lamports ?? 0n;
      flows.push({
        signature,
        kind: flow.kind,
        amount: flow.lamports,
        mint: null,
        counterparty: flow.from === address ? flow.to : flow.from,
      });
    }
    for (const flow of tokenFlows) {
      flows.push({
        signature,
        kind: flow.kind,
        amount: flow.amount,
        mint: flow.mint,
        counterparty:
          flow.destinationOwner === address || flow.destinationTokenAccount === address
            ? (flow.sourceOwner ?? flow.sourceTokenAccount)
            : (flow.destinationOwner ?? flow.destinationTokenAccount),
      });
    }
    for (const token of tokens) {
      const entry = byMint.get(token.mint) ?? { netAmount: 0n, accounts: 0 };
      entry.netAmount += token.netAmount ?? 0n;
      entry.accounts += 1;
      byMint.set(token.mint, entry);
    }
    for (const token of owned) {
      byOwnerMint.set(token.mint, (byOwnerMint.get(token.mint) ?? 0n) + (token.netAmount ?? 0n));
    }
  }

  return {
    address,
    transactions,
    withoutEffects,
    netLamports,
    unknownNetLamports,
    committedFeeLamports,
    netTokensByMint: [...byMint.entries()]
      .map(([mint, entry]) => ({ mint, netAmount: entry.netAmount, accounts: entry.accounts }))
      .sort((left, right) => (String(left.mint) < String(right.mint) ? -1 : 1)),
    netTokensByOwnedAccounts: [...byOwnerMint.entries()]
      .map(([mint, netAmount]) => ({ mint, netAmount }))
      .sort((left, right) => (String(left.mint) < String(right.mint) ? -1 : 1)),
    committedSolFlows: flows,
    signatures,
    exclusions: EXCLUSIONS,
  };
}

/**
 * Reads one stored artifact, decoded, at the *current* semantics version.
 *
 * An artifact from an older version is not returned: a query answers with what the current
 * engine produced, or reports the gap (`withoutCurrentRoutes`, `withoutEffects`).
 */
function loadArtifactFor(store: CorpusStore, signature: string, layer: string): unknown {
  const row = store.database
    .prepare('SELECT artifact_text FROM derived WHERE signature = ? AND layer = ? AND semantics_version = ?')
    .get(signature, layer, store.semanticsVersion);
  if (row === undefined) return null;
  // Decoded with the same codec the store writes with, so bigints come back as bigints.
  return decodeEvidence(String(row['artifact_text']));
}
