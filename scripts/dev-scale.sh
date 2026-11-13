#!/usr/bin/env bash
# Scale the data plane to N replicas, for local validation only.
#
# Proving the relay and proxy work at more than one replica used to be a manual
# sequence: patch control-config, scale both StatefulSets, restart the API and
# controller, then repeat after the next `make build deploy` because that resets
# the ConfigMap and the StatefulSets to their manifest values (#146).
#
# With no argument it prints the current counts and changes nothing.
#
# This is a dev-cluster tool. It is not the HA story (ADR 0010): the controller
# stays one replica, and the API's rate limits stay in-memory per replica.
set -euo pipefail

KUBECTL="${KUBECTL:-kubectl}"
NAMESPACE="${NAMESPACE:-sandbox-system}"
# Empty means the current kubeconfig context, which is what the other scripts in
# this directory assume.
CONTEXT="${CONTEXT:-}"
# scripts/dev-secrets.sh issues the relay certificate with SANs for relay-0..9,
# so a larger count needs a new certificate before the controller's mTLS admin
# calls can reach the extra shards.
MAX_REPLICAS="${MAX_REPLICAS:-10}"

k() {
  if [ -n "${CONTEXT}" ]; then
    "${KUBECTL}" --context "${CONTEXT}" -n "${NAMESPACE}" "$@"
  else
    "${KUBECTL}" -n "${NAMESPACE}" "$@"
  fi
}

# One ClusterIP Service per relay shard, selecting exactly that StatefulSet pod.
#
# A guest bakes its relay URL into the process at boot and cannot resolve DNS, so
# above one replica it needs a stable per-shard address. A Pod IP is not stable:
# replacing the pod changes it and every guest on that shard dials a dead
# address. `relay-<n>` is the address the controller hands out; it exists only
# while the shard does.
#
# The committed default is two shards, so relay-0 and relay-1 already live in
# deploy/kubernetes/12-relay.yaml. This keeps the cluster's Services in step with
# the N you ask for here; N=1 removes them (nothing to address) and `make deploy`
# restores the committed two. Changing the committed count means changing the
# manifest, not only this script: scripts/check-singletons.mjs requires one
# Service per shard.
ensure_relay_shard_services() {
  local target="$1" n
  for n in $(seq 0 $((MAX_REPLICAS - 1))); do
    if [ "${target}" -gt 1 ] && [ "${n}" -lt "${target}" ]; then
      cat <<EOF | k apply -f - >/dev/null
apiVersion: v1
kind: Service
metadata:
  name: relay-${n}
  namespace: ${NAMESPACE}
  labels: {app: relay, x402.io/relay-shard: "${n}"}
spec:
  selector:
    statefulset.kubernetes.io/pod-name: relay-${n}
  ports:
    - name: guest
      port: 8443
      targetPort: 8443
EOF
    else
      k delete service "relay-${n}" --ignore-not-found >/dev/null 2>&1 || true
    fi
  done
}

# A field that is absent (readyReplicas while a pod is starting) reads as 0.
field() {
  local kind="$1" name="$2" path="$3" value
  value="$(k get "${kind}" "${name}" -o "jsonpath={.${path}}" 2>/dev/null || true)"
  echo "${value:-0}"
}

config_value() {
  k get configmap control-config -o "jsonpath={.data.$1}" 2>/dev/null || true
}

report() {
  local relay_replicas relay_ready proxy_replicas proxy_ready api_replicas api_ready ctl_replicas ctl_ready
  relay_replicas="$(field statefulset relay spec.replicas)"
  relay_ready="$(field statefulset relay status.readyReplicas)"
  proxy_replicas="$(field statefulset egress-proxy spec.replicas)"
  proxy_ready="$(field statefulset egress-proxy status.readyReplicas)"
  api_replicas="$(field deployment api spec.replicas)"
  api_ready="$(field deployment api status.readyReplicas)"
  ctl_replicas="$(field deployment controller spec.replicas)"
  ctl_ready="$(field deployment controller status.readyReplicas)"

  echo "control plane (${NAMESPACE}):"
  printf '  %-13s %s replica(s), %s ready\n' controller "${ctl_replicas}" "${ctl_ready}"
  printf '  %-13s %s replica(s), %s ready\n' api "${api_replicas}" "${api_ready}"
  printf '  %-13s %s replica(s), %s ready   RELAY_REPLICAS=%s\n' \
    relay "${relay_replicas}" "${relay_ready}" "$(config_value RELAY_REPLICAS)"
  printf '  %-13s %s replica(s), %s ready   PROXY_REPLICAS=%s\n' \
    egress-proxy "${proxy_replicas}" "${proxy_ready}" "$(config_value PROXY_REPLICAS)"

  # A mismatch is the failure the config parser is designed to catch
  # (`SHARD_INDEX outside the N-replica range`), but it is worth saying out loud
  # before someone reads a CrashLoopBackOff as an unrelated regression.
  if [ "${relay_replicas}" != "$(config_value RELAY_REPLICAS)" ]; then
    echo "warning: relay StatefulSet and RELAY_REPLICAS disagree; a shard will refuse to start" >&2
  fi
  if [ "${proxy_replicas}" != "$(config_value PROXY_REPLICAS)" ]; then
    echo "warning: egress-proxy StatefulSet and PROXY_REPLICAS disagree; a shard will refuse to start" >&2
  fi
}

if ! k get namespace "${NAMESPACE}" >/dev/null 2>&1; then
  echo "no ${NAMESPACE} namespace: is the kind cluster up? (make up)" >&2
  exit 1
fi

target="${1:-}"
if [ -z "${target}" ]; then
  report
  exit 0
fi

if ! [[ "${target}" =~ ^[1-9][0-9]*$ ]] || [ "${target}" -gt "${MAX_REPLICAS}" ]; then
  echo "usage: make dev-scale [N]   (N between 1 and ${MAX_REPLICAS})" >&2
  exit 2
fi

echo "==> scaling the data plane to ${target} replica(s)"
# ConfigMap first: a pod whose ordinal is outside RELAY_REPLICAS refuses to
# start (controller/src/config.ts), so raising the StatefulSet first would crash
# the new shard. Lowering it first would leave a live shard unaddressed.
k patch configmap control-config --type merge \
  -p "{\"data\":{\"RELAY_REPLICAS\":\"${target}\",\"PROXY_REPLICAS\":\"${target}\"}}" >/dev/null

k scale statefulset/relay statefulset/egress-proxy --replicas="${target}" >/dev/null

echo "==> ensuring per-shard relay Services"
ensure_relay_shard_services "${target}"

# kind load replaces an image under the same tag; kubelet will not restart a pod
# whose tag did not change, so a rebuild is invisible without this. The API and
# controller also read the replica counts from the ConfigMap.
echo "==> restarting the control plane"
k rollout restart deployment/api deployment/controller statefulset/relay statefulset/egress-proxy >/dev/null

k rollout status deployment/controller --timeout=180s
k rollout status deployment/api --timeout=180s
k rollout status statefulset/relay --timeout=180s
k rollout status statefulset/egress-proxy --timeout=180s

report
echo "==> run: make demo-session"
