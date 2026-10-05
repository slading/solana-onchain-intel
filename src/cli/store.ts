#!/usr/bin/env node
/**
 * `npm run store -- <command> [options]`
 *
 * The corpus store CLI (Milestone 5.1). Five commands, one shared rule: **raw evidence is
 * the source of truth, and everything else is a versioned derivation of it.**
 *
 * ```
 * ingest <SIGNATURE> | --fixture <FILE>   fetch/load one transaction and store it
 * run <ADDRESS>                           ingest a bounded, resumable page of an address
 * print <SIGNATURE>                       render a stored transaction (no RPC, no network)
 * reanalyze [<SIGNATURE> | --all]         re-derive artifacts from the stored raw evidence
 * status                                  what the store holds
 * route-legs                              how much of the corpus's routed activity is covered
 * movement <ADDRESS>                      committed movement of one account, corpus-wide
 * ```
 *
 * `print` renders from stored artifacts only. It targets the same output as `npm run inspect`,
 * with one deliberate difference: a single trailing `store:` line reporting what the corpus
 * holds for that signature (fetch history, artifact versions, evidence quality), which
 * `--no-counts` removes. That line is the only difference — `scripts/verify-store-print.sh`
 * asserts it.
 *
 * Node ≥ 22.5 is required for this entry point: it uses the built-in `node:sqlite`
 * (no external database driver, no ORM). The M1–M4.4 `inspect` path still runs on Node ≥ 20.18.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { assertIsSignature, isSolanaError } from '@solana/kit';
import { byteSize } from '../lib/byte-size.ts';
import { stringifyJson } from '../lib/format.ts';
import { asRecord, asString } from '../lib/read-json.ts';
import { renderSummary } from '../render/summary.ts';
import { createRpc, resolveCommitment, resolveRpcUrl, TRANSACTION_REQUEST } from '../rpc/client.ts';
import { withoutRaw } from '../store/derive.ts';
import { DERIVED_SEMANTICS_VERSION } from '../store/version.ts';
import type { NormalizedProvenance } from '../model/transaction.ts';
import type {
  CorpusStore,
  FetchOutcome,
  IngestResult,
  StoreStats,
} from '../store/store.ts';

const EXIT_OK = 0;
const EXIT_NOT_FOUND = 1;
const EXIT_USAGE = 2;
const EXIT_ERROR = 3;
/** A retryable RPC failure (rate limit, transport) halted ingestion; retrying should work. */
const EXIT_RETRYABLE = 4;

const MINIMUM_NODE: readonly [number, number] = [22, 5];

