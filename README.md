# Solana On-chain Intelligence Assistant — Milestone 1

Fetch a real transaction by signature from a Solana JSON-RPC endpoint, normalize it into
our own model, and print a readable, deterministic CLI summary.

**In scope:** RPC access (`getTransaction`), the canonical `NormalizedTransaction` model,
basic field mapping (signature, slot, block time, success/error, fee, signers, accounts,
top-level instructions, inner instructions, logs, SOL balance changes, token balance
changes), a CLI, and tests over real recorded RPC payloads.

**Deliberately out of scope:** UI, database, third-party data providers (Helius, Birdeye,
Moralis, …), LLM interpretation, Rust/Anchor, and *any* attempt to explain what an
instruction means. Nothing here is inferred from instruction bytes.

---

## Quick start

```bash
npm install
npm run typecheck
npm test

# Inspect a real mainnet transaction
npm run inspect -- 26v8KDhQMUXVLCB2Xzfi3VXTDnvp61r3TLVRB3F9dJixFP7p1kkhskGrkmNshcqPA8wP5K9Th3tYqzCisvLR8ce4
```

```
TRANSACTION 26v8KDhQMUXVLCB2Xzfi3VXTDnvp61r3TLVRB3F9dJixFP7p1kkhskGrkmNshcqPA8wP5K9Th3tYqzCisvLR8ce4

  Slot         452640410
  Block time   2026-10-02T14:42:35.000Z (unix 1790952155)
  Version      v0
  Status       SUCCESS
  Fee          0.0000209 SOL (20900 lamports)
  Compute      218393 CU consumed (cost units 231531)
  Signatures   2
  Fee payer    E5JXp4obkiAcYNf1noBJyYkqJSdwnreBfYaX7vPbYTir
  Signers      E5JXp4obkiAcYNf1noBJyYkqJSdwnreBfYaX7vPbYTir, sighWH8KaiT7QhtV4w29ReVF8kG6D5yG3EQP1KYyGVF
  Recent bh    CyyNPqxFeSaSnzeEUVZ6X6EJhffQuZpm2zLN3jhad187
  Accounts     46 (35 resolved from address lookup tables)

INSTRUCTIONS (5 top-level, 24 inner)
  [0] ComputeBudget111111111111111111111111111111
      type   UNKNOWN — the RPC did not decode this instruction; meaning is not inferred
      data   EUYFZZ (base58, raw)
      accts  (0) (none)
      depth  1
  [2] ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL [spl-associated-token-account]
      type   createIdempotent (parsed by RPC)
      info   {"account":"Cr5vxXJTC4vu8PraDANEGLfE1YStzQo8JHYJ7K8qqAeh", …}
      [2.0] TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA [spl-token]
          type   getAccountDataSize (parsed by RPC)
  …

SOL BALANCE CHANGES (including the fee; unchanged accounts omitted)
  E5JXp4obkiAcYNf1noBJyYkqJSdwnreBfYaX7vPbYTir  147.55 -> 162.11 SOL  (+15220557121 lamports)
  …

TOKEN BALANCE CHANGES
  [3] CLD7C8D2yiwCpGQ8e2HvcVwVti8Puc22wXYLqn6EruTt  mint=9pJWJd…  program=TokenzQd…
      before 4774791332475 (ui 4774791.332475)
      after  0 (ui 0)
      delta  -4774791332475 raw units (pre and post reported)
```

### Options

| Flag | Meaning |
| --- | --- |
| `--rpc <url>` | RPC endpoint (default `$SOLANA_RPC_URL`, else `https://api.mainnet-beta.solana.com`) |
| `--commitment <level>` | `processed` \| `confirmed` \| `finalized` (default `$SOLANA_COMMITMENT`, else `confirmed`) |
| `--json` | Print the normalized model as JSON (includes the raw payload) |
| `--raw` | Print only the raw `getTransaction` result |
| `--no-logs` | Omit program logs from the text summary |
| `--out <file>` | Also write `{ normalized, raw }` JSON to a file |
| `-h`, `--help` | Usage |

### Exit codes

`0` inspected · `1` signature not found · `2` usage error (including an invalid signature)
· `3` RPC/normalization error.

---

## Architecture

```
src/
  cli/inspect.ts            argument parsing, exit codes, output selection
  rpc/
    client.ts               createSolanaRpc + the single request configuration
    fetch-transaction.ts    getTransaction + error translation (returns null = not found)
  normalize/
    transaction.ts          the pure entry point: raw result -> NormalizedTransaction
    instructions.ts         top-level + inner instruction normalization
    balances.ts             lamport and token delta computation
    diagnostics.ts          collects "here is what we do not know"
  model/transaction.ts      the canonical model + the rules it obeys
  render/summary.ts         deterministic text rendering
  lib/                      read-json (untrusted input), format (bigint/locale-safe), byte-size
```

Three stages, no framework:

```
raw RPC result ──► normalizeTransaction()  ──► NormalizedTransaction ──► renderSummary()
   (kit)              (pure, no I/O)             (only place that                  (pure)
                                                   knows Solana shapes)
```

