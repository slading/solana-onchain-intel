import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedProvenance, NormalizedTransaction } from '../../src/model/transaction.ts';
import { normalizeTransaction } from '../../src/normalize/transaction.ts';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

export interface FixtureEnvelope {
  readonly provenance: { readonly source: string; readonly note: string; readonly fetchedAtUtc: string };
  readonly request: { readonly signature: string; readonly config: Record<string, unknown> };
  /** The raw `getTransaction` result, exactly as the RPC sent it. */
  readonly response: unknown;
}

export function loadFixture(name: string): FixtureEnvelope {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), 'utf8')) as FixtureEnvelope;
}

export function allFixtureNames(): readonly string[] {
  return readdirSync(FIXTURE_DIR)
    .filter(file => file.endsWith('.json'))
    .map(file => file.replace(/\.json$/, ''))
    .sort();
}

export function normalizeFixture(name: string): {
  envelope: FixtureEnvelope;
  transaction: NormalizedTransaction;
} {
  const envelope = loadFixture(name);
  const provenance: NormalizedProvenance = {
    rpcEndpoint: envelope.provenance.source,
    encoding: 'jsonParsed',
    commitment: 'finalized',
    maxSupportedTransactionVersion: 1,
  };
  return { envelope, transaction: normalizeTransaction(envelope.response, { provenance }) };
}