const USAGE = `
Solana On-chain Intelligence Assistant — transaction corpus store

Usage:
  npm run store -- ingest <SIGNATURE> --store <FILE> [options]
  npm run store -- ingest --fixture <FILE> --store <FILE> [--rpc <url>] [--commitment <level>]
  npm run store -- run <ADDRESS> --store <FILE> [--max <n>] [options]
  npm run store -- print <SIGNATURE> --store <FILE> [options]
  npm run store -- reanalyze [<SIGNATURE> | --all] --store <FILE> [--stale-only] [--prune-old-versions]
  npm run store -- status --store <FILE> [--json]
  npm run store -- route-legs --store <FILE> [--json]
  npm run store -- movement <ADDRESS> --store <FILE> [--json]

Commands:
  ingest      Fetch one signature (or load a saved RPC response from --fixture) and store it.
              The raw evidence is kept once, at the best quality observed so far.
  run         Ingest up to --max signatures of an address, newest first, resumably. Already
              stored signatures are skipped without an RPC call. A retryable failure stops
              the run with the resumable cursor left before the failed signature.
  print       Render a stored transaction from stored artifacts. Never contacts the network.
  reanalyze   Re-derive normalized/effects/swaps/routes from the stored raw evidence. Never
              contacts the network; raw evidence is never modified. --all re-derives every
              stored transaction; --stale-only only those whose artifacts are missing or
              written under another semantics version.
  status      Show what the store holds (transactions, evidence, fetch history, versions).
  route-legs  Read the stored route artifacts and report how many dispatched legs the frozen
              swap recognizers cover, per (program id, discriminator). Never contacts the network.
  movement    Read the stored effects artifacts and sum the *committed* movement of one
              account: net lamports, fees paid, token nets per mint, and the committed flows.
              Reverted instructions contribute nothing but the fee. Never contacts the network.

Required:
  --store <FILE>       SQLite corpus file (created on first use)

Fetch options (ingest / run):
  --rpc <url>          RPC endpoint (default: $SOLANA_RPC_URL, else mainnet-beta)
  --commitment <level> processed | confirmed | finalized (default: $SOLANA_COMMITMENT, else confirmed)
  --max <n>            Maximum signatures to examine (run; default 20)
  --page-limit <n>     Signatures per page request (run; default 50)
  --json               Print the result as JSON

Print options (print):
  --json               Print the normalized model as JSON (includes the stored raw payload)
  --raw                Print only the stored raw payload as JSON
  --normalized         Print only the stored normalized artifact (no raw payload)
  --evidence           Print the raw-evidence row and its quality dimensions
  --fetch-history      Print every fetch attempt recorded for this signature
  --actions            Print only the ACTIONS section
  --effects            Print only the EFFECTS section
  --swaps              Print only the SWAPS section
  --routes             Print only the ROUTES section
  --full-addresses     Print exact addresses in ACTIONS/EFFECTS instead of abbreviated
  --no-actions         Omit the ACTIONS section
  --no-effects         Omit the EFFECTS section
  --no-swaps           Omit the SWAPS and ROUTES sections
  --no-routes          Omit the ROUTES section
  --no-logs            Omit program logs
  --no-counts          Omit the trailing "store:" counts line (output then matches inspect exactly)
  --out <file>         Also write { normalized, effects, swaps, routes, raw } JSON to <file>

Exit codes:
  0 success (stored, or already held)   1 signature not found / absent from the store
  2 usage error   3 RPC or store error   4 retryable RPC failure

Notes:
  Raw evidence is stored once per signature and is never overwritten by a weaker observation:
  commitment, meta presence, inner-instruction, token-balance, log and blockTime availability
  are compared explicitly, so storage order cannot change what is stored.
  Derived artifacts (normalized, effects, swaps, routes) are deterministic functions of the
  raw evidence and are versioned by derivation semantics (${DERIVED_SEMANTICS_VERSION}).
  Re-analysis never makes an RPC request, and storage never turns attempted movement into
  committed movement: a reverted transaction is stored and re-derived as the frozen M3/M4
  pipeline describes it, fee committed and instructions rolled back.
  Only Solana JSON-RPC is used: no third-party indexers, no LLMs.
  Node ≥ ${MINIMUM_NODE[0]}.${MINIMUM_NODE[1]} is required by this entry point (built-in node:sqlite).
`.trim();

type Command = 'ingest' | 'run' | 'print' | 'reanalyze' | 'status' | 'route-legs' | 'movement';

