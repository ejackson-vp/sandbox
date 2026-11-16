# Runbook: take a real payment on mainnet

The first time this ran for real, every failure was configuration rather than
code: an egress policy that mock mode never needed, a connector with no routes, a
payment mode the API refused to start under. This is the ordered path, and the
things to check at each step before trusting the next.

Testnet is the same sequence with different values; do that first if any of it is
new, because the assertions are identical and the money is free.

## What you need

| Thing | Why | Secret? |
| --- | --- | --- |
| `PAY_TO` address | where sessions are paid to | no, it is public |
| CDP API key id and secret | the facilitator that submits settlement | **yes** |
| Base mainnet RPC URL | the API re-reads the chain instead of trusting the facilitator | **yes**, usually |
| A funded payer wallet | to make the first payment | **yes**, and it holds money |
| A funded refund wallet | refunds are ordinary transfers and need gas | **yes** |

`PAY_TO` should be a receive-only wallet, ideally hardware. It never signs
anything, so it never needs to be online.

The refund wallet is a **different** wallet: it sends USDC, so it pays gas. A
receive-only wallet cannot refund. Keeping them apart means a compromised refund
key takes the gas float, not the revenue.

## 1. Know what the API will refuse at startup

Mainnet is fail-closed. It will not start unless all of these are true, and the
error names the one that is missing:

- `PAYMENT_MODE=mainnet`
- `NETWORK=eip155:8453`, set explicitly. There is no mainnet default.
- `PAY_TO` is a real 20-byte address, and not the mock address.
- `FACILITATOR_URL` is set explicitly. There is no mainnet facilitator default.
- `PAYMENT_RPC_URL` is set. Settlement must be verified on chain.
- `ALLOW_INSECURE_DEV=false`. The insecure switch accepts simulated attestation
  and an unpinned guest image, which is the wrong trade beside real money.

If it refuses to start, that is the guard working. Read the message rather than
weakening the value.

## 2. Egress

The API needs outbound HTTPS to the facilitator and to the RPC. In this
deployment `allow-api` grants 443 to the internet with the private ranges
excluded. Mock mode never needed it, so a cluster built for mock will fail with

```text
Failed to fetch supported kinds from facilitator: TypeError: fetch failed
```

and the pod will crash-loop. That message means egress, not the facilitator.

## 3. Deploy

Set the values above in the deployment (for the hosted beta, the patches in the
private overlay, not this repository) and reconcile. Then confirm the API is
advertising mainnet before paying anything:

```bash
curl -sS https://api.throwbox.dev/v1/pricing
```

Check `paymentMode`, `network`, `asset` and `payTo`. If `payTo` is not the wallet
you funded, stop: a payment would go somewhere you do not control.

## 4. One payment

```bash
CONFIRM_REAL_MONEY=yes EVM_PRIVATE_KEY=0x… \
  node cli/dist/index.js create --tier short --payment-mode mainnet \
  --api-url https://api.throwbox.dev
```

The payer needs no ETH: the facilitator submits the EIP-3009 authorization and
pays the gas.

Then verify three independent things. Any one of them alone is not proof.

1. **Session.** It reaches `READY`, and `exec` runs a command in it.
2. **Ledger.** One `SETTLED` row whose `mode` is `mainnet` and `amount` matches
   the price.
3. **Chain.** A `Transfer` of exactly that amount from the payer to `PAY_TO` on
   Base, at a block you can open in a block explorer.

If the session is `READY` but the ledger row is missing, the payment settled and
the entitlement did not: that is a refund, and it is the case the settlement
recovery worker exists for.

## 5. One refund

Refunds are the half that gets skipped, and the half that decides whether a bad
night is an incident. Two properties to prove:

- A delivered session is **refused**: `POST /internal/payments/<key>/refund`
  answers `409 service_delivered`. A customer who got the service does not get
  the money back by asking.
- An undelivered one is **recorded**: send the transfer from the refund wallet,
  then record it with the transaction hash. The ledger moves to `REFUNDED` with
  `refund_tx` set, and the balance moves between two addresses.

To produce a refundable row without inventing one, interrupt a live session:
`kubectl -n sandbox-system scale statefulset relay --replicas=0`, wait past
`RELAY_LOSS_GRACE_MS` (90 s by default), then scale back. The session ends
`failure:relay_lost` and the ledger becomes `REFUND_PENDING`.

There is no automated sender in this repository. `REFUND_WEBHOOK_URL` is unset by
default, so a `REFUND_PENDING` row waits for a person. That is deliberate:
giving up on a payment that may have moved is worse than a gauge that stays above
zero.

## 6. Roll back

If anything looks wrong, the safe state is mock:

```bash
PAYMENT_MODE=mock NETWORK=mock:local \
PAY_TO=0x0000000000000000000000000000000000000402 \
FACILITATOR_URL=http://facilitator.sandbox-system.svc.cluster.local:3002
```

This stops new payments immediately. It does not touch ledger rows already
written, and it does not stop sessions already running, which is the point.

## Costs worth knowing before you set a price

- **Refunds cost gas plus the amount.** At a $0.02 session, a day of refunds
  costs more than the revenue it returns.
- **A refunded row is not a reversed row.** The original transfer is still on
  chain; the refund is a second transfer. Your revenue is the difference, not the
  sum of `SETTLED` rows.
- **The gas float is a float.** If the refund wallet runs dry, refunds stop
  silently until someone notices the `REFUND_PENDING` gauge.
