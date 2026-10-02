import { asArray, asBigIntLike, asBoolean, asNumber, asRecord, asString, at, pick } from '../lib/read-json.ts';
import type {
  AccountSource,
  NormalizedAccount,
  NormalizedProvenance,
  NormalizedTransaction,
  NormalizedTransactionVersion,
} from '../model/transaction.ts';
import { decodeTransaction } from '../decode/decode.ts';
import { normalizeSolBalanceChanges, normalizeTokenBalanceChanges } from './balances.ts';
import { DiagnosticCollector } from './diagnostics.ts';
import { normalizeInnerInstructions, normalizeTopLevelInstructions } from './instructions.ts';

/**
 * Thrown when the payload is not a `getTransaction` result at all (wrong method,
 * wrong encoding). Missing *optional* data is never an error: it becomes `null`
 * plus a diagnostic.
 */
export class NormalizationError extends Error {
  public override readonly name = 'NormalizationError';
}

function readVersion(value: unknown, diagnostics: DiagnosticCollector): NormalizedTransactionVersion {
  if (value === 'legacy') return { kind: 'legacy' };
  const numbered = asNumber(value);
  if (numbered !== null) return { kind: 'numbered', value: numbered };
  if (value === undefined || value === null) {
    diagnostics.warn(
      'version-missing',
      'The response has no "version" field. This happens when the request omits ' +
        'maxSupportedTransactionVersion; the version is unknown.',
    );
    return { kind: 'unknown' };
  }
  diagnostics.warn(
    'version-unexpected',
    `Unrecognised "version" value ${JSON.stringify(value)}; the version is unknown.`,
  );
  return { kind: 'unknown' };
}

function readAccountSource(value: unknown): AccountSource | null {
  return value === 'transaction' || value === 'lookupTable' ? value : null;
}

/**
 * Reads `message.accountKeys`.
 *
 * `jsonParsed` returns objects (`pubkey`/`signer`/`writable`/`source`) where
 * lookup-table addresses are already resolved into the list. The `json` encoding
 * returns plain base58 strings and no flags — supported so the normalizer is not
 * silently wrong if the call site ever changes encoding, with the unknown flags
 * reported as `null`.
 */
function normalizeAccounts(
  rawAccountKeys: readonly unknown[] | null,
  diagnostics: DiagnosticCollector,
): readonly NormalizedAccount[] {
  if (rawAccountKeys === null) {
    diagnostics.warn('accounts-missing', 'message.accountKeys is absent; the account list is empty.');
    return [];
  }

  const accounts: NormalizedAccount[] = [];
  rawAccountKeys.forEach((raw, index) => {
    if (typeof raw === 'string') {
      accounts.push({ index, address: raw, signer: null, writable: null, source: null });
      return;
    }
    const record = asRecord(raw);
    const address = record === null ? null : asString(pick(record, 'pubkey'));
    if (address === null) {
      diagnostics.warn(
        'account-entry-malformed',
        `message.accountKeys[${index}] has no pubkey; the entry is preserved in raw only ` +
          `and index alignment is preserved with a placeholder address.`,
      );
      accounts.push({ index, address: '', signer: null, writable: null, source: null });
      return;
    }
    accounts.push({
      index,
      address,
      signer: asBoolean(pick(record as Record<string, unknown>, 'signer')),
      writable: asBoolean(pick(record as Record<string, unknown>, 'writable')),
      source: readAccountSource(pick(record as Record<string, unknown>, 'source')),
    });
  });
  return accounts;
}

/**
 * Turns a raw `getTransaction` result into the canonical model. Pure and
 * synchronous: the same input always produces the same output, which is what
 * makes the CLI output deterministic and the normalizer testable from fixtures.
 */
