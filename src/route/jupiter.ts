/**
 * The authoritative Jupiter Aggregator v6 `route_v2` surface this layer is built
 * from.
 *
 * Sources, and what each one is allowed to prove:
 *
 *   * **program id / discriminator** — the instruction's own bytes. The
 *     discriminator `bb64facc31c4af14` re-derives as `sha256("global:route_v2")[..8]`,
 *     the same Anchor convention the Milestone 4.1–4.3 recognizers rely on.
 *   * **header layout** — the community Codama ABI description of
 *     `RouteV2InstructionArgs`, accepted here only because it consumes the
 *     payloads of real transactions *exactly* (no trailing byte, no short read) in
 *     every one of the 33 `route_v2` transactions the Milestone 4.4 discovery
 *     examined, and because the header's `slippage_bps`/`quoted_out_amount`
 *     arithmetic is what JUP6 itself enforces (`Custom 6001`).
 *   * **plan element size** — *not* derivable from a fixed layout. `RoutePlanStepV2`
 *     is `{ swap: SwapType, bps: u16, input_index: u8, output_index: u8 }` and
 *     `SwapType` carries per-variant fields, so the element width depends on the
 *     variant. `ROUTE_PLAN_VARIANTS` below lists only the tags whose width is
 *     backed by evidence: observed on chain and consistent with the vendor ABI
 *     (`vendor-abi`), or solved from real payload bytes alone (`observed-bytes`,
 *     names deliberately left `null`). A tag outside the table is not guessed at:
 *     the plan decode stops there and says so.
 *   * **account roles** — the vendor ABI's `routeV2` account list, whose first ten
 *     entries match the real payloads slot for slot. Everything beyond slot 9 is
 *     opaque and is only counted.
 *
 * The deployed program is **newer than any public ABI**: tags 178, 181 and 187 were
 * executed on chain (measured from real payloads), and the vendor `SwapType` enum
 * stops at 171. Their byte widths are recorded below; their *names* are not
 * inventable from chain data and stay `null`. `dynamicV2` (146) is a variant whose
 * encoding is unresolved even for some real payloads — it is recorded as
 * `unsupported`, never as a fixed width.
 *
 * Nothing in this file reads logs, events or balances: only instruction bytes.
 */

import { readU32LE, readU64LE, type Bytes } from '../decode/bytes.ts';
import {
  DLMM_PROGRAM_ID,
  DLMM_SWAP2_DISCRIMINATOR,
} from '../swap/dlmm.ts';
import {
  PUMP_AMM_BUY_DISCRIMINATOR,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SELL_DISCRIMINATOR,
} from '../swap/pump.ts';

export const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/** 8-byte instruction discriminator, lower-case hex. */
export const JUPITER_ROUTE_V2_DISCRIMINATOR = 'bb64facc31c4af14';

/**
 * The ten account roles of `route_v2`, in the order the vendor ABI declares them.
 *
 * `destinationTokenAccount` (slot 7) is `optional` in the ABI and was observed
 * filled with the JUP6 program id itself — a filler, exactly like DLMM's optional
 * roles. It is exposed because the slot exists, never used as evidence.
 *
 * Slots 10+ are the caller's remaining accounts and are deliberately unnamed: the
 * discovery could not prove a role for any of them, so this layer counts them and
 * says nothing else. Account slots are *positional* — the lists contain repeated
 * pubkeys (the success fixture carries 81 slots over 45 distinct keys), so nothing
 * here may be resolved by pubkey lookup.
 */
export const ROUTE_V2_ACCOUNT_ROLES = [
  'userTransferAuthority',
  'userSourceTokenAccount',
  'userDestinationTokenAccount',
  'sourceMint',
  'destinationMint',
  'sourceTokenProgram',
  'destinationTokenProgram',
  'destinationTokenAccount',
  'eventAuthority',
  'program',
] as const;

export type RouteV2Role = (typeof ROUTE_V2_ACCOUNT_ROLES)[number];

/** Slots 0..9 are declared; everything after them is the caller's remaining accounts. */
export const ROUTE_V2_FIXED_ACCOUNT_COUNT = ROUTE_V2_ACCOUNT_ROLES.length;

