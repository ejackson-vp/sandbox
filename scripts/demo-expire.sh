#!/usr/bin/env bash
# Proves lease enforcement: buy a 5-second session, wait, then show that it is
# EXPIRED, refuses work, and that the pod is gone.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="node ${ROOT}/cli/dist/index.js"
API_URL="${API_URL:-http://localhost:8080}"
CONTEXT="${KUBECTL_CONTEXT:-kind-${KIND_CLUSTER:-x402-sandbox}}"
COMMON=(--api-url "${API_URL}" --payment-mode mock --quiet)
json_field() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(process.argv[1].split('.').reduce((o,k)=>o?.[k],j)??'')})" "$1"; }

echo "== creating a 5-second session"
OUT="$(${CLI} create --tier custom --duration 5 "${COMMON[@]}" --json)"
SESSION_ID="$(printf '%s' "${OUT}" | json_field sessionId)"
echo "session: ${SESSION_ID}"
echo "expires: $(printf '%s' "${OUT}" | json_field status.leaseExpiresAt)"

echo
echo "== running a command before expiry"
${CLI} exec "${SESSION_ID}" "${COMMON[@]}" -- echo "alive before expiry"

echo
echo "== waiting for the lease to end"
sleep 8

echo "== status after expiry"
${CLI} status "${SESSION_ID}" "${COMMON[@]}"

echo
echo "== attempting work after expiry (must fail)"
if ${CLI} exec "${SESSION_ID}" "${COMMON[@]}" -- echo "should not run"; then
  echo "error: execution after expiry unexpectedly succeeded" >&2
  exit 1
else
  echo "execution refused as expected"
fi

echo
echo "== verifying the pod was removed"
for i in $(seq 1 40); do
  PODS="$(kubectl --context "${CONTEXT}" -n sandbox-workloads get pods -l "x402.io/session=${SESSION_ID}" --no-headers 2>/dev/null || true)"
  if [ -z "${PODS}" ]; then
    echo "no sandbox pods remain"
    exit 0
  fi
  sleep 0.5
done
echo "error: expired sandbox pod still exists" >&2
exit 1
