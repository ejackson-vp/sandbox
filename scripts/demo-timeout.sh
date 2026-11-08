#!/usr/bin/env bash
# Per-command timeout: a runaway command is killed at the requested timeout,
# the session stays usable afterwards.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="node ${ROOT}/cli/dist/index.js"
API_URL="${API_URL:-http://localhost:8080}"
COMMON=(--api-url "${API_URL}" --payment-mode mock --quiet)
json_field() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(process.argv[1].split('.').reduce((o,k)=>o?.[k],j)??'')})" "$1"; }

OUT="$(${CLI} create --tier short "${COMMON[@]}" --json)"
SESSION_ID="$(printf '%s' "${OUT}" | json_field sessionId)"

echo "== running a command with a 2s timeout"
set +e
${CLI} exec "${SESSION_ID}" "${COMMON[@]}" --timeout 2s -- bash -c 'echo start; sleep 60'
CODE=$?
set -e
echo "cli exit code: ${CODE} (124 = timed out)"

echo
echo "== the session is still usable"
${CLI} exec "${SESSION_ID}" "${COMMON[@]}" -- echo "still alive"

${CLI} destroy "${SESSION_ID}" "${COMMON[@]}"
