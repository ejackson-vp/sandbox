#!/usr/bin/env bash
# Prove the guest image ClusterPolicy does what it says (#30).
#
# The policy file has existed since F-06 was filed and has never been executed,
# so `security-review/RELEASE_GATE.md` lists "Guest pod image pinned at admission"
# as PARTIAL. This script turns it into evidence on a throwaway kind cluster:
#
#   1. a Pod whose guest image is a tag is rejected;
#   2. a Pod in a foreign repository pinned by digest is rejected;
#   3. a digest that is not the released one is rejected;
#   4. the repository@sha256 released in deploy/release-pins.json is admitted.
#
# Admission is asked with `--dry-run=server`, so nothing is scheduled and no
# image is pulled: the API server runs the Kyverno webhook and answers, which is
# the control under test.
#
# It is not in CI. Kyverno's own install manifest is a rolling URL of unpinned
# images, which is the supply-chain gap F-15 is about; wiring it into a workflow
# needs digest-pinned Kyverno images first. Documented in
# deploy/kubernetes/kyverno/README.md.
#
# Usage:
#   ./scripts/kyverno-policy-test.sh            # creates and deletes its cluster
#   KEEP_CLUSTER=1 ./scripts/kyverno-policy-test.sh
#   TEST_CONTEXT=kind-x402-sandbox ./scripts/kyverno-policy-test.sh   # reuse one
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY="${ROOT}/deploy/kubernetes/kyverno/guest-image-policy.yaml"
PINS="${ROOT}/deploy/release-pins.json"
CLUSTER="${KYVERNO_TEST_CLUSTER:-x402-kyverno-policy}"
KYVERNO_VERSION="${KYVERNO_VERSION:-v1.13.4}"
NAMESPACE="${KYVERNO_TEST_NAMESPACE:-x402-policy-test}"
KEEP_CLUSTER="${KEEP_CLUSTER:-0}"

failures=()
fail() {
  failures+=("$1")
  echo "::error::$1"
}
note() {
  echo "==> $1"
}

cleanup() {
  kubectl --context "$CONTEXT" delete namespace "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if [ "$KEEP_CLUSTER" != "1" ] && [ -z "${TEST_CONTEXT:-}" ]; then
    kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ -n "${TEST_CONTEXT:-}" ]; then
  CONTEXT="$TEST_CONTEXT"
  if ! kubectl --context "$CONTEXT" get nodes >/dev/null 2>&1; then
    echo "::error::TEST_CONTEXT=${CONTEXT} is not reachable" >&2
    exit 1
  fi
else
  CONTEXT="kind-${CLUSTER}"
  if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    note "creating kind cluster ${CLUSTER}"
    kind create cluster --name "$CLUSTER" --wait 120s >/dev/null || {
      echo "::error::could not create the kind cluster" >&2
      exit 1
    }
  fi
fi

# The released digests, read from the same map scripts/check-deploy-pins.mjs
# compares against the overlay. jq is already required by the release workflow.
if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq is required" >&2
  exit 1
fi
released="$(jq -r '.talos.guestDigest' "$PINS")"
if ! printf '%s' "$released" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  echo "::error::${PINS} has no usable talos.guestDigest" >&2
  exit 1
fi
repository="ghcr.io/ejackson-vp/sandbox-guest"

note "installing Kyverno ${KYVERNO_VERSION}"
# `create`, not `apply`: Kyverno's CRDs carry annotations larger than the 262144
# byte limit `kubectl apply` enforces with a client-side last-applied annotation.
if kubectl --context "$CONTEXT" get namespace kyverno >/dev/null 2>&1; then
  note "Kyverno namespace already exists: not reinstalling"
else
  kubectl --context "$CONTEXT" create -f \
    "https://github.com/kyverno/kyverno/releases/download/${KYVERNO_VERSION}/install.yaml" >/dev/null || {
    echo "::error::could not create the Kyverno install manifest" >&2
    exit 1
  }
fi
kubectl --context "$CONTEXT" -n kyverno wait --for=condition=Available deploy --all --timeout=300s >/dev/null || {
  echo "::error::Kyverno did not become Available" >&2
  exit 1
}
# The webhook has to be serving before the first dry-run, or every dry-run fails
# for the wrong reason and this script reports a pass it did not earn.
for _ in $(seq 1 60); do
  ready="$(kubectl --context "$CONTEXT" -n kyverno get endpoints kyverno-svc -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null || true)"
  [ -n "$ready" ] && break
  sleep 2
