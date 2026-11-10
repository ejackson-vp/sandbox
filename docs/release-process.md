# Release process

Releases are cut by pushing an annotated tag matching `v*` (for example
`v0.1.19`). The tag starts `.github/workflows/release.yml`, which builds two
multi-arch images and publishes them to GHCR:

| Image | Contents |
| --- | --- |
| `ghcr.io/<owner>/<repo>-control` | api + controller + relay + egress + facilitator |
| `ghcr.io/<owner>/<repo>-guest` | the sandbox runtime (supervisor + toolchain) |

A release is **staged**: the version, `major.minor` and `latest` tags are only
created after both images pass the Trivy gate. A scan failure leaves nothing
deployable behind.

## Job graph

```text
test
 └── images (matrix: control, guest; push staging-<run-id>-<sha>)
      └── digests (resolve each multi-arch index digest)
           ├── attest (matrix: control, guest; keyless provenance, push to OCI)
           └── scan (matrix: control, guest; scan image@sha256:…)
                └── promote (imagetools create: version, major.minor, latest)
                     └── release (GitHub Release entry + provenance assets)
```

- `images` pushes exactly one tag per image, `staging-<run-id>-<sha>`. It is
  run-scoped so a re-run refreshes the same staging image and two concurrent
  runs cannot overwrite each other. It is never a release name.
- `digests` reads the pushed index digest from the registry and exposes it as a
  job output. Everything downstream addresses the image by digest, so moving a
  tag cannot redirect the scan away from the image that gets promoted.
- `scan` runs the same policy as before: `CRITICAL,HIGH`, `ignore-unfixed`,
  SARIF to the Security tab (`trivy-control`, `trivy-guest`), exit code 1 on a
  finding.
- `attest` generates keyless SLSA build provenance for each index digest with
  `actions/attest-build-provenance` (`id-token: write`, no stored key) and
  pushes it to GHCR. The bundle is attached to the GitHub Release as
  `sandbox-<name>.sigstore.json`, alongside the in-toto statement it contains
  (`sandbox-<name>.intoto.jsonl`).
- `promote` runs only after both matrix scans pass. It uses
  `docker buildx imagetools create` to add the release tags to the scanned
  index digest, then re-inspects every tag and fails if it does not resolve to
  that same digest.
- `release` depends on `promote` and `attest`, so the GitHub Release entry and
  its provenance assets are created last.

`imagetools create` copies the source index and its child manifests, so the
multi-arch (`linux/amd64`, `linux/arm64`) index and the SBOM/provenance OCI
attestations are preserved. No image is rebuilt at promotion time.

## What a failed scan leaves behind

| Job | Result on a scan failure |
| --- | --- |
| `images` | `staging-<run-id>-<sha>` exists, not a release name |
| `digests` | ran, digests resolved |
| `scan` | red; SARIF still uploaded |
| `promote` | never runs; no version, `major.minor` or `latest` tag is created |
| `release` | never runs |

A consumer pulling `<version>` fails because the tag was never created, and
`latest` still resolves to the previous release that passed its scan. Neither
can silently receive the unscanned image.

## Inspecting a release

```bash
# The promoted tags all resolve to the scanned index digest.
docker buildx imagetools inspect ghcr.io/<owner>/<repo>-control:0.1.19

# Attestations travel with the index; they are listed as unknown/unknown
# platform entries in the manifest list.
docker buildx imagetools inspect ghcr.io/<owner>/<repo>-control:0.1.19 \
  --format '{{json .Manifest}}'
```

To reproduce a red gate for an already-published tag without cutting a new
release, run the manual `scan` workflow (`.github/workflows/scan.yml`) with the
version tag.

## Verifying provenance

Every release carries keyless SLSA build provenance for both images. The
signing identity is this repository's release workflow, so there is no key to
distribute:

```bash
gh attestation verify oci://ghcr.io/<owner>/<repo>-control:0.1.21 \
  --repo <owner>/<repo>

# Same check against the copy stored in the registry rather than GitHub's.
gh attestation verify oci://ghcr.io/<owner>/<repo>-control:0.1.21 \
  --repo <owner>/<repo> --bundle-from-oci
```

The release assets `sandbox-control.sigstore.json` and
`sandbox-guest.sigstore.json` are those same bundles, and
`sandbox-<name>.intoto.jsonl` is the in-toto statement each bundle contains. The
statement is what SLSA tooling consumes and what OpenSSF Scorecard's
Signed-Releases check looks for; the bundle is what verifies.

Pinning the signer makes the check stricter:

```bash
gh attestation verify oci://ghcr.io/<owner>/<repo>-guest:0.1.21 \
  --repo <owner>/<repo> \
  --signer-workflow <owner>/<repo>/.github/workflows/release.yml \
  --source-digest "$(git rev-parse v0.1.21)"
```

## Rehearsing promotion locally

The promotion step is a plain shell block that reads `IMAGE_PREFIX`,
`GITHUB_REPOSITORY` and `GITHUB_REF_NAME`. It can be rehearsed against a local
registry without touching GHCR:

```bash
docker run -d --rm -p 5001:5000 --name release-registry registry:2

# Build one throwaway multi-arch image and push it under both staging tags.
mkdir -p /tmp/release-rehearsal && cd /tmp/release-rehearsal
printf 'FROM scratch\nCOPY hello /hello\n' > Dockerfile
printf 'hello\n' > hello
docker buildx build --platform linux/amd64,linux/arm64 \
  --provenance=true --sbom=true \
  -t 127.0.0.1:5001/demo-control:staging-local \
  -t 127.0.0.1:5001/demo-guest:staging-local --push .

export CONTROL_DIGEST=$(docker buildx imagetools inspect \
  127.0.0.1:5001/demo-control:staging-local --format '{{.Manifest.Digest}}')
export GUEST_DIGEST=$(docker buildx imagetools inspect \
  127.0.0.1:5001/demo-guest:staging-local --format '{{.Manifest.Digest}}')

# Run the promote step from release.yml with the prefix pointed at the local
# registry. It must not change either index digest.
IMAGE_PREFIX=127.0.0.1:5001/demo GITHUB_REF_NAME=v0.0.1 \
  bash -c '<the "Apply version, major.minor and latest" run block>'

docker buildx imagetools inspect 127.0.0.1:5001/demo-control:0.0.1
docker buildx imagetools inspect 127.0.0.1:5001/demo-control:latest

docker rm -f release-registry
```

The rehearsal proves the promotion command and digest check; it does not prove
the GitHub Actions expressions, permissions or a full release run.

## Cleaning up staging tags

GHCR deletes *package versions*, not individual tags, and a promoted image's
release tags point at the same version as its staging tag. **Deleting the
version of a promoted image removes the release tags too.** Do not prune a
staging tag that was promoted.

Staging images from runs that never reached `promote` are safe to delete. List
them with the GitHub CLI (replace `<org>`, `<repo>` and the package name):

```bash
gh api "/orgs/<org>/packages/container/<repo>-control/versions?per_page=100" \
  --jq '.[] | .metadata.container.tags as $t | select(($t | length) > 0 and ($t | all(startswith("staging-")))) | "\(.id)\t\($t | join(","))"'
```

Check that the listed version has **only** `staging-*` tags, then delete it:

```bash
gh api -X DELETE "/orgs/<org>/packages/container/<repo>-control/versions/<id>"
```

Keep the tag from the most recent successful release if you want a debugging
trail; everything else from abandoned runs can go.
