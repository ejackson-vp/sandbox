/**
 * Egress proxy connection accounting.
 *
 * These are deterministic: DNS is a resolver we control, and dialling is a
 * seam. No public address is ever contacted.
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEgressProxy, type EgressProxy } from "../../controller/src/egress-proxy.js";
import { mintProxyToken } from "../../controller/src/tokens.js";

const SECRET = ["egress", "proxy", "fixture"].join("-");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function listen(server: net.Server | import("node:http").Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

async function startProxy(opts: Parameters<typeof createEgressProxy>[0]): Promise<{ proxy: EgressProxy; port: number }> {
  const proxy = createEgressProxy(opts);
  const port = await listen(proxy.server);
  cleanups.push(() => proxy.close());
  return { proxy, port };
}

async function echoServer(): Promise<{ port: number }> {
  const server = net.createServer((socket) => socket.pipe(socket));
  const port = await listen(server);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return { port };
}

interface Attempt {
  socket: net.Socket;
  status: Promise<string>;
}

/** Issue a CONNECT and resolve with the status line (or "reset"). */
function connectVia(port: number, host: string, token: string): Attempt {
  const socket = net.connect({ host: "127.0.0.1", port });
  const status = new Promise<string>((resolve) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      const line = buffered.split("\r\n")[0];
      if (line) resolve(line);
    });
    socket.on("error", () => resolve("reset"));
    socket.on("close", () => resolve(buffered ? buffered.split("\r\n")[0]! : "reset"));
  });
  socket.on("connect", () => {
    socket.write(
      `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: Bearer ${token}\r\n\r\n`,
    );
  });
  cleanups.push(() => socket.destroy());
  return { socket, status };
}

async function waitFor(fn: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!fn()) throw new Error("condition not met in time");
}

