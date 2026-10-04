# Solana On-chain Intelligence Assistant

_This document is the Milestone 1 write-up; the Milestone 2 and Milestone 3 sections are
appended at the end._

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

*(Sample above is the Milestone 1 output shape. The CLI now also prints `ACTIONS` and `SWAPS`
sections by default — reproduce the Milestone 1 output with `--no-actions --no-swaps`, the
Milestone 3 output with `--no-swaps`; see “Milestone 2”, “Milestone 3” and “Milestone 4.1”
below.)*

### Options

| Flag | Meaning |
| --- | --- |
| `--rpc <url>` | RPC endpoint (default `$SOLANA_RPC_URL`, else `https://api.mainnet-beta.solana.com`) |
| `--commitment <level>` | `processed` \| `confirmed` \| `finalized` (default `$SOLANA_COMMITMENT`, else `confirmed`) |
| `--json` | Print the normalized model as JSON (includes the raw payload) |
| `--raw` | Print only the raw `getTransaction` result |
| `--no-logs` | Omit program logs from the text summary |
| `--actions` | Print the `ACTIONS` section (default on) |
| `--no-actions` | Omit `ACTIONS`, leaving the Milestone 1 output shape |
| `--effects` | Print only the `EFFECTS` section (value movement + net change) |
| `--no-effects` | Omit `EFFECTS` from the text summary |
| `--swaps` | Print only the `SWAPS` section (recognized AMM swaps) |
| `--no-swaps` | Omit `SWAPS`, leaving the Milestone 3 output shape byte-for-byte |
| `--full-addresses` | Print full base58 addresses in `ACTIONS`/`EFFECTS`/`SWAPS` instead of `4…4` abbreviations |
| `--out <file>` | Also write `{ normalized, effects, swaps, raw }` JSON to a file |
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
  render/
    summary.ts              deterministic text rendering
    actions.ts              the ACTIONS section (Milestone 2)
  lib/                      read-json (untrusted input), format (bigint/locale-safe), byte-size
  decode/                   Milestone 2 only: instruction -> meaning; see that section
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
npm test          # 106 with Milestone 1, 240 with Milestone 2, 374 with Milestone 3,
                  # 468 with Milestone 4.1 (20 files), 543 with Milestone 4.2 (24 files)
                  # — no network, no mocking framework
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

The files added by Milestone 2, Milestone 3 and Milestone 4.1 are described in their sections
below. `tests/helpers/fixtures.ts` drives the fixture-wide suites from `fixtures/*.json`; adding a
seventh fixture (Milestone 4.1) therefore extends `decode.transaction`, `effects.fixtures`,
`normalize.kit-transformed` and `normalize.real-fixtures` at once, and it has to satisfy every
invariant those suites check — it does.

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

## Milestone 2 — semantic decoding layer

Milestone 1 answers *what happened mechanically* (accounts, instructions, balances). Milestone 2
answers *what the instructions mean* — deterministically, from instruction data, with no guessing.

**In scope:** decode System Program, SPL Token Program and Associated Token Account Program
instructions into a separate `DecodedAction` layer; print a concise `ACTIONS` section; test
valid / malformed / partial / unknown instructions and both decoding paths.

**Still out of scope:** swap interpretation, Token-2022 extensions, fee attribution, UI,
LLM interpretation, third-party data providers.

### What it adds to the CLI

```text
ACTIONS (13 decoded, 16 not decoded, from 29 instruction(s))
  [2]       associated-token-account.create   CreateIdempotent  ata=Cr5v…qAeh  wallet=E5JX…YTir  mint=So11…1112  payer=E5JX…YTir  tokenProgram=Toke…Q5DA  [rpc-parsed]
  [2.1]     system.createAccount              0.00148844 SOL (1488440 lamports)  space=165 bytes  owner=Toke…Q5DA  from=E5JX…YTir  newAccount=Cr5v…qAeh  [rpc-parsed]
  [3.2]     spl-token.transferChecked         2729270725642 raw units  decimals=6  mint=9pJW…9ZMr  source=CLD7…ruTt  destination=7Tfu…ThcH  authority=E5JX…YTir  [rpc-parsed]
  … 10 more transferChecked / transfer / closeAccount lines, in instruction order
  [4]       spl-token.closeAccount            account=Cr5v…qAeh  destination=E5JX…YTir  authority=E5JX…YTir  [rpc-parsed]

  not decoded (16); unknown programs stay unknown:
    (13) program not decoded by this layer: [0] ComputeBudget111111111111111111111111111111  •  [1] ComputeBudget111111111111111111111111111111  •  [3] JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4  •  (+10 more)
    (3) recognized instruction, outside the Milestone 2 target set: [2.0] TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA [spl-token]  rpc-parsed-as=getAccountDataSize  •  [2.2] … rpc-parsed-as=initializeImmutableOwner  •  [2.3] … rpc-parsed-as=initializeAccount3

  decoded from instruction data only — never from balance changes.
```

Every action line carries a `ref` (`[2.1]` = inner instruction 1 of top-level instruction 2,
matching the `INSTRUCTIONS` section), the fields the instruction data actually proves, and the
evidence it came from (`bytes` or `rpc-parsed`). Addresses are abbreviated `4…4` by default;
`--full-addresses` prints them in full. `--no-actions` restores the Milestone 1 output shape.

### Architecture

```
src/decode/
  actions.ts                  DecodedAction / DecodedTransaction model, refLabel
  bytes.ts                    byte readers (u8/u32/u64 LE, pubkey), takeAccountRoles
  programs.ts                 program ids, name tables, ProgramDecoder contract, decode results
  system.ts                   System Program
  spl-token.ts                SPL Token + Token-2022 (one factory, two ids)
  associated-token-account.ts ATA
  decode.ts                   PROGRAM_DECODERS, decodeInstruction, decodeTransaction, actionKinds
src/render/actions.ts         renderActionSection, describeAction
```

