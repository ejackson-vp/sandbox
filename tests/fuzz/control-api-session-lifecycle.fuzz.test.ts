/**
 * The session lifecycle routes against the real transition table.
 *
 * `control-api-sessions.fuzz.test.ts` covers the command surface; this file
 * covers the lifecycle half. Every persisted state is a row the store actually
 * holds, and the expectation for each call is read from the row and from
 * `transition()` immediately before it, so the route and the table are compared
 * rather than a hand-written list of statuses. A transition the table forbids
 * must be a 409 and must leave the row byte-identical; a permitted one must
 * move it. That is the difference between "the API answered" and "the API
 * wrote something the lifecycle does not allow".
 *
 * The three apps from the harness are the role shapes: wired (a lifecycle), no
 * lifecycle wiring (501 for a role that cannot checkpoint), and a lifecycle that
 * throws (a named 500 rather than an escaping rejection). The harness explains
 * why the suspend/resume stand-ins are three lines rather than a cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transition } from "@x402s/shared/protocol";
import { snapshotOf } from "../../controller/src/session-snapshot.js";
import {
  LEASE_ID,
  NS,
  SEEDED_STATES,
  startSessionControlApi,
  stateId,
  type SessionHarness,
} from "../helpers/session-control-api.js";
import { sqlExec } from "../helpers/test-store.js";

let h: SessionHarness;

beforeAll(async () => {
  h = await startSessionControlApi();
});

afterAll(async () => {
  await h?.close();
});

const sessionPath = (id: string, suffix = ""): string =>
  `/internal/sessions/${encodeURIComponent(id)}${suffix}`;

let requestCounter = 0;
function requestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${requestCounter.toString(36).padStart(8, "0")}`;
}

function operationBody(id: string): Record<string, unknown> {
  return { requestId: id, envelope: "AAAA", op: "exec" };
}

describe("control API session lifecycle", () => {
  it("maps each lifecycle state to the table's verdict and never writes a forbidden transition", async () => {
    // One pass per state, and each call's expectation is read from the row
    // immediately before it, so a success in an earlier call cannot make a
    // later expectation stale.
    for (const state of SEEDED_STATES) {
      const id = stateId(state);

      const operationRow = await h.store.getSession(id);
      if (!operationRow) throw new Error(`no row for ${state}`);
      const operationsAllowed = transition(snapshotOf(operationRow), {
        type: "operation_started",
      }).ok;
      const beforeOperation = await h.guardedRow(id);
      const operation = await h.call(sessionPath(id, "/operations"), {
        body: operationBody(requestId("act")),
      });
      if (operationsAllowed) {
        expect(operation.status, `${state} operations`).toBe(200);
      } else {
        expect(operation.status, `${state} operations`).toBe(409);
        expect(operation.body).toMatchObject({ error: "session_not_usable", state });
        // A refusal is not a write: the row has to be byte-identical.
        expect(await h.guardedRow(id), `${state} operations wrote`).toEqual(beforeOperation);
      }

      const suspendRow = await h.store.getSession(id);
      if (!suspendRow) throw new Error(`no row for ${state} before suspend`);
      const suspendAllowed = transition(snapshotOf(suspendRow), {
        type: "suspend_requested",
      }).ok;
      const beforeSuspend = await h.guardedRow(id);
      const suspended = await h.call(sessionPath(id, "/suspend"), { body: {} });
      if (suspendAllowed) {
        expect(suspended.status, `${state} suspend`).toBe(200);
        expect(suspended.body).toMatchObject({ sessionId: id, state: "SUSPENDING" });
      } else {
        expect(suspended.status, `${state} suspend`).toBe(409);
        expect(suspended.body).toMatchObject({ error: "not_suspendable" });
        expect(await h.guardedRow(id), `${state} suspend wrote`).toEqual(beforeSuspend);
      }

      const resumeRow = await h.store.getSession(id);
      if (!resumeRow) throw new Error(`no row for ${state} before resume`);
      const resumeAllowed = transition(snapshotOf(resumeRow), {
        type: "resume_requested",
      }).ok;
      const beforeResume = await h.guardedRow(id);
      const resumed = await h.call(sessionPath(id, "/resume"), { body: {} });
      if (resumeAllowed) {
        expect(resumed.status, `${state} resume`).toBe(202);
        expect(resumed.body).toMatchObject({ sessionId: id, state: "RESUMING" });
      } else {
        expect(resumed.status, `${state} resume`).toBe(409);
        expect(resumed.body).toMatchObject({ error: "not_resumable" });
        expect(await h.guardedRow(id), `${state} resume wrote`).toEqual(beforeResume);
      }
    }
  });

  it("ends a session whose lease already ran out instead of forwarding", async () => {
    const id = LEASE_ID;
    // A lease that has already passed. The route owns the expiry decision, not
    // the caller.
    await sqlExec(
      "UPDATE sessions SET state = 'READY', lease_expires_at = $1 WHERE id = $2",
      [Date.now() - 1_000, id],
      NS,
    );

    const res = await h.call(sessionPath(id, "/operations"), {
      body: operationBody(requestId("act")),
    });
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ error: "lease_expired", state: "TERMINATING" });
    const row = await h.guardedRow(id);
    expect(row.state).toBe("TERMINATING");
  });

  it("answers the session view and the destroy request for a known id", async () => {
    const id = stateId("PAID");
    const read = await h.call(sessionPath(id), { method: "GET" });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ sessionId: id, state: "PAID" });
    // The payment is folded in, so the API does not need a second round trip.
    expect(read.body?.payment).toMatchObject({ network: "eip155:84532" });

    const destroy = await h.call(sessionPath(id), { method: "DELETE" });
    expect(destroy.status).toBe(200);
    expect(Number((await h.guardedRow(id)).destroy_requested)).toBe(1);
  });

  it("answers 501 when the role has no lifecycle wiring", async () => {
    const id = stateId("SUSPENDING");
    const suspended = await h.call(sessionPath(id, "/suspend"), {
      body: { state: "SUSPENDED" },
      origin: h.unwiredBase,
    });
    expect(suspended.status).toBe(501);
    expect(suspended.body).toMatchObject({ error: "not_supported" });
    const resumed = await h.call(sessionPath(id, "/resume"), {
      body: { state: "READY" },
      origin: h.unwiredBase,
    });
    expect(resumed.status).toBe(501);
    expect(resumed.body).toMatchObject({ error: "not_supported" });
  });

  it("names a lifecycle crash instead of letting it escape the handler", async () => {
    const id = stateId("TERMINATING");
    const suspended = await h.call(sessionPath(id, "/suspend"), {
      body: {},
      origin: h.failingBase,
    });
    expect(suspended.status).toBe(500);
    expect(suspended.body).toMatchObject({ error: "suspend_failed" });
    const resumed = await h.call(sessionPath(id, "/resume"), {
      body: {},
      origin: h.failingBase,
    });
    expect(resumed.status).toBe(500);
    expect(resumed.body).toMatchObject({ error: "resume_failed" });
  });
});