export interface RouteV2Header {
  /** `in_amount`, verbatim: the input the route was authorized to take. */
  readonly declaredInAmount: bigint;
  /** `quoted_out_amount`, verbatim: the quote. Never a fill. */
  readonly quotedOutAmount: bigint;
  /** `slippage_bps`, verbatim: route-level tolerance. */
  readonly slippageBps: number;
  /** `platform_fee_bps`, verbatim: an integrator fee *rate*. */
  readonly platformFeeBps: number;
  /** `positive_slippage_bps`, verbatim: declared metadata; its meaning is not proven. */
  readonly positiveSlippageBps: number;
  /** `route_plan` length prefix. */
  readonly routePlanStepCount: number;
  /** Bytes consumed by the header, discriminator included. */
  readonly consumedBytes: number;
}

export type RouteV2HeaderParse =
  | { readonly ok: true; readonly header: RouteV2Header }
  | { readonly ok: false; readonly detail: string };

/** Bytes of the header: discriminator (8) + 8 + 8 + 2 + 2 + 2 + plan length (4). */
const HEADER_BYTES = 34;

/**
 * Parses a `route_v2` payload (everything after the 8-byte discriminator).
 *
 * Exact byte consumption is the point, as everywhere in this project: a truncated
 * header fails the parse instead of being partially read, and a payload that is
 * *longer* than the header is not an error here — the remainder is the plan, whose
 * own decoder decides whether it consumes exactly.
 */
