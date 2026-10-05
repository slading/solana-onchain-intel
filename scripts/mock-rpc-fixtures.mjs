#!/usr/bin/env node
/**
 * A local, offline JSON-RPC node that serves the recorded fixtures.
 *
 * It exists so the two CLIs can be compared byte for byte without touching the network:
 * `inspect` needs a node, and the storage CLI needs one whenever a transaction is fetched
 * rather than loaded from a file. Both then see exactly the same response, from the same
 * endpoint, at the same commitment — which is what makes `npm run store -- print` and
 * `npm run inspect` comparable at all.
 *
 * ```
 * node scripts/mock-rpc-fixtures.mjs [port] [fixtureDir]
 * ```
 *
 * `getTransaction` answers with the fixture whose `request.signature` matches (and `null` for
 * anything else, exactly as a node that never saw a transaction does).
 * `getSignaturesForAddress` answers with an empty history: address ingestion is exercised in
 * the test suite against a scripted fake, not here.
 */

import { createServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const port = Number(process.argv[2] ?? 8899);
const fixtureDirectory = resolve(process.argv[3] ?? 'fixtures');

/** signature -> the exact `getTransaction` result. */
const bySignature = new Map();
let failures = 0;

for (const file of readdirSync(fixtureDirectory).filter(name => name.endsWith('.json')).sort()) {
  const envelope = JSON.parse(readFileSync(resolve(fixtureDirectory, file), 'utf8'));
  const signature = envelope.request?.signature;
  if (typeof signature !== 'string' || envelope.response === undefined) {
    failures += 1;
    console.error(`skipping ${file}: no request.signature or no response`);
    continue;
  }
  bySignature.set(signature, envelope.response);
}

function handle(request) {
  const id = request?.id ?? 1;
  if (request?.method === 'getTransaction') {
    const [signature] = request.params ?? [];
    return { jsonrpc: '2.0', id, result: bySignature.get(signature) ?? null };
  }
  if (request?.method === 'getSignaturesForAddress') {
    return { jsonrpc: '2.0', id, result: [] };
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `mock node does not implement ${request?.method}` },
  };
}

const server = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => (body += chunk));
  request.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    // `@solana/kit` may batch; answer each request in the batch, in order.
    const answer = Array.isArray(payload) ? payload.map(handle) : handle(payload);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.error(
    `mock rpc on http://127.0.0.1:${port} serving ${bySignature.size} fixture(s)` +
      `${failures > 0 ? ` (${failures} skipped)` : ''}`,
  );
});
