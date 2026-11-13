/**
 * A real control API for the session-route fuzz and lifecycle tests.
 *
 * The router is the production `createControlApi`, so the auth middleware,
 * body parser, rate limiter and error backstop are the ones a deployment runs,
 * and the store is the real Postgres adapter. The relay is a stub keyed on the
 * request id, because the point of those tests is the route's answer for each
 * outcome the relay can report (envelope, pending, a guest error, a link loss, a
 * refused frame), not the relay itself.
 *
 * `suspend` and `resume` are three-line stand-ins for `Lifecycle.suspend` and
 * `Lifecycle.resume`: they ask the real `transition()` table and then make the
 * same guarded write the real use case makes first. The route owns the mapping
 * from the refusal to a status, which is what the tests pin; the policy behind
 * the refusal is `tests/property/session-state.test.ts`.
 *
 * Two extra apps ride along. One has no lifecycle wiring (the 501 shape for a
 * role that cannot checkpoint) and one has a lifecycle that throws (the named
 * 500, not an unhandled rejection). The database namespace is this harness's
 * own, so a leftover run cannot collide with the payments fuzz file.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import { transition, SESSION_STATES, type SessionState } from "@x402s/shared/protocol";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import { LifecycleError } from "../../controller/src/lifecycle.js";
import { snapshotOf } from "../../controller/src/session-snapshot.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { limitsFor, paymentFixture, sessionFixture } from "./store-fixtures.js";
import { freshStore, sqlExec, sqlRows, testDatabaseUrl } from "./test-store.js";

export const ADMIN = "fuzz-sessions-admin-token-0123456789";
export const NS = "fuzz-sessions";

/** Every state a row can be seeded in, one session each. */
export const SEEDED_STATES = SESSION_STATES;

export const SESSION_ID = (index: number): string =>
  `sbx_${index.toString(16).padStart(24, "0")}`;

export function stateId(state: SessionState): string {
  return SESSION_ID(SEEDED_STATES.indexOf(state) + 1);
}

/**
 * Sessions the long tests own. The state table is mutated by the test that
 * walks it, so a test that needs a stable row gets its own instead of
 * depending on where it sits in the file.
 */
export const OWNERSHIP_ID = SESSION_ID(101);
export const RELAY_ID = SESSION_ID(102);
export const RETRY_ID = SESSION_ID(103);
export const LEASE_ID = SESSION_ID(104);
export const LOSS_ID = SESSION_ID(105);
export const LOSS_LATE_ID = SESSION_ID(106);
export const GUEST_LATE_ID = SESSION_ID(107);
export const SUPERSEDED_ID = SESSION_ID(108);
export const GATE_WAIT_ID = SESSION_ID(109);

/** The row columns a route must never write, read raw so no mapping hides it. */
export interface GuardedRow {
  state: string;
  payment_key: string;
  lease_expires_at: number | string | null;
  capability_hash: string;
  duration_seconds: number | string;
  active_request_id: string | null;
  exec_epoch: number | string;
  pod_name: string | null;
  relay_token_hash: string | null;
  destroyed_at: number | string | null;
  destroy_requested: number | string;
}

const GUARDED = [
  "state",
  "payment_key",
  "lease_expires_at",
  "capability_hash",
  "duration_seconds",
  "active_request_id",
  "exec_epoch",
  "pod_name",
  "relay_token_hash",
  "destroyed_at",
  "destroy_requested",
].join(", ");

export interface Answer {
  status: number;
  json: boolean;
  body: Record<string, unknown> | undefined;
}

export interface SessionHarness {
  store: PostgresStore;
  /** The wired app: operations, suspend, resume, destroy. */
  base: string;
  /** No lifecycle wiring: suspend and resume answer 501. */
  unwiredBase: string;
  /** A lifecycle that throws: the route names the failure. */
  failingBase: string;
  call(path: string, init?: CallOptions): Promise<Answer>;
  guardedRow(id: string): Promise<GuardedRow>;
  close(): Promise<void>;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  origin?: string;
}

/**
 * Every outcome the relay can report, selected by the request id the caller
 * sends. A prefix is not a production convention: it keeps each property run
 * stateless, so one test's answer cannot leak into the next.
 */
const responseCounts = new Map<string, number>();

