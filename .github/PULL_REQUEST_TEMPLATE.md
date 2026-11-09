## What changed

<!-- One or two sentences. Link the issue or ADR if there is one. -->

## Why

<!-- The problem this solves. -->

## Verification

<!-- Commands you ran and what they showed. `make verify` is the baseline. -->

## Checklist

- [ ] `make verify` passes
- [ ] Tests cover any new state transition, authorization check or isolation claim
- [ ] Modules stay under the 650-line limit (`make lint-structure`)
- [ ] No credentials, capabilities or plaintext added to logs or fixtures
- [ ] Docs updated if behaviour or a guarantee changed

## Trust boundary

<!-- Delete the ones that do not apply. -->

- [ ] Does not touch the trust boundary
- [ ] Changes the trust boundary — described above, and an ADR is added or updated
- [ ] Changes lease semantics — described above
- [ ] Changes deployment requirements (node labels, storage class, runtime class)