interface Args {
  command: Command | null;
  operand: string | null;
  store: string | null;
  fixture: string | null;
  rpcUrl: string | undefined;
  commitment: string | undefined;
  max: number | null;
  pageLimit: number | null;
  pruneOldVersions: boolean;
  all: boolean;
  staleOnly: boolean;
  json: boolean;
  raw: boolean;
  normalizedOnly: boolean;
  evidenceOnly: boolean;
  fetchHistory: boolean;
  includeLogs: boolean;
  actionsOnly: boolean;
  noActions: boolean;
  effectsOnly: boolean;
  noEffects: boolean;
  swapsOnly: boolean;
  noSwaps: boolean;
  routesOnly: boolean;
  noRoutes: boolean;
  fullAddresses: boolean;
  noCounts: boolean;
  out: string | null;
  help: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: null,
    operand: null,
    store: null,
    fixture: null,
    rpcUrl: undefined,
    commitment: undefined,
    max: null,
    pageLimit: null,
    pruneOldVersions: false,
    all: false,
    staleOnly: false,
    json: false,
    raw: false,
    normalizedOnly: false,
    evidenceOnly: false,
    fetchHistory: false,
    includeLogs: true,
    actionsOnly: false,
    noActions: false,
    effectsOnly: false,
    noEffects: false,
    swapsOnly: false,
    noSwaps: false,
    routesOnly: false,
    noRoutes: false,
    fullAddresses: false,
    noCounts: false,
    out: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--store':
        args.store = requireValue(argv, ++index, '--store');
        break;
      case '--fixture':
        args.fixture = requireValue(argv, ++index, '--fixture');
        break;
      case '--rpc':
        args.rpcUrl = requireValue(argv, ++index, '--rpc');
        break;
      case '--commitment':
        args.commitment = requireValue(argv, ++index, '--commitment');
        break;
      case '--max':
        args.max = requireInteger(argv, ++index, '--max');
        break;
      case '--page-limit':
        args.pageLimit = requireInteger(argv, ++index, '--page-limit');
        break;
      case '--out':
        args.out = requireValue(argv, ++index, '--out');
        break;
      case '--prune-old-versions':
        args.pruneOldVersions = true;
        break;
      case '--all':
        args.all = true;
        break;
      case '--stale-only':
        args.staleOnly = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--raw':
        args.raw = true;
        break;
      case '--normalized':
        args.normalizedOnly = true;
        break;
      case '--evidence':
        args.evidenceOnly = true;
        break;
      case '--fetch-history':
        args.fetchHistory = true;
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
      case '--swaps':
        args.swapsOnly = true;
        break;
      case '--no-swaps':
        args.noSwaps = true;
        break;
      case '--routes':
        args.routesOnly = true;
        break;
      case '--no-routes':
        args.noRoutes = true;
        break;
      case '--full-addresses':
        args.fullAddresses = true;
        break;
      case '--no-counts':
        args.noCounts = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (arg !== undefined && arg.startsWith('--')) throw new UsageError(`Unknown option "${arg}".`);
        if (args.command === null) {
          if (!isCommand(arg)) {
            throw new UsageError(
              `Unknown command "${arg ?? ''}". Expected ingest | run | print | reanalyze | status | route-legs | movement.`,
            );
          }
          args.command = arg;
        } else if (args.operand === null) {
          args.operand = arg ?? null;
        } else {
          throw new UsageError('Exactly one signature or address is expected.');
        }
    }
  }
  return args;
}