Why this shape:

- **`normalize` is pure and synchronous.** Same input ⇒ same output, so it is tested
  directly against recorded payloads with no mocking framework.
- **The RPC layer is the only thing that knows about `@solana/kit`.** Later milestones can
  add decoders (System Program, SPL Token, swaps) as pure functions over
  `NormalizedTransaction`, and the fetch/render layers do not change.
- **`render` never re-reads the RPC payload.** If the summary is wrong, the model is wrong
  — one place to fix.
- **The model is the contract.** It is deliberately a flat, JSON-serializable structure of
  plain objects, `string`, `number`, `boolean` and `bigint`; no classes, no getters.

### Later parsing is possible without premature abstraction

Nothing in the model blocks Milestone 2:

| Future need | Already covered by |
| --- | --- |
| System Program / SPL Token decoders | `NormalizedInstruction.data` (base58) + `decoding: 'rpc-partially-decoded'` for anything the RPC won't decode |
| Inner instruction analysis | `innerInstructionGroups` keeps CPIs attached to the outer instruction, with `stackHeight` |
| Token balance changes | exact raw `bigint` deltas per (account, mint), plus `presence` for created/closed accounts |
| Swaps | token + SOL deltas are already computed and index-aligned to addresses |
| Versioned transactions | `version` is a union (`legacy` / numbered / unknown); ALT accounts are flagged `source: 'lookupTable'`; v1 `transactionConfig` preserved |

No interfaces were invented for decoders that do not exist yet; adding them is additive.

---

## The canonical model, and the rules it obeys

`src/model/transaction.ts` documents every field. The rules matter more than the fields:

1. **Nothing is invented.** Every value is either taken from the response or is an
   explicitly documented derivation. The only derived fields are:
   - `feePayerAddress` — positional per the Solana message format (account `0` is the fee
     payer), because no RPC field states it;
   - `signers` — filtered from the accounts' own `signer` flag;
   - `*BalanceChange.delta*` — arithmetic on reported values;
   - `status` — `success`/`failed` from `meta.err`, `unknown` when `meta` is absent.
   Absent data is `null`, never `0`, `[]`, or a guess.
2. **Unknown stays unknown.** An instruction the RPC did not decode keeps its `programId`
   and raw base58 `data`, and is marked `decoding: 'rpc-partially-decoded'`.
   `parsedType`/`parsedInfo` stay `null`. We never say "this looks like a swap".
3. **"Empty" and "unavailable" are different.** `logs: null` means the node reported no
   logs; `logs: []` means the program logged nothing. Same for
   `innerInstructionsAvailable` and `tokenBalancesAvailable`.
4. **Raw is always reachable.** `NormalizedTransaction.raw` is the payload the model was
   built from, so a surprising interpretation can always be checked against the source.
5. **Determinism.** Fixed field order, fixed collection ordering (accounts by index, token
   changes by `(accountIndex, mint)`, inner groups by `outerIndex`), UTC timestamps only,
   integer math for lamports, no locale-aware comparison, no colours, no "now" timestamps.

### Diagnostics instead of silent nulls

Anything odd becomes a `NormalizedDiagnostic` (`{ level, code, message }`), so "we don't
know" is visible in the output:

```
DIAGNOSTICS
  [warning] inner-instruction-outer-index-out-of-range
      innerInstructions group references outer instruction 7, but the transaction has 1 top-level instruction(s).
  [info] token-account-created
      Token account for accountIndex 12 appears only in postTokenBalances (created during this transaction); no delta is reported.
```

---

## Solana concepts encountered (and the decisions they forced)

- **Accounts, indices and address lookup tables.** Instructions refer to accounts by index
  into an ordered account list. With `jsonParsed` the list is *already resolved*: each entry
  is `{ pubkey, signer, writable, source }`, where `source: "lookupTable"` marks an address
  that was expanded from an address lookup table in a v0 transaction. Everything else in the
  response is index-aligned to this list. Note `meta.loadedAddresses` is *omitted* in
  `jsonParsed` — the resolved entries replace it, so the model uses `source` instead.
- **Transaction versions: legacy / v0 / v1.** v0 added address lookup tables; **v1 is live on
  mainnet** (this project captured v1 transactions while harvesting fixtures) and carries
  resource limits in `message.transactionConfig` instead of ComputeBudget instructions, with
  no lookup tables. `version` is modelled as a union so an unknown future version cannot be
  mistaken for a known one. Reading v1 requires `maxSupportedTransactionVersion: 1` passed as
  the JSON **integer** `1` — a string fails request validation, and `0`/omitting it hides v1
  transactions.
- **Instructions vs inner instructions (CPI).** A program can invoke other programs; those
  calls appear in `meta.innerInstructions`, grouped by the top-level instruction that made
  them. **`index` is the 0-based index of the outer instruction** in
  `message.instructions` — verified against Agave's `map_inner_instructions`
  (`solana-transaction-status`), which enumerates the list and *then* filters out groups with
  no CPIs. Groups are therefore not necessarily contiguous, and the normalizer does not
  assume they are. `stackHeight` gives the CPI depth (1 = top level).
