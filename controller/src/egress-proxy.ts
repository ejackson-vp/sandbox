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
import { log } from "@x402s/shared";
import { verifyProxyToken } from "./tokens.js";

export interface EgressProxyOptions {
  tokenSecret: string;
  allowedPorts?: number[];
  /** Optional hostname allowlist (suffix match). Empty = any public host. */
  allowedHostSuffixes?: string[];
  deniedCidrs?: string[];
  maxConnectionsPerSession?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
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
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;

  const activeBySession = new Map<string, number>();
  let active = 0;
  let denied = 0;
  let allowed = 0;

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
        clientSocket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      }
      clientSocket.destroy();
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

    const current = activeBySession.get(verified.sessionId) ?? 0;
    if (current >= maxPerSession) {
      deny(429, "too_many_connections", host);
      return;
    }

    if (opts.allowedHostSuffixes?.length) {
      const ok = opts.allowedHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
      if (!ok) {
        deny(403, "host_not_allowlisted", host);
        return;
      }
    }

    // Resolve and validate.
    let addresses: string[] = [];
    try {
      if (isIpLiteral(host)) {
        addresses = [host];
      } else {
        // Single-label names are never legitimate public destinations, and are
        // the shape of most cluster-internal service names.
        if (!host.includes(".")) {
          deny(403, "single_label_hostname", host);
          return;
        }
        const resolved = await dns.lookup(host, { all: true, verbatim: true });
        addresses = resolved.map((r) => r.address);
      }
    } catch {
      deny(502, "dns_resolution_failed", host);
      return;
    }

    if (addresses.length === 0) {
      deny(502, "dns_no_addresses", host);
      return;
    }

    let target: string | null = null;
    for (const addr of addresses) {
      const cls: AddressClass = classifyAddress(addr, deniedCidrs);
      if (cls !== "public") {
        deny(403, `blocked_destination:${cls}`, host);
        return;
      }
      target ??= addr;
    }
    if (!target) {
      deny(502, "no_usable_address", host);
      return;
    }

    // Connect to the validated IP literal. Family is derived from the literal so
    // a dual-stack re-resolution cannot swap in a private address.
    const family = net.isIP(target);
    const upstream = net.connect({ host: target, port: authority.port, family });

    active += 1;
    activeBySession.set(verified.sessionId, current + 1);
    allowed += 1;

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      active -= 1;
      const n = (activeBySession.get(verified.sessionId) ?? 1) - 1;
      if (n <= 0) activeBySession.delete(verified.sessionId);
      else activeBySession.set(verified.sessionId, n);
    };

    const connectTimer = setTimeout(() => {
      if (!settled) {
        deny(504, "upstream_connect_timeout", host);
        upstream.destroy();
      }
    }, connectTimeoutMs);

    upstream.once("connect", () => {
      clearTimeout(connectTimer);
      if (!clientSocket.writable) {
        upstream.destroy();
        cleanup();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: x402-egress-proxy\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      log.info("egress_allowed", { host, port: authority.port, sessionPrefix: verified.sessionId.slice(0, 12) });

      upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
      upstream.on("error", () => clientSocket.destroy());
      upstream.on("close", () => {
        cleanup();
        clientSocket.destroy();
      });
      clientSocket.on("error", () => upstream.destroy());
      clientSocket.on("close", () => upstream.destroy());
    });

    upstream.once("error", () => {
      clearTimeout(connectTimer);
      cleanup();
      if (clientSocket.writable) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
      clientSocket.destroy();
    });
  }

  return {
    server,
    stats: () => ({ active, denied, allowed }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
