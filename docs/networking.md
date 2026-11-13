# Networking inside a session

The sandbox is **deny-all by default**. Only two outbound destinations exist:

| Destination             | Port | Why                                               |
| ----------------------- | ---- | ------------------------------------------------- |
| `relay` (control plane) | 8443 | the encrypted operation channel (guest-initiated) |
| `egress-proxy`          | 3128 | the only path to the public internet              |

Everything else — other sandboxes, the Kubernetes API, kubelets, node IPs, cloud
metadata (`169.254.169.254`), cluster Services, and the local network — is
blocked by Cilium NetworkPolicy and verified by `tests/security/network.test.ts`.

## Control-plane paths

The two relay listeners have different callers and different credentials. They
are never interchangeable:

| Path               | Port | Transport         | Credential                         | Caller          |
| ------------------ | ---- | ----------------- | ---------------------------------- | --------------- |
| guest WebSocket    | 8443 | plaintext HTTP/WS | per-session guest bearer token     | sandbox guest   |
| relay control      | 8444 | mTLS              | client certificate `CN=controller` | controller only |
| readiness/liveness | 8443 | plaintext HTTP    | none (bounded, non-secret body)    | kubelet         |
| controller wake    | 3001 | plaintext HTTP    | low-privilege `x-wake-token`       | relay only      |

