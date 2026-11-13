# cloudflared — public ingress for the hosted beta

`api.throwbox.dev` is a Cloudflare Tunnel to the `api` Service in
`sandbox-system`. The tunnel client (`cloudflared`) runs in-cluster and dials out
to Cloudflare's edge, so nothing on the internet can open a connection to the
cluster itself and the API Service stays `ClusterIP`.

Deploy it through the overlay that sets the matching public URL:

```bash
kubectl kustomize deploy/overlays/throwbox   # render
kubectl apply -k deploy/overlays/throwbox    # only if Flux is not doing it
```

The Tailscale Ingress is untouched and still works for operators. It is no longer
the public path.

## Required configuration

These two `control-config` values are not defaults. The overlay sets both:

| Key | Value | Why |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `https://api.throwbox.dev` | The 402 challenge advertises this as the resource URL. `.dev` is HSTS-preloaded for the whole TLD, so plain `http://` is unreachable: it must be `https`. |
| `TRUST_PROXY_HOPS` | `1` | With the tunnel in front, every socket peer is a cloudflared pod. At `0`, `req.ip` is the tunnel and every client shares one rate-limit bucket. `1` trusts a single forwarded hop, which is only safe while nothing untrusted can reach port 3000: `allow-api` admits the cloudflared pods there, and sandbox pods have no egress route into `sandbox-system`. |

`TRUST_PROXY_HOPS` must be `0` again if the tunnel is removed and the API is
reached directly, or a client can forge `X-Forwarded-For`.

## The Secret

The token is read by reference from `cloudflared-tunnel` in `sandbox-system`,
under the key `token`. Nothing in this repository contains a token, an account id
or a tunnel id.

The value is the connector token for the named tunnel (Cloudflare dashboard,
**Zero Trust → Networks → Tunnels**, or `cloudflared tunnel token <name>`). It is
a credential: whoever holds it can serve traffic for that tunnel. Store it in the
same secret store as `x402-secrets`; do not commit it, do not put it in a
ConfigMap, and do not paste it into a shell that records history.

```bash
kubectl create secret generic cloudflared-tunnel \
  --namespace sandbox-system \
  --from-literal=token='<connector token>'
```

In the homelab this Secret is applied from the private repository like the
others; the public repo only names it.

## Creating the tunnel

One tunnel, one public hostname, and a DNS record that Cloudflare manages:

```bash
cloudflared tunnel login                       # operator browser, once
cloudflared tunnel create throwbox-api         # writes the tunnel credentials
cloudflared tunnel route dns throwbox-api api.throwbox.dev
cloudflared tunnel token throwbox-api          # the value for the Secret above
```

Public hostname mapping, in the tunnel configuration (dashboard or
`~/.cloudflared/config.yml`): service `http://api.sandbox-system.svc.cluster.local:3000`.
No TLS origin is configured because the hop from cloudflared to the API stays
inside the cluster; TLS for the public leg terminates at Cloudflare.

`throwbox.dev` itself (the static site) is Cloudflare Pages and is not part of
this tunnel. See [site/README.md](../../../site/README.md).

## Rotating the token

The token is a long-lived credential with no expiry. Rotate it on any suspicion,
and as part of a routine schedule:

1. `cloudflared tunnel rotate-secret throwbox-api` (or refresh the token in the
   dashboard). The old connector token stops working.
2. Update `cloudflared-tunnel` from your secret store:

   ```bash
   kubectl create secret generic cloudflared-tunnel \
     --namespace sandbox-system \
     --from-literal=token='<new token>' \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

3. `kubectl rollout restart deployment/cloudflared -n sandbox-system`, because
   the token is read once at process start.

Rotating the secret invalidates the old connector, so the running pods lose their
edge connection until they are replaced. The rollout is surge-first and a new pod
only becomes ready once it has registered a connection, so the window is short
but it is not zero: expect 502s from the public host until the first new pod is
Ready.

## Point the public host at the API

The DNS record `api.throwbox.dev` is a proxied CNAME to
`<tunnel-id>.cfargotunnel.com`, created by `route dns` above. Do not add an A
record. Do not enable Cloudflare Access on the API host: the x402 challenge and
the capability header are the access control, and an interactive login page
breaks every non-browser client.

## Verifying

```bash
kubectl get pods -n sandbox-system -l app=cloudflared      # 2/2 Running, 2/2 Ready
kubectl logs -n sandbox-system -l app=cloudflared --tail=20 # "Registered tunnel connection"
curl -sS -o /dev/null -w '%{http_code}\n' https://api.throwbox.dev/healthz
curl -sS https://api.throwbox.dev/v1/pricing
```

A `502` at the public host with a healthy cloudflared pod is almost always the
origin, not the tunnel: check `allow-api` admits `app: cloudflared` on port 3000
and that the Service name in the tunnel config resolves.

## What this does not do

- No WAF, bot management or rate limiting rules are configured here. The API's
  own per-payer and per-IP buckets are the limit, and with `TRUST_PROXY_HOPS=1`
  the per-IP bucket finally sees the real client.
- Cloudflare returns `524` for a proxied request that takes longer than 100
  seconds. That is why `waitMs` is capped below it and a long command answers
  `202 pending`; see `api/src/schemas.ts`.
- The tunnel does not add isolation. It changes who can reach the API, not what
  a session can reach.