const COMMANDS: readonly Command[] = ['ingest', 'run', 'print', 'reanalyze', 'status', 'route-legs', 'movement'];

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} requires a value.`);
  return value;
}

function requireInteger(argv: readonly string[], index: number, flag: string): number {
  const value = requireValue(argv, index, flag);
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError(`${flag} expects a positive integer, got "${value}".`);
  }
  return Number(value);
}

/** Node version gate: `node:sqlite` is only available from 22.5. */
function nodeSupportsSqlite(): { readonly ok: boolean; readonly version: string } {
  const version = process.versions.node;
  const [major = 0, minor = 0] = version.split('.').map(part => Number(part));
  const ok =
    major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1]);
  return { ok, version };
}

/* ----------------------------------------------------------------- the store API -- */

/**
 * Loaded lazily so that a too-old Node reports a readable message instead of failing while
 * importing `node:sqlite`. Everything below this line needs the store module.
 */
async function loadStoreModule(): Promise<typeof import('../store/store.ts')> {
  return import('../store/store.ts');
}

function storePath(args: Args): string {
  if (args.store === null || args.store.trim() === '') {
    throw new UsageError('--store <FILE> is required: the store is the point of this command.');
  }
  return args.store;
}

/**
 * Checks what a command needs *before* the store file is opened.
 *
 * A usage error must not leave a new database behind: `store ingest --store x.db` with no
 * signature created an empty store the first time this was wired up.
 */
function validateArgs(args: Args): void {
  storePath(args);
  switch (args.command) {
    case 'ingest':
      if (args.operand === null && args.fixture === null) {
        throw new UsageError('ingest needs a signature, or --fixture <FILE>.');
      }
      return;
    case 'run':
      if (args.operand === null) throw new UsageError('run needs an address to ingest.');
      return;
    case 'print':
    case 'movement':
      if (args.operand === null) {
        throw new UsageError(`${args.command} needs ${args.command === 'movement' ? 'an account address' : 'a signature'}.`);
      }
      return;
    case 'reanalyze':
      if (!args.all && args.operand === null) {
        throw new UsageError('reanalyze needs a signature, or --all for every stored transaction.');
      }
      return;
    case 'status':
    case 'route-legs':
      return;
  }
}

/* ------------------------------------------------------------------------ ingest -- */

/**
 * A saved fixture, as `scripts/harvest-fixtures.mjs` writes them:
 * `{ provenance: {source, method, fetchedAtUtc, note}, request: {signature, config}, response }`.
 */
interface FixtureEnvelope {
  readonly response: unknown;
  readonly provenance?: Record<string, unknown>;
  readonly request?: { readonly signature?: string; readonly config?: Record<string, unknown> };
}

/**
 * The provenance of a fixture is reconstructed from the request that produced it, not
 * invented: the fixtures record the endpoint they came from and the exact config they were
 * fetched with, so a stored fixture and a live `inspect` run of the same transaction agree on
 * every provenance field — which is what makes their output comparable at all.
 */
function provenanceOfFixture(
  envelope: FixtureEnvelope,
  fallback: NormalizedProvenance,
): NormalizedProvenance {
  const source = asString(envelope.provenance?.['source']);
  const config = envelope.request?.config ?? {};
  const commitment = config['commitment'];
  const version = config['maxSupportedTransactionVersion'];
  return {
    rpcEndpoint: source ?? fallback.rpcEndpoint,
    encoding: TRANSACTION_REQUEST.encoding,
    commitment:
      commitment === 'processed' || commitment === 'confirmed' || commitment === 'finalized'
        ? commitment
        : fallback.commitment,
    maxSupportedTransactionVersion: version === 0 || version === 1 ? version : 1,
  };
}

function readFixture(path: string): FixtureEnvelope {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`--fixture could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--fixture is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = asRecord(parsed);
  if (record === null) throw new UsageError('--fixture must contain a JSON object.');

  // Two accepted shapes: a saved fixture envelope {provenance, request, response}, or the
  // bare getTransaction result. The bare shape is what `inspect --raw` prints.
  if (record['response'] !== undefined) {
    const request = asRecord(record['request']);
    const provenance = asRecord(record['provenance']);
    return {
      response: record['response'],
      ...(provenance === null ? {} : { provenance }),
      ...(request === null
        ? {}
        : {
            request: {
              ...(asString(request['signature']) === null ? {} : { signature: asString(request['signature']) as string }),
              ...(asRecord(request['config']) === null ? {} : { config: asRecord(request['config']) as Record<string, unknown> }),
            },
          }),
    };
  }
  return { response: parsed };
}

function describeIngest(result: IngestResult): string {
  return `${result.signature} -> ${result.outcome}: ${result.detail}`;
}

async function commandIngest(store: CorpusStore, args: Args): Promise<number> {
  const module = await loadStoreModule();
  const rpcEndpoint = resolveRpcUrl(args.rpcUrl);
  const commitment = resolveCommitment(args.commitment);

  if (args.fixture !== null) {
    const fixture = readFixture(args.fixture);
    const provenance = provenanceOfFixture(fixture, {
      rpcEndpoint,
      encoding: TRANSACTION_REQUEST.encoding,
      commitment,
      maxSupportedTransactionVersion: TRANSACTION_REQUEST.maxSupportedTransactionVersion,
    });
    const expected = fixture.request?.signature;
    const result = module.ingestRawResponse(store, {
      raw: fixture.response,
      provenance,
      ...(expected === undefined ? {} : { expectSignature: expected }),
    });
    if (args.json) console.log(stringifyJson(result));
    else console.log(describeIngest(result));
    return exitCodeFor(result);
  }

  if (args.operand === null) {
    throw new UsageError('ingest needs a signature, or --fixture <FILE>.');
  }
  try {
    assertIsSignature(args.operand);
  } catch (error) {
    console.error(
      `"${args.operand}" is not a valid Solana transaction signature` +
        `${isSolanaError(error) ? `: ${error.message}` : '.'}`,
    );
    return EXIT_USAGE;
  }

  const result = await module.ingestSignature(store, {
    rpc: createRpc(rpcEndpoint),
    signature: args.operand,
    rpcEndpoint,
    commitment,
  });
  if (args.json) console.log(stringifyJson(result));
  else console.log(describeIngest(result));

  return exitCodeFor(result);
}

/**
 * The exit code follows the *outcome*, not whether anything changed: re-ingesting a
 * transaction the store already holds is a success, not a failure.
 */
