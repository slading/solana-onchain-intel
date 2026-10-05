/**
 * Public surface of the library part of the project.
 *
 * The CLI is a thin shell over these three things: fetch -> normalize -> render.
 * Keeping them separate is what makes the normalizer unit-testable against
 * fixtures and will let later milestones (System Program / SPL Token parsing,
 * swap detection) plug in *after* normalization without touching the RPC layer.
 */
export { normalizeTransaction, NormalizationError } from './normalize/transaction.ts';
// Milestone 2 semantic layer: decodes normalized instructions into actions.
export { decodeTransaction, decodeInstruction, PROGRAM_DECODERS } from './decode/decode.ts';
export { refLabel } from './decode/actions.ts';
export { describeAction, renderActionSection } from './render/actions.ts';
export type {
  ActionKind,
  ActionPayload,
  DecodedAction,
  DecodedProgramLabel,
  DecodedTransaction,
  DecodeDiagnostic,
  DecodeEvidence,
  InstructionRef,
  UndecodedInstruction,
  UndecodedReason,
} from './decode/actions.ts';
// Milestone 3 effects layer: balances + decoded actions -> value movement, net
// change per account, account lifecycle, and everything left unattributed.
export { buildTransactionEffects, transactionEffects } from './effects/build.ts';
export { toEffectsInput } from './effects/input.ts';
export { NATIVE_MINT, isNativeMint } from './effects/native.ts';
export { renderEffectsSection, formatUnits } from './render/effects.ts';
export { abbreviateAddress } from './render/actions.ts';
export type {
  AccountCreatedEffect,
  AccountLifecycleEffect,
  AllowanceClearedEffect,
  AllowanceSetEffect,
  AmountSource,
  EffectCommitState,
  EffectConfidence,
  EffectsAccountRow,
  EffectsCounts,
  EffectsDiagnostic,
  EffectsInput,
  EffectsTokenRow,
  LifecycleKind,
  OwnerMintNet,
  Reconciliation,
  SolAccountNet,
  SolFlow,
  SolFlowKind,
  TokenAccountCreateEffect,
  TokenAccountClosedEffect,
  TokenAccountMintNet,
  TokenFieldEvidence,
  TokenFlow,
  TokenFlowKind,
  TransactionEffects,
  UnattributedEffect,
  UnattributedReason,
} from './effects/model.ts';
// Milestone 4.1 swap layer: recognizes Meteora DLMM swap2 from program
// semantics + deterministic evidence (never from token-out/token-in).
export { recognizeDlmmSwaps } from './swap/recognize.ts';
export type { RecognizeSwapOptions } from './swap/recognize.ts';
export {
  DLMM_PROGRAM_ID,
  DLMM_SWAP2_ACCOUNT_ROLES,
  DLMM_SWAP2_DISCRIMINATOR,
  parseDlmmSwap2Args,
} from './swap/dlmm.ts';
export type { DlmmSwap2ArgParse, DlmmSwap2Args, DlmmSwap2Role } from './swap/dlmm.ts';
export { recognizeSwaps } from './swap/recognize-swaps.ts';
export type { RecognizeSwapsOptions } from './swap/recognize-swaps.ts';
export {
  PUMP_AMM_BUY_ACCOUNT_ROLES,
  PUMP_AMM_BUY_DISCRIMINATOR,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SELL_ACCOUNT_ROLES,
  PUMP_AMM_SELL_DISCRIMINATOR,
  parsePumpBuyArgs,
  parsePumpSellArgs,
} from './swap/pump.ts';
export type {
  PumpBuyArgParse,
  PumpBuyArgs,
  PumpBuyRole,
  PumpBuyTrackVolume,
  PumpSellArgParse,
  PumpSellArgs,
  PumpSellRole,
} from './swap/pump.ts';
export { recognizePumpSells } from './swap/pump-recognize.ts';
export type { PumpSellRecognition, RecognizePumpOptions } from './swap/pump-recognize.ts';
// Milestone 4.3: the other pump_amm instruction, with its own mirrored evidence.
export { recognizePumpBuys } from './swap/pump-buy-recognize.ts';
export type { PumpBuyRecognition, RecognizePumpBuyOptions } from './swap/pump-buy-recognize.ts';
// Milestone 4.4: Jupiter `route_v2` as a route ENVELOPE — intent, quote, plan and
// references to dispatched instructions; never a movement of its own.
export { recognizeRoutes } from './route/recognize-routes.ts';
export type { RecognizeRoutesOptions } from './route/recognize-routes.ts';
export { renderRouteSection } from './render/routes.ts';
export type { RouteRenderOptions } from './render/routes.ts';
export {
  JUPITER_ROUTE_V2_DISCRIMINATOR,
  JUPITER_V6_PROGRAM_ID,
  ROUTE_INFRASTRUCTURE_PROGRAMS,
  ROUTE_PLAN_VARIANTS,
  ROUTE_V2_ACCOUNT_ROLES,
  ROUTE_V2_FIXED_ACCOUNT_COUNT,
  parseRouteV2Header,
  parseRouteV2Plan,
  provenLegInstructionName,
  routePlanVariant,
} from './route/jupiter.ts';
export type {
  RoutePlanParse,
  RoutePlanStepRead,
  RoutePlanVariant,
  RoutePlanVariantField,
  RoutePlanVariantSource,
  RouteV2Header,
  RouteV2HeaderParse,
  RouteV2Role,
} from './route/jupiter.ts';
export type {
  JupiterRouteEnvelope,
  RouteAccounts,
  RouteCheck,
  RouteCheckOutcome,
  RouteCommitState,
  RouteCounts,
  RouteDiagnostic,
  RouteIntent,
  RouteLeg,
  RouteLegAccounting,
  RouteLegSwapReference,
  RoutePlan,
  RoutePlanAlignment,
  RoutePlanAlignmentStatus,
  RouteReport,
  RouteState,
} from './route/model.ts';
export { renderSwapSection } from './render/swaps.ts';
export type { SwapRenderOptions } from './render/swaps.ts';
export type {
  PumpBuyFeeTransfer,
  PumpBuyFeeTransferRole,
  PumpBuyLeg,
  PumpBuyRoles,
  PumpFeeTransferRole,
  PumpSellFeeTransfer,
  PumpSellLeg,
  PumpSellRoles,
  SwapAmountEvidence,
  SwapCheck,
  SwapCheckOutcome,
  SwapCommitState,
  SwapDiagnostic,
  SwapLeg,
  SwapOwnerEvidence,
  SwapProtocol,
  SwapReport,
  SwapSide,
  SwapState,
  DlmmAmountEvidence,
  DlmmCheckOutcome,
  DlmmCommitState,
  DlmmSwapCheck,
  DlmmSwapCounts,
  DlmmSwapDiagnostic,
  DlmmSwapLeg,
  DlmmSwapRoles,
  DlmmSwapSide,
  DlmmSwapState,
  TransactionSwaps,
} from './swap/model.ts';
export { renderSummary } from './render/summary.ts';
export { stringifyJson } from './lib/format.ts';
export { fetchTransaction, TransactionFetchError } from './rpc/fetch-transaction.ts';
export { createRpc, resolveCommitment, resolveRpcUrl, TRANSACTION_REQUEST } from './rpc/client.ts';
export { DiagnosticCollector } from './normalize/diagnostics.ts';
export type {
  NormalizedAccount,
  NormalizedDiagnostic,
  NormalizedInnerInstructionGroup,
  NormalizedInstruction,
  NormalizedProvenance,
  NormalizedSolBalanceChange,
  NormalizedTokenBalanceChange,
  NormalizedTransaction,
  NormalizedTransactionVersion,
} from './model/transaction.ts';
