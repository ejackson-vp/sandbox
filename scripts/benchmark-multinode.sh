#!/usr/bin/env bash
# Two-worker burst benchmark. Requires `make up-2w`.
#
# Both kind workers are containers in the same Docker Desktop VM, so node
# memory is not additive. CAPACITY_NODE_MEMORY_MIB keeps the logical accounting
# well inside the shared VM.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONTEXT="${CONTEXT:-kind-x402-sandbox}"
POOL_SIZE="${POOL_SIZE:-8}"
LEVELS="${LEVELS:-10,25}"
NODE_MEMORY_MIB="${NODE_MEMORY_MIB:-2500}"

workers="$(kubectl --context "${CONTEXT}" get nodes -l x402.io/sandbox-pool=true --no-headers 2>/dev/null | wc -l | tr -d ' ')"
if [ "${workers}" -lt 2 ]; then
  echo "refusing: need at least 2 sandbox workers, found ${workers}; run make up-2w" >&2
  exit 2
fi

echo "==> two-worker burst: workers=${workers}, logical node memory=${NODE_MEMORY_MIB}MiB, levels=${LEVELS}"
MODE=capacity \
  NODE_MEMORY_MIB="${NODE_MEMORY_MIB}" \
  POOL_SIZE="${POOL_SIZE}" \
  LEVELS="${LEVELS}" \
  PROVISION_LIMIT="${PROVISION_LIMIT:-0}" \
  ./scripts/benchmark-capacity.sh

echo "==> restore the single-worker benchmark rig with: make down up"
