/**
 * A sealed result outlives the relay cache.
 *
 * The relay keeps a response for 5 minutes and 64 entries per session; after
 * that a retry of a completed request used to get `410 result_expired` even
 * though the operation had run. The controller now stores the client-sealed
 * envelope with the request row and answers from it on a cache miss. These
 * tests pin the three paths that persist it (the owning POST, the
 * duplicate-retry POST and the GET) and the two fallbacks (stored-null is still
 * `410`, an oversized envelope is never stored).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Store } from "../../controller/src/store.js";
import { MAX_PERSISTED_RESULT_BYTES } from "../../controller/src/store/models.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { seedReadySession } from "./store-contract/fixtures.js";

const ADMIN_TOKEN = "c".repeat(24);
const PAYMENT_KEY = "a".repeat(64);
const SESSION_ID = `sbx_${"8".repeat(24)}`;
const ENVELOPE = "c2VhbGVkLXJlc3VsdC1lbnZlbG9wZQ==";

/**
 * A relay with no cached result: every read is a miss, which is what the 5
 * minute TTL and the 64 entry cap produce after eviction. `hits` lets a test
 * hand back envelopes first, then miss, so the persist-then-evict order is
 * exercised rather than assumed.
 */
function missingRelay(hits: string[] = []): RelayClient {
  const relay = {
    async request() {},
    async response() {
      const next = hits.shift();
      return next ? { kind: "envelope" as const, envelope: next } : { kind: "pending" as const };
    },
    async cancel() {},
  };
  return relay as unknown as RelayClient;
}

const servers: http.Server[] = [];
const stores: Store[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-result-retention-"));
  dirs.push(dir);
  return dir;
}

async function startController(relay: RelayClient, store: Store): Promise<number> {
  const cfg = loadControllerConfig({
    ADMIN_TOKEN,
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    DB_PATH: join(tempDir(), "controller.db"),
  });
  const app = createControlApi({ cfg, store, relay, capacity: {} as CapacityService });
  const server = http.createServer(app);
  servers.push(server);
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** A ready session and a controller over the given relay. */
async function seededController(relay: RelayClient): Promise<{ port: number; store: Store }> {
  const store = new Store(join(tempDir(), "controller.db"));
  stores.push(store);
  await seedReadySession(store, SESSION_ID, PAYMENT_KEY);
  const port = await startController(relay, store);
  return { port, store };
}

function get(port: number, requestId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return request(
    "GET",
    `http://127.0.0.1:${port}/internal/sessions/${SESSION_ID}/operations/${requestId}?waitMs=0`,
    undefined,
  );
}

function retry(
  port: number,
  requestId: string,
  envelope = "cmUtc2VhbGVk",
): Promise<{ status: number; body: Record<string, unknown> }> {
  return request("POST", `http://127.0.0.1:${port}/internal/sessions/${SESSION_ID}/operations`, {
    requestId,
    envelope,
    op: "exec",
    waitMs: 0,
  });
}

async function request(
  method: string,
  url: string,
  body: Record<string, unknown> | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-internal-token": ADMIN_TOKEN },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Claim and finish a request as if the guest had answered, with no relay. */
async function prime(
  store: Store,
  requestId: string,
  resultEnvelope: string | null,
): Promise<void> {
  const claim = await store.claimOperation(SESSION_ID, requestId, "exec");
  if (!claim.ok) throw new Error(`claim was ${claim.code}`);
  await store.finishOperation(SESSION_ID, requestId, "done", resultEnvelope);
}

describe("stored result served on a relay cache miss", () => {
  it("returns the stored envelope on GET instead of result_expired", async () => {
    const { port, store } = await seededController(missingRelay());
    await prime(store, "evicted-request-0001", ENVELOPE);

    const res = await get(port, "evicted-request-0001");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requestId: "evicted-request-0001", envelope: ENVELOPE });
    expect(res.body).not.toHaveProperty("error");
  });

  it("returns the stored envelope to the duplicate-retry POST as well", async () => {
    const { port, store } = await seededController(missingRelay());
    await prime(store, "evicted-request-0002", ENVELOPE);

    const res = await retry(port, "evicted-request-0002");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ envelope: ENVELOPE });
    // Answered from the row: nothing was forwarded to the guest again.
    expect(res.body).not.toHaveProperty("pending");
  });

  it("keeps 410 when the row has no envelope either", async () => {
    const { port, store } = await seededController(missingRelay());
    // Finished without a result, as every pre-v17 row and every oversized
    // envelope looks.
    await prime(store, "evicted-request-0003", null);

    const res = await get(port, "evicted-request-0003");
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: "result_expired", requestId: "evicted-request-0003" });
  });

  it("still reports pending for a request the guest has not answered", async () => {
    const { port, store } = await seededController(missingRelay());
    const claim = await store.claimOperation(SESSION_ID, "evicted-request-0004", "exec");
    expect(claim).toMatchObject({ ok: true });

    const res = await get(port, "evicted-request-0004");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      state: "ACTIVE",
      requestId: "evicted-request-0004",
      pending: true,
    });
  });
});

describe("the paths that persist a result", () => {
  it("persists the envelope the owning POST received, then serves it after eviction", async () => {
    // The relay answers the first read and misses afterwards: a result that
    // arrived once and was evicted, in the order that actually happens.
    const { port, store } = await seededController(missingRelay([ENVELOPE]));

    const first = await retry(port, "persist-post-0001", ENVELOPE);
    expect(first.status).toBe(200);
    expect(first.body.envelope).toBe(ENVELOPE);
    expect((await store.getExecRequest(SESSION_ID, "persist-post-0001"))?.resultEnvelope).toBe(
      ENVELOPE,
    );

    // The relay has nothing now; the row answers.
    const after = await get(port, "persist-post-0001");
    expect(after.status).toBe(200);
    expect(after.body.envelope).toBe(ENVELOPE);
  });

  it("persists the envelope the GET path received", async () => {
    const { port, store } = await seededController(missingRelay([ENVELOPE]));
    const claim = await store.claimOperation(SESSION_ID, "persist-get-0001", "exec");
    expect(claim).toMatchObject({ ok: true });

    const first = await get(port, "persist-get-0001");
    expect(first.status).toBe(200);
    expect(first.body.envelope).toBe(ENVELOPE);
    expect((await store.getExecRequest(SESSION_ID, "persist-get-0001"))?.resultEnvelope).toBe(
      ENVELOPE,
    );

    // A second read is answered from the row with no relay result at all.
    const after = await get(port, "persist-get-0001");
    expect(after.status).toBe(200);
    expect(after.body.envelope).toBe(ENVELOPE);
  });

  it("does not persist an envelope above the bound, so the row stays cache-only", async () => {
    const oversized = "a".repeat(MAX_PERSISTED_RESULT_BYTES + 1);
    const { port, store } = await seededController(missingRelay([oversized]));

    const first = await retry(port, "persist-huge-0001", oversized);
    expect(first.status).toBe(200);
    // The client still gets its result; only the durable copy is refused.
    expect(first.body.envelope).toBe(oversized);
    expect((await store.getExecRequest(SESSION_ID, "persist-huge-0001"))?.resultEnvelope).toBeNull();

    const after = await get(port, "persist-huge-0001");
    expect(after.status).toBe(410);
    expect(after.body).toEqual({ error: "result_expired", requestId: "persist-huge-0001" });
  });
});
