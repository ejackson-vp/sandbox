/**
 * Egress proxy (proxy-only egress).
 *
 * The sandbox namespace has no direct egress: NetworkPolicy only permits
 * connections to this proxy's pods. This proxy:
 *   - accepts HTTPS CONNECT only (default port 443),
 *   - authenticates a per-session HMAC token,
 *   - resolves names itself and validates EVERY resolved address,
 *   - connects to the exact validated IP literal (no second lookup => no DNS
 *     rebinding window),
 *   - denies loopback/private/link-local/metadata/ULA/multicast/reserved ranges,
 *     cluster CIDRs, and IPv4-mapped IPv6 forms of all of the above,
 *   - refuses single-label hostnames and non-public ports.
 *
 * It keeps no payload state and logs only host + denial reason.
 */
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import type { Duplex } from "node:stream";
import { classifyAddress, type AddressClass } from "@x402s/shared";
import { log, metrics } from "@x402s/shared";
import { verifyProxyToken } from "./tokens.js";

export interface EgressProxyOptions {
  tokenSecret: string;
  /**
   * Ordinal of this proxy replica. When set, a CONNECT whose token claims a
   * different shard is refused: the per-session connection counter and the
   * fairness it enforces are process-local, so serving a misrouted session
   * would silently multiply its limit by the replica count. Unset (the
   * single-replica default) accepts any shard.
   */
  shardIndex?: number;
  /**
   * Number of proxy replicas. Enforcement is skipped at one replica because the
   * controller mints a claim-free token there; see the check below.
   */
  replicas?: number;
  allowedPorts?: number[];
  /** Optional hostname allowlist (suffix match). Empty = any public host. */
  allowedHostSuffixes?: string[];
  deniedCidrs?: string[];
  maxConnectionsPerSession?: number;
  /**
   * Independent process-wide budget. Per-session limits alone let many
   * sessions exhaust the proxy's file descriptors at once.
   */
  maxGlobalConnections?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Test seam: DNS resolver. Defaults to the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Test seam: dial the validated IP literal. Defaults to net.connect. */
  dial?: (opts: { host: string; port: number; family: number }) => net.Socket;
}

export interface EgressProxy {
  server: http.Server;
  close(): Promise<void>;
  stats(): { active: number; denied: number; allowed: number };
}

interface ParsedAuthority {
  host: string;
  port: number;
}

export function parseAuthority(authority: string): ParsedAuthority | null {
  // [v6]:443 | host:443 | host
  const v6 = /^\[([0-9a-fA-F:.%]+)\]:(\d{1,5})$/.exec(authority);
  if (v6) return { host: v6[1]!, port: Number(v6[2]) };
  const parts = authority.split(":");
  if (parts.length === 2) {
    const [host, portRaw] = parts as [string, string];
    if (!/^\d{1,5}$/.test(portRaw)) return null;
    return { host, port: Number(portRaw) };
  }
  if (parts.length === 1) return null; // CONNECT requires an explicit port
  return null;
}

