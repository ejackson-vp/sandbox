#!/usr/bin/env bash
# Release-gate isolation suites (#44).
#
# Runs tests/security against the live cluster, proves the sandbox RuntimeClass
# really boots the guest image, and records the image digests the cluster ran.
# Fails when the suite did not execute (no cluster, no Cilium CRDs, every test
# skipped), when the RuntimeClass is not the expected one, or when the images
# under test are not the ones the release is about to promote.
#
# This is the evidence `security-review/RELEASE_GATE.md` asks for: "make
# security-test on a disposable kind/Cilium cluster and the real Kata class,
# with image digests recorded".
#
# Usage, against a cluster already deployed with `make up` + the Kata overlay:
#   make security-isolation
#
#   EXPECT_CONTROL_IMAGE, EXPECT_CONTROL_DIGEST
#   EXPECT_GUEST_IMAGE,   EXPECT_GUEST_DIGEST   pin the tested images
#   REQUIRE_DIGEST_MATCH=1                      fail instead of skipping the check
#   EXPECT_RUNTIME_HANDLER                      default: kata
#   EXPECT_ISOLATION_ANNOTATION                 default: microvm
#
# Runner requirement is documented in docs/release-process.md.
set -uo pipefail

ARTIFACTS="${ARTIFACTS:-artifacts/isolation}"
NAMESPACE="${NAMESPACE:-sandbox-system}"
RUNTIME_CLASS="${RUNTIME_CLASS_NAME:-x402-sandbox}"
EXPECT_HANDLER="${EXPECT_RUNTIME_HANDLER:-kata}"
EXPECT_ISOLATION="${EXPECT_ISOLATION_ANNOTATION:-microvm}"
CONTROL_IMG="${CONTROL_IMG:-x402-sandbox/control:dev}"
GUEST_IMG="${GUEST_IMAGE:-x402-sandbox/guest:dev}"
EXPECT_CONTROL_IMAGE="${EXPECT_CONTROL_IMAGE:-}"
EXPECT_CONTROL_DIGEST="${EXPECT_CONTROL_DIGEST:-}"
EXPECT_GUEST_IMAGE="${EXPECT_GUEST_IMAGE:-}"
EXPECT_GUEST_DIGEST="${EXPECT_GUEST_DIGEST:-}"
PROBE_POD="x402-isolation-probe"
CONTEXT="${KUBECTL_CONTEXT:-$(kubectl config current-context 2>/dev/null || true)}"

mkdir -p "$ARTIFACTS"
failures=()

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

fail() {
  failures+=("$1")
  echo "::error::$1"
  summary "- **FAILED**: $1"
}

kubectl_do() {
  kubectl --context "$CONTEXT" "$@"
}

# --- preconditions ---------------------------------------------------------

if [ -z "$CONTEXT" ]; then
  fail "no kubectl context: set KUBECTL_CONTEXT or a kubeconfig"
  summary "### Isolation gate: no cluster"
  exit 1
fi
summary "### Isolation gate on \`${CONTEXT}\`"

if ! kubectl_do get namespace "$NAMESPACE" >/dev/null 2>&1; then
  fail "namespace ${NAMESPACE} is absent: deploy the sandbox (make up) before running the gate"
  exit 1
fi

if ! kubectl_do get crd ciliumnetworkpolicies.cilium.io >/dev/null 2>&1; then
  fail "Cilium CRDs are absent: the packet-level suite would be skipped, not run"
fi

# --- runtime class ---------------------------------------------------------

handler="$(kubectl_do get runtimeclass "$RUNTIME_CLASS" -o jsonpath='{.handler}' 2>/dev/null || true)"
isolation="$(kubectl_do get runtimeclass "$RUNTIME_CLASS" -o jsonpath='{.metadata.annotations.x402\.io/isolation}' 2>/dev/null || true)"
if [ "$handler" != "$EXPECT_HANDLER" ]; then
  fail "RuntimeClass ${RUNTIME_CLASS} handler is '${handler}', expected '${EXPECT_HANDLER}' (apply deploy/kata)"
fi
if [ "$isolation" != "$EXPECT_ISOLATION" ]; then
  fail "RuntimeClass ${RUNTIME_CLASS} annotation x402.io/isolation is '${isolation}', expected '${EXPECT_ISOLATION}'"