const relay = {
  async request(_sessionId: string, requestId: string): Promise<void> {
    if (requestId.startsWith("stale-")) {
      throw Object.assign(new Error("stale_epoch"), { status: 409 });
    }
    if (requestId.startsWith("down-")) throw new Error("relay unreachable");
  },
  async response(_sessionId: string, requestId: string) {
    const count = (responseCounts.get(requestId) ?? 0) + 1;
    responseCounts.set(requestId, count);
    if (requestId.startsWith("rerr-")) throw new Error("relay response failed");
    // The first answer is pending, every later one is a lost link: the retry
    // path that learns the outcome is unknown instead of seeing a 202 again.
    if (requestId.startsWith("flip-")) {
      return count === 1
        ? { kind: "pending" as const }
        : { kind: "guest_error" as const, code: "guest_disconnected", message: "link lost" };
    }
    // The same shape for a retry that arrives while the first attempt completed:
    // the stored envelope is the answer and the row's state is reconciled.
    if (requestId.startsWith("flip2-")) {
      return count === 1
        ? { kind: "pending" as const }
        : { kind: "envelope" as const, envelope: "e30=" };
    }
    // First answer completes, later ones are pending: the row keeps the
    // ciphertext, which is what a lookup past the relay's retention answers from.
    if (requestId.startsWith("flip3-")) {
      return count === 1
        ? { kind: "envelope" as const, envelope: "e30=" }
        : { kind: "pending" as const };
    }
    // First answer is pending, later ones carry the envelope: a lookup that
    // catches the result after the owning POST gave up waiting.
    if (requestId.startsWith("flip4-")) {
      return count === 1
        ? { kind: "pending" as const }
        : { kind: "envelope" as const, envelope: "e30=" };
    }
    if (requestId.startsWith("flip5-")) return { kind: "pending" as const };
    // A lookup that was waiting when the link died, and one that gets a real
    // guest failure while the row is still pending.
    if (requestId.startsWith("losslate-")) {
      return count === 1
        ? { kind: "pending" as const }
        : { kind: "guest_error" as const, code: "guest_disconnected", message: "link lost" };
    }
    if (requestId.startsWith("gerrlate-")) {
      return count === 1
        ? { kind: "pending" as const }
        : { kind: "guest_error" as const, code: "bad_request", message: "guest refused" };
    }
    if (requestId.startsWith("pending-")) return { kind: "pending" as const };
    if (requestId.startsWith("loss-")) {
      return { kind: "guest_error" as const, code: "guest_disconnected", message: "link lost" };
    }
    if (requestId.startsWith("superseded-")) {
      // The other link loss class: the frame was accepted and superseded, so the
      // outcome is just as unknown as a disconnect.
      return { kind: "guest_error" as const, code: "request_superseded", message: "superseded" };
    }
    if (requestId.startsWith("gerr-")) {
      return { kind: "guest_error" as const, code: "bad_request", message: "guest refused" };
    }
    return { kind: "envelope" as const, envelope: "e30=" };
  },
  async cancel(_sessionId: string, requestId: string): Promise<void> {
    // A cancel is best effort: a relay that cannot answer must not turn the
    // delete into an error, because the row is already recorded.
    if (requestId.startsWith("cancelerr-")) throw new Error("relay cancel failed");
  },
  async health() {
    return { ok: true, generation: "fuzz-generation" };
  },
} as unknown as RelayClient;

const capacity = {} as CapacityService;

const cfg = loadControllerConfig({
  ADMIN_TOKEN: ADMIN,
  ROLE: "controller",
  KUBERNETES_ENABLED: "false",
  RELAY_ADMIN_TOKEN: "r".repeat(24),
  WAKE_TOKEN: "w".repeat(24),
  PROXY_TOKEN_SECRET: "p".repeat(24),
  DATABASE_URL: testDatabaseUrl(NS),
});

/**
 * One paid session per state, plus the reserved rows. The idle policy and the
 * workspace make READY/ACTIVE suspendable, and the pod/relay fields are what the
 * transition table's invariants check.
 */
