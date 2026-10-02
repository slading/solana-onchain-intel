/**
 * DEV-ONLY TOOL — not part of the runtime, not run by `npm test`.
 *
 * Records real `getTransaction` responses into ./fixtures so the normalizer is
 * tested against genuine RPC payloads. Tests never touch the network; this script
 * is how the payloads behind them were obtained.
 *
 * Usage:
 *   node scripts/harvest-fixtures.mjs --signature <SIG> --name <fixture-name> [--rpc <url>]
 *   node scripts/harvest-fixtures.mjs --search [--rpc <url>]
 *
 * Search mode hunts for the four shapes the test suite wants:
 *   v0-success-swap         version 0, no error, CPIs + token balance changes
 *   v1-failed-*             version 1 with an instruction error
 *   legacy-success-vote     unversioned (legacy) transaction
 *
 * Notes learned the hard way:
 *   - The public mainnet endpoint rate limits `getTransaction` (HTTP 429), so we
 *     retry with exponential backoff. Point --rpc at your own node for volume.
 *   - Errors are logged, never swallowed: a silent 429 is indistinguishable from
 *     "no matching transaction found".
 *
 * Fixture envelope: { provenance, request, response }
 * where `response` is the raw, untouched `result` object.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const CONFIG = {
  encoding: 'jsonParsed',
  commitment: 'finalized',
  // The integer 1: omitting it (or passing 0) hides v1 transactions, and the
  // string "1" fails request validation on every call.
  maxSupportedTransactionVersion: 1,
};

function parseArgs(argv) {
  const args = { rpc: 'https://api.mainnet-beta.solana.com', search: false, signature: null, name: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--rpc') args.rpc = argv[++i];
    else if (arg === '--signature') args.signature = argv[++i];
    else if (arg === '--name') args.name = argv[++i];
    else if (arg === '--search') args.search = true;
    else throw new Error(`Unknown argument "${arg}".`);
  }
  return args;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requestId = 0;

async function rpc(url, method, params, { retries = 5 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    });
    if (response.status === 429 || response.status === 503) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    const body = await response.json();
    if (body.error) {
      if (body.error.code === 429) {
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    }
    return body.result;
  }
  throw new Error(`${method}: rate limited after ${retries} retries`);
}

const getTransaction = (url, signature) =>
  rpc(url, 'getTransaction', [signature, CONFIG]);

function save(name, note, signature, response) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(
    resolve(FIXTURE_DIR, `${name}.json`),
    `${JSON.stringify(
      {
        provenance: {
          source: /* the endpoint actually used */ usedRpcUrl,
          method: 'getTransaction',
          fetchedAtUtc: new Date().toISOString(),
          note,
        },
        request: { signature, config: CONFIG },
        response,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`saved ${name}.json  slot=${response.slot} version=${JSON.stringify(response.version)}`);
}

function classify(tx) {
  return {
    version: tx.version ?? 'legacy',
    failed: tx.meta?.err != null,
    inner:
      tx.meta?.innerInstructions?.reduce((total, group) => total + group.instructions.length, 0) ?? 0,
    beforeTokens: tx.meta?.preTokenBalances?.length ?? 0,
    afterTokens: tx.meta?.postTokenBalances?.length ?? 0,
    instructions: tx.transaction?.message?.instructions?.length ?? 0,
  };
}

let usedRpcUrl = 'https://api.mainnet-beta.solana.com';

async function search(url) {
  const found = {};
  const targets = [
    ...(await rpc(url, 'getSignaturesForAddress', ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', { limit: 25 }])),
    ...(await rpc(url, 'getSignaturesForAddress', ['Vote111111111111111111111111111111111111111', { limit: 5 }])),
  ].map(entry => entry.signature);

  for (const signature of targets) {
    if (found.swap && found.failed && found.legacy) break;
    let tx;
    try {
      tx = await getTransaction(url, signature);
    } catch (error) {
      // Logged, not swallowed: otherwise a 429 looks like "nothing matched".
      console.error(`skip ${signature.slice(0, 12)}…: ${error.message}`);
      continue;
    }
    if (!tx) continue;
    const shape = classify(tx);

    if (!found.swap && !shape.failed && shape.version === 0 && shape.inner > 0 && shape.beforeTokens > 0) {
      found.swap = { signature, tx, shape };
    } else if (!found.failed && shape.failed && shape.version === 1) {
      found.failed = { signature, tx, shape };
    } else if (!found.legacy && !shape.failed && shape.version === 'legacy') {
      found.legacy = { signature, tx, shape };
    }
    await sleep(500);
  }

  if (found.swap) {
    save('v0-success-swap', `Real mainnet v0 transaction with CPIs and token balance changes ${JSON.stringify(found.swap.shape)}`, found.swap.signature, found.swap.tx);
  }
  if (found.failed) {
    save(`v1-failed-${found.failed.signature.slice(0, 8)}`, `Real mainnet v1 failed transaction ${JSON.stringify(found.failed.shape)}`, found.failed.signature, found.failed.tx);
  }
  if (found.legacy) {
    save('legacy-success-vote', `Real mainnet legacy (unversioned) transaction ${JSON.stringify(found.legacy.shape)}`, found.legacy.signature, found.legacy.tx);
  }
  if (!found.swap || !found.failed || !found.legacy) {
    console.error('INCOMPLETE — did not find:', Object.keys(found));
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  usedRpcUrl = args.rpc;

  if (args.signature !== null) {
    if (args.name === null) throw new Error('--signature also needs --name.');
    const tx = await getTransaction(args.rpc, args.signature);
    if (!tx) throw new Error('RPC returned null for that signature.');
    save(args.name, `Real mainnet transaction ${JSON.stringify(classify(tx))}`, args.signature, tx);
    return;
  }

  if (args.search) return search(args.rpc);
  throw new Error('Nothing to do. Pass --search, or --signature with --name.');
}

main().catch(error => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
