#!/usr/bin/env bash
# Capacity-admission benchmark: same burst, capacity on vs off.
#
#   MODE=baseline ./scripts/benchmark-capacity.sh   # CAPACITY_ENABLED=false
#   MODE=capacity ./scripts/benchmark-capacity.sh   # CAPACITY_ENABLED=true
#   MODE=capacity PROVISION_LIMIT=4 ./scripts/benchmark-capacity.sh
set -euo pipefail

CONTEXT="${CONTEXT:-kind-x402-sandbox}"
POOL_SIZE="${POOL_SIZE:-8}"
POOL_TIER="${POOL_TIER:-short}"
PROVISION_LIMIT="${PROVISION_LIMIT:-0}"
LEVELS="${LEVELS:-5,10,25,50}"
MAX="${MAX:-50}"
MODE="${MODE:-capacity}"
NODE_MEMORY_MIB="${NODE_MEMORY_MIB:-}"
KUBECTL=(kubectl --context "${CONTEXT}" -n sandbox-system)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

restore() {
  echo "==> restoring deployment defaults"
  "${KUBECTL[@]}" set env deploy/api \
    CREATE_RATE_BURST- CREATE_RATE_REFILL- CREATE_IP_RATE_BURST- CREATE_IP_RATE_REFILL- >/dev/null 2>&1 || true
  "${KUBECTL[@]}" set env deploy/controller \
    WARM_POOL_SIZE- WARM_POOL_TIER- MAX_CONCURRENT_PROVISIONING- CAPACITY_ENABLED- \
    CAPACITY_NODE_MEMORY_MIB- CAPACITY_PLATFORM_OVERHEAD_MEMORY_MIB- >/dev/null 2>&1 || true
  "${KUBECTL[@]}" rollout status deploy/api --timeout=120s >/dev/null 2>&1 || true
  "${KUBECTL[@]}" rollout status deploy/controller --timeout=180s >/dev/null 2>&1 || true
}
trap restore EXIT

echo "==> mode=${MODE}, pool=${POOL_SIZE}, provisioning=${PROVISION_LIMIT}, levels=${LEVELS}"
"${KUBECTL[@]}" set env deploy/api \
  CREATE_RATE_BURST=1000 CREATE_RATE_REFILL=500 \
  CREATE_IP_RATE_BURST=1000 CREATE_IP_RATE_REFILL=500 >/dev/null
EXTRA_ENV=()
if [ -n "${NODE_MEMORY_MIB}" ]; then
  EXTRA_ENV=(CAPACITY_NODE_MEMORY_MIB="${NODE_MEMORY_MIB}" CAPACITY_PLATFORM_OVERHEAD_MEMORY_MIB=0)
fi
"${KUBECTL[@]}" set env deploy/controller \
  WARM_POOL_SIZE="${POOL_SIZE}" WARM_POOL_TIER="${POOL_TIER}" \
  MAX_CONCURRENT_PROVISIONING="${PROVISION_LIMIT}" \
  CAPACITY_ENABLED="$([ "${MODE}" = "baseline" ] && echo false || echo true)" \
  "${EXTRA_ENV[@]}" >/dev/null
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