async function seed(store: PostgresStore): Promise<void> {
  const rows: Array<{ id: string; key: string; state: SessionState }> = [
    ...SEEDED_STATES.map((state, index) => ({
      id: SESSION_ID(index + 1),
      key: index.toString(16).padStart(64, "0"),
      state,
    })),
    { id: OWNERSHIP_ID, key: "a1".repeat(32), state: "READY" },
    { id: RELAY_ID, key: "a2".repeat(32), state: "READY" },
    { id: RETRY_ID, key: "a3".repeat(32), state: "ACTIVE" },
    { id: LEASE_ID, key: "a4".repeat(32), state: "READY" },
    { id: LOSS_ID, key: "a5".repeat(32), state: "READY" },
    { id: LOSS_LATE_ID, key: "a6".repeat(32), state: "READY" },
    { id: GUEST_LATE_ID, key: "a7".repeat(32), state: "READY" },
    { id: SUPERSEDED_ID, key: "a8".repeat(32), state: "READY" },
    { id: GATE_WAIT_ID, key: "a9".repeat(32), state: "READY" },
  ];

  for (const { id, key, state } of rows) {
    const claim = await store.claimPaymentIntent(key, "b".repeat(64), 30_000);
    if (claim.status !== "claimed") throw new Error(`seed claim ${state}: ${claim.status}`);
    await store.completeEntitlement(
      key,
      claim.token,
      paymentFixture({ paymentKey: key, network: "eip155:84532" }),
      sessionFixture({
        id,
        paymentKey: key,
        tier: "standard",
        durationSeconds: 300,
        limits: limitsFor("unit"),
        clientPublicKey: `pk-${id}`,
        clientNonce: `nonce-${id}`,
      }),
    );
    await sqlExec(
      `UPDATE sessions
          SET state = $1, idle_policy_json = $2, workspace_pvc = $3, pod_name = $4,
              relay_token_hash = $5, ready_at = $6
        WHERE id = $7`,
      [
        state,
        JSON.stringify({ maxIdleSeconds: 600, suspendedDurationSeconds: 600, autoResume: false }),
        "pvc-fuzz",
        "pod-fuzz",
        "relay-fuzz",
        state === "CREATED" ? null : Date.now(),
        id,
      ],
      NS,
    );
  }
}

/** The table's verdict, then the same guarded write the real use case makes. */
async function suspend(store: PostgresStore, id: string): Promise<void> {
  const session = await store.getSession(id);
  // A lifecycle with no row to act on is a no-op; the route's own read is what
  // answers 404. That is the shape a fire-and-forget suspender has.
  if (!session) return;
  if (!transition(snapshotOf(session), { type: "suspend_requested" }).ok) {
    throw new LifecycleError("not_suspendable", `session is ${session.state}`, 409);
  }
  if (!(await store.markSuspending(id))) {
    throw new LifecycleError("not_suspendable", "session changed state while suspending", 409);
  }
}

async function resume(store: PostgresStore, id: string): Promise<void> {
  const session = await store.getSession(id);
  if (!session) return;
  if (!transition(snapshotOf(session), { type: "resume_requested" }).ok) {
    throw new LifecycleError("not_resumable", `session is ${session.state}`, 409);
  }
  if (!(await store.markResuming(id, "pod-fuzz"))) {
    throw new LifecycleError("not_resumable", "session changed state while resuming", 409);
  }
}

export async function startSessionControlApi(): Promise<SessionHarness> {
  const store = await freshStore({ namespace: NS });
  await seed(store);

  const servers: Server[] = [];
  const listen = async (app: Express): Promise<string> => {
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  const base = await listen(
    createControlApi({
      cfg,
      store,
      relay,
      capacity,
      suspend: (id) => suspend(store, id),
      resume: (id) => resume(store, id),
    }),
  );
  const unwiredBase = await listen(createControlApi({ cfg, store, relay, capacity }));
  const failingBase = await listen(
    createControlApi({
      cfg,
      store,
      relay,
      capacity,
      suspend: async () => {
        throw new Error("checkpoint storage is unavailable");
      },
      resume: async () => {
        throw new Error("checkpoint storage is unavailable");
      },
    }),
  );

  async function call(
    path: string,
    init: CallOptions = {},
  ): Promise<Answer> {
    const method = init.method ?? "POST";
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = init.token === undefined ? ADMIN : init.token;
    if (token !== null) headers["x-internal-token"] = token;
    // `fetch` refuses a body on GET/HEAD, and the property varies the body for
    // every verb: the request, not the caller, decides whether it can travel.
    const sendBody = init.body !== undefined && method !== "GET" && method !== "HEAD";
    const res = await fetch(`${init.origin ?? base}${path}`, {
      method,
      headers,
      ...(sendBody ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return {
      status: res.status,
      json: (res.headers.get("content-type") ?? "").includes("application/json"),
      body: parsed as Record<string, unknown> | undefined,
    };
  }

  async function guardedRow(id: string): Promise<GuardedRow> {
    const rows = await sqlRows<GuardedRow>(
      `SELECT ${GUARDED} FROM sessions WHERE id = $1`,
      [id],
      NS,
    );
    if (!rows[0]) throw new Error(`session ${id} disappeared`);
    return rows[0];
  }

  async function close(): Promise<void> {
    await Promise.all(
      servers.splice(0).map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  }

  return { store, base, unwiredBase, failingBase, call, guardedRow, close };
}
