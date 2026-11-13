# Contributing

## Build and test

```bash
npm ci
npm test            # unit + property, no cluster or guest binary
make verify         # build, typecheck, structure lint, unit, property, portable, go tests
make test           # adds integration tests against the real guest binary
npm run test:coverage   # unit + property under coverage (CI badge and floor source)
```

Each command, and what it deliberately leaves out:

| Command | Covers |
| --- | --- |
| `npm test` | `tests/unit` and `tests/property` with `--fileParallelism`. Fast, hermetic, the same set the badge measures. |
| `npm run test:unit` | `tests/unit`: store, controller, API and CLI behaviour on Postgres. |
| `npm run test:property` | `tests/property`: `fast-check` invariants. |
| `npm run test:portable` | `tests/transfers`, `tests/workloads`, `tests/compatibility`. No cluster; the browser case skips without its image. |
| `make verify` | Build, typecheck, structure lint, unit, property, portable, `go test`, `go vet`. What a reviewer runs. |
| `make test` | `tests/unit` plus `tests/integration` against a real guest binary. Needs `make guest` first. |
| `make security-test` | `tests/security`. Needs a kind cluster with Cilium (`make up`). |
| `npm run mutation` | Stryker against `shared/src/payment.ts`, `controller/src/control-api/payments.ts` and `sdk/src/transfers.ts`. Slow, nightly, needs `DATABASE_URL`. |

`npm test` deliberately excludes `tests/integration` and `tests/security`: both
need a guest binary or a live cluster, so including them is what made `npm test`
fail on a fresh clone. `fileParallelism` is opt-in per script for the same
reason: the global default in `vitest.config.ts` stays serial because the
integration suite SIGSTOPs a real guest process and the security suite drives
real sockets, and running those files concurrently flakes (#128, #145). The unit
and property files share no process, port or fixture, so they parallelise: 915
tests in ~4 s instead of ~24 s, verified three times under
`--sequence.shuffle`.

Coverage covers the shipped TypeScript (`shared`, `sdk`, `api`, `controller`,
`cli`), not tests or the Go guest. Three suites are measured and merged, because
coverage is a union: **unit and property**, **integration**, and the TypeScript
**fuzz** targets. Integration used to be excluded, which scored the client and
wiring code at zero even though end-to-end tests exercise it, so `sdk` and `api`
read in the forties while `shared` and `cli` read near ninety.

`scripts/coverage-merge.mjs` takes the maximum hit count per line, function and
branch across every report. It is the only place a total the whole set reaches
can be gated, so it owns the merged floor, and CI publishes its output to the
`badges` branch, which is what the README badge reads.
`npm run test:integration:coverage` and `npm run test:fuzz:coverage` run the
other two suites the same way CI does.

`vitest.config.ts` sets a floor per module (plus a repo-wide one), a few points
under each current total, so a regression fails `npm run test:coverage` and the
`unit` job and names the module that moved. That run is gated per pull request;
the merged floor is gated on a main push.

A test that imports `@x402s/shared/<entry>` measures `shared/src`, not
`shared/dist`: the config aliases that specifier to the source entry. Without
it, the durable-call protocol read 0% because its property test drove the built
copy. `@x402s/sdk` is deliberately not aliased, because `cli-args.test.ts`
imports the built package on purpose and needs the class identity the shipped
build has.

`npm run typecheck` also compiles `tests/` and `scripts/` through
`tsconfig.tests.json`. Vitest strips types with esbuild and never checks them, so
without that pass a test can name a symbol that does not exist and still pass.

Cluster-backed tests need a live cluster:

```bash
make up
make security-test       # Cilium packet-level suite
make kata                # switch the deployment to the Kata RuntimeClass
make security-isolation  # release gate: both suites, Kata boot probe, digests
```

`make security-test` needs a cluster and a deployment, and no database: it runs
under `vitest.security.config.ts`, which drops the root config's Postgres
precondition. The same suite runs in CI as the `isolation` job, on a hosted
runner with kind and Cilium, but only for a pull request that touches something
which can move a packet (the NetworkPolicy, the relay, the egress proxy, the
guest, the manifests) or that changes the relay's dependencies. Everything else
skips the job in seconds, and the check still reports either way, so it can be
made a required check without leaving merges hanging on a check that never runs.

The Kata half of the release gate stays on the fault runner. Nested
virtualisation is not available on a hosted runner, so `make security-isolation`
is still the only place both halves run together.

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

CI runs each target as its own step through `scripts/fuzz-go.sh`. That wrapper
retries a target once when, and only when, the run failed with
`context deadline exceeded` and found no input (#130); any other nonzero exit is
fatal and is not retried. A retry is recorded in the job summary.

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

## Mutation testing

Line coverage answers "did this line run?". It cannot answer "did any test
notice what this line did?", and the suite reached the point where that
distinction mattered: 87% lines and a green run said nothing about whether the
money routes were asserted or merely executed.

Stryker answers the second question. It rewrites one line at a time (flip a
comparison, drop a `!`, swap a return value, change an error code) and re-runs
the tests that reached it. A **killed** mutant failed a test, which is what a
test is for. A **survived** mutant ran the line, through the test, and every
assertion stayed green: either the test is missing an assertion, or the mutation
is equivalent (semantically identical to the original, for example a changed
string that is never compared). "No coverage" is the third outcome: no selected
test reached the line at all.

```bash
DATABASE_URL=postgres://postgres:pg@127.0.0.1:55432/sandbox npm run mutation
```

It needs Postgres because it forks vitest, and the global setup refuses to start
without it. It mutates three modules where a survivor is a real bug rather than
a style opinion:

| File | What a survivor means |
| --- | --- |
| `shared/src/payment.ts` | Pricing, asset or validity-window validation is not pinned; a wrong mock scheme passes the suite. |
| `controller/src/control-api/payments.ts` | A money route answers the same with a changed status, hash or claim check, so a client can be served twice or not at all. |
| `sdk/src/transfers.ts` | Resume, chunk bounds or digest verification can change without a test noticing a truncated or corrupted transfer. |

`stryker.config.mjs` limits `testFiles` to `tests/unit`, `tests/fuzz` and
`tests/transfers`: integration and security need a guest binary or a cluster, so
they would cost minutes per mutant and are out of scope. `coverageAnalysis:
"perTest"` records which test reached which line in the dry run, so a mutant
only re-runs those tests instead of all ~1100.

The report is the point, not the number. The HTML report is written to
`reports/mutation/index.html` (git-ignored), and the nightly
`.github/workflows/mutation.yml` uploads it as an artifact with the per-file
score in the job summary. Read it survivor by survivor: decide whether the test
should assert something, or whether the mutant is equivalent. Add the assertion;
do not chase the percentage. A `// Stryker disable next-line <Mutator>: <why>`
comment is the last resort for a mutant that is provably equivalent, and it
needs the reason, because the next reader cannot re-derive it.

`thresholds.break` is `null`, so the job reports and does not fail. That is
deliberate for the first landing: there is no baseline yet, and a `break` set
today would either block every pull request or claim a floor the suite has not
earned. Once a few nightly runs exist, watch the trend and set `break` to
`low` (60), the point where it means "the suite stopped asserting" instead of
"the code changed".

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
make docs-check     # markdownlint + internal link check, same globs and flags as CI
```

`make docs-check` mirrors `.github/workflows/docs.yml`: the same glob set
(`*.md`, `docs/`, `deploy/`, `security-review/`, `.github/`) and the same lychee
flags, `--offline --include-fragments`. Fragment checking matters: without it a
link to a heading that was renamed passes locally and fails in CI. The link check
is skipped with a notice when lychee is not installed.

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
