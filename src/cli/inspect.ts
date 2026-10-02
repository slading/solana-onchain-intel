#!/usr/bin/env node
/**
 * `npm run inspect -- <SIGNATURE> [options]`
 *
 * Fetches one transaction from Solana RPC, normalizes it, and prints a
 * human-readable summary. Everything it prints comes from the model described in
 * `src/model/transaction.ts`; the raw RPC payload is always one flag away.
 */
import { writeFileSync } from 'node:fs';
import { assertIsSignature, isSolanaError } from '@solana/kit';
import { byteSize } from '../lib/byte-size.ts';
import { stringifyJson } from '../lib/format.ts';
import { transactionEffects } from '../effects/build.ts';
import { normalizeTransaction, NormalizationError } from '../normalize/transaction.ts';
import { renderSummary } from '../render/summary.ts';
import { createRpc, resolveCommitment, resolveRpcUrl } from '../rpc/client.ts';
import { fetchTransaction, TransactionFetchError } from '../rpc/fetch-transaction.ts';

const EXIT_OK = 0;
const EXIT_NOT_FOUND = 1;
const EXIT_USAGE = 2;
const EXIT_RPC_ERROR = 3;

const USAGE = `
Solana On-chain Intelligence Assistant — transaction inspector

Usage:
  npm run inspect -- <SIGNATURE> [options]

Options:
  --rpc <url>          RPC endpoint (default: $SOLANA_RPC_URL, else mainnet-beta)
  --commitment <level> processed | confirmed | finalized (default: $SOLANA_COMMITMENT, else confirmed)
  --json               Print the normalized model as JSON (includes the raw RPC payload)
  --raw                Print only the raw getTransaction result as JSON
  --actions            Print only the ACTIONS section (decoded semantics)
  --effects            Print only the EFFECTS section (value movement + net change)
  --full-addresses     Print exact addresses in ACTIONS/EFFECTS instead of abbreviated
  --no-actions         Omit the ACTIONS section from the text summary
  --no-effects         Omit the EFFECTS section from the text summary
  --no-logs            Omit program logs from the text summary
  --out <file>         Also write { normalized, effects, raw } JSON to <file>
  -h, --help           Show this help

Exit codes:
  0 inspected   1 signature not found   2 usage error   3 RPC error

Notes:
  Only Solana JSON-RPC is used: no third-party indexers, no databases, no LLMs.
  Instructions the RPC does not decode are reported as UNKNOWN, never interpreted.
  ACTIONS are decoded from System / SPL Token / Associated Token Account
  instruction data only. Unknown programs stay unknown, and meaning is never
  inferred from balance changes.
  EFFECTS add value movement and per-account net change on top: instruction-proven
  flows are separated from amounts sized by exact balance reconciliation, anything
  unexplained is listed as unattributed, and a failed transaction contributes
  nothing but its fee.
`.trim();

interface Args {
  signature: string | null;
  rpcUrl: string | undefined;
  commitment: string | undefined;
  json: boolean;
  raw: boolean;
  includeLogs: boolean;
  actionsOnly: boolean;
  noActions: boolean;
  effectsOnly: boolean;
  noEffects: boolean;
  fullAddresses: boolean;
  out: string | null;
  help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    signature: null,
    rpcUrl: undefined,
    commitment: undefined,
    json: false,
    raw: false,
    includeLogs: true,
    actionsOnly: false,
    noActions: false,
    effectsOnly: false,
    noEffects: false,
    fullAddresses: false,
    out: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--rpc':
        args.rpcUrl = requireValue(argv, ++index, '--rpc');
        break;
      case '--commitment':
        args.commitment = requireValue(argv, ++index, '--commitment');
        break;
      case '--out':
        args.out = requireValue(argv, ++index, '--out');
        break;
      case '--json':
        args.json = true;
        break;
      case '--raw':
        args.raw = true;
        break;
      case '--no-logs':
        args.includeLogs = false;
        break;
      case '--actions':
        args.actionsOnly = true;
        break;
      case '--no-actions':
        args.noActions = true;
        break;
      case '--effects':
        args.effectsOnly = true;
        break;
      case '--no-effects':
        args.noEffects = true;
        break;
      case '--full-addresses':
        args.fullAddresses = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (arg !== undefined && arg.startsWith('--')) {
          throw new UsageError(`Unknown option "${arg}".`);
        }
        if (args.signature !== null) {
          throw new UsageError('Exactly one transaction signature is expected.');
        }
        args.signature = arg ?? null;
    }
  }

  return args;
}

