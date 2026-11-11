# Contributing

## Build and test

```bash
npm ci
make verify         # build, typecheck, structure lint, unit + property, go tests
make test           # adds integration tests against the real guest binary
npm run test:coverage   # unit + property under coverage (CI badge source)
```

Coverage covers the shipped TypeScript (`shared`, `sdk`, `api`, `controller`,
`cli`), not tests or the Go guest. It measures the **unit and property** suites
only: integration runs once per push in its own CI job, and instrumenting a
second concurrent copy of that timing-sensitive suite is what made #128 flake
(#145). The lines only integration reaches, mostly the controller lifecycle and
reconciler paths, are therefore not in the badge. CI publishes the number to the
`badges` branch, which is what the README badge reads; there is no fixed
threshold yet, so a drop shows up as a smaller badge rather than a red build.

`npm run typecheck` also compiles `tests/` and `scripts/` through
`tsconfig.tests.json`. Vitest strips types with esbuild and never checks them, so
without that pass a test can name a symbol that does not exist and still pass.

Cluster-backed tests need a live cluster:

```bash
make up
make security-test
```

## Fuzzing

The guest parsers, the relay frame handling and the API schemas are fuzzed.
None of it needs a cluster. PR CI runs every target for a short fixed budget
(20 s per Go target, one pass of the fast-check properties).

Go targets (`testing.F`, in-package):

| Target | Package | Boundary |
| --- | --- | --- |
| `FuzzOpen` | `guest/internal/envelope` | sealed-box / base64 envelope decode |
| `FuzzResolve` | `guest/internal/files` | workspace path validation and containment |
| `FuzzTransferFraming` | `guest` | chunked upload framing: order, duplicates, size and digest |
| `FuzzChunkDecode` | `guest` | base64 transfer chunk decode |
| `FuzzSupervisorDecrypt` | `guest` | envelope open, JSON decode and session binding before dispatch |
| `FuzzFrameDecode` | `guest` | relay control-frame JSON decode |

TypeScript targets (`fast-check` + Vitest, `tests/fuzz/`): API create/operation
schemas, plaintext rejection, payment header decoding, the real operations
router (malformed input must produce a 4xx, never a 500), relay registry bounds
(pending and response caches), relay HTTP and guest WebSocket frames.

Short run (the CI budget):

```bash
npm run test:fuzz

cd guest
go test ./internal/envelope -run=^$ -fuzz=FuzzOpen -fuzztime=20s
go test ./internal/files -run=^$ -fuzz=FuzzResolve -fuzztime=20s
go test . -run=^$ -fuzz=FuzzTransferFraming -fuzztime=20s
go test . -run=^$ -fuzz=FuzzSupervisorDecrypt -fuzztime=20s
go test . -run=^$ -fuzz=FuzzFrameDecode -fuzztime=20s
go test . -run=^$ -fuzz=FuzzChunkDecode -fuzztime=20s
```

Longer local soak (recommended before touching a parser or a size cap):

```bash
cd guest
go test ./internal/envelope -run=^$ -fuzz=FuzzOpen -fuzztime=10m
go test ./internal/files -run=^$ -fuzz=FuzzResolve -fuzztime=10m
go test . -run=^$ -fuzz=FuzzTransferFraming -fuzztime=10m
go test . -run=^$ -fuzz=FuzzSupervisorDecrypt -fuzztime=10m
go test . -run=^$ -fuzz=FuzzFrameDecode -fuzztime=10m
go test . -run=^$ -fuzz=FuzzChunkDecode -fuzztime=10m
```

`-fuzztime` is wall-clock per target. Add `-parallel=1` when reproducing a
timing-sensitive report, and keep the Fuzz worker count down on a loaded
machine so the per-target budget is not starved.

### Corpora and reproducers

- Seeds are registered with `f.Add` in the `*_fuzz_test.go` files, using
  shapes from the existing unit tests. `go test ./...` replays every seed and
  every committed corpus entry, so a fixed crash stays covered.
- When a run finds a new input, Go writes the reproducer to
  `testdata/fuzz/<Target>/` next to the package (`guest/testdata/fuzz/` or
  `guest/internal/<pkg>/testdata/fuzz/`). Commit the file as-is; it is the
  regression. `go test ./...` will replay it without fuzzing.
- Inputs worth keeping that the fuzzer only found in its cache live under
  `$(go env GOCACHE)/fuzz`. Copy the interesting file into the same
  `testdata/fuzz/<Target>/` directory rather than editing it.
- Regenerating a corpus from scratch means deleting that target's
  `testdata/fuzz/<Target>/` directory and re-running the fuzzer; do not delete
  a file that reproduces a reported crash.
- TypeScript failures print `{ seed, path }`. Replay with
  `FUZZ_SEED=<seed> npm run test:fuzz`. Add the shrunk counterexample as a
  normal assertion so it is covered on every run, not only under a seed.

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

Tags are the release mechanism. Pushing `vX.Y.Z` runs the test gate, builds
multi-arch `control` and `guest` images, and pushes only a run-scoped
`staging-<run-id>-<sha>` tag. Both images are then scanned by Trivy by digest;
only if they pass does a promotion job add the version, `major.minor` and
`latest` tags, and the GitHub Release is created last. A failed scan leaves no
deployable tag in the registry. See [docs/release-process.md](docs/release-process.md)
for the job graph, inspection commands and staging cleanup.

Add the user-visible change to [CHANGELOG.md](CHANGELOG.md) before tagging.
