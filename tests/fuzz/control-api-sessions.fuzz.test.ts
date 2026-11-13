/**
 * Property tests against the real control API session routes.
 *
 * These routes are the controller's command surface: the API forwards customer
 * requests here, and an operator drives suspend/resume/delete from a runbook.
 * The contract is narrow and must hold for any input. Nothing is served without
 * the admin token. No parsed body, path segment or query value reaches a 5xx.
 * An id the store has never seen is a 404, not a throw. And a caller can only
 * ask for the operation it named: the body cannot set a lease deadline, a
 * payment key, or a state.
 *
 * The router is the real `createControlApi` over the real Postgres adapter, so
 * the auth middleware, body parser, rate limiter and error backstop are the
 * production ones; `tests/helpers/session-control-api.ts` explains the relay and
 * lifecycle stand-ins. The lifecycle table itself, and the app with no lifecycle
 * wiring, are in tests/fuzz/control-api-session-lifecycle.fuzz.test.ts.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fuzzSeed } from "./seeds.js";
import {
  ADMIN,
  LOSS_ID,
  OWNERSHIP_ID,
  RELAY_ID,
  RETRY_ID,
  GUEST_LATE_ID,
  SEEDED_STATES,
  SUPERSEDED_ID,
  GATE_WAIT_ID,
  LOSS_LATE_ID,
  startSessionControlApi,
  stateId,
  type SessionHarness,
} from "../helpers/session-control-api.js";

let h: SessionHarness;

beforeAll(async () => {
  h = await startSessionControlApi();
});

afterAll(async () => {
  await h?.close();
});

/** Path-safe random identifier: a segment cannot be `.` or `..`, which fetch normalises. */
const segment = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter((value) => value !== "." && value !== "..");

/**
 * JSON the parser actually hands to a route. `express.json({strict: true})`
 * refuses a top-level primitive before any handler runs, so only arrays and
 * objects can reach the code under test.
 */
const parsedJson = fc.oneof(
  fc.array(fc.jsonValue(), { maxLength: 5 }),
  fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue(), { maxKeys: 5 }),
);

const sessionPath = (id: string, suffix = ""): string =>
  `/internal/sessions/${encodeURIComponent(id)}${suffix}`;

/** A body that passes `operationSchema`, so a test varies only the id. */
function operationBody(requestId: string): Record<string, unknown> {
  return { requestId, envelope: "AAAA", op: "exec" };
}

/**
 * Request ids have to be inside the schema's alphabet, unique per property run,
 * and long enough. The relay stub reads the prefix, so the counter is after it.
 */
