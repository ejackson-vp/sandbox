#!/usr/bin/env bash
# Multi-node placement demo. Requires `make up-2w`.
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
}
trap cleanup EXIT

kubectl -n "$NAMESPACE" port-forward svc/controller "${CONTROLLER_PORT}:3001" >/tmp/x402-placement-port-forward.log 2>&1 &
PF_PID=$!
for _ in $(seq 1 50); do
  curl -fsS -H "x-internal-token: ${CONTROLLER_ADMIN_TOKEN}" \
    "${CONTROLLER_URL}/internal/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done

npx tsx scripts/placement-demo.ts
