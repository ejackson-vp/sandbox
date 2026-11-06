#!/usr/bin/env bash
# Burst the warm pool: N simultaneous paid creates, then restore defaults.
#
# Both admission buckets are raised so the measurement is about pool/capacity,
# not the product's per-payer rate limit. Run the same command with the default
# limits to measure admission control itself.
set -euo pipefail

CONTEXT="${CONTEXT:-kind-x402-sandbox}"
POOL_SIZE="${POOL_SIZE:-8}"
POOL_TIER="${POOL_TIER:-short}"
LEVELS="${LEVELS:-10,25,50}"
MAX="${MAX:-50}"
KUBECTL=(kubectl --context "${CONTEXT}" -n sandbox-system)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

restore() {
  echo "==> restoring deployment defaults"
  "${KUBECTL[@]}" set env deploy/api \
    CREATE_RATE_BURST- CREATE_RATE_REFILL- CREATE_IP_RATE_BURST- CREATE_IP_RATE_REFILL- >/dev/null 2>&1 || true
  "${KUBECTL[@]}" set env deploy/controller WARM_POOL_SIZE- WARM_POOL_TIER- >/dev/null 2>&1 || true
  "${KUBECTL[@]}" rollout status deploy/api --timeout=120s >/dev/null 2>&1 || true
  "${KUBECTL[@]}" rollout status deploy/controller --timeout=180s >/dev/null 2>&1 || true
}
trap restore EXIT

echo "==> enabling warm pool (size=${POOL_SIZE}, tier=${POOL_TIER})"
"${KUBECTL[@]}" set env deploy/api \
  CREATE_RATE_BURST=1000 CREATE_RATE_REFILL=500 \
  CREATE_IP_RATE_BURST=1000 CREATE_IP_RATE_REFILL=500 >/dev/null
"${KUBECTL[@]}" set env deploy/controller WARM_POOL_SIZE="${POOL_SIZE}" WARM_POOL_TIER="${POOL_TIER}" >/dev/null
"${KUBECTL[@]}" rollout status deploy/api --timeout=120s
"${KUBECTL[@]}" rollout status deploy/controller --timeout=180s

echo "==> waiting for ${POOL_SIZE} warm pod(s)"
for _ in $(seq 1 90); do
  count="$(kubectl --context "${CONTEXT}" -n sandbox-workloads get pods -l x402.io/pool=warm --no-headers 2>/dev/null | wc -l | tr -d ' ')"
  [ "${count}" -ge "${POOL_SIZE}" ] && break
  sleep 1
done

cd "${ROOT}"
npx tsx benchmarks/harness/cli.ts burst --levels "${LEVELS}" --max "${MAX}" --yes