let requestCounter = 0;
function requestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${requestCounter.toString(36).padStart(8, "0")}`;
}

describe("control API session routes", () => {
  it("serves nothing without the admin token", async () => {
    const paths = [
      sessionPath(stateId("READY")),
      sessionPath(stateId("READY"), "/suspend"),
      sessionPath(stateId("READY"), "/resume"),
      sessionPath(stateId("READY"), "/operations"),
      sessionPath(stateId("READY"), "/operations/act-00000000"),
      sessionPath("sbx_unknown"),
    ];

    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[\x20-\x7e]{0,64}$/), async (token) => {
        fc.pre(token !== ADMIN);
        for (const path of paths) {
          const res = await h.call(path, { body: {}, token });
          expect(res.status).toBe(401);
          expect(res.body).toMatchObject({ error: "unauthorized" });
        }
      }),
      { numRuns: 20, ...fuzzSeed },
    );

    // No credential at all, on a GET and a DELETE as well as the writes.
    for (const path of paths) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const res = await h.call(path, { method, body: {}, token: null });
        expect(res.status).toBe(401);
      }
    }
  });

  it("answers arbitrary JSON on every write route with a 4xx, never a 5xx", async () => {
    const prepared = stateId("PAID");
    const ready = stateId("READY");
    const unknown = "sbx_unknown";
    await fc.assert(
      fc.asyncProperty(parsedJson, fc.string({ maxLength: 16 }), async (body, waitMs) => {
        const answers = await Promise.all([
          // A PAID session is outside the operation table, so the route answers
          // a controlled refusal without forwarding anything.
          h.call(sessionPath(prepared, "/operations"), { body }),
          h.call(sessionPath(prepared, "/suspend"), { body }),
          // Resume needs a SUSPENDED row: a READY one is a named 409.
          h.call(sessionPath(ready, "/resume"), { body }),
          h.call(sessionPath(unknown, "/operations"), { body }),
          h.call(sessionPath(unknown, "/operations/nope-0000000"), { method: "GET", body }),
          h.call(sessionPath(unknown, "/operations/nope-0000000"), { method: "DELETE", body }),
          h.call(sessionPath(unknown), { method: "GET", body }),
          h.call(
            `${sessionPath(unknown, "/operations/act-00000000")}?waitMs=${encodeURIComponent(waitMs)}`,
            { method: "GET" },
          ),
        ]);
        for (const res of answers) {
          expect(res.status).toBeGreaterThanOrEqual(200);
          expect(res.status).toBeLessThan(500);
          expect(res.json).toBe(true);
        }
      }),
      { numRuns: 40, ...fuzzSeed },
    );
  });

  it("answers a session id it has never seen with a controlled 404", async () => {
    const known = new Set(SEEDED_STATES.map((state) => stateId(state)));
    await fc.assert(
      fc.asyncProperty(segment, async (id) => {
        fc.pre(!known.has(id) && !id.startsWith("sbx_unknown"));
        const read = await h.call(sessionPath(id), { method: "GET" });
        expect(read.status).toBe(404);
        expect(read.body).toMatchObject({ error: "not_found" });

        const operation = await h.call(sessionPath(id, "/operations"), {
          body: operationBody(requestId("act")),
        });
        expect(operation.status).toBe(404);
        expect(operation.body).toMatchObject({ error: "not_found" });

        const destroy = await h.call(sessionPath(id), { method: "DELETE" });
        expect(destroy.status).toBe(404);

        const suspendUnknown = await h.call(sessionPath(id, "/suspend"), { body: {} });
        expect(suspendUnknown.status).toBe(404);
        const resumeUnknown = await h.call(sessionPath(id, "/resume"), { body: {} });
        expect(resumeUnknown.status).toBe(404);
      }),
      { numRuns: 40, ...fuzzSeed },
    );
  });

  it("ignores every field the operations route does not own", async () => {
    const id = OWNERSHIP_ID;
    const before = await h.guardedRow(id);

    // The route accepts requestId, envelope, payloadHash, op and waitMs. These
    // are the fields a caller would reach for to move the row directly.
    const unowned = fc.dictionary(
      fc.constantFrom(
        "state",
        "leaseExpiresAt",
        "readyAt",
        "paymentKey",
        "capabilityHash",
        "durationSeconds",
        "sessionId",
        "destroyRequested",
        "activeRequestId",
        "execEpoch",
        "podName",
        "relayTokenHash",
        "terminatingAt",
      ),
      fc.jsonValue(),
      { maxKeys: 6 },
    );

    await fc.assert(
      fc.asyncProperty(unowned, async (extras) => {
        const rid = requestId("act");
        const res = await h.call(sessionPath(id, "/operations"), {
          body: { ...operationBody(rid), ...extras },
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ requestId: rid, envelope: "e30=" });
        // The answer is the route's own shape: nothing the caller sent is echoed
        // back as if it were stored.
        expect(Object.keys(res.body ?? {}).sort()).toEqual(["envelope", "requestId", "state"]);

        const after = await h.guardedRow(id);
        expect(after).toEqual(before);
      }),
      { numRuns: 40, ...fuzzSeed },
    );
  });

  it("answers each relay outcome with its documented status", async () => {
    const id = RELAY_ID;

    // Envelope: the result travels back and the gate is released.
    const done = await h.call(sessionPath(id, "/operations"), {
      body: operationBody(requestId("act")),
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ envelope: "e30=" });

    // Pending: accepted, not finished, and the single-operation gate is held.
    const pendingId = requestId("pending");
    const pending = await h.call(sessionPath(id, "/operations"), {
      body: operationBody(pendingId),
    });
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ requestId: pendingId, pending: true });

    // The same request while it is still in flight is the same operation: a
    // 202, not a second run and not a reused-key error.
    const pendingAgain = await h.call(sessionPath(id, "/operations"), {
      body: operationBody(pendingId),
    });
    expect(pendingAgain.status).toBe(202);
    expect(pendingAgain.body).toMatchObject({ requestId: pendingId, pending: true });

    // A second operation while the first is in flight is busy, not a second run.
    const busy = await h.call(sessionPath(id, "/operations"), {
      body: operationBody(requestId("act")),
    });
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ error: "busy", requestId: pendingId });
    await h.store.finishOperation(id, pendingId, "abandoned");

    // Link loss: the outcome is unknown and the gate stays closed, so this runs
    // on its own session. Nothing releases that gate except the fence or relay
    // recovery, which a route test cannot do.
    const lossId = requestId("loss");
    const loss = await h.call(sessionPath(LOSS_ID, "/operations"), {
      body: operationBody(lossId),
    });
    expect(loss.status).toBe(409);
    expect(loss.body).toMatchObject({ error: "outcome_unknown", requestId: lossId });
    const lossAgain = await h.call(sessionPath(LOSS_ID, "/operations"), {
      body: operationBody(lossId),
    });
    expect(lossAgain.status).toBe(409);
    expect(lossAgain.body).toMatchObject({ error: "outcome_unknown" });

    // The guest ran it and refused: a real outcome, a 502, and the gate opens.
    const gerrId = requestId("gerr");
    const guestError = await h.call(sessionPath(id, "/operations"), {
      body: operationBody(gerrId),
    });
    expect(guestError.status).toBe(502);
    expect(guestError.body).toMatchObject({ error: "guest_error", requestId: gerrId });
    const expired = await h.call(sessionPath(id, `/operations/${gerrId}`), { method: "GET" });
    expect(expired.status).toBe(410);
    expect(expired.body).toMatchObject({ error: "result_expired" });

    // A refused frame is a generation conflict, not a guest failure.
    const stale = await h.call(sessionPath(id, "/operations"), {
      body: operationBody(requestId("stale")),
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "stale_epoch" });

    // Any other delivery failure is the guest not being reachable.
    const down = await h.call(sessionPath(id, "/operations"), {
      body: operationBody(requestId("down")),
    });
    expect(down.status).toBe(409);
    expect(down.body).toMatchObject({ error: "guest_not_available" });

    // A response that throws after delivery leaves the operation pending.
    const rerrId = requestId("rerr");
    const rerr = await h.call(sessionPath(id, "/operations"), {
      body: operationBody(rerrId),
    });
    expect(rerr.status).toBe(202);
    expect(rerr.body).toMatchObject({ requestId: rerrId, pending: true });
    await h.store.finishOperation(id, rerrId, "abandoned");

    // A retry that was pending when the link died learns the same answer. This
    // fences the gate, so it goes last on this session.
    const flipId = requestId("flip");
    const flipping = await h.call(sessionPath(id, "/operations"), {
      body: operationBody(flipId),
    });
    expect(flipping.status).toBe(202);
    const flipped = await h.call(sessionPath(id, "/operations"), {
      body: operationBody(flipId),
    });
    expect(flipped.status).toBe(409);
    expect(flipped.body).toMatchObject({ error: "outcome_unknown", requestId: flipId });
  });

  it("reconciles a retry that arrived while the link or the guest was moving", async () => {
    // A pending retry whose first attempt has now completed: the stored
    // envelope is the answer, and the row's state is brought forward with it.
    const flipId = requestId("flip2");
    const first = await h.call(sessionPath(RETRY_ID, "/operations"), {
      body: operationBody(flipId),
    });
    expect(first.status).toBe(202);
    const reconciled = await h.call(sessionPath(RETRY_ID, "/operations"), {
      body: operationBody(flipId),
    });
    expect(reconciled.status).toBe(200);
    expect(reconciled.body).toMatchObject({ requestId: flipId, envelope: "e30=" });
    expect((await h.store.getExecRequest(RETRY_ID, flipId))?.state).toBe("done");

    // A lookup that was waiting when the link died must answer outcome_unknown.
    const lateId = requestId("losslate");
    expect(
      (await h.call(sessionPath(LOSS_LATE_ID, "/operations"), { body: operationBody(lateId) }))
        .status,
    ).toBe(202);
    const lateLoss = await h.call(sessionPath(LOSS_LATE_ID, `/operations/${lateId}`), {
      method: "GET",
    });
    expect(lateLoss.status).toBe(409);
    expect(lateLoss.body).toMatchObject({ error: "outcome_unknown", requestId: lateId });
    expect((await h.store.getExecRequest(LOSS_LATE_ID, lateId))?.state).toBe("outcome_unknown");

    // A lookup that gets the guest's real failure while pending records it.
    const guestId = requestId("gerrlate");
    expect(
      (await h.call(sessionPath(GUEST_LATE_ID, "/operations"), { body: operationBody(guestId) }))
        .status,
    ).toBe(202);
    const lateGuest = await h.call(sessionPath(GUEST_LATE_ID, `/operations/${guestId}`), {
      method: "GET",
    });
    expect(lateGuest.status).toBe(502);
    expect(lateGuest.body).toMatchObject({ error: "guest_error", requestId: guestId });
    expect((await h.store.getExecRequest(GUEST_LATE_ID, guestId))?.state).toBe("error");

    // The superseded class is a link loss too, so the outcome is unknown.
    const superseded = await h.call(sessionPath(SUPERSEDED_ID, "/operations"), {
      body: operationBody(requestId("superseded")),
    });
    expect(superseded.status).toBe(409);
    expect(superseded.body).toMatchObject({ error: "outcome_unknown" });

    // A cancel the relay cannot confirm is still a recorded delete: the route
    // answers 202 and leaves the row to the reconciler.
    const cancelId = requestId("cancelerr");
    const cancelTarget = await h.call(sessionPath(RETRY_ID, "/operations"), {
      body: operationBody(cancelId),
    });
    expect(cancelTarget.status).toBe(200);
    const cancelled = await h.call(sessionPath(RETRY_ID, `/operations/${cancelId}`), {
      method: "DELETE",
    });
    expect(cancelled.status).toBe(202);
    expect(cancelled.body).toMatchObject({ ok: true, requestId: cancelId });

    // A retry whose owner already recorded the result, and a lookup after the
    // relay evicted it: both answer from the row's ciphertext.
    const storedId = requestId("flip3");
    expect(
      (await h.call(sessionPath(RETRY_ID, "/operations"), { body: operationBody(storedId) })).status,
    ).toBe(200);
    const storedReplay = await h.call(sessionPath(RETRY_ID, "/operations"), {
      body: operationBody(storedId),
    });
    expect(storedReplay.status).toBe(200);
    expect(storedReplay.body).toMatchObject({ requestId: storedId, envelope: "e30=" });
    const storedRead = await h.call(sessionPath(RETRY_ID, `/operations/${storedId}`), {
      method: "GET",
    });
    expect(storedRead.status).toBe(200);
    expect(storedRead.body).toMatchObject({ requestId: storedId, envelope: "e30=" });

    // A lookup that catches the envelope after the POST stopped waiting records
    // the completion on the row.
    const lateDoneId = requestId("flip4");
    expect(
      (await h.call(sessionPath(RETRY_ID, "/operations"), { body: operationBody(lateDoneId) }))
        .status,
    ).toBe(202);
    const lateDone = await h.call(sessionPath(RETRY_ID, `/operations/${lateDoneId}`), {
      method: "GET",
    });
    expect(lateDone.status).toBe(200);
    expect(lateDone.body).toMatchObject({ requestId: lateDoneId, envelope: "e30=" });
    expect((await h.store.getExecRequest(RETRY_ID, lateDoneId))?.state).toBe("done");

    // A lookup that is still waiting answers 202 rather than pretending the
    // operation failed.
    const waitingId = requestId("flip5");
    expect(
      (await h.call(sessionPath(GATE_WAIT_ID, "/operations"), { body: operationBody(waitingId) }))
        .status,
    ).toBe(202);
    const waiting = await h.call(sessionPath(GATE_WAIT_ID, `/operations/${waitingId}`), {
      method: "GET",
    });
    expect(waiting.status).toBe(202);
    expect(waiting.body).toMatchObject({ requestId: waitingId, pending: true });
  });

  it("treats a retry as the same operation, never as a second one", async () => {
    const id = RETRY_ID;
    const rid = requestId("act");
    const body = operationBody(rid);

    const first = await h.call(sessionPath(id, "/operations"), { body });
    expect(first.status).toBe(200);
    const stored = await h.store.getExecRequest(id, rid);
    expect(stored?.state).toBe("done");

    // Same id and same payload: the stored envelope is the answer.
    const replay = await h.call(sessionPath(id, "/operations"), { body });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ requestId: rid, envelope: "e30=" });

    // Same id and a different payload: the cached result belongs to another
    // operation, so neither running it nor returning that result is correct.
    const reused = await h.call(sessionPath(id, "/operations"), {
      body: { ...body, payloadHash: "a".repeat(64) },
    });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ error: "idempotency_key_reused", requestId: rid });

    const read = await h.call(sessionPath(id, `/operations/${rid}`), { method: "GET" });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ requestId: rid, envelope: "e30=" });

    const cancel = await h.call(sessionPath(id, `/operations/${rid}`), { method: "DELETE" });
    expect(cancel.status).toBe(202);
    expect(cancel.body).toMatchObject({ ok: true, requestId: rid });

    const unknown = await h.call(sessionPath(id, "/operations/nope-0000000"), { method: "GET" });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: "request_not_found" });
    const unknownCancel = await h.call(sessionPath(id, "/operations/nope-0000000"), {
      method: "DELETE",
    });
    expect(unknownCancel.status).toBe(404);
  });
});