export function parseRouteV2Header(bytes: Bytes): RouteV2HeaderParse {
  const payloadLength = bytes.length - 8;
  const declaredInAmount = readU64LE(bytes, 8);
  if (declaredInAmount === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): in_amount (u64) is truncated` };
  }
  const quotedOutAmount = readU64LE(bytes, 16);
  if (quotedOutAmount === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): quoted_out_amount (u64) is truncated` };
  }
  const slippageBps = readU16LE(bytes, 24);
  if (slippageBps === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): slippage_bps (u16) is truncated` };
  }
  const platformFeeBps = readU16LE(bytes, 26);
  if (platformFeeBps === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): platform_fee_bps (u16) is truncated` };
  }
  const positiveSlippageBps = readU16LE(bytes, 28);
  if (positiveSlippageBps === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): positive_slippage_bps (u16) is truncated` };
  }
  const routePlanStepCount = readU32LE(bytes, 30);
  if (routePlanStepCount === null) {
    return { ok: false, detail: `${payloadLength} payload byte(s): route_plan length (u32) is truncated` };
  }
  return {
    ok: true,
    header: {
      declaredInAmount,
      quotedOutAmount,
      slippageBps,
      platformFeeBps,
      positiveSlippageBps,
      routePlanStepCount,
      consumedBytes: HEADER_BYTES,
    },
  };
}

/** Unsigned 16-bit little-endian integer, bounds-checked like the other readers. */
function readU16LE(bytes: Bytes, offset: number): number | null {
  if (offset < 0 || bytes.length - offset < 2) return null;
  const low = bytes[offset];
  const high = bytes[offset + 1];
  if (low === undefined || high === undefined) return null;
  return low + high * 256;
}

/* ------------------------------------------------------------------ the plan */

/**
 * How many bytes a `SwapType` variant carries after its tag.
 *
 * `remaining-accounts-info` and `optional-remaining-accounts-info` are structural:
 * the encoding is `u32 slice count` followed by two bytes per slice (`{accountsType
 * u8, length u8}`), optionally behind a one-byte `Option` prefix. That is the same
 * shape the frozen DLMM parser reads, and it is what makes the observed widths (4
 * bytes for `meteoraDlmmSwapV2`, 2 or 8 for `whirlpoolSwapV2`) come out exactly.
 */
export type RoutePlanVariantField =
  /** No payload bytes after the tag. */
  | { readonly kind: 'none' }
  /** A fixed width, proven by real payloads. */
  | { readonly kind: 'fixed'; readonly bytes: number }
  /** `RemainingAccountsInfo`: `u32` count, then 2 bytes per slice. */
  | { readonly kind: 'remaining-accounts-info' }
  /**
   * A one-byte direction flag (`aToB: bool`) followed by
   * `Option<RemainingAccountsInfo>` — observed at 2 bytes when the option is `None`
   * and 8 bytes with one slice. The option byte is *after* the flag, which is
   * exactly the kind of off-by-one a fixed width would hide.
   */
  | { readonly kind: 'flag-then-optional-remaining-accounts-info' }
  /** Known to exist, but its width is not established: decoding stops here. */
  | { readonly kind: 'unsupported'; readonly reason: string };

/** Where a variant's name and width come from. */
export type RoutePlanVariantSource =
  /** Named by the vendor ABI, and the vendor-ABI width matched real payloads. */
  | 'vendor-abi'
  /** Solved from real payload bytes; no ABI names this tag (so `name` is `null`). */
  | 'observed-bytes';

export interface RoutePlanVariant {
  readonly tag: number;
  /**
   * The `SwapType` variant name, or `null` when no available ABI names this tag.
   * A `null` name is reported as the raw tag — never as an invented name.
   */
  readonly name: string | null;
  readonly field: RoutePlanVariantField;
  /**
   * The program this tag was observed to dispatch to, or `null` when no dispatch
   * was observed. Used only to *check* a plan against the instructions the route
   * actually invoked; it is never used to invent a leg.
   */
  readonly dispatchesTo: string | null;
  readonly source: RoutePlanVariantSource;
}

/**
 * The tags this layer may decode, and nothing else.
 *
 * Every `fixed` width below was solved by consuming real `route_v2` payloads
 * exactly; the `vendor-abi` names come from the community Codama ABI description of
 * `SwapType` and were kept only where the observed width agreed with it. Tags the
 * ABI declares but this corpus never produced are **absent on purpose**: an
 * unobserved variant's width is a guess, and a wrong width would silently shift
 * every following step of the plan.
 */
export const ROUTE_PLAN_VARIANTS: readonly RoutePlanVariant[] = [
  {
    tag: 17,
    name: 'whirlpool',
    field: { kind: 'fixed', bytes: 1 },
    dispatchesTo: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    source: 'vendor-abi',
  },
  {
    tag: 26,
    name: 'raydiumClmm',
    field: { kind: 'none' },
    dispatchesTo: 'HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq',
    source: 'vendor-abi',
  },
  {
    tag: 38,
    name: 'meteoraDlmm',
    field: { kind: 'none' },
    dispatchesTo: DLMM_PROGRAM_ID,
    source: 'vendor-abi',
  },
  {
    tag: 40,
    name: 'raydiumClmmV2',
    field: { kind: 'none' },
    dispatchesTo: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    source: 'vendor-abi',
  },
  {
    tag: 46,
    name: 'raydiumCP',
    field: { kind: 'none' },
    dispatchesTo: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
    source: 'vendor-abi',
  },
  {
    tag: 47,
    name: 'whirlpoolSwapV2',
    field: { kind: 'flag-then-optional-remaining-accounts-info' },
    dispatchesTo: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    source: 'vendor-abi',
  },
  {
    tag: 75,
    name: 'meteoraDlmmSwapV2',
    field: { kind: 'remaining-accounts-info' },
    dispatchesTo: DLMM_PROGRAM_ID,
    source: 'vendor-abi',
  },
  {
    tag: 95,
    name: 'solFiV2',
    field: { kind: 'fixed', bytes: 1 },
    dispatchesTo: 'SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF',
    source: 'vendor-abi',
  },
  {
    tag: 99,
    name: 'pumpSwapBuyV3',
    field: { kind: 'none' },
    dispatchesTo: PUMP_AMM_PROGRAM_ID,
    source: 'vendor-abi',
  },
  {
    tag: 100,
    name: 'pumpSwapSellV3',
    field: { kind: 'none' },
    dispatchesTo: PUMP_AMM_PROGRAM_ID,
    source: 'vendor-abi',
  },
  {
    tag: 104,
    name: 'alphaQ',
    field: { kind: 'fixed', bytes: 1 },
    dispatchesTo: 'ALPHAQmeA7bjrVuccPsYPiCvsi428SNwte66Srvs4pHA',
    source: 'vendor-abi',
  },
  {
    tag: 108,
    name: 'meteoraDammV2WithRemainingAccounts',
    field: { kind: 'none' },
    dispatchesTo: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
    source: 'vendor-abi',
  },
  {
    tag: 116,
    name: 'manifest',
    field: { kind: 'fixed', bytes: 1 },
    dispatchesTo: 'MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms',
    source: 'vendor-abi',
  },
  {
    tag: 117,
    name: 'bisonFi',
    field: { kind: 'fixed', bytes: 1 },
    dispatchesTo: 'BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi',
    source: 'vendor-abi',
  },
  {
    tag: 141,
    name: 'bisonFiV2',
    field: { kind: 'fixed', bytes: 1 },
    dispatchesTo: 'BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi',
    source: 'vendor-abi',
  },
  {
    tag: 146,
    name: 'dynamicV2',
    field: {
      kind: 'unsupported',
      reason:
        'dynamicV2 carries a variable-length candidate list whose item encoding is not resolved: the vendor ' +
        'ABI description decodes only some real payloads and no fixed width fits the others',
    },
    dispatchesTo: 'BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi',
    source: 'vendor-abi',
  },
  {
    tag: 147,
    name: 'pumpSwapBuyV3WithCashbackClaim',
    field: { kind: 'none' },
    dispatchesTo: PUMP_AMM_PROGRAM_ID,
    source: 'vendor-abi',
  },
  {
    tag: 148,
    name: 'pumpSwapSellV3WithCashbackClaim',
    field: { kind: 'none' },
    dispatchesTo: PUMP_AMM_PROGRAM_ID,
    source: 'vendor-abi',
  },
  {
    tag: 151,
    name: 'goonFiV3',
    field: { kind: 'fixed', bytes: 1 },
    dispatchesTo: 'goonuddtQRrWqqn5nFyczVKaie28f3kDkHWkHtURSLE',
    source: 'vendor-abi',
  },
  {
    tag: 153,
    name: 'pumpWrappedSellV5',
    field: { kind: 'fixed', bytes: 1 },
    dispatchesTo: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    source: 'vendor-abi',
  },
  {
    tag: 154,
    name: 'zeroFiSwapV2',
    field: { kind: 'none' },
    dispatchesTo: 'ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY',
    source: 'vendor-abi',
  },
  {
    tag: 156,
    name: 'byrealDynamicV3',
    field: { kind: 'none' },
    dispatchesTo: 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2',
    source: 'vendor-abi',
  },
  {
    tag: 178,
    name: null,
    field: { kind: 'fixed', bytes: 1 },
    dispatchesTo: 'TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH',
    source: 'observed-bytes',
  },
  {
    tag: 181,
    name: null,
    field: { kind: 'fixed', bytes: 1 },
    dispatchesTo: '3TK9D8aoBFYjYZtKCjciPrVrRStsnvo7KmpcJqDavpaU',
    source: 'observed-bytes',
  },
  {
    tag: 187,
    name: null,
    field: { kind: 'fixed', bytes: 2 },
    dispatchesTo: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    source: 'observed-bytes',
  },
];

/** The variant record for a raw tag, or `null` when no evidence covers it. */
export function routePlanVariant(tag: number): RoutePlanVariant | null {
  return ROUTE_PLAN_VARIANTS.find(variant => variant.tag === tag) ?? null;
}

/**
 * One decoded plan step, exactly as the bytes state it.
 *
 * `swapName` is `null` when the tag has no proven name — the raw tag is then the
 * only identity this layer may report. `bps`, `inputIndex` and `outputIndex` are
 * carried verbatim: the split-weight semantics are supported by the discovery (a
 * split's weights sum to 10 000, a chain's steps each carry 10 000, so there is no
 * global sum invariant), but the *space* those indices point into is not, so they
 * are reported as opaque topology indices and never resolved to accounts.
 */
export interface RoutePlanStepRead {
  readonly index: number;
  readonly swapTag: number;
  readonly swapName: string | null;
  /** Bytes the variant payload occupied after the tag. */
  readonly swapFieldBytes: number;
  readonly bps: number;
  readonly inputIndex: number;
  readonly outputIndex: number;
}

export type RoutePlanParse =
  | { readonly ok: true; readonly steps: readonly RoutePlanStepRead[]; readonly consumedBytes: number }
  | {
      readonly ok: false;
      /** Steps that decoded before the failure, in order. Never a partial step. */
      readonly steps: readonly RoutePlanStepRead[];
      readonly detail: string;
      readonly consumedBytes: number;
    };

/**
 * Parses the `route_plan` that follows the header.
 *
 * Steps are read one at a time, each with its own variant width, and the parse is
 * only `ok` when the declared step count is reached **and** every payload byte is
 * consumed. Anything else is a failure with the reason and the steps that did
 * decode — never a best-effort reading of the bytes that remain.
 */
export function parseRouteV2Plan(bytes: Bytes, stepCount: number): RoutePlanParse {
  const steps: RoutePlanStepRead[] = [];
  let offset = HEADER_BYTES;

  for (let index = 0; index < stepCount; index += 1) {
    const tag = bytes[offset];
    if (tag === undefined) {
      return {
        ok: false,
        steps,
        consumedBytes: offset,
        detail: `the plan declares ${stepCount} step(s) but the payload ends after ${steps.length}`,
      };
    }
    const variant = routePlanVariant(tag);
    if (variant === null) {
      return {
        ok: false,
        steps,
        consumedBytes: offset,
        detail:
          `step ${index} uses SwapType tag ${tag}, which no accepted evidence covers ` +
          '(the deployed enum is larger than any public ABI); the plan is not read past it',
      };
    }
    if (variant.field.kind === 'unsupported') {
      return {
        ok: false,
        steps,
        consumedBytes: offset,
        detail: `step ${index} uses SwapType tag ${tag} (${variant.name ?? 'unnamed'}): ${variant.field.reason}`,
      };
    }

    const fieldStart = offset + 1;
    const fieldRead = readVariantField(variant.field, bytes, fieldStart);
    if ('detail' in fieldRead) {
      return { ok: false, steps, consumedBytes: offset, detail: `step ${index} (tag ${tag}): ${fieldRead.detail}` };
    }
    const fieldBytes = fieldRead.bytes;

    const bps = readU16LE(bytes, fieldStart + fieldBytes);
    const inputIndex = bytes[fieldStart + fieldBytes + 2];
    const outputIndex = bytes[fieldStart + fieldBytes + 3];
    if (bps === null || inputIndex === undefined || outputIndex === undefined) {
      return {
        ok: false,
        steps,
        consumedBytes: offset,
        detail: `step ${index} (tag ${tag}) is truncated: its bps/input_index/output_index did not fit`,
      };
    }

    steps.push({
      index,
      swapTag: tag,
      swapName: variant.name,
      swapFieldBytes: fieldBytes,
      bps,
      inputIndex,
      outputIndex,
    });
    offset = fieldStart + fieldBytes + 4;
  }

  if (offset !== bytes.length) {
    return {
      ok: false,
      steps,
      consumedBytes: offset,
      detail:
        `the plan's ${stepCount} step(s) consumed ${offset - HEADER_BYTES} payload byte(s) but ` +
        `${bytes.length - offset} byte(s) remain unconsumed: the declared step count and the payload disagree`,
    };
  }
  return { ok: true, steps, consumedBytes: offset };
}

