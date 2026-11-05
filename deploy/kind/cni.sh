#!/usr/bin/env bash
# Install a real NetworkPolicy-enforcing CNI into the kind cluster.
#
# kind's default kindnet does not enforce NetworkPolicy, so a CNI that does is a
# hard requirement for this project. Cilium is used when the `cilium` CLI is
# available; otherwise the script prints instructions and fails.
set -euo pipefail

CLUSTER="${KIND_CLUSTER:-x402-sandbox}"
CONTEXT="kind-${CLUSTER}"

if ! command -v cilium >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: the `cilium` CLI is required for CNI installation.

  brew install cilium-cli        # macOS
  # or: https://docs.cilium.io/en/stable/gettingstarted/k8s-install-default/

Cilium is used because it enforces Kubernetes NetworkPolicy at the packet
level. Calico is an acceptable substitute; see docs/architecture.md.
EOF
  exit 1
fi

echo "==> installing Cilium (NetworkPolicy enforcement) into ${CONTEXT}"
cilium install \
  --context "${CONTEXT}" \
  --set kubeProxyReplacement=false \
  --set bpf.masquerade=false \
  --set ipam.mode=kubernetes \
  --set hubble.enabled=false

echo "==> waiting for Cilium to become ready"
cilium status --context "${CONTEXT}" --wait