function exitCodeFor(result: IngestResult): number {
  switch (result.outcome) {
    case 'normalization-error':
      return EXIT_ERROR;
    case 'not-found':
      return EXIT_NOT_FOUND;
    case 'rpc-error':
      return result.retryable ? EXIT_RETRYABLE : EXIT_ERROR;
    case 'stored':
    case 'stored-upgraded':
    case 'unchanged-equal-quality':
    case 'skipped-lower-quality':
      return EXIT_OK;
  }
}

/* --------------------------------------------------------------------------- run -- */

async function commandRun(store: CorpusStore, args: Args): Promise<number> {
  const module = await loadStoreModule();
  if (args.operand === null) throw new UsageError('run needs an address to ingest.');
  const rpcEndpoint = resolveRpcUrl(args.rpcUrl);
  const commitment = resolveCommitment(args.commitment);
  const max = args.max ?? 20;

  const result = await module.ingestAddress(store, {
    rpc: createRpc(rpcEndpoint),
    address: args.operand,
    max,
    rpcEndpoint,
    commitment,
    ...(args.pageLimit === null ? {} : { pageLimit: args.pageLimit }),
    onEvent: event => {
      if (!args.json) console.log(`  ${event.kind}: ${event.message}`);
    },
  });

  if (args.json) console.log(stringifyJson(result));
  else {
    console.log(
      `${result.address}: examined ${result.examined} signature(s) over ${result.pages} page(s) — ` +
        `${result.stored} stored, ${result.upgraded} upgraded, ${result.alreadyPresent} already stored, ` +
        `${result.skippedPresent} skipped (no RPC), ${result.notFound} not found, ${result.errors} error(s)` +
        `${result.complete ? ', history exhausted' : ''}`,
    );
    if (result.detail !== null) console.error(`stopped: ${result.detail}`);
  }
  return result.retryable ? EXIT_RETRYABLE : EXIT_OK;
}

/* ------------------------------------------------------------------------- print -- */

interface FetchHistoryRow {
  readonly id: number;
  readonly outcome: FetchOutcome;
  readonly retryable: boolean;
  readonly commitment: string;
  readonly endpoint: string;
  readonly detail: string | null;
  readonly observedAt: string;
}

function readFetchHistory(store: CorpusStore, signature: string): readonly FetchHistoryRow[] {
  return store.database
    .prepare(
      `SELECT id, outcome, retryable, commitment, endpoint, detail, observed_at
       FROM fetches WHERE signature = ? ORDER BY id`,
    )
    .all(signature)
    .map(row => ({
      id: Number(row['id']),
      outcome: String(row['outcome']) as FetchOutcome,
      retryable: Number(row['retryable']) !== 0,
      commitment: String(row['commitment']),
      endpoint: String(row['endpoint']),
      detail: row['detail'] === null ? null : String(row['detail']),
      observedAt: String(row['observed_at']),
    }));
}

