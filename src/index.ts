/**
 * Public surface of the library part of the project.
 *
 * The CLI is a thin shell over these three things: fetch -> normalize -> render.
 * Keeping them separate is what makes the normalizer unit-testable against
 * fixtures and will let later milestones (System Program / SPL Token parsing,
 * swap detection) plug in *after* normalization without touching the RPC layer.
 */
export { normalizeTransaction, NormalizationError } from './normalize/transaction.ts';
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
