#!/usr/bin/env bash
# Capacity admission demo. Constrains the controller to 700 MiB of schedulable
# memory and 1000m CPU, runs the SDK demo, then restores the deployment.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NAMESPACE="${NAMESPACE:-sandbox-system}"
CONTROLLER_PORT="${CONTROLLER_PORT:-13001}"
export API_URL="${API_URL:-http://localhost:8080}"
export CONTROLLER_URL="http://127.0.0.1:${CONTROLLER_PORT}"
export CONTROLLER_ADMIN_TOKEN
CONTROLLER_ADMIN_TOKEN="$(kubectl -n "$NAMESPACE" get secret x402-secrets -o jsonpath='{.data.admin-token}' | base64 --decode)"

cleanup() {
  kill "${PF_PID:-}" 2>/dev/null || true
  kubectl -n "$NAMESPACE" set env deploy/controller \
    CAPACITY_NODE_MEMORY_MIB- \
    CAPACITY_NODE_CPU_MILLICORES- \
    CAPACITY_PLATFORM_OVERHEAD_MEMORY_MIB- \
    CAPACITY_PLATFORM_OVERHEAD_CPU_MILLICORES- \
    CAPACITY_PLATFORM_OVERHEAD_STORAGE_MIB- >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" rollout status deploy/controller --timeout=120s >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> constraining controller capacity"
kubectl -n "$NAMESPACE" set env deploy/controller \
  CAPACITY_NODE_MEMORY_MIB=700 \
  CAPACITY_NODE_CPU_MILLICORES=1000 \
  CAPACITY_PLATFORM_OVERHEAD_MEMORY_MIB=0 \
  CAPACITY_PLATFORM_OVERHEAD_CPU_MILLICORES=0 \
  CAPACITY_PLATFORM_OVERHEAD_STORAGE_MIB=0 >/dev/null
kubectl -n "$NAMESPACE" rollout status deploy/controller --timeout=120s

echo "==> port-forwarding controller for capacity inspection"
kubectl -n "$NAMESPACE" port-forward svc/controller "${CONTROLLER_PORT}:3001" >/tmp/x402-capacity-port-forward.log 2>&1 &
PF_PID=$!
for _ in $(seq 1 50); do
  curl -fsS -H "x-internal-token: ${CONTROLLER_ADMIN_TOKEN}" \
    "${CONTROLLER_URL}/internal/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done

echo "==> running capacity demo"
npx tsx scripts/capacity-demo.ts
