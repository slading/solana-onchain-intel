/**
 * Helpers for the Milestone 4.4 route tests.
 *
 * Same approach as the other helpers: the real fixtures are the primary vectors,
 * and transactions are patched in *memory* (never on disk) for the cases mainnet
 * samples do not contain — a tampered plan, a missing leg, a variant the deployed
 * program uses but no ABI names. Payloads are built from the accepted layout rather
 * than harvested, so a byte-offset mistake shows up as a failing assertion.
 */
import { normalizeFixture } from './fixtures.ts';
import { base58, u64leBytes } from './swaps.ts';
import { transactionEffects } from '../../src/effects/build.ts';
import { recognizeSwaps } from '../../src/swap/recognize-swaps.ts';
import { recognizeRoutes } from '../../src/route/recognize-routes.ts';
import { JUPITER_ROUTE_V2_DISCRIMINATOR } from '../../src/route/jupiter.ts';
import type { JupiterRouteEnvelope, RouteCheck, RouteReport } from '../../src/route/model.ts';
import type { NormalizedTransaction } from '../../src/model/transaction.ts';
import type { SwapReport } from '../../src/swap/model.ts';

export const JUP6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

export interface RouteFixture {
  readonly transaction: NormalizedTransaction;
  readonly effects: ReturnType<typeof transactionEffects>;
  readonly swaps: SwapReport;
  readonly routes: RouteReport;
}

/** One real fixture, normalized, with the effects, swap and route layers applied. */
export function routeFixture(name: string): RouteFixture {
  const { transaction } = normalizeFixture(name);
  const effects = transactionEffects(transaction);
  const swaps = recognizeSwaps(transaction, { effects });
  return { transaction, effects, swaps, routes: recognizeRoutes(transaction, { swaps }) };
}

/** The single recognized envelope, failing loudly when the count is not one. */
export function onlyEnvelope(routes: RouteReport): JupiterRouteEnvelope {
  if (routes.envelopes.length !== 1) {
    throw new Error(`expected exactly one route envelope, found ${routes.envelopes.length}`);
  }
  return routes.envelopes[0] as JupiterRouteEnvelope;
}

/** The envelope at `[outerIndex.index]` (`outerIndex` null = top-level). */
export function envelopeAt(
  routes: RouteReport,
  outerIndex: number | null,
  index: number,
): JupiterRouteEnvelope {
  const found = routes.envelopes.find(envelope =>
    outerIndex === null
      ? envelope.ref.path === 'top-level' && envelope.ref.index === index
      : envelope.ref.path === 'inner' && envelope.ref.outerIndex === outerIndex && envelope.ref.index === index,
  );
  if (found === undefined) {
    throw new Error(
      `no route envelope at ${outerIndex === null ? `[${index}]` : `[${outerIndex}.${index}]`}; ` +
        `recognized: ${routes.envelopes
          .map(entry =>
            entry.ref.path === 'top-level' ? `[${entry.ref.index}]` : `[${entry.ref.outerIndex}.${entry.ref.index}]`,
          )
          .join(', ')}`,
    );
  }
  return found;
}

export function routeCheck(envelope: JupiterRouteEnvelope, id: string): RouteCheck {
  const found = envelope.checks.find(entry => entry.id === id);
  if (found === undefined) throw new Error(`route envelope has no check "${id}"`);
  return found;
}

export function routeOutcome(envelope: JupiterRouteEnvelope, id: string): RouteCheck['outcome'] {
  return routeCheck(envelope, id).outcome;
}

/* ------------------------------------------------------------- payload building */

/** One `RoutePlanStepV2` as raw bytes: tag, the variant's own field bytes, bps, indices. */
export function planStep(
  tag: number,
  variantFields: readonly number[],
  bps: number,
  inputIndex: number,
  outputIndex: number,
): number[] {
  return [tag, ...variantFields, bps & 0xff, (bps >> 8) & 0xff, inputIndex, outputIndex];
}

/** `RemainingAccountsInfo` bytes: a u32 slice count, then two bytes per slice. */
export function remainingAccountsInfo(slices: readonly (readonly [number, number])[] = []): number[] {
  return [
    slices.length & 0xff,
    (slices.length >> 8) & 0xff,
    (slices.length >> 16) & 0xff,
    (slices.length >> 24) & 0xff,
    ...slices.flatMap(([accountsType, length]) => [accountsType, length]),
  ];
}

export interface RouteV2DataOptions {
  readonly declaredInAmount: bigint;
  readonly quotedOutAmount: bigint;
  readonly slippageBps: number;
  readonly platformFeeBps?: number;
  readonly positiveSlippageBps?: number;
  /** Overrides the length prefix, for the "declared count disagrees with bytes" cases. */
  readonly stepCountOverride?: number;
  readonly steps: readonly (readonly number[])[];
  /** Extra bytes after the plan, for the trailing-byte cases. */
  readonly trailingBytes?: readonly number[];
}

/** A `route_v2` payload rebuilt from the accepted layout: disc | header | plan. */
export function routeV2Data(options: RouteV2DataOptions): string {
  const discriminator = JUPITER_ROUTE_V2_DISCRIMINATOR.match(/../g) ?? [];
  const count = options.stepCountOverride ?? options.steps.length;
  const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
  const u32 = (value: number): number[] => [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ];
  return base58([
    ...discriminator.map(byte => Number.parseInt(byte, 16)),
    ...u64leBytes(options.declaredInAmount),
    ...u64leBytes(options.quotedOutAmount),
    ...u16(options.slippageBps),
    ...u16(options.platformFeeBps ?? 0),
    ...u16(options.positiveSlippageBps ?? 0),
    ...u32(count),
    ...options.steps.flatMap(step => [...step]),
    ...(options.trailingBytes ?? []),
  ]);
}
