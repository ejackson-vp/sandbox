# Roadmap

Ordered by risk and by what unlocks the next step, not by novelty. The detailed,
file-level backlog is in issues; this page keeps the order. The gap analysis is
[`docs/production-readiness.md`](docs/production-readiness.md).

## Next

The issue tracker is the detailed, file-level backlog. This list keeps the order
of risk.

1. **Make payment records survive schema changes.** `migrate()` drops every
   table on a version bump, including `payments`, `payment_intents` and
   `payment_ledger`. Split durable payment migrations from disposable session
   tables and add the backup/restore runbook before real settlement. (#18)
2. **Fence recovery.** A restarted controller clears the operation gate without
   proving the old guest operation stopped, and intent claims use a stale
   timeout without a fencing token. Both can hand a session to a second worker.
   (#19, #20)
3. **Close the relay restart window.** A create that lands during a relay
   replacement can lose its registration (#17). Re-register before the guest's
   dial deadline, or drain creates while the relay is not ready.
4. **Push readiness instead of polling.** 0.1.16 moved client p50 665 → 395 ms
   and server p50 179 → 127 ms. The remaining ~268 ms is payment/create
   (~175 ms) plus polling and network; p95 is 708 / 286 ms. A pushed `READY`
   event or long-poll removes the tick; folding the post-create `getSession`
   into the completion response is the smaller first cut. (#26, #27)
5. **Move the store behind an adapter tested against a second backend.**
   SQLite is the single writer and therefore the HA ceiling. Postgres or
   DynamoDB with conditional writes, preserving the unique payment key and
   guarded transitions. (#25)
6. **Relay state out of process.** One in-memory relay pod loses pending
   ciphertext on restart. Redis or NATS with per-session queues and TTLs,
   ciphertext only. (#24)

## Later

- **Admission control for images.** Digest pinning exists; Kyverno or sigstore
  policy would make a moved tag or a compromised node a second, independent
  failure rather than the only one.
- **Real settlement reconciliation and refunds.** Mock mode auto-refunds
  terminal-before-`READY` sessions. Testnet/mainnet need facilitator webhooks or
  an on-chain refund worker before money is real.
- **Encrypted checkpoint storage.** Checkpoint PVCs are plaintext today, which
  puts suspended session files in the node and storage trust domain.
- **Publish `@x402s/sdk` to npm.** The package is a workspace build today; a
  public release makes the SDK usable without cloning the repo.
- **Docs site.** Only if it can be generated from `docs/` without becoming a
  second source of truth.

## Out of scope

Hardware attestation requires TEE hardware and an independent verifier; it is not
something this repository can honestly claim. Mainnet payments, accounts, managed
wallets and persistent dev environments are deliberate non-goals — see the README.

## How items leave this list

Work lands as a PR with tests; close the issue and remove the item here and from
`production-readiness.md` in the same change. A roadmap entry that silently
disappears is worse than one that stays.
