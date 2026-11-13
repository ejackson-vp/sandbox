# Launch runbook

The order to take `throwbox.dev` from a merged repository to a paid public beta.
Each step names what you must supply, the commands, and the check that proves the
step happened. A step is not done because a command exited zero; it is done when
its check passes.

Nothing here is applied by hand in the homelab except where it says so: the
`sandbox` app is reconciled by Flux from `ejackson-vp/homelab`. Standing up a new
host is the exception, because it is a new cluster.

## 0. Preconditions

| You must supply | Used by |
| --- | --- |
| A KVM-capable Linux host | Step 1 |
| A Coinbase CDP API key pair | Step 2 |
| A funded Base wallet, and the USDC it will receive | Step 2 |
| A Cloudflare account and the `throwbox.dev` registration | Steps 3 and 4 |
| The addresses to allowlist | Step 5 |

As of this writing `throwbox.dev` is unregistered (registry RDAP returns 404), so
step 4 cannot start until it is bought.

## 1. Isolation evidence

The release gate refuses a tag until the Kata and Cilium suites run on real
hardware. A kind cluster on macOS has no `/dev/kvm`, so this is the one step that
cannot be done on the laptop.

1. Provision the host and install Talos with the `kata-containers` system
   extension. Follow [`deploy/talos/README.md`](../deploy/talos/README.md).
2. Label only the disposable node, never the one running etcd:

   ```bash
   kubectl label node <sandbox-node> x402.io/sandbox-pool=true
   ```

3. Prove the runtime is present before deploying anything:

   ```bash
   kubectl get runtimeclass x402-sandbox -o jsonpath='{.handler}{"\n"}'  # expect: kata
   talosctl -n <sandbox-node> ls /dev/kvm                                # expect: kvm
   ```

4. Register a GitHub Actions runner on that host with the label
   `sandbox-isolation`, then set the repository variable:

   ```bash
   gh variable set SANDBOX_ISOLATION_RUNNER \
     --repo ejackson-vp/sandbox \
     --body '["self-hosted","linux","x64","sandbox-isolation"]'
   ```

5. Cut a release from a clean `main` and watch the gate:

   ```bash
   git tag -a v0.1.31 -m v0.1.31 && git push origin v0.1.31
   gh run watch --workflow release.yml
   ```

**Check:** the `isolation` job is green, the release body has no
"suites were not run" banner, and `tested-images.json` names the same control and
guest digests that `promote` tagged. If any of that is missing, the gate did not
run, whatever the colour says.

## 2. Real money

Until this step the service is mock. It is the only step that moves funds, so do
it with the smallest session you can buy.

1. Create a CDP API key pair, and note the receiving address (`PAY_TO`).
2. Set the payment configuration. Every value is required; there is no mainnet
   default.

   ```bash
   PAYMENT_MODE=mainnet
   NETWORK=eip155:8453
   PAY_TO=0x...                       # your receiving wallet
   FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
   FACILITATOR_API_KEY_ID=...
   FACILITATOR_API_KEY_SECRET=...
   PAYMENT_RPC_URL=https://...        # any Base mainnet RPC
   ```

   `PAYMENT_USDC_ADDRESS` is optional; it defaults to the Base USDC contract and
   exists only to override it.

3. Start the API and confirm the assertions pass. A missing verifier, a mock
   `PAY_TO` or an unset `NETWORK` refuses to start, which is the intended
   failure.

   ```bash
   curl -s https://api.throwbox.dev/healthz | jq
   ```

4. Buy one `short` session with the CLI against the real deployment.
5. Confirm in the ledger that the payment row is `settled`, the source is `x402`
   and the amount matches the price table.
6. Force a refund: create a session that cannot reach `READY` (for example by
   scaling the guest image reference to a digest that does not exist on the
   node), and confirm a `REFUND_PENDING` row appears and the worker executes it
   against your `REFUND_WEBHOOK_URL`.

**Check:** one real settle and one real refund, both visible on chain, both
recorded in the ledger. Nothing in the test suite substitutes for this.

If step 6 is not possible with a real provider, say so in the launch note rather
than claiming refunds work. The code records the debt and the worker sends it;
neither has been exercised with real funds.

## 3. The tunnel

1. Create the tunnel and keep the token out of the repo:

   ```bash
   cloudflared tunnel create throwbox
   kubectl -n sandbox-system create secret generic cloudflared-tunnel \
     --from-literal=token=<tunnel-token>
   ```

2. Apply the overlay. It composes `deploy/talos` with
   `PUBLIC_BASE_URL=https://api.throwbox.dev` and `TRUST_PROXY_HOPS=1`.

   ```bash
   kubectl kustomize deploy/overlays/throwbox   # inspect first
   kubectl apply -k deploy/overlays/throwbox
   ```

   Apply this before rolling the controller, not after: the runtime-class guard
   fails closed, and the new `sandbox-controller-runtimeclasses` ClusterRole must
   exist or the pod will not start. That failure is intended, but it looks like an
   outage.

3. Route the hostname to the tunnel in the Cloudflare dashboard, and confirm the
   origin is reachable only through it.

**Check:**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://api.throwbox.dev/healthz   # 200
curl -sS https://api.throwbox.dev/v1/pricing | jq '.tiers | keys'
curl -sSI https://api.throwbox.dev/healthz | grep -i x-forwarded               # absent: the edge sets it
```

`TRUST_PROXY_HOPS=1` is correct only while cloudflared is the single hop. If you
add another proxy, raise it or the per-IP buckets collapse into one.

## 4. The site

This is the step that makes the claims public. Do it last.

1. Buy `throwbox.dev` and move the nameservers to Cloudflare.
2. Deploy the static directory with no build step:

   ```bash
   npx wrangler pages deploy site --project-name throwbox
   ```

3. Attach `throwbox.dev` as a custom domain.
4. Re-read the page against reality. The copy says real USDC on Base, one region,
   one control-plane node, and unverified isolation. Every one of those must
   still be true on the day it goes live.

**Check:** `curl -s https://throwbox.dev | grep -i "isolation"` shows the
"unverified" wording, and `llms.txt` points at the hosted API rather than
`localhost:8080`.

## 5. Free access

The allowlist is off by default. Turn it on and add entries.

1. Set `PAYER_ALLOWLIST_ENABLED=true` in the control config and roll the API.
2. Add Hermes's address, which its payer printer reports:

   ```bash
   python -m hermes_sandbox.payer_address
   sandbox admin allowlist add 0x... --label hermes --max-tier standard --max-concurrent 2
   ```

3. Add anything else, with a ceiling low enough that a leaked key is cheap:

   ```bash
   sandbox admin allowlist add 0x... --label friend --max-tier short --max-concurrent 1
   ```

4. Confirm a free create produces a ledger row with `source=allowlist` and
   `amount=0`, and that the paid path is unchanged for an address that is not on
   the list.

**Check:** `sandbox admin allowlist list` shows the entries, and the
`sandbox_sessions_total{source="allowlist"}` series increases by exactly one for
one create.

## Rollback

There is no kill switch yet: stopping new creates means scaling the API to zero,
which also stops reads for sessions already running. Treat that as the emergency
stop and expect to refund leases it interrupts. A durable flag that refuses
creates without touching live leases is the next change, not part of this launch.

To undo a payment configuration change, roll the API back to the previous image
digest. The ledger is additive, so a rollback does not lose settled rows; the
`source` column defaults to `x402` for anything written by an older build.
