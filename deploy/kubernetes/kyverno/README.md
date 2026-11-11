# Kyverno guest-image admission

`guest-image-policy.yaml` is a Kyverno `ClusterPolicy` that rejects any sandbox
guest pod whose image is not `<repository>@sha256:<64 hex>`, or whose digest is
not the released one. It is the second layer behind the controller's own digest
check (`controller/src/runtime-profiles.ts`): the controller refusing to run an
unpinned image depends on the controller being honest, and this does not.

Nothing here is wired into `deploy/kubernetes/kustomization.yaml`, and
`deploy/kind/up.sh` does not install Kyverno, so an install that does not opt in
behaves exactly as before. That is deliberate: a `ClusterPolicy` is inert without
the CRD, and silently applying a third-party operator from `make deploy` would be
a bigger change than this control.

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
# 1. Kyverno (its own instructions; any 1.11+ install works)
helm repo add kyverno https://kyverno.github.io/kyverno
helm install kyverno kyverno/kyverno -n kyverno --create-namespace --set admissionController.replicas=1

# 2. The policy. Rule 2 fails closed until the digests are filled in.
kubectl apply -f deploy/kubernetes/kyverno/guest-image-policy.yaml
kubectl get clusterpolicy sandbox-guest-image-pinned
```

`REPLACE_WITH_RELEASED_*_DIGEST` placeholders are intentional. Until they are
replaced, every guest pod in an `enforce` namespace is rejected, which is the
correct failure: a policy that admits an unfilled allowlist is worse than no
policy.

## Keep the allowlist in step with the deployment

Rule 2 duplicates three values that live in `deploy/kubernetes/03-config.yaml`:
`GUEST_IMAGE_DIGEST`, and `RUNTIME_PROFILES.<profile>.digest` for each profile.
Change them in the same commit, or the next rollout is rejected. The release
digests are in the release assets (`sandbox-guest*.sigstore.json`) and in
`docs/release-process.md`.

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
this is a manual step, not a CI job. On a cluster that has the policy and a
namespace labelled `enforce`:

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
