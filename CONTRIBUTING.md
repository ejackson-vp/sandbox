# Contributing

## Build and test

```bash
npm ci
make verify         # build, typecheck, structure lint, unit + property tests
make test           # adds integration tests against the real guest binary
```

Cluster-backed tests need a live cluster:

```bash
make up
make security-test
```

## Rules

- **Modules stay reviewable.** `npm run lint:structure` enforces 650 lines. Split
  a file rather than raising the limit.
- **`shared/` is the protocol layer.** No workspace imports another workspace
  except through `@x402s/shared`.
- **Security invariants need a test.** A state transition, an authorization
  check, or an isolation claim without a test is documentation, not a guarantee.
  See [docs/architecture-principles.md](docs/architecture-principles.md).
- **No credentials.** `scripts/dev-secrets.sh` generates a git-ignored Secret for
  local runs; never commit its output.

## Documentation

Docs are part of the product surface, so they are linted in CI:

```bash
make docs-check     # markdownlint, plus internal link check if lychee is installed
```

- Put a document in `docs/` and link it from [docs/README.md](docs/README.md).
  An unlinked doc is a dead end.
- Keep the README a pitch, not a manual. Detail belongs in `docs/`.
- A change to a trust boundary, a durability guarantee or a deployment
  constraint needs an ADR: add one under [docs/adr/](docs/adr/) or supersede an
  existing record. One page, alternatives included.

## Images

The architecture diagram and social preview are committed SVGs. Regenerate the
PNG raster after editing the SVG source:

```bash
make assets         # docs/assets/social-preview.png, via rsvg-convert/Inkscape/Chrome
make demo-gif       # requires vhs and a live cluster
```

## Pull requests

One topic per change, with tests and a note in the description about what you
verified. Do not commit `dist/` output. If a change affects the trust boundary,
say so explicitly — those get a slower review. The PR template asks for this.

## Releases

Tags are the release mechanism. Pushing `vX.Y.Z` runs the test gate, publishes
multi-arch `control` and `guest` images to GHCR with SBOM and provenance,
scans both images with Trivy, and only then creates the GitHub Release. A failed
scan blocks the Release entry even though the tag exists.

Add the user-visible change to [CHANGELOG.md](CHANGELOG.md) before tagging.
