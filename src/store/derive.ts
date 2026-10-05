/**
 * The derivation composition the store persists (Milestone 5.1).
 *
 * One function, and it is deliberately the *same call sequence the CLI already uses*
 * (`src/cli/inspect.ts`): normalize -> effects -> swaps -> routes. The store does not own
 * a second way of deriving anything, so a stored artifact and a freshly printed summary
 * cannot disagree.
 *
 * `normalized` is stored **without** its embedded `raw` payload. The raw response is the
 * authoritative evidence and lives exactly once, in `raw_responses`; keeping a second copy
 * inside a derived artifact would be two sources of truth for one payload. Loading a
 * stored transaction re-attaches it (see `rehydrateNormalized`), which makes the
 * rehydrated model object-identical to the one the live pipeline produced.
 */

import { normalizeTransaction } from '../normalize/transaction.ts';
import { transactionEffects } from '../effects/build.ts';
import { recognizeSwaps } from '../swap/recognize-swaps.ts';
import { recognizeRoutes } from '../route/recognize-routes.ts';
import type { NormalizedProvenance, NormalizedTransaction } from '../model/transaction.ts';
import type { TransactionEffects } from '../effects/model.ts';
import type { SwapReport } from '../swap/model.ts';
import type { RouteReport } from '../route/model.ts';

/** The normalized model as stored: everything except the embedded raw response. */
export type StoredNormalizedTransaction = Omit<NormalizedTransaction, 'raw'>;

/** The four artifacts stored per (signature, semantics version). */
export interface DerivedArtifacts {
  readonly normalized: StoredNormalizedTransaction;
  readonly effects: TransactionEffects;
  readonly swaps: SwapReport;
  readonly routes: RouteReport;
}

/** Drops the embedded raw payload. Mirrors the CLI's own `stripRaw`, kept local on purpose. */
export function withoutRaw(transaction: NormalizedTransaction): StoredNormalizedTransaction {
  const { raw: _raw, ...rest } = transaction;
  return rest;
}

/**
 * Re-attaches the authoritative raw payload to a stored normalized model.
 *
 * `raw` is appended last, which is where `normalizeTransaction` puts it, so the result is
 * byte-identical (under `stringifyJson`) to the model the pipeline built.
 */
export function rehydrateNormalized(
  stored: StoredNormalizedTransaction,
  raw: unknown,
): NormalizedTransaction {
  return { ...stored, raw };
}

/** Derives the four artifacts from an already normalized transaction. */
export function deriveArtifacts(transaction: NormalizedTransaction): DerivedArtifacts {
  const effects = transactionEffects(transaction);
  const swaps = recognizeSwaps(transaction, { effects });
  const routes = recognizeRoutes(transaction, { swaps });
  return { normalized: withoutRaw(transaction), effects, swaps, routes };
}

/** Normalizes raw evidence and derives everything from it, in one step. */
export function normalizeAndDerive(
  raw: unknown,
  provenance: NormalizedProvenance,
): { readonly transaction: NormalizedTransaction; readonly artifacts: DerivedArtifacts } {
  const transaction = normalizeTransaction(raw, { provenance });
  return { transaction, artifacts: deriveArtifacts(transaction) };
}
