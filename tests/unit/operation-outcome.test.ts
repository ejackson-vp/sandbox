/**
 * Outcome classification for an operation the relay accepted.
 *
 * A relay link that dies after the frame was forwarded means the command may
 * have run and no result exists. That is `outcome_unknown`, never a guest
 * failure (502), never a cache expiry (410), and never a reused idempotency key
 * (409 idempotency_key_reused). A guest-reported error is still a real outcome.
 *
 * The relay failure classes come from the response endpoint: the relay used to
 * collapse them into one 409 with prose, which forced the controller to guess.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { seedReadySession } from "./store-contract/fixtures.js";
import { freshStore, testDatabaseUrl } from "../helpers/test-store.js";

const SESSION_ID = `sbx_${"9".repeat(24)}`;
const PAYMENT_KEY = "b".repeat(64);
const REQUEST_ID = "outcome-request-0001";
const ENVELOPE = "c2VhbGVkLWVudmVsb3BlLU9VVENPTUU=";
const ADMIN = "c".repeat(24);

type RelayOutcome =
  | { kind: "pending" }
  | { kind: "envelope"; envelope: string }
  | { kind: "guest_error"; code: string; message: string };

interface Harness {
  port: number;
  store: PostgresStore;
  /** Change what the relay answers for the response poll. */
  answer(outcome: RelayOutcome): void;
  /** Make the relay refuse the frame before it is accepted. */
  failRequest(message: string): void;
}

const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startController(relay: RelayClient, store: PostgresStore): Promise<number> {
  const cfg = loadControllerConfig({
    ADMIN_TOKEN: ADMIN,
    ROLE: "controller",
    KUBERNETES_ENABLED: "false",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    DATABASE_URL: testDatabaseUrl(),
    RELAY_RESPONSE_WAIT_MS: "0",
  });
  const app = createControlApi({ cfg, store, relay, capacity: {} as CapacityService });
  const server = http.createServer(app);
  servers.push(server);
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

async function harness(): Promise<Harness> {
  const store = await freshStore();
  await seedReadySession(store, SESSION_ID, PAYMENT_KEY);
  let outcome: RelayOutcome = { kind: "pending" };
  let requestError: Error | undefined;
  const relay = {
    async request() {
      if (requestError) throw requestError;
    },
    async response() {
      return outcome;
    },
    async cancel() {},
  } as unknown as RelayClient;
  const port = await startController(relay, store);
  return {
    port,
    store,
    answer(next) {
      outcome = next;
    },
    failRequest(message) {
      requestError = Object.assign(new Error(message), { status: 409 });
    },
  };
}

async function post(
  h: Harness,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${h.port}/internal/sessions/${SESSION_ID}/operations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": ADMIN },
    body: JSON.stringify({ requestId: REQUEST_ID, envelope: ENVELOPE, op: "exec", waitMs: 0, ...body }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function get(
  h: Harness,
  requestId = REQUEST_ID,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `http://127.0.0.1:${h.port}/internal/sessions/${SESSION_ID}/operations/${requestId}?waitMs=0`,
    { headers: { "x-internal-token": ADMIN } },
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("operation outcome classification", () => {
  for (const code of ["guest_disconnected", "request_superseded"] as const) {
    it(`marks a ${code} link loss as outcome_unknown and keeps the gate closed`, async () => {
      const h = await harness();
      try {
        h.answer({ kind: "guest_error", code, message: "the link went away" });
        const response = await post(h);

        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ error: "outcome_unknown", requestId: REQUEST_ID });
        expect(await h.store.getExecRequest(SESSION_ID, REQUEST_ID)).toMatchObject({
          state: "outcome_unknown",
          resultEnvelope: null,
        });
        // The command may still be running: the single-operation gate stays
        // closed until the fence sees the guest idle.
        expect((await h.store.getSession(SESSION_ID))?.activeRequestId).toBe(REQUEST_ID);
        expect(await h.store.claimOperation(SESSION_ID, "outcome-new-request", "exec")).toMatchObject({
          ok: false,
          code: "busy",
        });
      } finally {
        await h.store.close();
      }
    });
  }

  it("answers a lookup with outcome_unknown, not result_expired", async () => {
    const h = await harness();
    try {
      h.answer({ kind: "guest_error", code: "guest_disconnected", message: "guest disconnected" });
      await post(h);
      h.answer({ kind: "guest_error", code: "guest_disconnected", message: "guest disconnected" });

      const looked = await get(h);
      expect(looked.status).toBe(409);
      expect(looked.body).toMatchObject({ error: "outcome_unknown", requestId: REQUEST_ID });
    } finally {
      await h.store.close();
    }
  });

  it("answers a same-id retry with outcome_unknown even when the payload hash differs", async () => {
    const h = await harness();
    try {
      h.answer({ kind: "guest_error", code: "guest_disconnected", message: "guest disconnected" });
      await post(h, { payloadHash: "a".repeat(64) });

      // A retry that does not send the original canonical hash (a diagnostic
      // client, or a re-sealed envelope) must still learn the outcome, not be
      // told the id belongs to a different operation.
      h.answer({ kind: "pending" });
      const retry = await post(h, { payloadHash: "b".repeat(64) });
      expect(retry.status).toBe(409);
      expect(retry.body).toMatchObject({ error: "outcome_unknown", requestId: REQUEST_ID });
    } finally {
      await h.store.close();
    }
  });

  it("keeps a guest-reported operation error as a real failure", async () => {
    const h = await harness();
    try {
      h.answer({ kind: "guest_error", code: "guest_error", message: "exit status 2" });
      const response = await post(h);

      expect(response.status).toBe(502);
      expect(response.body).toMatchObject({ error: "guest_error", requestId: REQUEST_ID });
      expect(await h.store.getExecRequest(SESSION_ID, REQUEST_ID)).toMatchObject({
        state: "error",
      });
      // A real outcome releases the gate: the single-operation slot is free.
      expect((await h.store.getSession(SESSION_ID))?.activeRequestId).toBeNull();
      expect(await h.store.claimOperation(SESSION_ID, "after-guest-error", "exec")).toMatchObject({
        ok: true,
      });
    } finally {
      await h.store.close();
    }
  });

  it("leaves a failure before the frame is accepted as abandoned", async () => {
    const h = await harness();
    try {
      h.failRequest("guest_not_connected");
      const response = await post(h);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ error: "guest_not_available" });
      expect(await h.store.getExecRequest(SESSION_ID, REQUEST_ID)).toMatchObject({
        state: "abandoned",
      });
      expect((await h.store.getSession(SESSION_ID))?.activeRequestId).toBeNull();
    } finally {
      await h.store.close();
    }
  });
});