async function commandPrint(store: CorpusStore, args: Args): Promise<number> {
  const module = await loadStoreModule();
  if (args.operand === null) throw new UsageError('print needs a signature.');
  const signature = args.operand;

  const stored = module.getStoredTransaction(store, signature);
  if (stored === null) {
    console.error(`Signature ${signature} is not in ${store.path}.`);
    const history = readFetchHistory(store, signature);
    if (history.length > 0) {
      console.error('Recorded fetch attempts (no evidence was stored):');
      for (const entry of history) {
        console.error(`  #${entry.id} ${entry.outcome}${entry.retryable ? ' (retryable)' : ''}: ${entry.detail ?? ''}`);
      }
    } else {
      console.error('No fetch was ever recorded for it: run `npm run store -- ingest` first.');
    }
    return EXIT_NOT_FOUND;
  }

  if (args.evidenceOnly) {
    const evidence = module.loadRawEvidence(store, signature);
    const payload = store.database
      .prepare(
        `SELECT raw_sha256, encoding, commitment, rpc_endpoint, max_supported_tx_version,
                meta_present, inner_instructions_available, token_balances_available,
                block_time_available, logs_present, length(raw_text) AS chars, observed_at
         FROM raw_responses WHERE signature = ?`,
      )
      .get(signature);
    console.log(
      stringifyJson({
        signature,
        sha256: evidence?.rawSha256 ?? null,
        codecVersion: evidence?.rawCodecVersion ?? null,
        payloadBytes: byteSize(stringifyJson(evidence?.raw ?? null, 0)),
        stored: payload,
        quality: stored.evidence.quality,
        fetchOutcome: readFetchHistory(store, signature).map(entry => entry.outcome),
      }),
    );
    return EXIT_OK;
  }

  if (args.fetchHistory) {
    console.log(stringifyJson(readFetchHistory(store, signature)));
    return EXIT_OK;
  }

  const normalized = module.loadTransactionModel(store, signature);
  if (normalized === null) {
    console.error(`Signature ${signature} has no derived normalized artifact at ${store.semanticsVersion}.`);
    console.error('Run `npm run store -- reanalyze` to re-derive it from the stored raw evidence.');
    return EXIT_ERROR;
  }
  const evidence = module.loadRawEvidence(store, signature);
  if (evidence === null) {
    console.error(`Signature ${signature} has no stored raw evidence; the store is inconsistent.`);
    return EXIT_ERROR;
  }

  if (args.raw) {
    console.error(
      'note: stored raw payload as decoded by @solana/kit (u64 values are bigint, printed as ' +
        'decimal strings; use --out to save it)',
    );
    console.log(stringifyJson(evidence.raw));
    return EXIT_OK;
  }
  if (args.normalizedOnly) {
    console.log(stringifyJson(module.loadNormalizedArtifact(store, signature)));
    return EXIT_OK;
  }

  const effects = args.noEffects ? null : module.loadEffectsArtifact(store, signature);
  const swaps =
    args.noSwaps || args.effectsOnly ? null : module.loadSwapsArtifact(store, signature);
  const routes =
    args.noRoutes || args.effectsOnly || (args.noSwaps && !args.routesOnly)
      ? null
      : module.loadRoutesArtifact(store, signature);

  if (args.out !== null) {
    writeFileSync(
      args.out,
      `${stringifyJson({
        normalized: withoutRaw(normalized),
        effects,
        swaps,
        routes,
        raw: evidence.raw,
      })}\n`,
    );
    console.error(`Wrote normalized + effects + swaps + routes + raw JSON to ${args.out}`);
  }

  if (args.json) {
    const payload = {
      ...normalized,
      ...(effects === null ? {} : { effects }),
      ...(swaps === null ? {} : { swaps }),
      ...(routes === null ? {} : { routes }),
    };
    console.log(
      stringifyJson(effects === null && swaps === null && routes === null ? normalized : payload),
    );
    return EXIT_OK;
  }

  console.log(
    renderSummary(normalized, {
      includeLogs: args.includeLogs,
      includeActions: !args.noActions,
      onlyActions: args.actionsOnly,
      onlyEffects: args.effectsOnly,
      onlySwaps: args.swapsOnly,
      onlyRoutes: args.routesOnly,
      effects,
      swaps,
      routes,
      fullAddresses: args.fullAddresses,
    }),
  );
  if (!args.noCounts) console.log(storeCountsLine(store, signature));
  console.log(
    `  source: ${evidence.provenance.rpcEndpoint} (${evidence.provenance.commitment}, encoding ` +
      `${evidence.provenance.encoding}) • raw payload ${byteSize(stringifyJson(evidence.raw, 0))} • ` +
      'use --json / --raw for full data',
  );
  console.log('');
  return EXIT_OK;
}

/**
 * The one line `print` adds that `inspect` cannot have: what the corpus holds for this
 * signature. `--no-counts` removes it, making the output byte-identical to `inspect`.
 */
function storeCountsLine(store: CorpusStore, signature: string): string {
  const history = readFetchHistory(store, signature);
  const stored = getStoredRow(store, signature);
  const layers = store.database
    .prepare('SELECT COUNT(*) AS n FROM derived WHERE signature = ? AND semantics_version = ?')
    .get(signature, store.semanticsVersion);
  return (
    `  store: ${store.path} • observations ${stored?.observationCount ?? 0} • fetches ${history.length} ` +
    `(${history.map(entry => entry.outcome).join(', ')}) • derived ${Number(layers?.['n'] ?? 0)}/4 @ ` +
    `${store.semanticsVersion}`
  );
}

