#!/usr/bin/env bash
# Create the kind cluster (idempotent) and install the CNI.
set -euo pipefail

CLUSTER="${KIND_CLUSTER:-x402-sandbox}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="${CLUSTER_CONFIG:-${ROOT}/deploy/kind/cluster.yaml}"

if kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  echo "==> kind cluster '${CLUSTER}' already exists"
else
  echo "==> creating kind cluster '${CLUSTER}'"
  kind create cluster --config "${CONFIG}"
fi

"${ROOT}/deploy/kind/cni.sh"

kubectl config use-context "kind-${CLUSTER}" >/dev/null
kubectl wait --for=condition=Ready nodes --all --timeout=180s
kubectl -n kube-system wait --for=condition=Ready pods -l k8s-app=kube-dns --timeout=180s
echo "==> cluster ready"
