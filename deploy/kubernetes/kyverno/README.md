# Kyverno guest-image admission

`guest-image-policy.yaml` is a Kyverno `ClusterPolicy` that rejects any sandbox
guest pod whose image is not `<repository>@sha256:<64 characters>`, or whose
digest is not the released one. It is the second layer behind the controller's own digest
check (`controller/src/runtime-profiles.ts`): the controller refusing to run an
unpinned image depends on the controller being honest, and this does not.

Nothing here is wired into `deploy/kubernetes/kustomization.yaml`, and
`deploy/kind/up.sh` does not install Kyverno, so an install that does not opt in
behaves exactly as before. That is deliberate: a `ClusterPolicy` is inert without
the CRD, and silently applying a third-party operator from `make deploy` would be
a bigger change than this control. `make kyverno-policy` proves the policy on a
throwaway cluster; see [Verify](#verify).

## Scope

Both rules match pods only where the **namespace** label says so:

| `x402.io/image-policy` on the namespace | rule 1: repository + digest shape | rule 2: released digest |
| --- | --- | --- |
| `enforce` (default, shipped in `00-namespaces.yaml`) | enforced | enforced |
| `dev-unpinned` | enforced | **skipped** |
| absent | policy does not match | policy does not match |

The label lives in `deploy/kubernetes/00-namespaces.yaml` on
`sandbox-workloads`, so installing Kyverno is enough to turn it on. Deleting the
label disables admission for that namespace; that is why it ships with the
namespace rather than being a manual step.

## Install

```bash
# 1. Kyverno (its own instructions; tested on 1.13.4, the version
#    scripts/kyverno-policy-test.sh installs)
helm repo add kyverno https://kyverno.github.io/kyverno
helm install kyverno kyverno/kyverno -n kyverno --create-namespace --set admissionController.replicas=1

# 2. The policy. The allowlist carries the current release's three digests.
kubectl apply -f deploy/kubernetes/kyverno/guest-image-policy.yaml
kubectl get clusterpolicy sandbox-guest-image-pinned
```

An empty or stale allowlist rejects every guest pod in an `enforce` namespace,
which is the correct failure: a policy that admits anything the controller asks
for is not a second check. The digests now come from
`deploy/release-pins.json` and are validated offline by
`scripts/check-deploy-pins.mjs`; before that map existed the file carried
`REPLACE_WITH_RELEASED_*_DIGEST` placeholders and had never been applied.

## Keep the allowlist in step with the deployment

Rule 2 duplicates the three values `deploy/talos/kustomization.yaml` deploys:
`GUEST_IMAGE_DIGEST` and `RUNTIME_PROFILES.<profile>.digest` for each profile.
They are also recorded in `deploy/release-pins.json`, and
`node scripts/check-deploy-pins.mjs` fails when any of the three files disagrees,
so the rollout cannot be rejected by an allowlist that missed the bump. The
digests are in the release assets (`sandbox-guest*.sigstore.json`) and in the
release body.

## Local kind

`deploy/kind/apply.sh` pins `GUEST_IMAGE_DIGEST` to the digest of the image it
loaded into containerd. That digest is machine-specific, so it cannot be in a
committed allowlist. Do not add it; relabel the namespace instead:

```bash
# local kind only: keeps the digest-shape rule, drops the released-digest rule
kubectl --context kind-x402-sandbox label namespace sandbox-workloads \
  x402.io/image-policy=dev-unpinned --overwrite
```

Do this only where the node is a laptop. The label is the whole exception, so a
production cluster must never carry it.

## Verify

The policy is only meaningful against an API server with Kyverno installed, so
the executable check is a script, not a unit test. It creates its own kind
cluster, installs Kyverno, applies this policy, and asks the API server to admit
four pods with `--dry-run=server` (nothing is scheduled, no image is pulled):

```bash
make kyverno-policy
# or, against a cluster you already have:
TEST_CONTEXT=kind-x402-sandbox ./scripts/kyverno-policy-test.sh
```

It asserts: a tag is rejected, a foreign repository pinned by digest is rejected,
an unreleased digest is rejected, the digest in `deploy/release-pins.json` is
admitted, and a namespace without the label is not affected. Exits non-zero on
the first disagreement.

**This is not in CI yet.** Kyverno's own install manifest is a rolling list of
unpinned images, and adding that to a workflow would introduce the exact
supply-chain gap F-15 is about. Wiring the script into CI needs Kyverno's images
pinned by digest, which is a separate change. What CI does check offline is the
allowlist itself: `scripts/check-deploy-pins.mjs` fails when the policy's digests
disagree with the release map and the Talos overlay.

On a cluster that has the policy and a namespace labelled `enforce`, the same
cases by hand:

```bash
# rejected: tag-only reference
kubectl apply --dry-run=server -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: {name: probe-tag, namespace: sandbox-workloads}
spec:
  containers: [{name: guest, image: "x402-sandbox/guest:dev"}]
EOF
# expect: admission webhook "validate.kyverno.svc-fail" denied the request

# rejected: right repository, wrong digest
kubectl apply --dry-run=server -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: {name: probe-digest, namespace: sandbox-workloads}
spec:
  containers:
    - name: guest
      image: "ghcr.io/ejackson-vp/sandbox-guest@sha256:0000000000000000000000000000000000000000000000000000000000000000"
EOF

# accepted: the released digest from the allowlist
kubectl apply --dry-run=server -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata: {name: probe-ok, namespace: sandbox-workloads}
spec:
  containers:
    - name: guest
      image: "ghcr.io/ejackson-vp/sandbox-guest@sha256:<the digest from rule 2>"
EOF
```

`kyverno apply` offline cannot reproduce this: both rules select on a namespace
*label*, which an offline run does not have. `tests/unit` covers the
controller-side refusal that this policy backs up
(`tests/unit/provisioning-profile-image.test.ts`).
