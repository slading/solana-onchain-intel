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
export { renderSwapSection } from './render/swaps.ts';
export type { SwapRenderOptions } from './render/swaps.ts';
export type {
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
