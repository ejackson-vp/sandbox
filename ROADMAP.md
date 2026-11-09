# Roadmap

Ordered by risk and by what unlocks the next step, not by novelty. The detailed
gap list, with the concrete next action for each item, is
[`docs/production-readiness.md`](docs/production-readiness.md).

## Next

1. **Push readiness instead of polling it.** The SDK polls every 250 ms and the
   client-side gap is roughly 486 ms against a 179 ms server-side claim. A pushed
   `READY` event or a long-poll is the cheapest large win.
2. **Pre-sign repeat creates.** Remove the x402 402-challenge round trip from the
   critical path while keeping settlement verifiable.
3. **Move the store behind an adapter tested against a second backend.**
   SQLite is the single writer and therefore the HA ceiling. Postgres or DynamoDB
   with conditional writes, preserving the unique payment key and guarded
   transitions.
4. **Relay state out of process.** One in-memory relay pod loses pending
   ciphertext on restart. Redis or NATS with per-session queues and TTLs,
   ciphertext only.

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

Work lands as a PR with tests, and the item is removed here and from
`production-readiness.md` in the same change. A roadmap entry that silently
disappears is worse than one that stays.
