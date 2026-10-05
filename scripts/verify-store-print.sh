#!/usr/bin/env bash
#
# Proves that a stored transaction prints exactly like a freshly inspected one.
#
# For every fixture in ./fixtures:
#
#   1. `npm run store -- ingest <sig>` fetches it from a local mock node (no real network)
#   2. `npm run store -- print <sig> --json` is compared with `npm run inspect <sig> --json`
#   3. `npm run store -- print <sig>` is compared with `npm run inspect <sig>` after removing
#      the single trailing `  store:` line that only the storage CLI can print
#
# Both CLIs talk to the same mock endpoint at the same commitment, so a difference can only
# come from the store, not from the request.
#
# Usage: scripts/verify-store-print.sh [port] [workdir]
set -uo pipefail

PORT="${1:-8899}"
WORKDIR="${2:-$(mktemp -d)}"
FIXTURE_DIR="$(cd "$(dirname "$0")/.." && pwd)/fixtures"

mkdir -p "$WORKDIR"
STORE="$WORKDIR/corpus.db"
rm -f "$STORE" "$STORE-wal" "$STORE-shm"

node scripts/mock-rpc-fixtures.mjs "$PORT" "$FIXTURE_DIR" &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null' EXIT
for _ in $(seq 1 50); do
  if node -e "fetch('http://127.0.0.1:$PORT', {method:'POST', body:'{\"method\":\"getSignaturesForAddress\"}'}).then(() => process.exit(0)).catch(() => process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

RPC="http://127.0.0.1:$PORT"
COMMITMENT="finalized"
fixtures=("$FIXTURE_DIR"/*.json)
passed=0
failed=0

echo "verifying ${#fixtures[@]} fixture(s) against $RPC"
for fixture in "${fixtures[@]}"; do
  name="$(basename "$fixture" .json)"
  signature="$(node -e '
    const fs = require("fs");
    const envelope = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(envelope.request.signature);
  ' "$fixture")"

  if ! npm run --silent store -- ingest "$signature" --store "$STORE" --rpc "$RPC" --commitment "$COMMITMENT" >"$WORKDIR/$name.ingest" 2>&1; then
    echo "FAIL $name: ingest failed"
    sed -n '1,5p' "$WORKDIR/$name.ingest"
    failed=$((failed + 1))
    continue
  fi

  # Written to files, not to pipes: `inspect` ends with process.exit(), which can truncate a
  # large payload written to a pipe. Both CLIs are compared on the bytes they produce.
  npm run --silent store -- print "$signature" --store "$STORE" --json >"$WORKDIR/$name.store.json" 2>"$WORKDIR/$name.store.err"
  npm run --silent inspect -- "$signature" --rpc "$RPC" --commitment "$COMMITMENT" --json >"$WORKDIR/$name.inspect.json" 2>"$WORKDIR/$name.inspect.err"

  # stdout only: the store CLI runs on Node's experimental `node:sqlite`, so Node prints an
  # ExperimentalWarning to stderr. Stdout is the comparison surface, and it must stay clean.
  npm run --silent store -- print "$signature" --store "$STORE" >"$WORKDIR/$name.store.txt" 2>"$WORKDIR/$name.store.report.err"
  npm run --silent inspect -- "$signature" --rpc "$RPC" --commitment "$COMMITMENT" >"$WORKDIR/$name.inspect.txt" 2>"$WORKDIR/$name.inspect.err"
  grep -v '^  store: ' "$WORKDIR/$name.store.txt" >"$WORKDIR/$name.store.nocounts.txt"

  problems=()
  if ! cmp -s "$WORKDIR/$name.store.json" "$WORKDIR/$name.inspect.json"; then
    problems+=("json payload differs")
  fi
  if ! cmp -s "$WORKDIR/$name.store.nocounts.txt" "$WORKDIR/$name.inspect.txt"; then
    problems+=("text output differs (beyond the store: line)")
  fi
  counts_lines="$(grep -c '^  store: ' "$WORKDIR/$name.store.txt" || true)"
  if [ "$counts_lines" != "1" ]; then
    problems+=("expected exactly one store: line, found $counts_lines")
  fi
  if grep -qi 'error' "$WORKDIR/$name.store.report.err"; then
    problems+=("the storage CLI wrote an error to stderr")
  fi
  if [ -s "$WORKDIR/$name.inspect.err" ]; then
    problems+=("inspect wrote to stderr")
  fi

  if [ "${#problems[@]}" -eq 0 ]; then
    passed=$((passed + 1))
    echo "ok   $name"
  else
    failed=$((failed + 1))
    echo "FAIL $name: ${problems[*]}"
    diff "$WORKDIR/$name.store.nocounts.txt" "$WORKDIR/$name.inspect.txt" | head -20
    diff "$WORKDIR/$name.store.json" "$WORKDIR/$name.inspect.json" | head -5
  fi
done

echo
echo "print ≡ inspect: ${passed} passed, ${failed} failed (artifacts in $WORKDIR)"
[ "$failed" -eq 0 ]