fi
summary "- RuntimeClass \`${RUNTIME_CLASS}\`: handler \`${handler:-absent}\`, isolation \`${isolation:-absent}\`"

# --- images under test -----------------------------------------------------

# A pulled index digest survives in the local daemon's RepoDigests, even after
# retagging to the dev tag the manifests use. That is the only reliable link
# between "the digest the release scanned" and "the image the cluster ran";
# containerd reports the platform manifest digest, which differs for a
# multi-arch index.
check_digest() {
  local name="$1" image="$2" want_image="$3" want_digest="$4"
  local digests
  digests="$(docker inspect --format '{{join .RepoDigests "\n"}}' "$image" 2>/dev/null || true)"
  local found=""
  local line
  while IFS= read -r line; do
    case "$line" in
      "${want_image}@${want_digest}") found="$line" ;;
    esac
  done <<<"$digests"
  if [ -z "$found" ]; then
    fail "${name}: ${image} is not ${want_image}@${want_digest} (RepoDigests: ${digests:-none})"
    return
  fi
  summary "- ${name}: \`${want_image}@${want_digest}\`"
}

require_match="${REQUIRE_DIGEST_MATCH:-0}"
check_image_pair() {
  local name="$1" image="$2" want_image="$3" want_digest="$4"
  if [ -n "$want_image" ] && [ -n "$want_digest" ]; then
    check_digest "$name" "$image" "$want_image" "$want_digest"
  elif [ "$require_match" = "1" ]; then
    fail "${name}: REQUIRE_DIGEST_MATCH=1 but the expected image and digest are unset"
  else
    summary "- ${name}: \`${image}\` (no expected digest; local run)"
  fi
}
check_image_pair control "$CONTROL_IMG" "$EXPECT_CONTROL_IMAGE" "$EXPECT_CONTROL_DIGEST"
check_image_pair guest "$GUEST_IMG" "$EXPECT_GUEST_IMAGE" "$EXPECT_GUEST_DIGEST"

# --- the guest really boots under that RuntimeClass ------------------------

# A RuntimeClass whose handler is not installed leaves a pod in
# ContainerCreating, so reaching Succeeded proves the sandbox path works and not
# just that the object exists.
apply_probe() {
  cat <<EOF | kubectl_do apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${PROBE_POD}
  namespace: sandbox-workloads
  labels: {x402.io/test-probe: "true"}
spec:
  runtimeClassName: ${RUNTIME_CLASS}
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  nodeSelector: {x402.io/sandbox-pool: "true"}
  tolerations: [{key: x402.io/sandbox, operator: Exists, effect: NoSchedule}]
  securityContext: {runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: ${GUEST_IMG}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-c", "echo handled-by-${RUNTIME_CLASS}"]
      securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ["ALL"]}}
      volumeMounts: [{name: w, mountPath: /run/x402}]
  volumes: [{name: w, emptyDir: {medium: Memory, sizeLimit: 32Mi}}]
EOF
}

cleanup_probe() {
  kubectl_do -n sandbox-workloads delete pod "$PROBE_POD" --ignore-not-found --grace-period=0 --force >/dev/null 2>&1 || true
}
trap cleanup_probe EXIT

cleanup_probe
if apply_probe 2>"$ARTIFACTS/probe-apply.log"; then
  phase=""
  for _ in $(seq 1 60); do
    phase="$(kubectl_do -n sandbox-workloads get pod "$PROBE_POD" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    case "$phase" in
      Succeeded | Failed) break ;;
    esac
    sleep 2
  done
  case "$phase" in
    Succeeded) summary "- Kata boot probe: guest image reached Succeeded under \`${RUNTIME_CLASS}\`" ;;
    *) fail "Kata boot probe did not succeed (phase '${phase:-unknown}'); see ${ARTIFACTS}/probe-apply.log and kubectl describe" ;;
  esac
  kubectl_do -n sandbox-workloads describe pod "$PROBE_POD" >"$ARTIFACTS/probe-describe.txt" 2>&1 || true
  kubectl_do -n sandbox-workloads logs "$PROBE_POD" >"$ARTIFACTS/probe-logs.txt" 2>&1 || true