function getStoredRow(store: CorpusStore, signature: string): { observationCount: number } | null {
  const row = store.database
    .prepare('SELECT observation_count FROM transactions WHERE signature = ?')
    .get(signature);
  return row === undefined ? null : { observationCount: Number(row['observation_count']) };
}

/* --------------------------------------------------------------------- reanalyze -- */

async function commandReanalyze(store: CorpusStore, args: Args): Promise<number> {
  const module = await loadStoreModule();
  const options = { pruneOlderVersions: args.pruneOldVersions };

  if (args.all || args.operand === null) {
    if (!args.all) {
      throw new UsageError('reanalyze needs a signature, or --all for every stored transaction.');
    }
    // `--all` means every stored transaction; `--stale-only` narrows that to the ones whose
    // artifacts are missing or from an older semantics version.
    const summary = module.reanalyzeAll(store, { ...options, onlyStale: args.staleOnly });
    if (args.json) console.log(stringifyJson(summary));
    else {
      console.log(
        `reanalyzed ${summary.reanalyzed}/${summary.requested} transaction(s) at ${store.semanticsVersion}` +
          `${summary.failed > 0 ? `, ${summary.failed} failed` : ''}` +
          `${summary.skippedNoEvidence > 0 ? `, ${summary.skippedNoEvidence} without evidence` : ''}`,
      );
      for (const result of summary.results) {
        if (result.outcome !== 'reanalyzed') console.log(`  ${result.signature}: ${result.outcome} — ${result.detail}`);
      }
    }
    return summary.failed > 0 ? EXIT_ERROR : EXIT_OK;
  }

  const result = module.reanalyzeSignature(store, args.operand, options);
  if (args.json) console.log(stringifyJson(result));
  else console.log(`${result.signature} -> ${result.outcome}: ${result.detail}`);
  if (result.outcome === 'failed') return EXIT_ERROR;
  if (result.outcome === 'skipped-no-evidence') return EXIT_NOT_FOUND;
  return EXIT_OK;
}

/* ----------------------------------------------------------------------- queries -- */

async function commandRouteLegs(store: CorpusStore, args: Args): Promise<number> {
  const { routeLegCoverage } = await import('../store/queries.ts');
  const coverage = routeLegCoverage(store);
  if (args.json) {
    console.log(
      stringifyJson({
        ...coverage,
        // A bigint-free view for JSON consumers that prefer a number they can read.
        coveredPercent: coverage.coveredShare === null ? null : Number((coverage.coveredShare * 100).toFixed(1)),
      }),
    );
    return EXIT_OK;
  }
  console.log(
    `route legs: ${coverage.legs} dispatched leg(s) across ${coverage.routes} recognized route(s) — ` +
      `${coverage.covered} covered by a frozen swap recognizer` +
      `${coverage.coveredShare === null ? '' : ` (${(coverage.coveredShare * 100).toFixed(1)}%)`}`,
  );
  for (const row of coverage.classes) {
    console.log(
      `  ${row.covered}/${row.total}  ${row.key}${row.protocols.length === 0 ? '  — uncovered' : `  (${row.protocols.join(', ')})`}`,
    );
  }
  if (coverage.withoutCurrentRoutes.length > 0) {
    console.log(`  ${coverage.withoutCurrentRoutes.length} transaction(s) without current route artifacts`);
  }
  return EXIT_OK;
}

async function commandMovement(store: CorpusStore, args: Args): Promise<number> {
  const { committedMovementByAccount } = await import('../store/queries.ts');
  if (args.operand === null) throw new UsageError('movement needs an account address.');
  const movement = committedMovementByAccount(store, args.operand);
  if (args.json) {
    console.log(stringifyJson(movement));
    return EXIT_OK;
  }
  console.log(`committed movement of ${movement.address} across ${movement.transactions} transaction(s)`);
  console.log(`  net lamports:  ${movement.netLamports}`);
  console.log(`  fees paid:      ${movement.committedFeeLamports}`);
  if (movement.unknownNetLamports > 0) {
    console.log(`  unknown nets:   ${movement.unknownNetLamports} transaction(s) where the net could not be computed`);
  }
  for (const token of movement.netTokensByMint) {
    console.log(`  token ${token.mint ?? '(unknown mint)'}: ${token.netAmount} (${token.accounts} account(s))`);
  }
  for (const token of movement.netTokensByOwnedAccounts) {
    console.log(`  owned ${token.mint ?? '(unknown mint)'}: ${token.netAmount}`);
  }
  console.log(`  counted from:  ${movement.signatures.length} signature(s)`);
  console.log(`  not counted:   ${movement.exclusions.join('; ')}`);
  return EXIT_OK;
}

