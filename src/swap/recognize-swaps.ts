/**
 * The swap layer's entry point: run every implemented protocol recognizer over one
 * transaction and report the legs together, in execution order.
 *
 * There is deliberately no registry and no plugin list — `scannedProtocols` is a
 * literal, and each protocol's recognition code is a plain function call below.
 * Adding a protocol means adding a recognizer and a line, with its own tests.
 *
 * Diagnostics are merged deterministically:
 *
 *   * leg-level notes (those with a `ref`) are kept as-is, in execution order;
 *   * transaction-level notes (those with `ref === null`) are deduplicated by
 *     code, keeping the first — the recognizers describe the same two conditions
 *     (no recorded CPIs, no effects model), and saying it twice would be noise.
 *
 * The 4.1 API (`recognizeDlmmSwaps`) is untouched and still returns the
 * DLMM-only `TransactionSwaps`, so nothing that already consumed it changes.
 */

import type { InstructionRef } from '../decode/actions.ts';
import type { TransactionEffects } from '../effects/model.ts';
import type { SwapDiagnostic, SwapLeg, SwapProtocol, SwapReport } from './model.ts';
import { recognizeDlmmSwaps } from './recognize.ts';
import { recognizePumpSells } from './pump-recognize.ts';

/** Every protocol this build can recognize, in a fixed order. */
const SCANNED_PROTOCOLS: readonly SwapProtocol[] = ['meteora-dlmm', 'pump-amm'];

export interface RecognizeSwapsOptions {
  /** The Milestone 3 effects model for the same transaction (see 4.1/4.2 notes). */
  readonly effects?: TransactionEffects | null;
}

/** Execution order within the canonical model: top-level first, then inner groups. */
function orderKey(ref: InstructionRef): readonly [number, number, number] {
  return [ref.path === 'top-level' ? 0 : 1, ref.outerIndex ?? -1, ref.index];
}

function compareRefs(left: InstructionRef, right: InstructionRef): number {
  const a = orderKey(left);
  const b = orderKey(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function recognizeSwaps(
  transaction: Parameters<typeof recognizeDlmmSwaps>[0],
  options: RecognizeSwapsOptions = {},
): SwapReport {
  const effects = options.effects ?? null;

  const dlmm = recognizeDlmmSwaps(transaction, { effects });
  const pump = recognizePumpSells(transaction, { effects });

  const legs: SwapLeg[] = [...dlmm.legs, ...pump.legs].sort((left, right) =>
    compareRefs(left.ref, right.ref),
  );

  const diagnostics: SwapDiagnostic[] = [];
  const seenTransactionCodes = new Set<string>();
  for (const note of [...dlmm.diagnostics, ...pump.diagnostics]) {
    if (note.ref === null) {
      if (seenTransactionCodes.has(note.code)) continue;
      seenTransactionCodes.add(note.code);
    }
    diagnostics.push(note);
  }

  return {
    scannedProtocols: SCANNED_PROTOCOLS,
    legs,
    diagnostics,
    counts: {
      recognized: legs.length,
      proven: legs.filter(leg => leg.state === 'proven').length,
      partiallyProven: legs.filter(leg => leg.state === 'partially-proven').length,
      notCommitted: legs.filter(leg => leg.state === 'not-committed').length,
      conflicting: legs.filter(leg => leg.state === 'conflicting').length,
    },
  };
}
