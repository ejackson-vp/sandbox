# Networking inside a session

The sandbox is **deny-all by default**. Only two outbound destinations exist:

| Destination | Port | Why |
| --- | --- | --- |
| `relay` (control plane) | 8443 | the encrypted operation channel (guest-initiated) |
| `egress-proxy` | 3128 | the only path to the public internet |

Everything else — other sandboxes, the Kubernetes API, kubelets, node IPs, cloud
metadata (`169.254.169.254`), cluster Services, and the local network — is
blocked by Cilium NetworkPolicy and verified by `tests/security/network.test.ts`.

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

```
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