/* ------------------------------------------------------------------------ status -- */

function renderStats(stats: StoreStats): string {
  const lines = [
    `store:            ${stats.path}`,
    `format version:   ${stats.formatVersion}`,
    `semantics:        ${stats.semanticsVersion}`,
    `transactions:     ${stats.transactions}`,
    `  by status:      ${Object.entries(stats.byStatus).map(([key, value]) => `${key} ${value}`).join(', ') || 'none'}`,
    `  meta present:   ${stats.evidence.metaPresent}`,
    `  inner ixs:      ${stats.evidence.innerInstructionsAvailable}`,
    `  token balances: ${stats.evidence.tokenBalancesAvailable}`,
    `  block time:     ${stats.evidence.blockTimeAvailable}`,
    `fetches:          ${stats.fetches.total}`,
    `  by outcome:     ${Object.entries(stats.fetches.byOutcome).map(([key, value]) => `${key} ${value}`).join(', ') || 'none'}`,
    `derived rows:     ${stats.derived.rows} (${stats.derived.currentVersionRows} current, ${stats.derived.staleRows} stale)`,
    `  needing re-analysis: ${stats.derived.signaturesNeedingReanalysis}`,
  ];
  for (const cursor of stats.cursors) {
    lines.push(
      `cursor ${cursor.address}: seen ${cursor.signaturesSeen} over ${cursor.pagesFetched} page(s)` +
        `${cursor.complete ? ' (complete)' : `, before ${cursor.beforeSignature ?? '(newest)'}`}`,
    );
  }
  return lines.join('\n');
}

async function commandStatus(store: CorpusStore, args: Args): Promise<number> {
  const module = await loadStoreModule();
  const stats = module.storeStats(store);
  if (args.json) console.log(stringifyJson(stats));
  else console.log(renderStats(stats));
  return EXIT_OK;
}

/* -------------------------------------------------------------------------- main -- */

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${USAGE}`);
    return EXIT_USAGE;
  }

  if (args.help || args.command === null) {
    console.log(USAGE);
    return args.help ? EXIT_OK : EXIT_USAGE;
  }

  const support = nodeSupportsSqlite();
  if (!support.ok) {
    console.error(
      `This command needs Node >= ${MINIMUM_NODE[0]}.${MINIMUM_NODE[1]} for the built-in node:sqlite ` +
        `module; this process is Node ${support.version}.`,
    );
    console.error('The `inspect` command (npm run inspect) still works on Node >= 20.18.');
    return EXIT_USAGE;
  }

  let store: CorpusStore;
  try {
    validateArgs(args);
    const module = await loadStoreModule();
    store = module.openCorpusStore(storePath(args));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(`\n${USAGE}`);
      return EXIT_USAGE;
    }
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_ERROR;
  }

  try {
    switch (args.command) {
      case 'ingest':
        return await commandIngest(store, args);
      case 'run':
        return await commandRun(store, args);
      case 'print':
        return await commandPrint(store, args);
      case 'reanalyze':
        return await commandReanalyze(store, args);
      case 'status':
        return await commandStatus(store, args);
      case 'route-legs':
        return await commandRouteLegs(store, args);
      case 'movement':
        return await commandMovement(store, args);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(`\n${USAGE}`);
      return EXIT_USAGE;
    }
    console.error('Unexpected failure:', error);
    return EXIT_ERROR;
  } finally {
    store.close();
  }
}

// `process.exit()` would not flush a large `console.log` payload written to a pipe — it
// truncates intermittently under load — so the exit status is set and the process is left to
// finish on its own, with nothing else keeping the loop alive (the store is closed above).
main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    console.error('Unexpected failure:', error);
    process.exitCode = 70;
  });