function isIpLiteral(host: string): boolean {
  return net.isIP(host) !== 0;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Accept both `Proxy-Authorization: Bearer <token>` and the Basic form emitted
 * by curl/python/Go when the proxy URL carries userinfo
 * (`http://x402:<token>@host:port`).
 */
export function extractProxyToken(header: string | undefined): string {
  if (!header) return "";
  const value = header.trim();
  if (/^bearer\s+/i.test(value)) return value.replace(/^bearer\s+/i, "").trim();
  if (/^basic\s+/i.test(value)) {
    try {
      const decoded = Buffer.from(value.replace(/^basic\s+/i, ""), "base64").toString("utf8");
      if (!/^[\x20-\x7e]+$/.test(decoded)) return "";
      const idx = decoded.indexOf(":");
      const token = (idx >= 0 ? decoded.slice(idx + 1) : decoded).trim();
      // Tokens are base64url/HMAC output only.
      return /^[A-Za-z0-9._~-]+$/.test(token) ? token : "";
    } catch {
      return "";
    }
  }
  return "";
}

export function createEgressProxy(opts: EgressProxyOptions): EgressProxy {
  const allowedPorts = new Set(opts.allowedPorts ?? [443]);
  const deniedCidrs = opts.deniedCidrs ?? [];
  const maxPerSession = opts.maxConnectionsPerSession ?? 16;
  const maxGlobal = opts.maxGlobalConnections ?? 512;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const resolveHost =
    opts.resolve ??
    (async (host: string) =>
      (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address));
  const dial = opts.dial ?? ((o: { host: string; port: number; family: number }) => net.connect(o));

  const activeBySession = new Map<string, number>();
  let active = 0;
  let denied = 0;
  let allowed = 0;

  /**
   * A reservation is taken synchronously, before the first await, so concurrent
   * CONNECT attempts cannot all observe a free slot. release() is idempotent:
   * every path may call it, but the counters move exactly once.
   */
  interface Lease {
    release(): void;
  }

  function reserve(sessionId: string): Lease | null {
    const current = activeBySession.get(sessionId) ?? 0;
    if (current >= maxPerSession) return null;
    if (active >= maxGlobal) return null;
    activeBySession.set(sessionId, current + 1);
    active += 1;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        active -= 1;
        const n = (activeBySession.get(sessionId) ?? 1) - 1;
        if (n <= 0) activeBySession.delete(sessionId);
        else activeBySession.set(sessionId, n);
      },
    };
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/stats")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...(req.url === "/stats" ? { active, denied, allowed } : {}) }));
      return;
    }
    // Plain HTTP proxying is deliberately unsupported: only HTTPS tunnels.
    res.writeHead(405, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ error: "https_connect_only" }));
  });

  server.on("connect", (req: http.IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    void handleConnect(req, clientSocket, head);
  });

  async function handleConnect(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    const deny = (status: number, reason: string, host?: string) => {
      denied += 1;
      log.warn("egress_denied", { reason, host: host ? host.slice(0, 100) : undefined });
      if (clientSocket.writable) {
        clientSocket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        // end() flushes; destroy is only a backstop for a hostile peer that
        // never reads. unref keeps it out of the event loop's liveness set.
        setTimeout(() => clientSocket.destroy(), 1_000).unref();
      } else {
        clientSocket.destroy();
      }
    };

    const auth = req.headers["proxy-authorization"];
    const token = extractProxyToken(typeof auth === "string" ? auth : undefined);
    if (!token) {
      deny(407, "proxy_authentication_required");
      return;
    }
    const verified = verifyProxyToken(opts.tokenSecret, token);
    if (!verified.ok) {
      deny(407, "proxy_authentication_failed");
      return;
    }
    // Fail closed on a cross-shard landing. The counter this proxy enforces is
    // in memory, so a session split across replicas gets N times the limit
    // regardless of what this check says; rejecting makes the misrouting
    // visible instead of silently over-serving it.
    if (opts.shardIndex !== undefined && (opts.replicas ?? 1) > 1 && verified.shard !== opts.shardIndex) {
      metrics
        .counter("sandbox_egress_cross_shard_total", "CONNECTs refused for landing on the wrong shard")
        .inc({ service: "proxy", reason: verified.shard === undefined ? "missing_shard" : "wrong_shard" });
      log.warn("egress_cross_shard_rejected", {
        reason: verified.shard === undefined ? "missing_shard" : "wrong_shard",
        expected: opts.shardIndex,
        claimed: verified.shard ?? null,
      });
      deny(421, "wrong_shard");
      return;
    }

    const authority = parseAuthority(req.url ?? "");
    if (!authority) {
      deny(400, "bad_connect_target");
      return;
    }
    const host = normalizeHost(authority.host);
    if (!host || host.length > 253 || /[\s/\\]/.test(host)) {
      deny(400, "bad_host");
      return;
    }
    if (!allowedPorts.has(authority.port)) {
      deny(403, "port_not_allowed", host);
      return;
    }

    if (opts.allowedHostSuffixes?.length) {
      const ok = opts.allowedHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
      if (!ok) {
        deny(403, "host_not_allowlisted", host);
        return;
      }
    }

    // Reserve before resolving. DNS can take seconds; without this, N concurrent
    // CONNECTs all pass the limit check while holding no slot.
    const lease = reserve(verified.sessionId);
    if (!lease) {
      deny(429, "too_many_connections", host);
      return;
    }

    // A paused socket does not report peer close, so a client that disconnects
    // during DNS would hold its slot until the dial timeout. Resume it and
    // buffer (bounded) any bytes that arrive before the tunnel is up.
    const early: Buffer[] = [];
    let earlyBytes = 0;
    let aborted = false;
    const onEarlyData = (chunk: Buffer) => {
      earlyBytes += chunk.length;
      if (earlyBytes > 64 * 1024) {
        aborted = true;
        clientSocket.destroy();
        return;
      }
      early.push(chunk);
    };
    // Upgraded HTTP sockets are allowHalfOpen: a peer FIN arrives as "end",
    // not "close". Treat either as the client going away.
    const onClientGone = () => {
      aborted = true;
      lease.release();
      clientSocket.destroy();
    };
    const detach = () => {
      clientSocket.off("close", onClientGone);
      clientSocket.off("end", onClientGone);
      clientSocket.off("data", onEarlyData);
    };
    clientSocket.on("data", onEarlyData);
    clientSocket.once("close", onClientGone);
    clientSocket.once("end", onClientGone);
    clientSocket.resume();

    const fail = (status: number, reason: string) => {
      detach();
      lease.release();
      deny(status, reason, host);
    };

    // Resolve and validate.
    let addresses: string[] = [];
    try {
      if (isIpLiteral(host)) {
        addresses = [host];
      } else {
        // Single-label names are never legitimate public destinations, and are
        // the shape of most cluster-internal service names.
        if (!host.includes(".")) {
          fail(403, "single_label_hostname");
          return;
        }
        addresses = await resolveHost(host);
      }
    } catch {
      fail(502, "dns_resolution_failed");
      return;
    }

    if (aborted || !clientSocket.writable) {
      detach();
      lease.release();
      return;
    }
    if (addresses.length === 0) {
      fail(502, "dns_no_addresses");
      return;
    }

    let target: string | null = null;
    for (const addr of addresses) {
      const cls: AddressClass = classifyAddress(addr, deniedCidrs);
      if (cls !== "public") {
        fail(403, `blocked_destination:${cls}`);
        return;
      }
      target ??= addr;
    }
    if (!target) {
      fail(502, "no_usable_address");
      return;
    }

    // Connect to the validated IP literal. Family is derived from the literal so
    // a dual-stack re-resolution cannot swap in a private address.
    const family = net.isIP(target);
    let upstream: net.Socket;
    try {
      upstream = dial({ host: target, port: authority.port, family });
    } catch {
      fail(502, "upstream_dial_failed");
      return;
    }

    allowed += 1;

    let tunnelled = false;
    const connectTimer = setTimeout(() => {
      if (tunnelled) return;
      upstream.destroy();
      fail(504, "upstream_connect_timeout");
    }, connectTimeoutMs);

    const onConnectError = () => {
      clearTimeout(connectTimer);
      if (tunnelled) return;
      detach();
      lease.release();
      if (clientSocket.writable) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        setTimeout(() => clientSocket.destroy(), 1_000).unref();
      } else {
        clientSocket.destroy();
      }
    };
    upstream.once("error", onConnectError);

    upstream.once("connect", () => {
      clearTimeout(connectTimer);
      // The pre-connect handler must not survive: writing a 502 into an
      // established tunnel corrupts the client's TLS stream.
      upstream.off("error", onConnectError);
      tunnelled = true;
      detach();
      clientSocket.pause();
      if (!clientSocket.writable) {
        upstream.destroy();
        lease.release();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: x402-egress-proxy\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      for (const chunk of early) upstream.write(chunk);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      log.info("egress_allowed", { host, port: authority.port, sessionPrefix: verified.sessionId.slice(0, 12) });

      upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
      upstream.on("error", () => clientSocket.destroy());
      upstream.on("close", () => {
        lease.release();
        clientSocket.destroy();
      });
      clientSocket.on("error", () => upstream.destroy());
      clientSocket.on("close", () => upstream.destroy());
    });
  }

  return {
    server,
    stats: () => ({ active, denied, allowed }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
