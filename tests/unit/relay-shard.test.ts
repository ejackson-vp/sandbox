/**
 * Relay shard enforcement.
 *
 * The registry is in process memory, so a guest that dials the wrong replica
 * would register somewhere the controller never queries. The guest token
 * carries the owning shard; a mismatch fails the upgrade with 421 instead of
 * being served.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo, Server as NetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRelay, type RelayServer } from "../../controller/src/relay.js";
import { RelayClient } from "../../controller/src/relay-client.js";
import { guestTokenFor, sha256Hex } from "../../controller/src/tokens.js";

const ADMIN = "relay-admin-token-0123456789";
const OPAQUE_TOKEN = "guest-token-0123456789";

const relays: RelayServer[] = [];

afterEach(async () => {
  while (relays.length) await relays.pop()!.close();
});

function listen(server: NetServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

async function start(env: { shardIndex?: number; replicas?: number }): Promise<{
  relay: RelayServer;
  port: number;
  client: RelayClient;
}> {
  const relay = createRelay({
    adminToken: ADMIN,
    responseTtlMs: 30_000,
    ...(env.shardIndex !== undefined ? { shardIndex: env.shardIndex } : {}),
    ...(env.replicas !== undefined ? { replicas: env.replicas } : {}),
  });
  relays.push(relay);
  const port = await listen(relay.server);
  const client = new RelayClient({ baseUrl: `http://127.0.0.1:${port}`, adminToken: ADMIN });
  return { relay, port, client };
}

/** Issue a guest upgrade and resolve with its status line. */
function upgrade(port: number, sessionId: string, token: string): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: `/guest?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        // Fresh per request: the value is a nonce, never a credential.
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(`101 ${res.statusMessage ?? ""}`.trim());
    });
    req.on("response", (res) => {
      res.resume();
      resolve(`${res.statusCode} ${res.statusMessage ?? ""}`.trim());
    });
    req.on("error", () => resolve("error"));
    req.end();
  });
}

describe("relay shard enforcement", () => {
  it("rejects a guest token claiming another shard, and accepts its own", async () => {
    const { port, client } = await start({ shardIndex: 1, replicas: 2 });
    const sessionId = "sbx_relay_shard_own";
    const token = guestTokenFor(OPAQUE_TOKEN, 1);
    await client.register(sessionId, sha256Hex(token), 60_000);
    expect(await upgrade(port, sessionId, token)).toContain("101");

    const misroutedSession = "sbx_relay_shard_other";
    const otherToken = guestTokenFor(`${OPAQUE_TOKEN}-b`, 0);
    await client.register(misroutedSession, sha256Hex(otherToken), 60_000);
    expect(await upgrade(port, misroutedSession, otherToken)).toContain("421");
  });

  it("rejects a token with no shard claim in a multi-replica deployment", async () => {
    const { port, client } = await start({ shardIndex: 0, replicas: 2 });
    const sessionId = "sbx_relay_shard_missing";
    await client.register(sessionId, sha256Hex(OPAQUE_TOKEN), 60_000);
    expect(await upgrade(port, sessionId, OPAQUE_TOKEN)).toContain("421");
  });

  // Regression: the StatefulSet always exports SHARD_INDEX, but at one replica
  // the controller mints a token with no shard claim. Enforcing there refused
  // every guest and every create timed out.
  it("accepts a claim-free token when a shard is configured but only one replica runs", async () => {
    const { port, client } = await start({ shardIndex: 0, replicas: 1 });
    const sessionId = "sbx_relay_single_replica";
    await client.register(sessionId, sha256Hex(OPAQUE_TOKEN), 60_000);
    expect(await upgrade(port, sessionId, OPAQUE_TOKEN)).toContain("101");
  });

  it("accepts any shard when SHARD_INDEX is unset", async () => {
    const { port, client } = await start({});
    for (const shard of [0, 1]) {
      const sessionId = `sbx_relay_unsharded_${shard}`;
      const token = guestTokenFor(`${OPAQUE_TOKEN}-${shard}`, shard);
      await client.register(sessionId, sha256Hex(token), 60_000);
      expect(await upgrade(port, sessionId, token)).toContain("101");
    }
    const legacyId = "sbx_relay_unsharded_legacy";
    await client.register(legacyId, sha256Hex(OPAQUE_TOKEN), 60_000);
    expect(await upgrade(port, legacyId, OPAQUE_TOKEN)).toContain("101");
  });
});