class UsageError extends Error {}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${flag} requires a value.`);
  }
  return value;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${USAGE}`);
    return EXIT_USAGE;
  }

  if (args.help || (args.signature === null && process.argv.length <= 2)) {
    console.log(USAGE);
    return args.help ? EXIT_OK : EXIT_USAGE;
  }
  if (args.signature === null) {
    console.error('A transaction signature is required.');
    console.error(`\n${USAGE}`);
    return EXIT_USAGE;
  }

  try {
    assertIsSignature(args.signature);
  } catch (error) {
    // kit validates base58 + length, so we never send malformed input to a node.
    console.error(
      `"${args.signature}" is not a valid Solana transaction signature` +
        `${isSolanaError(error) ? `: ${error.message}` : '.'}`,
    );
    return EXIT_USAGE;
  }

  const signature = args.signature;
  const rpcEndpoint = resolveRpcUrl(args.rpcUrl);
  const commitment = resolveCommitment(args.commitment);

  let fetched;
  try {
    fetched = await fetchTransaction(createRpc(rpcEndpoint), signature, {
      rpcEndpoint,
      commitment,
    });
  } catch (error) {
    if (error instanceof TransactionFetchError) {
      console.error(`error: ${error.message}`);
      if (error.hint !== null) console.error(`hint:  ${error.hint}`);
      return EXIT_RPC_ERROR;
    }
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
      return EXIT_USAGE;
    }
    console.error('Unexpected RPC error:', error);
    return EXIT_RPC_ERROR;
  }

  if (fetched === null) {
    console.error(
      `Transaction ${signature} was not found at commitment "${commitment}" on ${rpcEndpoint}.`,
    );
    console.error(
      'The node returned null: the signature does not exist, or the transaction is no longer ' +
        'retained by this node. Retry with --rpc pointing at a node with deeper history.',
    );
    return EXIT_NOT_FOUND;
  }

  if (args.raw) {
    // @solana/kit runs every response through its transformers, so this is the
    // decoded view rather than the wire bytes: 64-bit integers are bigints here
    // and are printed as exact decimal strings. Nothing is rounded or dropped.
    console.error(
      'note: raw payload as decoded by @solana/kit (u64 values are bigint, printed as ' +
        'decimal strings; use --out to save it)',
    );
    console.log(stringifyJson(fetched.raw));
    return EXIT_OK;
  }

  let normalized;
  try {
    normalized = normalizeTransaction(fetched.raw, { provenance: fetched.provenance });
  } catch (error) {
    if (error instanceof NormalizationError) {
      console.error(`error: could not normalize this response: ${error.message}`);
      console.error('hint:  run with --raw to inspect the untouched RPC payload.');
      return EXIT_RPC_ERROR;
    }
    throw error;
  }

  if (normalized.signature !== signature) {
    // Defensive: the RPC should never answer with a different transaction.
    console.error(
      `error: the RPC returned transaction ${normalized.signature} for requested signature ${signature}.`,
    );
    return EXIT_RPC_ERROR;
  }

  // The effects layer consumes the canonical model plus the decoded actions; it
  // is computed once and shared by the JSON dumps and the text summary.
  const effects = args.noEffects ? null : transactionEffects(normalized);

  if (args.out !== null) {
    writeFileSync(
      args.out,
      `${stringifyJson({
        normalized: stripRaw(normalized),
        effects,
        raw: fetched.raw,
      })}\n`,
    );
    console.error(`Wrote normalized + effects + raw JSON to ${args.out}`);
  }

  if (args.json) {
    console.log(stringifyJson(effects === null ? normalized : { ...normalized, ...{ effects } }));
    return EXIT_OK;
  }

  console.log(
    renderSummary(normalized, {
      includeLogs: args.includeLogs,
      includeActions: !args.noActions,
      onlyActions: args.actionsOnly,
      onlyEffects: args.effectsOnly,
      effects,
      fullAddresses: args.fullAddresses,
    }),
  );
  console.log(
    `  source: ${rpcEndpoint} (${commitment}, encoding ${fetched.provenance.encoding}) • ` +
      `raw payload ${byteSize(stringifyJson(fetched.raw, 0))} • use --json / --raw for full data`,
  );
  console.log('');
  return EXIT_OK;
}

/** `--json` embeds raw; keep `--out` useful without duplicating megabytes twice. */
function stripRaw(normalized: { raw: unknown }): unknown {
  const { raw: _raw, ...rest } = normalized;
  return rest;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error('Unexpected failure:', error);
    process.exit(70);
  });