Rules the layer obeys, by construction:

1. **Decoders consume normalized instructions, never RPC payloads.** They receive a narrow
   `DecodableTransactionView` that exposes instructions only — balances, logs and raw payload are
   unreachable from decoder code, so a balance delta *cannot* be turned into an action even by
   accident.
2. **The Milestone 1 model is unchanged.** `decoded` is one additive optional field on
   `NormalizedTransaction`; nothing in `src/normalize/*` was refactored.
3. **Two independent evidence paths, one meaning.** Where the node returned a parsed instruction
   *and* the raw bytes exist, both are decoded; raw instruction-data bytes win when both are
   present, and a dual-path test asserts the two paths produce identical meaning on a shared
   table of vectors. A field that cannot be read stays `null` and gets a diagnostic — never an
   inferred value.
4. **Unknown stays unknown.** Undecoded instructions keep a specific reason
   (`program-not-supported`, `instruction-not-in-scope`, `unknown-instruction-tag`,
   `malformed-instruction-data`, `no-decoding-evidence`, `program-id-missing`) and are grouped
   as such in the render. A recognized program with an instruction outside the Milestone 2 target
   set (e.g. `setAuthority`, `syncNative`) is reported as *not in scope*, never as an unknown
   program — and a program label (e.g. `saber-stableswap`) is reported as a **label, not meaning**.

### Semantics proven (verified against official sources and real mainnet data)

| Action | Program | Evidence |
| --- | --- | --- |
| `system.transfer`, `system.createAccount` | `11111111111111111111111111111111` | bincode ⇒ u32-LE tags, field order from `system-interface/src/instruction.rs`; real fixtures |
| `spl-token.transfer`, `transferChecked`, `mintTo`, `mintToChecked`, `burn`, `burnChecked`, `approve`, `revoke`, `closeAccount` | `Tokenkeg…`, `TokenzQd…` (Token-2022 superset) | tags/account order from `token/interface/src/instruction.rs`; real fixtures for transfer/approve/closeAccount; spec-derived byte vectors for the rest |
| `associated-token-account.create` / `createIdempotent` | `ATokenGPv…` | enum order from the ATA interface; empty data ⇒ `Create` (from `processor.rs`); real fixtures |

`parsed.info` field names come from reading Agave's `parse_token.rs` / `parse_system.rs` /
`parse_associated_token.rs`, **not** from the spec names — they differ (non-checked
`mintTo`/`burn` carry a bare `amount`, checked variants nest `tokenAmount{amount,decimals}`;
multisig authorities replace the plain key and add `signers[]`). One real mapping bug was found
and fixed this way.

### Semantics still unknown (deliberately)

- **Swap and aggregator semantics** — Jupiter, ComputeBudget and vote programs appear in real
  fixtures as opaque instructions (`program-not-supported`). No spec, no meaning.
- **Token-2022 extensions** — recognized as Token-2022, decoded only for the base instruction set.
- **Effects and attribution** — which signer ultimately *paid*, CPI authority chains, and net
  per-mint flow are not derived; actions are statements about instruction data, nothing more.
- **Fee attribution beyond the transaction fee** — inner instructions have no fee of their own.

### Tests

`npm test` → **240 tests, 9 files, no network, no mocking framework.** Milestone 1's 106 tests
(all four original files, unmodified) still pass; the new files are:

- `tests/decode.bytes.test.ts` (36) — the byte path over spec-derived vectors.
- `tests/decode.parsed.test.ts` (26) — the `rpc-parsed` path over Agave's real field names,
  including multisig variants and partial info.
- `tests/decode.dual-path.test.ts` (16) — same instruction expressed as bytes and as node parse
  must yield the same meaning (`evidence` excluded from the comparison).
- `tests/decode.transaction.test.ts` (41) — accounting over every real fixture: every
  instruction is either decoded or attributed to a reason, refs resolve, decoding is
  deterministic, and **decoding never depends on balance deltas** (fixtures with rolled-back
  balances decode identically).
- `tests/render.actions.test.ts` (15) — the section's counts, lines, refs, grouping,
  abbreviation, totals, notes, determinism, and `--no-actions` compatibility.

Two fresh real mainnet fixtures were harvested for this milestone
(`fixtures/token-mixed-approve.json`, `fixtures/token-mixed-closeAccount.json`).

## Milestone 3 — effects layer

Milestone 2 answers *what the instructions mean*. Milestone 3 answers the transaction-level
question: **who moved what, how much net, and what is proven versus merely consistent.**

**In scope:** a separate `TransactionEffects` model that joins the canonical normalized data
(boundary balances, account identities, token rows, fee) with `DecodedAction[]`; a deterministic
`EFFECTS` section; reconciliation invariants; and explicit treatment of failed transactions.

**Deliberately out of scope:** swap or DEX recognition, aggregator heuristics, price data, PnL,
UI, database/indexer, LLM interpretation, and third-party providers. Nothing in this layer reads
a raw RPC payload: it consumes the canonical model and the decoded actions only, and it never
mutates or reinterprets a `DecodedAction`.

### What it adds to the CLI

```bash
npm run inspect -- <signature> --effects          # only the EFFECTS section
npm run inspect -- <signature> --no-effects       # the Milestone 2 shape
```

A real mainnet close-account transaction (`fixtures/token-mixed-closeAccount.json`), trimmed:

```
EFFECTS (committed)
  11 proven by instruction data • 3 sized by balance reconciliation • 0 unattributed • 0 with an unobservable amount

  SOL
    21gs…vBNH: -0.000005 SOL charged by the network (no account in this transaction receives it; the burn/validator split is not claimed)  [fee]
    21gs…vBNH → HiRn…fWsx: 0.00148844 SOL (1488440 lamports)  (account-create-deposit)  [2.1] system.createAccount
    21gs…vBNH → HiRn…fWsx: 0.000185356 SOL (185356 lamports)  (transfer)  [5] system.transfer
    HiRn…fWsx → A7mZ…9RBW: 0.000185356 SOL (185356 lamports)  (native-token-leg)  [7.1] spl-token.transferChecked
    HiRn…fWsx → 21gs…vBNH: 0.00148844 SOL (1488440 lamports) (reconciled)  (account-close-return)  [8] spl-token.closeAccount

  TOKEN (raw units; decimals are labels, not arithmetic)
    token account HiRn…fWsx → token account A7mZ…9RBW: 185356 raw units (0.000185356)  (mint So11…1112) • owners 21gs…vBNH → 5wYc…rTdV • wrapped SOL: moved the same lamports too • authority 21gs…vBNH  [7.1] spl-token.transferChecked
    …

  NET SOL (exact, from the transaction's boundary balances)
    21gs…vBNH (fee payer): -190356 lamports (-0.000190356 SOL)  [exactly explained]
    A7mZ…9RBW: +185356 lamports (0.000185356 SOL)  [exactly explained]

  NET TOKEN BY OWNER (aggregated over that owner's accounts of the mint; an owner is not a signer)
    owner 5wYc…rTdV: -176691257 raw units of mint 4LjR…yUKK across 1 token account(s)  [exact]
    …

  LIFECYCLE
    created associated token account HiRn…fWsx for owner 21gs…vBNH (mint So11…1112), paid by 21gs…vBNH: 1488440 lamports deposited  [2] associated-token-account.create
    idempotent create did nothing: FfcK…ghhP already was an initialised token account  [3] associated-token-account.create
    closed token account HiRn…fWsx (mint So11…1112, owner 21gs…vBNH); 1488440 lamports returned to 21gs…vBNH — the transaction created it, so none of this is rent it held: 1673796 lamports were paid in and 185356 spent (composition not provable)  [8] spl-token.closeAccount

  notes (2):
    info: [2] creates a token account; the lamport movement is the system.createAccount it makes at [2.1] (1488440 lamports), which is recorded as its own flow rather than counted twice.
    info: [8] closes a wrapped-SOL account; the split between unwrapped SOL and the account's other lamports is not established, because its lamport history and its decoded wrapped-balance movements do not describe the same events — candidates are the instructions this layer does not decode: [2.0] getAccountDataSize, [2.2] initializeImmutableOwner, [2.3] initializeAccount3, [6] syncNative.
```

The last line is the point of the milestone: the transaction *can* be described completely as
movements (every account reconciles exactly), and it *cannot* be described as "0.00148844 SOL of
recovered rent", because a `syncNative` this layer does not decode took part in that balance. The
output says so instead of choosing.

### Three kinds of claim, and where each amount comes from

