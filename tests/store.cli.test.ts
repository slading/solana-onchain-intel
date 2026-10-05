/**
 * The storage CLI, as a process (Milestone 5.1).
 *
 * Everything here runs the real entry point — `tsx src/cli/store.ts` — against a throwaway
 * store file, and asserts the two things a CLI must get right that a library test cannot:
 * exit codes, and the bytes it prints. The `print --json` comparison is the offline half of
 * "stored print ≡ inspect": the payload must be byte-identical to what the inspect CLI
 * renders for the same transaction. `scripts/verify-store-print.sh` covers the text output
 * of all 13 fixtures with both CLIs and a mock RPC server.
 *
 * No network: ingestion here is always `--fixture`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringifyJson } from '../src/lib/format.ts';
import { normalizeTransaction } from '../src/normalize/transaction.ts';
import { transactionEffects } from '../src/effects/build.ts';
import { recognizeSwaps } from '../src/swap/recognize-swaps.ts';
import { recognizeRoutes } from '../src/route/recognize-routes.ts';
import { loadFixture } from './helpers/fixtures.ts';
import { fixtureFilePath } from './helpers/store.ts';
import { sqliteAvailable } from './helpers/store.ts';

const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(process.cwd(), 'src', 'cli', 'store.ts');
const FIXTURE = 'v0-success-pump-buy-24b';
const FAILED_FIXTURE = 'v0-failed-pump-buy-slippage';

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runStore(args: readonly string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [TSX, CLI, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

function withStoreFile<T>(body: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'solana-store-cli-'));
  try {
    return body(join(directory, 'corpus.db'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function ingestFixture(store: string, name: string): RunResult {
  return runStore(['ingest', '--fixture', fixtureFilePath(name), '--store', store]);
}

/** The payload `npm run inspect -- <sig> --json` prints, computed in-process. */
function inspectPayload(name: string): string {
  const envelope = loadFixture(name);
  const transaction = normalizeTransaction(envelope.response, {
    provenance: {
      rpcEndpoint: envelope.provenance.source,
      encoding: 'jsonParsed',
      commitment: 'finalized',
      maxSupportedTransactionVersion: 1,
    },
  });
  const effects = transactionEffects(transaction);
  const swaps = recognizeSwaps(transaction, { effects });
  return stringifyJson({ ...transaction, effects, swaps, routes: recognizeRoutes(transaction, { swaps }) });
}

