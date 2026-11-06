#!/usr/bin/env bash
# Lifecycle soak: create -> write -> suspend -> (sometimes fault) -> resume ->
# verify -> destroy. Asserts no session pods and no workspace PVCs at the end.
set -euo pipefail

CONTEXT="${CONTEXT:-kind-x402-sandbox}"
DURATION="${DURATION:-300}"
RATE="${RATE:-0.5}"
FAULT_EVERY="${FAULT_EVERY:-60}"
KUBECTL=(kubectl --context "${CONTEXT}" -n sandbox-system)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

restore() {
  echo "==> restoring deployment defaults"
  "${KUBECTL[@]}" set env deploy/api \
    CREATE_RATE_BURST- CREATE_RATE_REFILL- CREATE_IP_RATE_BURST- CREATE_IP_RATE_REFILL- >/dev/null 2>&1 || true
  "${KUBECTL[@]}" rollout status deploy/api --timeout=120s >/dev/null 2>&1 || true
}
trap restore EXIT

"${KUBECTL[@]}" set env deploy/api \
  CREATE_RATE_BURST=1000 CREATE_RATE_REFILL=500 \
  CREATE_IP_RATE_BURST=1000 CREATE_IP_RATE_REFILL=500 >/dev/null
"${KUBECTL[@]}" rollout status deploy/api --timeout=120s

cd "${ROOT}"
npx tsx benchmarks/harness/cli.ts soak --lifecycle \
  --duration "${DURATION}" --rate "${RATE}" --fault-every "${FAULT_EVERY}"
