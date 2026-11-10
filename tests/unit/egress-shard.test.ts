import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEgressProxy, type EgressProxy } from "../../controller/src/egress-proxy.js";
import { mintProxyToken } from "../../controller/src/tokens.js";

/**
 * A connection that lands on the wrong proxy replica must fail, not be served.
 *
 * The per-session connection counter is process memory, so accepting a session
 * another replica owns would multiply its limit by the replica count. These
 * tests exercise the real CONNECT path: DNS and dialling are seams, no public
 * address is contacted.
 */
const SECRET = ["egress", "cross", "shard", "fixture"].join("-");

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

async function startProxy(opts: Parameters<typeof createEgressProxy>[0]): Promise<{
  proxy: EgressProxy;
  port: number;
}> {
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

function connectVia(port: number, token: string): { socket: net.Socket; status: Promise<string> } {
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
      `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Bearer ${token}\r\n\r\n`,
    );
  });
  cleanups.push(() => socket.destroy());
  return { socket, status };
}

describe("egress proxy shard enforcement", () => {
  it("rejects a token claiming another shard and accepts its own", async () => {
    const echo = await echoServer();
    const base = {
      tokenSecret: SECRET,
      resolve: async () => ["93.184.216.34"],
      dial: () =>
        net.connect({ host: "127.0.0.1", port: echo.port, family: 0 }),
    };

    const shardOne = await startProxy({ ...base, shardIndex: 1, replicas: 2 });
    const ownToken = mintProxyToken(SECRET, "session-a", 60_000, 1);
    const accepted = connectVia(shardOne.port, ownToken);
    expect(await accepted.status).toContain("200");

    const shardZero = await startProxy({ ...base, shardIndex: 0, replicas: 2 });
    const misrouted = connectVia(shardZero.port, ownToken);
    expect(await misrouted.status).toContain("421");
    expect(shardZero.proxy.stats().allowed).toBe(0);
    expect(shardZero.proxy.stats().denied).toBe(1);
  });

  it("rejects a token with no shard claim in a multi-replica deployment", async () => {
    const echo = await echoServer();
    const shardZero = await startProxy({
      tokenSecret: SECRET,
      shardIndex: 0,
      replicas: 2,
      resolve: async () => ["93.184.216.34"],
      dial: () => net.connect({ host: "127.0.0.1", port: echo.port, family: 0 }),
    });

    const legacy = connectVia(shardZero.port, mintProxyToken(SECRET, "session-b", 60_000));
    expect(await legacy.status).toContain("421");
  });

  // Regression: the StatefulSet always exports SHARD_INDEX, but at one replica
  // the controller mints a claim-free token. Enforcing there denied every
  // tunnel.
  it("accepts a claim-free token when a shard is configured but only one replica runs", async () => {
    const echo = await echoServer();
    const shardZero = await startProxy({
      tokenSecret: SECRET,
      shardIndex: 0,
      replicas: 1,
      resolve: async () => ["93.184.216.34"],
      dial: () => net.connect({ host: "127.0.0.1", port: echo.port, family: 0 }),
    });

    const legacy = connectVia(shardZero.port, mintProxyToken(SECRET, "session-c", 60_000));
    expect(await legacy.status).toContain("200");
  });

  it("accepts any shard when SHARD_INDEX is unset", async () => {
    const echo = await echoServer();
    const unsharded = await startProxy({
      tokenSecret: SECRET,
      resolve: async () => ["93.184.216.34"],
      dial: () => net.connect({ host: "127.0.0.1", port: echo.port, family: 0 }),
    });

    for (const shard of [0, 1]) {
      const attempt = connectVia(
        unsharded.port,
        mintProxyToken(SECRET, `session-shard-${shard}`, 60_000, shard),
      );
      expect(await attempt.status).toContain("200");
    }
    // A token minted before placement existed still works too.
    const legacy = connectVia(unsharded.port, mintProxyToken(SECRET, "session-legacy", 60_000));
    expect(await legacy.status).toContain("200");
  });

  it("keeps the shard claim inside the MAC", async () => {
    const token = mintProxyToken(SECRET, "session-c", 60_000, 1);
    const [version, exp, , sessionId, mac] = token.split(".");
    expect(`${version}.${exp}.0.${sessionId}.${mac}`).not.toBe(token);
    // A rewritten claim is a signature failure, not a different shard.
    const { verifyProxyToken } = await import("../../controller/src/tokens.js");
    expect(verifyProxyToken(SECRET, `${version}.${exp}.0.${sessionId}.${mac}`)).toEqual({
      ok: false,
      reason: "bad_token_signature",
    });
  });
});
