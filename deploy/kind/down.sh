#!/usr/bin/env bash
# Tear everything down, including images loaded into the cluster.
set -euo pipefail
CLUSTER="${KIND_CLUSTER:-x402-sandbox}"

echo "==> deleting workloads"
kubectl --context "kind-${CLUSTER}" delete -k "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/kubernetes" --ignore-not-found --wait=false 2>/dev/null || true

echo "==> deleting kind cluster '${CLUSTER}'"
kind delete cluster --name "${CLUSTER}"