The control listener is served by `https.createServer` with `requestCert`,
`rejectUnauthorized` and a client CA. The expected `CN=controller` is enforced on
the authenticated TLS socket at `secureConnection`, before Express sees the
request. A plaintext connection fails the TLS handshake; a certificate signed by
the CA for another component (for example the API's `CN=api`) is rejected at the
transport layer (connection reset); a valid controller certificate is the only
credential — the shared relay admin token is not accepted on this listener.
`/internal/*` is not mounted on the guest listener at all, so
`curl http://<relay>:8443/internal/...` returns `404`.

NetworkPolicy mirrors the split: `allow-relay` admits `sandbox-workloads` only on
8443 and the controller only on 8444, while `allow-controller` egress to the relay
is limited to 8444. The relay's own egress to the controller stays on 3001 for
the wake token; that listener cannot reach any other internal route.

Local clusters generate a throwaway CA, relay server certificate and
`CN=controller` client certificate in `scripts/dev-secrets.sh` (git-ignored,
never committed). A deployed environment mounts its own `relay-tls` and
`relay-client-tls` Secrets from the private infrastructure repository.

## DNS

There is deliberately **no usable DNS** in a sandbox:

- `dnsPolicy: None` with `127.0.0.1` as the only nameserver (nothing listens),
- NetworkPolicy has no DNS egress rule.

Consequences:

- `getaddrinfo()`/`socket.gethostbyname()` fail fast.
- Tools that resolve names themselves (before using the proxy) fail. The proxy
  resolves names **for you**, validates every returned IP, and connects to the
  validated IP literal (this is what defeats DNS rebinding).
- There is no DNS-based exfiltration channel.

## HTTPS through the proxy

The guest sets these for every command (credentialed, per session):

```text
HTTP_PROXY=http://x402:<session-token>@<proxy-ip>:3128
HTTPS_PROXY=http://x402:<session-token>@<proxy-ip>:3128
http_proxy=...  https_proxy=...
NO_PROXY=
```

Proxy-aware clients work out of the box:

```bash
curl https://example.com/                    # uses HTTPS_PROXY
python3 -c "import urllib.request; print(urllib.request.urlopen('https://example.com').status)"
node -e "fetch('https://example.com').then(r=>console.log(r.status))"
git clone https://github.com/…               # libcurl honours HTTPS_PROXY
```

Clients that ignore proxy environment variables must be configured explicitly:

```bash
# Python requests / pip
pip install --proxy "$HTTPS_PROXY" requests
python3 -m pip config set global.proxy "$HTTPS_PROXY"

# npm
npm config set proxy "$HTTP_PROXY"
npm config set https-proxy "$HTTPS_PROXY"
# npm may also need the registry over https and strict-ssl left on

# git
git -c http.proxy="$HTTPS_PROXY" clone https://…

# Go
export GOPROXY=https://proxy.golang.org
# (go modules use HTTPS_PROXY automatically)
```

Rules enforced by the proxy:

- `CONNECT` only, port **443** only (plain HTTP proxying is refused),
- authentication: per-session HMAC token (Bearer or proxy-URL Basic),
- destination must resolve entirely to public addresses; loopback, RFC1918,
  CGNAT, link-local, cloud metadata, multicast, reserved, IPv6 ULA/link-local,
  NAT64, 6to4, Teredo and IPv4-mapped forms are rejected,
- single-label hostnames and cluster names are rejected,
- connect happens to the validated IP literal, so a second DNS answer cannot
  swap in a private address,
- maximum 16 concurrent tunnels per session.

## What customers cannot do

- Listen for inbound connections (the namespace has no ingress rules; the pod is
  never reachable from outside).
- Reach another sandbox, the control plane, or any internal service.
- Reach the internet without the proxy, including by IP.
- Use DNS to exfiltrate.
- Bypass the proxy with IPv6 or DNS tricks.

## Package installation

`apk`/`apt` need root and are not available (the sandbox runs unprivileged).
Language-level package managers work through the proxy:

```bash
pip install --proxy "$HTTPS_PROXY" requests
npm install --proxy "$HTTP_PROXY" --https-proxy "$HTTPS_PROXY" left-pad
```

Large installs count against the workspace disk quota and the session's
duration. Nothing persists after the session ends.

## Service addressing inside a microVM

Sandboxes run in a Kata microVM with their own kernel. **A ClusterIP is not
reachable from inside it.**

Cilium implements Kubernetes Services with eBPF at the socket/connect layer and on
the pod's veth. Traffic originating in the guest never traverses either: the
guest has its own TCP stack, so the service VIP arrives at the host as an
ordinary packet addressed to an address no endpoint owns, and it is routed into
a dead end. Nothing logs a policy drop, because policy is evaluated against a
backend identity that is never resolved.

Measured on a two-node cluster, same namespace, same policies:

| From       | To relay pod IP | To relay ClusterIP |
| ---------- | --------------- | ------------------ |
| `runc` pod | OK              | OK                 |
| `kata` pod | OK              | **timeout**        |

The controller resolves two different things for two different reasons:

- the **egress proxy** to a ready EndpointSlice address (`getServiceAddress` in
  `controller/src/k8s.ts`). A proxy replacement only breaks egress for the rest
  of the session, so a Pod IP is acceptable, and Pod IPs are routed normally in
  every runtime. With `PROXY_REPLICAS` above 1 it resolves the endpoint whose
  hostname is `egress-proxy-<shard>` (the StatefulSet pod name behind the
  headless Service).
- the **relay** to a ClusterIP (`getStableServiceAddress`), never an endpoint
  Pod IP. The guest URL is baked into the pod at create, and a Pod IP dies with
  the relay pod. At one relay replica that is the `relay` Service; at two it is
  the session shard's `relay-<n>` Service, a ClusterIP whose only selector is
  `statefulset.kubernetes.io/pod-name: relay-<n>`, so it reaches exactly the pod
  that holds the session. A shard with no ready endpoint fails provisioning
  instead of falling back to a name, another shard, or a dead Pod IP.

The Kata caveat above still applies to the relay: where a guest cannot reach a
Service VIP, `RELAY_GUEST_ADDRESS=pod` makes the guest dial the shard's endpoint
Pod IP instead. That mode keeps sessions working but cannot follow a relay pod
replacement, so a restart ends the affected sessions with `relay_lost` rather
than reconnecting them (ADR 0012). Two shards do not change that: they halve how
many sessions a restart touches, not what a replacement costs a guest that holds
a Pod IP.

Warm-pool guests take the same decision. A warm pod dials the relay before any
session exists, and it used to pick a ClusterIP itself regardless of
`RELAY_GUEST_ADDRESS`, so on a cluster that denies Service VIPs from the guest
netns every warm pod timed out and was recycled until the pool was empty while
cold sessions worked. Both paths now resolve through
`DataPlaneEndpoints.relayAddress`, so a cluster gets one addressing mode, not
two. A warm pod that holds a Pod IP is stranded by a relay replacement exactly
like a claimed one: it fails its next dial and the pool replaces it.

The controller's admin calls take a third path: mTLS to
`relay-<n>.relay-headless:8444`, because the controller runs in-cluster with
working DNS. Sharding therefore requires the relay server certificate to carry a
`relay-<n>.relay-headless` SAN per shard. `scripts/dev-secrets.sh` issues
`relay-0` through `relay-9` for a local cluster; a deployed `relay-tls` Secret is
issued elsewhere and has to list the shards actually in use.

Consequences worth knowing:

- A guest is pinned to one shard for the life of the process. The guest token
  carries the shard and the relay refuses a mismatch with 421.
- The controller caches the ClusterIP for 30 s; the relay's endpoint Pod IP
  (when `RELAY_GUEST_ADDRESS=pod`) is resolved on every use, because a
  replacement changes it.
- The controller's Role needs `get`/`list` on `endpointslices` in
  `discovery.k8s.io`. Without it every reconcile fails with 403, which surfaces
  as a paid session stuck in `PAID` until it times out.
- This is also why sandbox pods are given no usable DNS: nothing inside needs a
  name, and a working resolver would only widen the egress surface.