else
  fail "could not create the Kata boot probe; see ${ARTIFACTS}/probe-apply.log"
fi
cleanup_probe

# --- the suite -------------------------------------------------------------

GUEST_BINARY="${GUEST_BINARY:-$PWD/guest/bin/x402-guest}" \
  npx vitest run tests/security \
    --reporter=default \
    --reporter=junit \
    --outputFile.junit="$ARTIFACTS/junit.xml" \
    2>&1 | tee "$ARTIFACTS/vitest.log"
vitest_status="${PIPESTATUS[0]}"
if [ "$vitest_status" -ne 0 ]; then
  fail "the isolation suite failed (vitest exit ${vitest_status}); see ${ARTIFACTS}/vitest.log"
fi

# A skipped suite is not evidence. unit the counts and refuse to report success
# when the two isolation files produced nothing, or when anything was skipped
# because a precondition was missing.
node - "$ARTIFACTS/junit.xml" <<'NODE'
const { readFileSync } = require("node:fs");
const file = process.argv[2];
let xml;
try {
  xml = readFileSync(file, "utf8");
} catch (err) {
  console.error(`::error::no JUnit report at ${file}: ${err.message}`);
  process.exit(1);
}
const suites = [...xml.matchAll(/<testsuite name="([^"]+)"[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*errors="(\d+)"[^>]*skipped="(\d+)"/g)].map((m) => ({
  file: m[1],
  tests: Number(m[2]),
  failures: Number(m[3]),
  errors: Number(m[4]),
  skipped: Number(m[5]),
}));
const required = ["tests/security/network.test.ts", "tests/security/workload.test.ts"];
let bad = false;
for (const name of required) {
  const suite = suites.find((s) => s.file.endsWith(name.replace("tests/security/", "")));
  if (!suite) {
    console.error(`::error::${name} is missing from the report: the suite did not run`);
    bad = true;
    continue;
  }
  if (suite.skipped > 0 || suite.tests - suite.skipped === 0) {
    console.error(`::error::${name} had ${suite.skipped}/${suite.tests} skipped: a skipped isolation suite is not evidence`);
    bad = true;
  }
  if (suite.failures + suite.errors > 0) {
    console.error(`::error::${name} reported ${suite.failures + suite.errors} failing tests`);
    bad = true;
  }
}
for (const suite of suites) {
  console.error(`  ${suite.file}: ${suite.tests} tests, ${suite.skipped} skipped, ${suite.failures + suite.errors} failed`);
}
process.exit(bad ? 1 : 0);
NODE
if [ $? -ne 0 ]; then
  fail "the isolation report does not prove the suites ran (see above)"
fi

# --- record ----------------------------------------------------------------

record_commit="${GITHUB_SHA:-local}"
record_run="${GITHUB_RUN_ID:-local}"
if ! node - "$ARTIFACTS/tested-images.json" <<NODE
const { writeFileSync } = require("node:fs");
writeFileSync(
  process.argv[2],
  JSON.stringify(
    {
      context: ${CONTEXT@Q},
      runtimeClass: { name: ${RUNTIME_CLASS@Q}, handler: ${handler@Q}, isolation: ${isolation@Q} },
      images: {
        control: { local: ${CONTROL_IMG@Q}, expected: ${EXPECT_CONTROL_IMAGE@Q}, digest: ${EXPECT_CONTROL_DIGEST@Q} },
        guest: { local: ${GUEST_IMG@Q}, expected: ${EXPECT_GUEST_IMAGE@Q}, digest: ${EXPECT_GUEST_DIGEST@Q} },
      },
      suite: "tests/security",
      commit: ${record_commit@Q},
      runId: ${record_run@Q},
    },
    null,
    2,
  ) + "\n",
);
NODE
then
  fail "could not write ${ARTIFACTS}/tested-images.json"
fi

if [ "${#failures[@]}" -gt 0 ]; then
  summary ""
  summary "**Isolation gate failed with ${#failures[@]} problem(s).** A release must not proceed."
  exit 1
fi
summary ""
summary "**Isolation gate passed.** The Cilium packet-level suite and the Kata boot probe ran against the images above."