- **`jsonParsed` is the RPC's own parser, not ours.** It decodes what it knows (`system`,
  `spl-token`, …) and hands back `accounts` + base58 `data` for everything else. That is
  exactly the split we want: the RPC's label is kept verbatim, and everything else stays
  explicitly undecoded. (Note that even well-known programs such as ComputeBudget come back
  undecoded — so they print as `UNKNOWN`, which is correct behaviour for this milestone.)
- **Fees, lamports and precision.** `meta.fee` is in lamports (1 SOL = 1e9). Lamports are
  handled as `bigint` and formatted with integer math, and the CLI prints exact raw integer
  amounts alongside `uiAmountString` rather than recomputing decimals.
- **SOL vs token balances.** `preBalances`/`postBalances` are lamport arrays index-aligned to
  the account list; deltas include the fee. `pre/postTokenBalances` are a *separate*,
  independently listed set keyed by `accountIndex`, so they are merged per
  `(accountIndex, mint)`. An account present on only one side was created or closed during
  the transaction, so no delta is computable and none is claimed.
- **Failure is a first-class outcome.** A failed transaction still has instructions, inner
  instructions and logs; only its state changes roll back. `meta.err` is preserved verbatim
  (e.g. `{"InstructionError":[3,{"Custom":6001}]}`) — mapping custom program codes to meanings
  is program-specific knowledge and is out of scope.
- **Commitment levels.** `processed`/`confirmed` results can still be reorged out;
  `finalized` is permanent. The model records the commitment used in `provenance`.
- **`getTransaction` returning `null`** means the node has no such transaction: the signature
  may not exist, or the node no longer retains it. We report that ambiguity rather than
  guessing which case it is.

---

## Tests

```bash
npm test          # 88 tests, no network, no mocking framework
```

Four layers:

- **`tests/normalize.real-fixtures.test.ts`** — every fixture is a real mainnet response.
  Invariants: account/balance index alignment, inner groups resolving to real outer
  instructions, no instruction claimed as decoded without a parsed type, and
  **Σ(lamport deltas) = −fee** (lamports are conserved except for the fee), which doubles as
  an index-alignment check.
- **`tests/normalize.edge-cases.test.ts`** — synthetic payloads for what mainnet rarely
  provides: `meta: null`, unrecorded inner instructions, non-integer or unsafe lamport
  values, malformed account entries, token accounts created/closed mid-transaction,
  out-of-range indices, and the payloads that must be rejected outright.
- **`tests/normalize.kit-transformed.test.ts`** — see the note below.
- **`tests/render.test.ts`** — a frozen golden summary, plus checks that output is
  byte-identical across runs and free of ANSI escapes.

Fixtures (`fixtures/*.json`) are `{ provenance, request, response }` where `response` is the
untouched `result`. Re-harvest with `npm run harvest:fixtures -- --search` (network; the
public endpoint rate limits `getTransaction`, so the script retries with backoff and logs
every skip).

---

## Assumptions & limitations

1. **`@solana/kit` post-processes responses.** Its transformers upcast integers to `bigint`
   except at an allow-list of small fields (`accountIndex`, `decimals`, `stackHeight`, …).
   So the live path sees `blockTime`/`fee`/balances as `bigint`, while a raw JSON fixture sees
   numbers. Both are supported and tested to produce identical models. Consequently
   `--raw`/`--json` show the *decoded* view, with bigints printed as exact decimal strings —
   not byte-identical wire JSON, but value-exact.
2. **We trust the node.** We do not verify signatures ourselves, and we do not check that a
   `confirmed` transaction survived in the canonical chain.
3. **Only `jsonParsed` is requested.** The normalizer tolerates bare-string account keys
   (the `json` encoding) but marks their signer/writable flags `null`.
4. **Program semantics are out of scope.** Any instruction-level meaning comes from the RPC's
   parser, never from us. Custom program error codes stay unmapped.
5. **Display truncation.** The text summary elides long base58 data, large account lists and
   long parsed info. Truncation is display-only and marked; the model and `--json` are always
   complete.
6. **v1 coverage is thinner.** v1 transactions are recent and still rare; the recorded
   fixtures are failed v1 transactions (token balances roll back, so the normalizer's
   zero-delta path is exercised but a *successful* v1 swap was not captured). The model
   treats v1 like v0 minus lookup tables.
7. **Public endpoint caveat.** `api.mainnet-beta.solana.com` throttles `getTransaction`
   (HTTP 429) after a couple of calls and does not retain deep history. Point `--rpc` /
   `SOLANA_RPC_URL` at a node you control for volume.
8. **`blockTime` is an estimate** and can be `null`; `slot` is the canonical ordering key.
9. **No caching and no retries in the CLI** — one RPC call per invocation, by design.

## Next steps (Milestone 2, not implemented here)

Decoders as pure functions over `NormalizedTransaction`: System Program and SPL Token
instruction decoding (including inner instructions), token balance-change interpretation,
swap detection, and then whatever the intelligence layer needs — all without changing the
fetch or render layers.