done

# The API server rejects a pod whose runtimeClassName does not exist, before
# Kyverno is consulted. A stand-in class keeps every case below about the image
# rule rather than the scheduler's.
kubectl --context "$CONTEXT" apply -f - >/dev/null <<'EOF'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: x402-sandbox
handler: runc
EOF

note "applying the policy"
kubectl --context "$CONTEXT" apply -f "$POLICY" >/dev/null || {
  echo "::error::could not apply ${POLICY}" >&2
  exit 1
}
kubectl --context "$CONTEXT" wait --for=condition=Ready clusterpolicy/sandbox-guest-image-pinned --timeout=120s >/dev/null || {
  echo "::error::the ClusterPolicy did not become Ready" >&2
  exit 1
}

# A namespace the policy matches. The label is what scopes both rules; without
# it the policy is inert and every case below would pass for the wrong reason.
kubectl --context "$CONTEXT" create namespace "$NAMESPACE" >/dev/null 2>&1 || true
kubectl --context "$CONTEXT" label namespace "$NAMESPACE" x402.io/image-policy=enforce --overwrite >/dev/null

# admit <name> <image> [init-image]: true when the API server accepts the Pod in
# dry-run. An init image is supplied for the case that hides a tag there.
admit() {
  local name="$1" image="$2" init_image="${3:-}"
  kubectl --context "$CONTEXT" -n "$NAMESPACE" create --dry-run=server -f - >/dev/null 2>&1 <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
spec:
  runtimeClassName: x402-sandbox
  restartPolicy: Never
  initContainers:
    - name: bootstrap
      image: ${init_image:-${image}}
  containers:
    - name: guest
      image: ${image}
EOF
}

expect_reject() {
  local name="$1" image="$2" why="$3" init_image="${4:-}"
  if admit "$name" "$image" "$init_image"; then
    fail "admitted a pod that should be rejected (${why}): ${image} (init ${init_image:-same})"
  else
    note "rejected ${why}: ${image}"
  fi
}

expect_admit() {
  local name="$1" image="$2" why="$3" init_image="${4:-}"
  if admit "$name" "$image" "$init_image"; then
    note "admitted ${why}: ${image}"
  else
    fail "rejected a pod that should be admitted (${why}): ${image} (init ${init_image:-same})"
  fi
}

note "case 1: a tag is not a pin"
expect_reject policy-tag "${repository}:0.1.30" "tag-only reference"

note "case 2: another repository is not the pinned one"
expect_reject policy-foreign "docker.io/library/alpine@${released}" "foreign repository"

note "case 3: a different digest is not the released one"
zeros="$(printf '0%.0s' $(seq 1 64))"
expect_reject policy-stale "${repository}@sha256:${zeros}" "unreleased digest"

note "case 4: a tag in an initContainer is rejected"
# The rule walks `spec.[containers, initContainers][]`; a tag hidden in the
# bootstrap container is the same unpinned image.
expect_reject policy-init-tag "${repository}@${released}" "initContainer tag" "${repository}:0.1.30"

note "case 5: the released repository@digest is admitted"
expect_admit policy-pinned "${repository}@${released}" "released digest"

# One more thing the two rules must not do: reject a pod outside their scope.
unlabelled="x402-policy-ignored"
kubectl --context "$CONTEXT" create namespace "$unlabelled" >/dev/null 2>&1 || true
if kubectl --context "$CONTEXT" -n "$unlabelled" create --dry-run=server -f - >/dev/null 2>&1 <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: outside-scope
spec:
  containers:
    - name: c
      image: docker.io/library/alpine:3.20
EOF
then
  note "admitted a tag outside the labelled namespace, as designed"
else
  fail "the policy rejected a pod outside its namespace scope"
fi
kubectl --context "$CONTEXT" delete namespace "$unlabelled" --ignore-not-found --wait=false >/dev/null 2>&1 || true

if [ "${#failures[@]}" -gt 0 ]; then
  echo ""
  echo "Kyverno policy test failed with ${#failures[@]} problem(s)."
  for failure in "${failures[@]}"; do echo "  - ${failure}"; done
  exit 1
fi
echo ""
echo "Kyverno policy test passed: tag, foreign repository and stale digest rejected; released digest admitted."
