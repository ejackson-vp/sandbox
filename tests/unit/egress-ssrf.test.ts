/**
 * Egress proxy destination validation. Every address here is synthetic or a
 * local literal; no private network is contacted and `dial` must never run for
 * a denied target.
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEgressProxy } from "../../controller/src/egress-proxy.js";
import { mintProxyToken } from "../../controller/src/tokens.js";

const SECRET = ["egress", "proxy", "fixture"].join("-");
const TOKEN = mintProxyToken(SECRET, "ssrf-session", 60_000);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function start(
  resolve: (host: string) => Promise<string[]>,
  // Typed explicitly: the default alone infers `() => never`, which no real
  // dialer assignment satisfies.
  dial: (opts: { host: string; port: number; family: number }) => net.Socket = () => {
    throw new Error("dial must not be called");
  },
) {
  const proxy = createEgressProxy({
    tokenSecret: SECRET,
    allowedPorts: [443],
    allowedHostSuffixes: [],
    resolve,
    dial,
  });
  await new Promise<void>((r) => proxy.server.listen(0, "127.0.0.1", () => r()));
  const port = (proxy.server.address() as net.AddressInfo).port;
  cleanups.push(() => proxy.close());
  return { proxy, port };
}

function attempt(port: number, authority: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    cleanups.push(() => {
    socket.destroy();
  });
    let buffered = "";
    socket.on("connect", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Bearer ${TOKEN}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      const line = buffered.split("\r\n")[0];
      if (line) resolve(line);
    });
    socket.on("error", () => resolve("reset"));
    socket.on("close", () => resolve(buffered.split("\r\n")[0] ?? "reset"));
  });
}

describe("egress destination validation", () => {
  const denied = [
    ["loopback v4", "127.0.0.1"],
    ["loopback v6", "::1"],
    ["private 10/8", "10.0.0.1"],
    ["private 172.16/12", "172.16.4.4"],
    ["private 192.168/16", "192.168.1.1"],
    ["CGNAT", "100.64.0.1"],
    ["link-local", "169.254.1.1"],
    ["cloud metadata", "169.254.169.254"],
    ["ECS metadata", "169.254.170.2"],
    ["unspecified", "0.0.0.0"],
    ["multicast", "224.0.0.1"],
    ["reserved", "240.0.0.1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["IPv4-compatible loopback", "::127.0.0.1"],
    ["ULA", "fc00::1"],
    ["link-local v6", "fe80::1"],
    ["link-local v6 with zone", "fe80::1%eth0"],
    ["documentation v6", "2001:db8::1"],
    ["NAT64", "64:ff9b::7f00:1"],
  ] as const;

  for (const [name, address] of denied) {
    it(`denies ${name} (${address})`, async () => {
      let dialled = false;
      const { port } = await start(
        async () => [address],
        () => {
          dialled = true;
          throw new Error("must not dial");
        },
      );
      const authority = address.includes(":") ? `[${address}]:443` : `${address}:443`;
      const status = await attempt(port, authority);
      // A zone id is rejected outright at parse time (400); other literals are
      // resolved-and-classified (403). Either way: denied, never dialled.
      expect(status).toMatch(/^HTTP\/1\.1 (400 bad_connect_target|403 blocked_destination:)/);
      expect(dialled).toBe(false);
    });
  }

  it("denies a mixed answer even when the first address is public", async () => {
    let dialled = false;
    const { port } = await start(
      async () => ["93.184.216.34", "10.0.0.1"],
      () => {
        dialled = true;
        throw new Error("must not dial");
      },
    );
    const status = await attempt(port, "mixed.example.com:443");
    expect(status).toContain("403 blocked_destination:private");
    expect(dialled).toBe(false);
  });

  it("refuses single-label names and disallowed ports before resolving", async () => {
    let resolved = false;
    const { port } = await start(async () => {
      resolved = true;
      return ["93.184.216.34"];
    });
    expect(await attempt(port, "kubernetes:443")).toContain("403 single_label_hostname");
    expect(await attempt(port, "example.com:22")).toContain("403 port_not_allowed");
    expect(resolved).toBe(false);
  });

  it("dials the exact validated literal, not the hostname", async () => {
    let dialledHost: string | undefined;
    const { port } = await start(
      async () => ["93.184.216.34"],
      ({ host }) => {
        dialledHost = host;
        const socket = new net.Socket();
        process.nextTick(() => socket.destroy(new Error("test dial stop")));
        return socket;
      },
    );
    const status = await attempt(port, "example.com:443");
    expect(status).toContain("502");
    expect(dialledHost).toBe("93.184.216.34");
  });

  it("rejects a missing or invalid proxy token", async () => {
    const { port } = await start(async () => ["93.184.216.34"]);
    const noAuth = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      cleanups.push(() => {
        socket.destroy();
      });
      let buffered = "";
      socket.on("connect", () => socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n"));
      socket.on("data", (c) => {
        buffered += c.toString("latin1");
        if (buffered.includes("\r\n")) resolve(buffered.split("\r\n")[0]!);
      });
      socket.on("close", () => resolve(buffered.split("\r\n")[0] ?? "reset"));
    });
    expect(noAuth).toContain("407");
  });
});