function readVariantField(
  field: RoutePlanVariantField,
  bytes: Bytes,
  offset: number,
): { readonly bytes: number } | { readonly detail: string } {
  switch (field.kind) {
    case 'none':
      return { bytes: 0 };
    case 'fixed':
      return bytes.length - offset >= field.bytes
        ? { bytes: field.bytes }
        : { detail: `the variant payload (${field.bytes} byte(s)) is truncated` };
    case 'unsupported':
      return { detail: field.reason };
    case 'remaining-accounts-info':
      return readRemainingAccountsInfo(bytes, offset);
    case 'flag-then-optional-remaining-accounts-info': {
      const flag = bytes[offset];
      if (flag === undefined) return { detail: 'the variant payload is truncated at its direction flag' };
      const option = bytes[offset + 1];
      if (option === undefined) {
        return { detail: 'the variant payload is truncated at its Option<RemainingAccountsInfo> prefix' };
      }
      if (option === 0) return { bytes: 2 };
      if (option !== 1) {
        return { detail: `the variant's Option prefix is ${option}, which is not a valid Option discriminant` };
      }
      const inner = readRemainingAccountsInfo(bytes, offset + 2);
      return 'detail' in inner ? inner : { bytes: 2 + inner.bytes };
    }
  }
}

/** `RemainingAccountsInfo = { slices: Vec<{ accountsType u8, length u8 }> }`. */
function readRemainingAccountsInfo(
  bytes: Bytes,
  offset: number,
): { readonly bytes: number } | { readonly detail: string } {
  const sliceCount = readU32LE(bytes, offset);
  if (sliceCount === null) return { detail: 'remaining_accounts_info.slices length (u32) is truncated' };
  const SLICE_BYTES = 2;
  const total = 4 + sliceCount * SLICE_BYTES;
  if (bytes.length - offset < total) {
    return {
      detail:
        `remaining_accounts_info declares ${sliceCount} slice(s) (${sliceCount * SLICE_BYTES} byte(s)) ` +
        `but only ${bytes.length - offset - 4} byte(s) remain`,
    };
  }
  return { bytes: total };
}