describe("egress proxy accounting", () => {
  it("never exceeds the per-session limit while DNS is in flight", async () => {
    const echo = await echoServer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let resolves = 0;
    const { proxy, port } = await startProxy({
      tokenSecret: SECRET,
      maxConnectionsPerSession: 4,
      resolve: async () => {
        resolves += 1;
        await gate;
        return ["93.184.216.34"];
      },
      dial: ({ host, port: destPort, family }) => {
        expect(host).toBe("93.184.216.34");
        expect(family).toBe(4);
        return net.connect({ host: "127.0.0.1", port: echo.port, family: 0 });
      },
    });

    const token = mintProxyToken(SECRET, "session-a", 60_000);
    const attempts = Array.from({ length: 32 }, () => connectVia(port, "example.com:443", token));

    // Four reservations are taken synchronously; the other 28 are rejected
    // without waiting for DNS.
    await waitFor(() => resolves === 4 && proxy.stats().denied === 28);
    expect(proxy.stats().active).toBe(4);

    release();
    // The four accepted tunnels connect; the rest were refused with 429.
    const statuses = await Promise.all(attempts.map((a) => a.status));
    expect(statuses.filter((s) => s.includes("200"))).toHaveLength(4);
    expect(statuses.filter((s) => s.includes("429"))).toHaveLength(28);
    expect(proxy.stats().active).toBe(4);

    // Closing the tunnels releases exactly four slots.
    for (const attempt of attempts) attempt.socket.destroy();
    await waitFor(() => proxy.stats().active === 0);
    expect(proxy.stats().active).toBe(0);
  });

  it("releases exactly one reservation per failed resolve and never goes negative", async () => {
    let calls = 0;
    const { proxy, port } = await startProxy({
      tokenSecret: SECRET,
      maxConnectionsPerSession: 2,
      resolve: async () => {
        calls += 1;
        throw new Error("synthetic NXDOMAIN");
      },
    });

    const token = mintProxyToken(SECRET, "session-b", 60_000);
    for (let i = 0; i < 6; i += 1) {
      const attempt = connectVia(port, "blocked.example.invalid:443", token);
      expect(await attempt.status).toContain("502");
      attempt.socket.destroy();
      expect(proxy.stats().active).toBe(0);
    }
    expect(calls).toBe(6);
    expect(proxy.stats().active).toBe(0);

    // A reservation is still available afterwards: the counters did not stick.
    const next = connectVia(port, "blocked.example.invalid:443", token);
    expect(await next.status).toContain("502");
    expect(proxy.stats().active).toBe(0);
  });

  it("releases the reservation when the dial errors", async () => {
    const { proxy, port } = await startProxy({
      tokenSecret: SECRET,
      maxConnectionsPerSession: 1,
      resolve: async () => ["93.184.216.34"],
      dial: () => {
        const socket = new net.Socket();
        process.nextTick(() => socket.destroy(new Error("synthetic dial failure")));
        return socket;
      },
    });

    const token = mintProxyToken(SECRET, "session-c", 60_000);
    for (let i = 0; i < 4; i += 1) {
      const attempt = connectVia(port, "example.com:443", token);
      expect(await attempt.status).toMatch(/502/);
      attempt.socket.destroy();
      expect(proxy.stats().active).toBe(0);
    }
  });

  it("releases the reservation when the client aborts during DNS", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    let resolved = false;
    const { proxy, port } = await startProxy({
      tokenSecret: SECRET,
      maxConnectionsPerSession: 1,
      resolve: async () => {
        started = true;
        await gate;
        resolved = true;
        return ["93.184.216.34"];
      },
    });

    const token = mintProxyToken(SECRET, "session-d", 60_000);
    const attempt = connectVia(port, "example.com:443", token);
    await waitFor(() => started);
    expect(proxy.stats().active).toBe(1);
    attempt.socket.destroy();
    await waitFor(() => proxy.stats().active === 0);
    release();
    await waitFor(() => resolved);
    // Give the resumed handler a turn; it must not re-reserve or dial.
    await new Promise((r) => setTimeout(r, 20));
    expect(proxy.stats().active).toBe(0);
  });

  it("enforces a global budget across sessions", async () => {
    const echo = await echoServer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { proxy, port } = await startProxy({
      tokenSecret: SECRET,
      maxConnectionsPerSession: 10,
      maxGlobalConnections: 3,
      resolve: async () => {
        await gate;
        return ["93.184.216.34"];
      },
      dial: () => net.connect({ host: "127.0.0.1", port: echo.port }),
    });

    const attempts: Attempt[] = [];
    for (const session of ["s1", "s2", "s3"]) {
      const token = mintProxyToken(SECRET, session, 60_000);
      for (let i = 0; i < 4; i += 1) attempts.push(connectVia(port, "example.com:443", token));
    }

    await waitFor(() => proxy.stats().active === 3 && proxy.stats().denied === 9);
    expect(proxy.stats().active).toBe(3);
    release();
    const statuses = await Promise.all(attempts.map((a) => a.status));
    expect(statuses.filter((s) => s.includes("200"))).toHaveLength(3);
    for (const attempt of attempts) attempt.socket.destroy();
    await waitFor(() => proxy.stats().active === 0);
  });

  it("does not inject a 502 into an established tunnel", async () => {
    const echo = await echoServer();
    let upstream: net.Socket | undefined;
    const { proxy, port } = await startProxy({
      tokenSecret: SECRET,
      resolve: async () => ["93.184.216.34"],
      dial: () => {
        upstream = net.connect({ host: "127.0.0.1", port: echo.port });
        return upstream;
      },
    });

    const token = mintProxyToken(SECRET, "session-e", 60_000);
    const attempt = connectVia(port, "example.com:443", token);
    const received: string[] = [];
    attempt.socket.on("data", (chunk) => received.push(chunk.toString("latin1")));
    expect(await attempt.status).toContain("200");
    await waitFor(() => upstream !== undefined);

    // Error after connect: the client must not see a second HTTP response.
    upstream!.destroy(new Error("synthetic post-connect failure"));
    await waitFor(() => proxy.stats().active === 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(received.join("")).not.toContain("502");
  });
});

describe("egress denial attribution", () => {
  it("names the session in the denial log so a runbook can trace it", async () => {
    const { port } = await startProxy({ tokenSecret: SECRET });
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      // Port 22 is refused before any dial, so this is deterministic.
      const attempt = connectVia(port, "example.com:22", mintProxyToken(SECRET, "session-z", 60_000));
      expect(await attempt.status).toContain("403");
      attempt.socket.destroy();
    } finally {
      process.stderr.write = write;
    }
    const denial = lines.find((line) => line.includes("egress_denied"));
    expect(denial).toBeDefined();
    expect(JSON.parse(denial!)).toMatchObject({
      msg: "egress_denied",
      reason: "port_not_allowed",
      sessionId: "session-z",
    });
  });
});