export function normalizeTransaction(
  rawResult: unknown,
  options: { readonly provenance: NormalizedProvenance },
): NormalizedTransaction {
  const diagnostics = new DiagnosticCollector();

  const root = asRecord(rawResult);
  if (root === null) {
    throw new NormalizationError(
      'getTransaction result is not a JSON object (the signature may not exist, or the ' +
        'request used a binary encoding).',
    );
  }

  const slot = asBigIntLike(pick(root, 'slot'));
  if (slot === null) {
    throw new NormalizationError('getTransaction result has no numeric "slot" field.');
  }

  const transaction = asRecord(pick(root, 'transaction'));
  if (transaction === null) {
    throw new NormalizationError(
      'getTransaction result has no "transaction" object. Re-run with encoding "jsonParsed" ' +
        'or "json".',
    );
  }

  const message = asRecord(pick(transaction, 'message'));
  if (message === null) {
    throw new NormalizationError('The transaction has no "message" object.');
  }

  const rawInstructions = asArray(pick(message, 'instructions'));
  if (rawInstructions === null) {
    throw new NormalizationError('The transaction message has no "instructions" array.');
  }

  const signatures = (asArray(pick(transaction, 'signatures')) ?? [])
    .map(asString)
    .filter((value): value is string => value !== null);
  if (signatures.length === 0) {
    diagnostics.warn('signatures-missing', 'The transaction has no signatures.');
  }

  const blockTimeUnix = asNumber(pick(root, 'blockTime'));
  if (blockTimeUnix === null) {
    diagnostics.info(
      'block-time-missing',
      'The RPC has no block time for this slot; the timestamp is unknown.',
    );
  }

  const accounts = normalizeAccounts(asArray(pick(message, 'accountKeys')), diagnostics);
  const instructions = normalizeTopLevelInstructions(rawInstructions, diagnostics);

  const meta = asRecord(pick(root, 'meta'));
  if (meta === null) {
    diagnostics.warn(
      'metadata-missing',
      'meta is null: fee, logs, balances and success cannot be determined from this response.',
    );
  }

  const error = meta === null ? null : (pick(meta, 'err') ?? null);
  const status: NormalizedTransaction['status'] =
    meta === null ? 'unknown' : error === null ? 'success' : 'failed';

  const rawInnerInstructions = meta === null ? null : asArray(pick(meta, 'innerInstructions'));
  const innerInstructionsAvailable = rawInnerInstructions !== null;
  if (meta !== null && rawInnerInstructions === null) {
    diagnostics.warn(
      'inner-instructions-not-recorded',
      'meta.innerInstructions is null, meaning this node did not record CPI instructions; ' +
        'an empty result here means "not recorded", not "no cross-program invocations".',
    );
  }
  const innerInstructionGroups = normalizeInnerInstructions(
    rawInnerInstructions ?? [],
    instructions.length,
    diagnostics,
  );

  const rawPreBalances = meta === null ? null : asArray(pick(meta, 'preBalances'));
  const rawPostBalances = meta === null ? null : asArray(pick(meta, 'postBalances'));
  const solBalanceChanges = normalizeSolBalanceChanges(
    accounts,
    rawPreBalances,
    rawPostBalances,
    diagnostics,
  );

  // `null` on either side means "not reported by this node", which is different
  // from an empty array meaning "no token balances were involved".
  const rawPreTokenBalances = meta === null ? null : asArray(pick(meta, 'preTokenBalances'));
  const rawPostTokenBalances = meta === null ? null : asArray(pick(meta, 'postTokenBalances'));
  const { changes: tokenBalanceChanges, available: tokenBalancesAvailable } =
    normalizeTokenBalanceChanges(
      accounts,
      rawPreTokenBalances,
      rawPostTokenBalances,
      diagnostics,
    );

  const logsRaw = meta === null ? null : pick(meta, 'logMessages');
  const logsArray = asArray(logsRaw);
  const logs = logsArray === null ? null : logsArray.map(value => asString(value) ?? '');
  if (meta !== null && logs === null) {
    diagnostics.info(
      'logs-unavailable',
      'meta.logMessages is null (the transaction failed before execution began, or recording ' +
        'is disabled).',
    );
  }

  const signers =
    accounts.length > 0 && accounts.every(account => account.signer === null)
      ? null
      : accounts.filter(account => account.signer === true).map(account => account.address);
  if (signers === null) {
    diagnostics.warn(
      'signer-flags-missing',
      'The account list does not report signer flags, so the signer set is unknown.',
    );
  }

  return {
    signature: signatures[0] ?? '',
    signatures,
    slot,
    blockTimeUnix,
    version: readVersion(pick(root, 'version'), diagnostics),
    status,
    error,
    feeLamports: meta === null ? null : asBigIntLike(pick(meta, 'fee')),
    computeUnitsConsumed: meta === null ? null : asBigIntLike(pick(meta, 'computeUnitsConsumed')),
    costUnits: meta === null ? null : asBigIntLike(pick(meta, 'costUnits')),
    recentBlockhash: asString(pick(message, 'recentBlockhash')),
    // Positional rule of the Solana message format: account 0 is the fee payer.
    feePayerAddress: at(accounts, 0)?.address ?? null,
    accounts,
    signers,
    instructions,
    innerInstructionGroups,
    innerInstructionsAvailable,
    logs,
    solBalanceChanges,
    tokenBalanceChanges,
    tokenBalancesAvailable,
    // v1 only: message-level resource limits. Absent (not null) for legacy/v0.
    transactionConfig: pick(message, 'transactionConfig') ?? null,
    diagnostics: diagnostics.collect(),
    provenance: options.provenance,
    // Milestone 2 semantic layer. Derived from `instructions` only, so it is
    // deterministic and cannot be influenced by balances, logs or the raw payload.
    decoded: decodeTransaction({ instructions, innerInstructionGroups }),
    raw: rawResult,
  };
}