/* ------------------------------------------------------------- leg naming --- */

/**
 * Anchor instruction names proven by discriminator preimage — `sha256("global:<name>")[..8]`.
 *
 * Same proof standard as the frozen recognizers, applied to the instruction names
 * the Milestone 4.4 discovery solved for the legs Jupiter actually dispatched. The
 * three names the frozen modules already export are re-used rather than re-listed;
 * everything else here was proven during that discovery and is used **only** to
 * label a leg for the reader. A discriminator that is absent from this table stays
 * unnamed, and a leg's *meaning* is never derived from its name either way.
 */
const PROVEN_LEG_INSTRUCTION_NAMES: ReadonlyMap<string, string> = new Map([
  [DLMM_SWAP2_DISCRIMINATOR, 'swap2'],
  [PUMP_AMM_SELL_DISCRIMINATOR, 'sell'],
  [PUMP_AMM_BUY_DISCRIMINATOR, 'buy'],
  ['f8c69e91e17587c8', 'swap'],
  ['2b04ed0b1ac91e62', 'swap_v2'],
  ['f0e02621b01ff1af', 'swap_v3'],
  ['8fbe5adac41e33de', 'swap_base_input'],
  ['c62e1552b4d9e870', 'buy_exact_quote_in'],
  ['5df6823ce7e940b2', 'sell_v2'],
  ['1c92de7726c469d5', 'sell_v3'],
  ['7af3cc415e741d37', 'claim_cashback_v2'],
  ['f945a4da9667548a', 'close_user_volume_accumulator'],
]);

/** The proven Anchor name for a leg's discriminator, or `null`. */
export function provenLegInstructionName(discriminator: string | null): string | null {
  return discriminator === null ? null : (PROVEN_LEG_INSTRUCTION_NAMES.get(discriminator) ?? null);
}

/**
 * Programs the route layer treats as infrastructure rather than executions.
 *
 * A route's legs are the *other programs* it ran; token moves, account creation and
 * compute-budget settings are the plumbing between them. Excluded means "counted,
 * not listed as a leg" — the accounting always reconciles, so nothing is hidden.
 */
export const ROUTE_INFRASTRUCTURE_PROGRAMS: readonly string[] = [
  '11111111111111111111111111111111', // System
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
  'ComputeBudget111111111111111111111111111111', // Compute budget
];
