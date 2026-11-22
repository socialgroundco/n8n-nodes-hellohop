#!/usr/bin/env bash
# Starts a Prism mock of the public API spec, runs the tests against it, always stops it.
set -uo pipefail
cd "$(dirname "$0")/.."
PRISM="./node_modules/.bin/prism"
[ -x "$PRISM" ] || PRISM="${PRISM_BIN:-$HOME/.cache/b2-tools/node_modules/.bin/prism}"
PORT="${PRISM_PORT:-4519}"
"$PRISM" mock -p "$PORT" -h 127.0.0.1 test/fixtures/public-v1.json >/tmp/hellohop-n8n-prism.log 2>&1 &
PRISM_PID=$!
trap 'kill "$PRISM_PID" 2>/dev/null; wait "$PRISM_PID" 2>/dev/null' EXIT
for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && break
  sleep 0.5
done
PRISM_URL="http://127.0.0.1:$PORT" node --import tsx --test test/*.test.mts
