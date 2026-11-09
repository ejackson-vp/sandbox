# Contributing

## Build and test

```bash
npm ci
npm run build
npm run typecheck          # tsc --noEmit for every workspace
npm run lint:structure     # 650-line module guard
npm run test:unit
npm run test:property
npm run test:integration   # real guest, no cluster
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

## Pull requests

One topic per change, with tests and a note in the description about what you
verified. Do not commit `dist/` output. If a change affects the trust boundary,
say so explicitly — those get a slower review.