describe.skipIf(!sqliteAvailable)('storage CLI', () => {
  it('prints usage, and refuses what it cannot do', () => {
    const help = runStore(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('ingest');
    expect(help.stdout).toContain('reanalyze');
    expect(help.stdout).toContain('--store');

    // A usage error must not create a store file: these paths never exist.
    const absent = join(tmpdir(), 'solana-store-cli-never-created', 'x.db');

    expect(runStore([]).status).toBe(2);
    expect(runStore(['teleport', '--store', absent]).status).toBe(2);
    expect(runStore(['teleport', '--store', absent]).stderr).toContain('Unknown command');

    const noStore = runStore(['status']);
    expect(noStore.status).toBe(2);
    expect(noStore.stderr).toContain('--store <FILE> is required');

    expect(runStore(['ingest', '--store', absent]).status).toBe(2);
    expect(runStore(['movement', '--store', absent]).status).toBe(2);
    expect(existsSync(absent)).toBe(false);
  });

  it('ingests a fixture offline, twice, with a success code both times', () => {
    withStoreFile(store => {
      const first = ingestFixture(store, FIXTURE);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('stored');
      expect(first.stdout).toContain('finalized; completeness 15/15');

      // Idempotent: the same command again is still a success, and says why.
      const second = ingestFixture(store, FIXTURE);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('unchanged-equal-quality');
      expect(second.stdout).toContain('byte-identical');

      const status = runStore(['status', '--store', store, '--json']);
      expect(status.status).toBe(0);
      const stats = JSON.parse(status.stdout) as {
        transactions: number;
        derived: { currentVersionRows: number; rows: number; signaturesNeedingReanalysis: number };
        fetches: { total: number; byOutcome: Record<string, number> };
        byStatus: Record<string, number>;
      };
      expect(stats.transactions).toBe(1);
      expect(stats.derived).toEqual({ rows: 4, currentVersionRows: 4, staleRows: 0, signaturesNeedingReanalysis: 0 });
      expect(stats.fetches.total).toBe(2);
      expect(stats.fetches.byOutcome).toEqual({ stored: 1, 'unchanged-equal-quality': 1 });
      expect(stats.byStatus).toEqual({ success: 1 });
    });
  });

  it('prints a stored transaction as the same JSON payload inspect prints', () => {
    withStoreFile(store => {
      const envelope = loadFixture(FIXTURE);
      expect(ingestFixture(store, FIXTURE).status).toBe(0);

      const printed = runStore(['print', envelope.request.signature, '--store', store, '--json']);
      expect(printed.status).toBe(0);
      expect(printed.stdout).toBe(`${inspectPayload(FIXTURE)}\n`);
    });
  });

  it('adds exactly one line to that output in text mode, and can drop it', () => {
    withStoreFile(store => {
      const envelope = loadFixture(FIXTURE);
      ingestFixture(store, FIXTURE);

      const withCounts = runStore(['print', envelope.request.signature, '--store', store]).stdout;
      const withoutCounts = runStore([
        'print',
        envelope.request.signature,
        '--store',
        store,
        '--no-counts',
      ]).stdout;

      const countsLine = withCounts.split('\n').filter(line => line.startsWith('  store: '));
      expect(countsLine).toHaveLength(1);
      expect(countsLine[0]).toContain(store);
      expect(countsLine[0]).toContain('fetches 1');

      const stripped = withCounts
        .split('\n')
        .filter(line => !line.startsWith('  store: '))
        .join('\n');
      expect(stripped).toBe(withoutCounts);
      expect(withoutCounts.includes('  store: ')).toBe(false);
      expect(withoutCounts).toContain('source:');
    });
  });

  it('supports the same section and payload flags as inspect', () => {
    withStoreFile(store => {
      const envelope = loadFixture(FIXTURE);
      ingestFixture(store, FIXTURE);

      const raw = runStore(['print', envelope.request.signature, '--store', store, '--raw']);
      expect(raw.status).toBe(0);
      expect(JSON.parse(raw.stdout)).toEqual(envelope.response);

      const normalizedOnly = runStore([
        'print',
        envelope.request.signature,
        '--store',
        store,
        '--normalized',
      ]);
      expect(normalizedOnly.status).toBe(0);
      expect('raw' in (JSON.parse(normalizedOnly.stdout) as object)).toBe(false);

      const effectsOnly = runStore(['print', envelope.request.signature, '--store', store, '--effects']);
      expect(effectsOnly.status).toBe(0);
      expect(effectsOnly.stdout).toContain('EFFECTS');

      const evidence = JSON.parse(
        runStore(['print', envelope.request.signature, '--store', store, '--evidence']).stdout,
      ) as { quality: { commitment: string }; codecVersion: number; fetchOutcome: readonly string[] };
      expect(evidence.quality.commitment).toBe('finalized');
      expect(evidence.codecVersion).toBe(1);
      expect(evidence.fetchOutcome).toEqual(['stored']);

      const history = JSON.parse(
        runStore(['print', envelope.request.signature, '--store', store, '--fetch-history']).stdout,
      ) as readonly { outcome: string }[];
      expect(history.map(entry => entry.outcome)).toEqual(['stored']);
    });
  });

  it('says what it knows about a signature it does not hold', () => {
    withStoreFile(store => {
      const absent = runStore(['print', 'not-in-this-store', '--store', store]);
      expect(absent.status).toBe(1);
      expect(absent.stderr).toContain('is not in');
      expect(absent.stderr).toContain('ingest');
    });
  });

  it('reports a failed transaction as failed, from stored evidence only', () => {
    withStoreFile(store => {
      const envelope = loadFixture(FAILED_FIXTURE);
      expect(ingestFixture(store, FAILED_FIXTURE).status).toBe(0);

      const printed = runStore(['print', envelope.request.signature, '--store', store, '--json']);
      expect(printed.status).toBe(0);
      const payload = JSON.parse(printed.stdout) as {
        status: string;
        effects: { commitState: string; tokenFlows: readonly unknown[] };
        route: unknown;
      };
      expect(payload.status).toBe('failed');
      expect(payload.effects.commitState).toBe('reverted');
      expect(payload.effects.tokenFlows).toEqual([]);
    });
  });

  it('re-analyses from stored evidence with no network and no change to the evidence', () => {
    withStoreFile(store => {
      const envelope = loadFixture(FIXTURE);
      ingestFixture(store, FIXTURE);
      const before = runStore(['print', envelope.request.signature, '--store', store, '--json']).stdout;

      const reanalyze = runStore(['reanalyze', '--all', '--store', store]);
      expect(reanalyze.status).toBe(0);
      expect(reanalyze.stdout).toContain('reanalyzed 1/1');

      // `--stale-only` finds nothing to do, because everything is already current.
      const staleOnly = runStore(['reanalyze', '--all', '--stale-only', '--store', store]);
      expect(staleOnly.status).toBe(0);
      expect(staleOnly.stdout).toContain('reanalyzed 0/0');

      const after = runStore(['print', envelope.request.signature, '--store', store, '--json']).stdout;
      expect(after).toBe(before);

      // Without a signature and without --all there is nothing to do, and the CLI says so.
      const usage = runStore(['reanalyze', '--store', store]);
      expect(usage.status).toBe(2);
      expect(usage.stderr).toContain('--all');

      const absent = runStore(['reanalyze', 'not-in-this-store', '--store', store]);
      expect(absent.status).toBe(1);
      expect(absent.stdout).toContain('skipped-no-evidence');
    });
  });

  it('refuses a malformed signature before touching the network or the store', () => {
    withStoreFile(store => {
      const result = runStore(['ingest', 'not-a-signature', '--store', store]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('not a valid Solana transaction signature');
      const status = JSON.parse(runStore(['status', '--store', store, '--json']).stdout) as {
        fetches: { total: number };
      };
      expect(status.fetches.total).toBe(0);
    });
  });

  it('answers the two corpus questions from stored artifacts, in text and JSON', () => {
    withStoreFile(store => {
      ingestFixture(store, FIXTURE);
      ingestFixture(store, 'v0-success-dlmm-minout');
      ingestFixture(store, 'v1-failed-custom6001'); // carries a route_v2 envelope
      ingestFixture(store, 'v0-failed-pump-buy-slippage'); // the reverted transaction below

      const legs = runStore(['route-legs', '--store', store, '--json']);
      expect(legs.status).toBe(0);
      const coverage = JSON.parse(legs.stdout) as {
        routes: number;
        legs: number;
        covered: number;
        coveredPercent: number | null;
        withoutCurrentRoutes: readonly string[];
      };
      expect(coverage.routes).toBeGreaterThan(0);
      expect(coverage.legs).toBeGreaterThanOrEqual(coverage.covered);
      expect(coverage.withoutCurrentRoutes).toEqual([]);

      const movement = runStore([
        'movement',
        '41n8gyoVAuDjZdUeHRGrPscG2DzJawDHpa1Y6VLV4VqJ',
        '--store',
        store,
        '--json',
      ]);
      expect(movement.status).toBe(0);
      const totals = JSON.parse(movement.stdout) as {
        netLamports: string;
        committedFeeLamports: string;
        signatures: readonly string[];
        exclusions: readonly string[];
      };
      // JSON cannot carry a bigint, so exact integers arrive as decimal strings.
      expect(totals.netLamports).toBe('-24386');
      expect(totals.committedFeeLamports).toBe('24386');
      expect(totals.signatures).toHaveLength(1);
      expect(totals.exclusions.length).toBeGreaterThan(0);

      const text = runStore(['movement', '41n8gyoVAuDjZdUeHRGrPscG2DzJawDHpa1Y6VLV4VqJ', '--store', store]);
      expect(text.stdout).toContain('net lamports:  -24386');
      expect(text.stdout).toContain('not counted:');

      expect(runStore(['movement', '--store', store]).status).toBe(2);
    });
  });

  it('prints the movement of an account with no committed activity as zero, never as a guess', () => {
    withStoreFile(store => {
      ingestFixture(store, 'v0-failed-pump-buy-slippage');
      const attemptedRecipient = runStore([
        'movement',
        'Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3',
        '--store',
        store,
        '--json',
      ]);
      const totals = JSON.parse(attemptedRecipient.stdout) as {
        netLamports: string;
        committedSolFlows: readonly unknown[];
        signatures: readonly string[];
      };
      expect(totals.netLamports).toBe('0');
      expect(attemptedRecipient.status).toBe(0);
      expect(totals.committedSolFlows).toEqual([]);
      expect(totals.signatures).toEqual([]);
    });
  });

  it('appends to a fetch history across runs without rewriting evidence', () => {
    withStoreFile(store => {
      ingestFixture(store, FIXTURE);
      ingestFixture(store, FIXTURE);
      ingestFixture(store, FIXTURE);

      const status = JSON.parse(runStore(['status', '--store', store, '--json']).stdout) as {
        fetches: { total: number; byOutcome: Record<string, number> };
        derived: { rows: number };
      };
      expect(status.fetches.total).toBe(3);
      expect(status.fetches.byOutcome).toEqual({ stored: 1, 'unchanged-equal-quality': 2 });
      expect(status.derived.rows).toBe(4);
    });
  });
});