| Confidence | Meaning |
| --- | --- |
| `proven` | The instruction data states it (a transfer amount, a create's lamports, a mint). |
| `reconciled` | An instruction proves the *relationship*; the boundary balances show the *size* — what a close returned, what an ATA create deposited. |
| `ambiguous` | A movement exists but its size, its counterparty, or its owner is not established. It is never promoted to a flow. |

Every flow also carries an `amountSource`: `instruction-data`, `transaction-metadata` (the fee),
`balance-reconciliation`, `residual-reconciliation`, or `not-observable`. `residual-reconciliation`
is the one narrow case where a balance decides an amount: when a flow an instruction *already
proved* is the only unreadable movement touching both of its endpoints and those endpoints agree
on the size to the lamport, that remainder is that flow's amount. The relationship came from the
instruction; reconciliation only measured it.

### The rules the layer obeys

1. **Instruction data proves relationships; balances prove amounts.** A delta alone is never
   turned into a sender→receiver edge, a mint, or an owner.
2. **Unattributed is a first-class result.** Whatever is left over is reported with its sign, its
   account, its mint where applicable, and the undecoded instructions that *could* have moved it
   (`unattributedEffects`), plus a diagnostic. Residuals are not absorbed into plausible flows.
3. **Nothing is called a wallet.** Accounts are accounts; owners are whoever the token rows say.
   A signer flag is reported where the model has one, never inferred from balances.
4. **Token account, mint and owner stay separate.** `sourceTokenAccount`/`destinationTokenAccount`
   are the token accounts the instruction named; owners are reported beside them, and the owner
   aggregate (`netTokenByOwnerMint`) is labelled as an aggregate over that owner's accounts.
5. **Raw units exactly.** Amounts are integer lamports or integer raw units. `decimals` is
   presentation metadata copied from the rows, and the formatter's UI figure is computed with
   integer arithmetic — never used to sum.
6. **Created vs already there.** A create's deposit is distinguished from rent the account already
   held: `lamportsAtStart` / `lamportsCredited` / `lamportsSpent` / `returnComposition`
   (`own-lamports` | `in-transaction-lamports` | `mixed` | `not-provable`), claimed only when the
   three terms reproduce the return exactly. Rent and dust are deliberately **not** separated —
   that needs the rent-exempt minimum, a sysvar value this layer refuses to hardcode.
7. **CPI nesting keeps its reference.** Every effect carries the `InstructionRef` of the
   instruction that caused it (`[2.1] system.createAccount`, not "the transaction"), and a
   duplicate outer claim is dropped with a note when an inner instruction states the same movement.
8. **Unknown stays unknown.** Undecoded instructions remain undecoded; the effects layer only
   names them as candidates, and only when they could actually be the cause (e.g. an undecoded
   instruction *of the token program that owns the account*, or an undecoded System instruction).
9. **A failed transaction commits the fee and nothing else.** Solana deducts the fee before
   execution and rolls back every state change when any instruction fails (docs: *Fee Structure*,
   *Transactions*). So instruction-derived effects are reported as `commitState: 'reverted'` in a
   separate `DID NOT COMMIT` list, never as state; only the fee appears as committed. If a failed
   transaction's balances show a change beyond the fee, that is a contradiction and is warned
   about (`effects-reverted-state-changed`) rather than believed.

### Wrapped SOL: semantics taken from the program source

Two SPL Token behaviours decide how wrapped-SOL accounts are read, both from
`token/program/src/processor.rs`:

- `process_transfer` moves lamports 1:1 with the token amount when the source account `is_native`,
  so a WSOL token transfer is *also* a lamport transfer. Those legs are recorded as
  `kind: 'native-token-leg'` in `solFlows`, and a fixture-level invariant checks that
  `WSOL token delta == lamport delta` for every untouched WSOL account.
- `process_close_account` moves the account's whole lamport balance to the destination and deletes
  the account, and a native account may be closed while holding units (non-native ones may not).
  The units that leave with it are recorded as `kind: 'close-unwrap'` — not as a transfer or a burn,
  because the mint's supply is not decremented; the matching lamport movement is the close's
  `account-close-return` flow. Their size comes from the lamport composition, so when the two
  histories disagree the units are recorded as unknown and the residual stays visible.
- `process_mint_to` and `process_burn` reject a native account outright, so a `mintTo`/`burn`
  can never imply a lamport leg; a fixture or synthetic payload that seems to do so is flagged.

### Architecture

```
src/effects/native.ts     the wrapped-SOL rule (mint constant + `isNativeMint`)
src/effects/model.ts      TransactionEffects and every record it contains
src/effects/input.ts      the ONLY file that touches the canonical model (`toEffectsInput`)
src/effects/claims.ts     decoded actions -> proven flows, mint cross-checks, lifecycle, allowances
src/effects/reconcile.ts  the arithmetic: sizing, nets, invariants, close composition, unattributed
src/effects/build.ts      transaction effects: committed/reverted split, counts, diagnostics
src/render/effects.ts     the EFFECTS section (prints the model; computes nothing)
```

`transactionEffects(transaction)` is a pure function: same input, byte-identical JSON output
(asserted for all six fixtures). The effects model is also exported from `src/index.ts` and
`--json` carries it alongside the normalized model.

### Invariants checked on every transaction

- **Σ lamport deltas + fee = 0** — lamports are conserved apart from the fee (also asserted
  fixture-by-fixture, independently of the layer's own diagnostics).
- **Σ token deltas = minted − burned, per non-WSOL mint** — WSOL is excluded because a native
  account's balance is a lamport claim, and closing one moves lamports rather than changing supply.
- **WSOL token delta = lamport delta** for a WSOL account that was not created or closed.
- **Flow bookkeeping** — every committed flow credits one account and debits another, so the
  explained totals cancel against the fee; a flow aimed outside the transaction is warned about.
- **Close rules** — a non-native account closed while its own row shows units is flagged; a close
  whose amount can't be reconciled is left unsized.

All six recorded fixtures produce **0 unattributed effects, 0 residual, 0 violated invariant**.

### Tests

`npm test` → **374 tests, 16 files, no network, no mocking framework.** Milestone 1 (106) and
Milestone 2 (134) are untouched; Milestone 3 adds 134 tests in seven files:

- `tests/effects.sol.test.ts` (16) — SOL flows: fee, transfers, CPI-mediated transfers, unreadable
  amounts, missing/attributable fees, lamport conservation, purity.
- `tests/effects.token.test.ts` (20) — transfers, mint/burn, mint conflicts and unreadable mints,
  WSOL lamport legs, allowances as state (never value), owner-vs-account separation.
- `tests/effects.lifecycle.test.ts` (13) — `createAccount`, ATA create (created / no-op /
  not-provable), closes and where their lamports came from, wrapped-SOL closes and unwrapping.
- `tests/effects.reconciliation.test.ts` (18) — no attribution from deltas alone, residual sizing
  with both endpoints, unsized movements, the invariants, ambiguity reporting, and the narrow
  input the layer is allowed to see.
- `tests/effects.failed.test.ts` (10) — rolled-back transactions and the unknown-commitment case.
- `tests/effects.fixtures.test.ts` (47) — every fixture: determinism, exact reconciliation, both
  conservation invariants, commitment marking, and what each transaction proves.
- `tests/render.effects.test.ts` (10) — a frozen golden summary for a synthetic transaction that
  exercises every section, the failed-transaction output, section order, ablations, `--effects`,
  full addresses, elision, and the wrapped-SOL close lines.

Test helpers (`tests/helpers/effects.ts`) run the *real* pipeline — `decodeTransaction` then
`buildTransactionEffects` — over hand-written balance rows, so no test can pass against a
hypothetical shape the production path does not produce.

### Semantics still unknown (deliberately)

- **What an undecoded program did.** A residual it might explain is reported as unattributed with
  the instruction named as a candidate; no meaning is assigned.
- **Rent vs dust.** Not separated, by design (see rule 6).
- **Who a non-signing authority is.** A multisig member, a program-derived address, or a delegate:
  reported as "not a signer", never guessed.
- **Fees paid by inner instructions.** Inner instructions have no fee of their own, and priority
  fees are not attributed beyond the transaction fee.
- **Anything about intent.** No swap recognition, no PnL, no price, no "this was a buy".

## Recommended Milestone 4

1. **Swap recognition — only with a spec in hand.** Program-by-program (e.g. Jupiter route
   instructions with their account lists), never by pattern-matching token flow. The effects layer
   is the right foundation: a swap is a *claim about intent* laid over flows that are already
   proven, and the milestone should be judged on how it handles a route it does not recognise.
2. **Token-2022 extension coverage.** Transfer fees, interest-bearing mints and metadata pointers
   change what a token delta means; today they are decoded only for the base instruction set.
3. **CPI authority tracing.** Which signer authorized each inner call, which would let a "not a
   signer" authority be explained instead of merely reported.
4. **An indexer-free multi-transaction view.** The effects model is per-transaction and pure;
   the next useful question ("what did this account do today") needs a caller that can run it
   over many signatures — not a database.

---

## Milestone 4.1 — Meteora DLMM `swap2` recognition

Milestones 1–3 answer *what moved*. This milestone answers one narrow question about *intent*,
and only where a program's own instruction semantics prove it: **was this a Meteora DLMM
`swap2`, and exactly what did it claim?** The Milestone 3 section above ends with “no swap
recognition, no PnL, no price, no ‘this was a buy’”. This milestone adds exactly one exception —
a recognized Meteora DLMM `swap2` — and nothing else on that list.

### Scope: one program, one instruction

- **Recognized:** `swap2` (`414b3f4ceb5b5b88`) of `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
  (`lb_clmm`), per `MeteoraAg/dlmm-sdk` → `idls/dlmm.json`.
- **Not recognized, deliberately:** DLMM's own `swap` (v1), every other DLMM instruction, pump_amm,
  Jupiter's `route_v2` (the router envelope is *never* read for meaning — a leg is recognized from
  the pool's instruction alone), and any "this token went out and that one came in, so it was a
  swap" heuristic. There is no AMM registry.

### How a leg is proven

A `DlmmSwapLeg` exists only when all of this holds; each step is one entry in the leg's `checks`
array, which is fixed at 19 entries in a fixed order:

| # | Condition | Required |
| --- | --- | --- |
| 1 | the instruction's program id is the DLMM program | yes |
| 2 | its first 8 bytes are the `swap2` discriminator | yes |
| 3 | its arguments parse with **exact** byte consumption — no truncated `u64`, no unread slice, **no trailing byte** | yes |
| 4 | at least the 16 named IDL roles are present (the tail is counted, never assumed) | yes |
| 5 | the instruction's CPI subtree is available (a CPI depth is known, inner instructions were recorded) | yes |
| 6–7 | exactly one token transfer out of `user_token_in` and one into `user_token_out` **inside that subtree** | yes |
| 8–9 | those transfers' mints are the pool's two named mints, on opposite sides | yes |
| 10 | the direction follows from the mints (`token_x_mint` in ⇒ `swap_for_y`) | yes |
| 11–12 | the vaults agree with the direction: an X-in leg pays into `reserve_x` and is paid out of `reserve_y` | yes |
| 13 | the input transfer's amount equals the instruction's `amount_in` | yes |
| 14 | `min_amount_out` is stated (`> 0`) | no — informational |
| 15 | the output is `>= min_amount_out`, *if* one is stated | no |
| 16 | the input transfer was authorized by the account's reported owner | no — informational |
| 17–18 | both transfers appear in the Milestone 3 effects model **at the same instruction reference**, with the same endpoints, mint, amount, `amountSource: 'instruction-data'` and a committed state | yes |
| 19 | the transaction itself succeeded | yes |

Arguments may only be read one way: `amount_in: u64 @8`, `min_amount_out: u64 @16`, then
`RemainingAccountsInfo { slices: Vec<RemainingAccountsSlice { accounts_type: u8, length: u8 }> }`.
A payload with any byte left over is *not* a `swap2` this layer understands, and is reported as
unrecognized rather than partially read — a future program version degrades to silence, never to a
wrong amount.

**`min_amount_out = 0` is not a pass.** Zero means the instruction states no floor; the renderer
says so in those words, the leg records `min-amount-out-not-stated` as an unknown, and no
`min-amount-*` check is ever reported as passed. `v0-success-swap` has zero floors on both legs;
`v0-success-dlmm-minout` has a real floor of `1`, which the output satisfies.

**Commitment is inherited, never assumed.** A failed transaction is reported as
`not-committed` (amounts labelled as attempted movement); a missing effects model caps a leg at
`partially-proven`; two disagreeing pieces of evidence make it `conflicting` and both values are
printed. Nothing is averaged and nothing is guessed.

**Events and logs are supplemental only.** The Anchor `Swap`/`Swap2Evt` events are not parsed and
not required; the layer works with `logs: null`. Conversely, `Program log: Instruction: Swap2` is
never sufficient — and when the node did not record CPI instructions at all, the layer says
`swap-inner-instructions-unavailable` instead of reporting "no swap".

### Output

The `SWAPS` section is deterministic, prints the semantic result first, and names the evidence
(the instruction reference, both token accounts with owners, the pool vaults and mints, the two
transfer legs, the raw argument values) and every condition that did not pass. It never prints
BUY or SELL: whether a swap is a "buy" depends on which asset the reader treats as the quote
asset, which is not a fact this layer has.

### Fixtures

- `v0-success-swap.json` — the primary vector: a Jupiter `route_v2` routing through **two**
  Meteora DLMM pools. Both `swap2` legs are recognized independently and exactly (`[3.8]` and
  `[3.13]`), and both reconcile with the effects model.
- `v0-success-dlmm-minout.json` — captured for this milestone because every `swap2` in the
  primary fixture states a zero floor: a direct pool swap with `min_amount_out = 1`. It was
  harvested with `npm run harvest:fixtures -- --signature …` from the same public endpoint.

### Tests

`tests/swap.dlmm.test.ts` (10), `tests/swap.fixtures.test.ts` (17),
`tests/swap.adversarial.test.ts` (31), `tests/render.swaps.test.ts` (15): the discriminator
(re-derived from `sha256('global:swap2')`, not copied from an observation), exact byte
consumption, IDL role order, both real legs, transfer-by-transfer reconciliation with the effects
model, `min_amount_out` semantics, CPI-subtree attribution (including a sibling transfer that must
*not* be attributed), log/event independence, misleading logs, a failed transaction, mutation
vectors (tampered `amount_in`, violated floor, wrong vault, swapped mints, missing and duplicated
transfers, unrecorded CPIs), purity/determinism, and the golden section. `--no-swaps` is verified
byte-identical to the frozen Milestone 3 output — by the test above and by diffing the CLI's own
output against the same command run from the Milestone 3 commit.

### Semantics still unknown (deliberately)

- **Everything outside DLMM `swap2`.** pump_amm, DLMM `swap`, Jupiter `route_v2` and the rest stay
  unrecognized; the discovery report (`m4-swap-recognition-discovery.md`) is the groundwork.
- **What the BinArray tail is.** Counted, never interpreted, never needed for the proof.
- **Token-2022 transfer-hook slices.** The `RemainingAccountsInfo` slice count is recorded; the
  slices are not interpreted, and hook accounts are not differentiated from bin arrays.
- **Fees.** The DLMM `Swap`/`Swap2Evt` events would give fee decomposition; nothing here parses
  them, so no fee is claimed.
- **The router's own intent.** The route envelope's splits, fee bps and quoted amount are not
  read, so a multi-leg transaction is reported as two pool swaps, not as one routed swap.
- **A shared-mint leg.** If a pool's two mints were ever equal, the leg is `conflicting` by
  construction rather than "probably X to Y".

## Milestone 4.2 — pump_amm `sell` recognition

Milestone 4.1 recognized one instruction of one program. This milestone adds the second, and only
the second: **was this a `sell` on the pump_amm program, and exactly what did it claim?** It is
deliberately *not* a protocol framework — there is still no registry, no plugin list and no shared
"AMM" abstraction; there is one extra recognizer and one extra line that calls it.

### Scope: one program, one instruction

- **Recognized:** `sell` (`33e685a4017f83ad`) of `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
  (`pump_amm`), per `pump-fun/pump-public-docs` → `idl/pump_amm.json`.
- **Both call forms:** a direct top-level `sell` (primary fixture
  `token-mixed-closeAccount`, at `[7]`) and a `sell` invoked under a Jupiter/router CPI (primary
  fixture `v0-success-swap`, at `[3.0]`). The router's envelope is still never read for meaning.
- **Not recognized, deliberately:** pump `buy`, every other pump_amm and pump_fees instruction,
  Jupiter `route_v2` semantics, and any "a token went out and another came in, so it was a sell"
  heuristic. A pump sell is never inferred from token deltas.

### How a leg is proven

A `PumpSellLeg` exists only when all of this holds; each step is one entry in the leg's `checks`
array, which is fixed at 19 entries in a fixed order:

| # | Condition | Required |
| --- | --- | --- |
| 1 | the instruction's program id is the pump_amm program | yes |
| 2 | its first 8 bytes are the `sell` discriminator (re-derived from `sha256('global:sell')`) | yes |
| 3 | its arguments parse with **exact** byte consumption — `base_amount_in: u64 @8`, `min_quote_amount_out: u64 @16`, 24 bytes, **no trailing byte** | yes |
| 4 | the 21 named IDL roles are present in IDL order (the tail is counted, never assumed) | yes |
| 5 | the instruction's CPI subtree is available (a CPI depth is known, inner instructions were recorded) | yes |
| 6–7 | exactly one transfer out of the named user base account and one into the named user quote account, **inside that subtree** | yes |
| 8–9 | those transfers' mints are the instruction's named `base_mint` and `quote_mint`, on opposite sides | yes |
| 10–11 | the base transfer's counterparty is `pool_base_token_account`, and the quote transfer's source is `pool_quote_token_account` | yes |
| 12 | the input transfer's amount equals the instruction's `base_amount_in` | yes |
| 13 | `min_quote_amount_out` is stated (`> 0`) | no — informational |
| 14 | the output is `>= min_quote_amount_out`, *if* one is stated | no |
| 15 | the base transfer was authorized by the account's reported owner | no — informational |
| 16 | the user's output is the transfer into the named user quote account, and every other outflow of the pool quote vault is listed separately by destination | yes |
| 17–18 | both transfers appear in the Milestone 3 effects model at the same instruction reference, with the same endpoints, mint, amount, `amountSource: 'instruction-data'` and a committed state | yes |
| 19 | the transaction itself succeeded | yes |

**The user's proceeds are identified by named account slot, never by size.** Everything else the
pool quote vault pays in the same subtree — protocol fee, coin-creator fee, and any further
destination — is reported as a `PumpSellFeeTransfer` with role `protocol-fee-recipient`,
`coin-creator-vault` or `other`, with its destination owner where that owner is itself evidenced
(account metadata, or the very ATA-creation instruction that made the account). No such transfer
is ever counted as the user's output, and no fee decomposition is claimed beyond listing them.

**`min_quote_amount_out = 0` is not a pass.** Zero means the instruction states no floor; the
renderer says so in those words (`no floor is stated by this instruction, so the output cannot be
tested against one`), the leg records `min-quote-amount-out-not-stated` as an unknown, and no
`min-quote-*` check is ever reported as passed. The routed fixture's leg is exactly that case; the
direct fixture states a floor of `171510690`, which its output of `176602689` satisfies.

**Commitment is inherited, never assumed.** A failed transaction is `not-committed` (a reverted
`sell` is still *recognized*, never a committed sell); a missing effects model caps a leg at
`partially-proven`; a missing CPI recording caps it at `partially-proven` too — the two transfer
checks become `not-checkable` and the renderer warns that absent inner instructions are *not
evidence that none happened*. Two disagreeing pieces of evidence make the leg `conflicting` and
both values are printed.

**Logs and events are supplemental only.** No pump event is parsed and none is required; the layer
works with `logs: null`. Conversely `Program log: Instruction: Sell` is never sufficient — a vote
transaction carrying that line verbatim produces **zero** legs.

### Output

`SWAPS` now covers both protocols and orders legs by execution order (top-level first, then inner
groups). A pump leg prints the instruction reference, the authoritative instruction name `sell`,
the pool, input amount/mint/token account/owner with its transfer leg, user output
amount/mint/token account/owner with its transfer leg, the named roles actually used (with the
counted tail), the excluded fee transfers, the floor line, the check tally and any unknowns. The
section still never prints BUY or SELL: `sell` appears only as the authoritative instruction name.

A report that names no protocols (the 4.1 `recognizeDlmmSwaps` API) keeps the exact 4.1 wording,
so the 4.1 golden tests still pin the same bytes; the section's header and footer name the
protocols only when the report says which ones were scanned.

### Fixtures

- `token-mixed-closeAccount.json` — the direct vector: a top-level pump_amm `sell` at `[7]`, with
  185356 WSOL in (`[7.1]`) and 176602689 units out (`[7.2]`), plus the protocol-fee and other
  quote-vault transfers it must not confuse with the output.
- `v0-success-swap.json` — the routed vector: a pump_amm `sell` at `[3.0]` executed under the
  router's CPI, with 2729270725642 units in (`[3.2]`) and 8747131976 WSOL out (`[3.3]`), a zero
  floor, three excluded fee transfers, and the two DLMM `swap2` legs of Milestone 4.1 at `[3.8]`
  and `[3.13]` unchanged.

### Tests

`tests/pump.sell.test.ts` (9), `tests/pump.fixtures.test.ts` (18),
`tests/pump.adversarial.test.ts` (34), `tests/render.swaps.pump.test.ts` (14): the exact
discriminator, exact byte consumption, IDL account order, both real legs (direct and routed),
fee-transfer exclusion, amount mismatch, wrong vault/mint, missing CPI, duplicated candidate
transfer, zero and non-zero `min_quote_amount_out`, a failed transaction, log independence,
in-memory mutation vectors, purity/determinism, the golden section, and DLMM regression.
`--no-swaps` is still verified byte-identical to the frozen Milestone 3 output, and every 4.1 DLMM
leg block renders byte-for-byte as it did in 4.1.

### Semantics still unknown (deliberately)

- **Everything else on pump_amm.** `buy`, the fee-program instructions and the rest stay
  unrecognized; only `sell` is matched.
- **The account tail.** 2 accounts on a direct sell, 3 when routed via a router — counted and
  reported as a number, never named or indexed. What a future program version puts there is
  unknown, and an unexpected count never changes the proof.
- **Fee provenance.** A destination is classified as protocol-fee or coin-creator only when it is
  the instruction's named fee slot; anything else is `other`. No bps, no mint-side fee split, and
  no total is claimed.
- **The router's own intent.** A routed sell is reported as a pool sell plus the router's other
  legs, never as one aggregated swap.
- **Price, PnL and "was this a good trade".** Not computed, not approximated.

## Milestone 4.3 — pump_amm `buy` recognition

Milestones 4.1 and 4.2 recognized one instruction each. This milestone adds the third instruction,
and only the third: **was this a `buy` on the pump_amm program, and exactly what did it claim?**
The direction is the instruction's own name, so nothing about it has to be inferred from token
movement — and nothing is: the words "buy" and "sell" exist in the output only as the instruction
names `pump_amm` itself declares. There is still no registry, no plugin list, and no shared "AMM"
abstraction; one recognizer file and one line that calls it.

### Scope: one program, one instruction

- **Recognized:** `buy` (`66063d1201daebea`) of `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
  (`pump_amm`), per `pump-fun/pump-public-docs` → `idl/pump_amm.json`.
- **Three real call forms:** a legacy direct `buy` (`legacy-success-pump-buy`, `[6]`), a routed
  `buy` under a router CPI (`v0-success-pump-buy-24b`, `[3.8]`), and a real failure
  (`v0-failed-pump-buy-slippage`, `[5]`, the program's own `ExceededSlippage` 6004).
- **Not recognized, deliberately:** `buy_exact_quote_in` (`c62e1552b4d9e870`) and every other
  pump_amm instruction, any new Jupiter route semantics, and any "a token came in and another went
  out, so it was a buy" heuristic.

### How a leg is proven

A `PumpBuyLeg` exists only when all of this holds; each step is one entry in the leg's `checks`
array, which is fixed at 20 entries in a fixed order:

| # | Condition | Required |
| --- | --- | --- |
| 1 | the instruction's program id is the pump_amm program | yes |
| 2 | its first 8 bytes are the `buy` discriminator (re-derived from `sha256('global:buy')`) | yes |
| 3 | its arguments parse with **exact** byte consumption — `base_amount_out: u64 @8`, `max_quote_amount_in: u64 @16`, 24 bytes, or 25 with a trailing `OptionBool` byte in `{0x00, 0x01}` | yes |
| 4 | the 23 named IDL roles are present in IDL order (the tail is counted, never assumed) | yes |
| 5 | the instruction's CPI subtree is available (a CPI depth is known, inner instructions were recorded) | yes |
| 6–7 | exactly one transfer into the named user base account and one into the named pool quote vault, **inside that subtree** | yes |
| 8–9 | those transfers' mints are the instruction's named `base_mint` and `quote_mint`, on opposite sides | yes |
| 10–11 | the base transfer's source is `pool_base_token_account`, and the payment's source is `user_quote_token_account` | yes |
| 12 | the base transfer's amount equals the instruction's `base_amount_out` **exactly** | yes |
| 13 | the user's spend is fully enumerated: every outflow of the named user quote account in the subtree appears in the effects model, and nothing else does | yes |
| 14 | a bound is stated at all — `max_quote_amount_in != u64::MAX`; the maximum u64 is recorded as "no limit stated" | no — informational, and an unknown |
| 15 | the total spend is inside that bound, when one is stated and check 13 passed | no — see below |
| 16 | the payment was authorized by the account's reported owner | no — informational |
| 17–19 | both transfers and **every fee transfer** appear in the Milestone 3 effects model at the same instruction reference, with the same endpoints, mint, amount, `amountSource: 'instruction-data'` and a committed state | yes |
| 20 | the transaction itself succeeded | yes |

**The user's spend is the payment plus every other outflow of the named user quote account.**
Those outflows are found in the instruction's own CPI subtree and classified by destination
identity: `protocol-fee-recipient`, `coin-creator-vault`, or `other`. They are listed with their
amounts and destination owners, and they are **counted in the total** — a fee the user paid is part
of what the user paid. A `BuyEvent` or a log line is never consulted, and never sufficient: the
real failed fixture carries a full `BuyEvent` and still reports `not-committed`.

**`max_quote_amount_in` bounds that total, and is only ever reported as satisfied when it can be.**
A finite cap is compared with the *total* spend (in the routed fixture the vault transfer alone is
below the cap while the total is exactly equal to it); `u64::MAX` means the instruction states no
binding limit, which is reported as `not-checkable` with the unknown `max-quote-amount-in-unbounded`
and never as a satisfied cap; `0` is a real bound of zero, evaluated literally — this is **not**
`sell`'s "`min_quote_amount_out = 0` means no floor" rule, and the two never share a code path.
Before any of that, the completeness gate of check 13 must pass: if an outflow of the user's quote
account is missing from the enumeration, or an attributed outflow is absent from the effects model,
the cap check is `not-checkable` and `user-quote-spend-not-fully-enumerated` is recorded — a
silently incomplete enumeration can never look like a satisfied bound.

**Two payload forms are recorded, not interpreted.** Live mainnet carries both a 24-byte `buy`
payload and a 25-byte one whose last byte is `0x00` or `0x01`. The layer accepts exactly those,
records which form it saw (`trackVolumeByte`), and states that it does not know why both exist: the
24-byte form is *not* read as `false`, and no fetched revision of the vendor IDL declares it.

### Output

```
  [6]  buy  pool CzTw…nk8y  quote → base  committed  proven
      in    2343923556 raw units  mint So11…1112  token account ARBC…fjCJ  owner 9KHS…evjp  leg [6.2]
      out   4734094242460 raw units  mint AJAa…pump  token account 4DeB…ZS5c  owner 9KHS…evjp  leg [6.1]
      roles  global_config ADyA…JKqw  pool_base 5S1e…faPk  pool_quote 4Up7…GaQd  base_mint AJAa…pump  quote_mint So11…1112  remaining 3
      fees   3 other outflow(s) of the user's quote account, counted in the spend: 584812 → 94qW…YDjb (protocol-fee-recipient, owner 62qc…fNgV); 22222829 → B8T8…xWK7 (coin-creator-vault, owner C69k…Re9b); 584811 → HjQj…Sr8i (other, owner 5YxQ…vxeD)
      cap  max_quote_amount_in 2980000000 — an upper bound on the user's total quote spend; the spend 2367316008 (2343923556 into the pool quote vault + 23392452 in 3 other outflow(s)) satisfies it
      checks  20 pass • 0 fail • 0 not-checkable
```

A failed buy renders as `reverted  NOT COMMITTED (transaction failed)` with a note that the
amounts below are attempted movement, and its cap line says the bound was never tested. The
section's header and footer, and its "nothing recognized" sentence, now name `pump_amm buy/sell`
— that is the whole of the change to what 4.1 and 4.2 print, and it is pinned by their tests.

### Fixtures

Six real mainnet buys, all harvested with the repository's own tool:

- `legacy-success-pump-buy.json` — the canonical direct buy: 25-byte payload `0x01`, 13454552763
  base out, 97750000 cap, three fee outflows, total spend 84441000.
- `v0-success-pump-buy-24b.json` — the routed 24-byte buy, whose total spend (22914125) is exactly
  its cap; also proves the buy's subtree does not swallow its sibling instructions' movements.
- `v0-success-pump-buy-24b-direct.json` — a direct 24-byte buy, so the payload form is covered
  without routing.
- `v0-success-pump-buy-25b-false.json` — the 25-byte form whose byte is `0x00`, and a buy whose
  quote side is a token while the base side is SOL.
- `v0-success-pump-buy-unbounded.json` — `max_quote_amount_in = u64::MAX`, in a transaction that
  also holds a pump `sell` (two legs, no cross-talk).
- `v0-failed-pump-buy-slippage.json` — reverted by the program's own `ExceededSlippage`: no
  transfers at all, so nothing is presented as committed and no cap is tested.

### Tests

`tests/pump.buy.test.ts` (25), `tests/pump.buy.fixtures.test.ts` (38),
`tests/pump.buy.adversarial.test.ts` (20), `tests/render.swaps.buy.test.ts` (9): the derived
discriminator, exact byte consumption in both payload forms, the 23-role IDL order, six real
fixtures end to end, the spend and its fee outflows, the completeness gate, cap satisfied /
exactly binding / violated / zero / `u64::MAX` / uncommitted, commit states, log and event
independence, look-alikes, truncation, invalid trailing bytes, swapped mints/vaults/user accounts,
ambiguous duplicates, a payment from the wrong account, a transfer to itself, missing CPI
recording, absent effects, payload-form equivalence, purity and determinism, and the golden
section. `--no-swaps` is verified byte-identical to the frozen Milestone 3 output over all 13
fixtures (272258 bytes), and both the 4.1 DLMM and the 4.2 sell recognizers produce byte-identical
output for every pre-4.3 fixture.

### Semantics still unknown (deliberately)

- **Why two payload forms exist.** Both are live in the same slot range; the 24-byte form is
  recorded as `absent` and never read as `false`, because the mechanism is unknown.
- **What the tail accounts are.** 2 or 3 of them, counted and never named; the last one is
  empirically the destination of one fee transfer, which is why outflows are *enumerated* rather
  than predicted.
- **Whether fee legs can be anything else.** Cashback was zero in every observed buy; a future
  cashback leg simply appears as another `other` outflow.
- **`buy_exact_quote_in` and every other pump_amm instruction.** Unrecognized, silently.
- **Price, PnL and "was this a good trade".** Not computed, not approximated.
