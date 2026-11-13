/**
 * Suspend is a guarded write before a goodbye.
 *
 * The module's ordering rule is load-bearing: persist SUSPENDING first, then
 * stop the guest. A refused write must therefore leave the guest running, and
 * the test asserts that the shutdown was never sent rather than only that the
 * error code was returned. `finishSuspend` and `reconcileSuspend` are the crash
 * repair paths, so both are driven from every state: completing is legal only
 * from SUSPENDING, a completed checkpoint is a no-op, and anything else is
 * refused without touching the checkpoint.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  baseShape,
  harness,
  record,
  refusal,
  shapeArb,
  stateArb,
  type SessionShape,
} from "../helpers/lifecycle-harness.js";

describe("suspend is a guarded write before a goodbye", () => {
  it("only suspends a live, suspendable session with a workspace, and never partially", async () => {
    await fc.assert(
      fc.asyncProperty(shapeArb, async (shape) => {
        const h = harness({ sessions: [record(shape)] });
        const before = await h.store.getSession("sbx_lifecycle");
        const expected = ["READY", "ACTIVE"].includes(shape.state) && shape.suspendable && shape.hasPvc;
        const err = await refusal(h.lifecycle.suspend("sbx_lifecycle"));
        const after = await h.store.getSession("sbx_lifecycle");

        if (!expected) {
          expect(err?.code).toBe("not_suspendable");
          expect(after!.state).toBe(before!.state);
          expect(h.shutdowns).toHaveLength(0);
          expect(h.podSuspends).toHaveLength(0);
          expect(h.capacityCalls.suspend).toHaveLength(0);
          return;
        }

        expect(err).toBeNull();
        expect(after!.state).toBe("SUSPENDED");
        expect(after!.podName).toBeNull();
        // The workspace is the checkpoint: it survives.
        expect(after!.workspacePvc).toBe("x402-ws-sbx_lifecycle");
        expect(h.captures).toEqual(["sbx_lifecycle"]);
        expect(h.capacityCalls.suspend).toEqual(["sbx_lifecycle"]);
        if (shape.hasPod) {
          expect(h.shutdowns.map((call) => call.reason)).toEqual(["suspend"]);
          expect(h.podSuspends).toEqual(["sbx-lifecycle"]);
        } else {
          expect(h.shutdowns).toHaveLength(0);
          expect(h.podSuspends).toHaveLength(0);
        }
        if (shape.hasRelay) expect(h.purges).toEqual(["sbx_lifecycle"]);
      }),
      { numRuns: 80 },
    );
  });

  it("stops before the goodbye when the guarded write refuses", async () => {
    const shape: SessionShape = {
      state: "READY",
      suspendable: true,
      hasPvc: true,
      hasPod: true,
      hasRelay: true,
      nodeName: "node-a",
      maxLifetimeSeconds: null,
      ageMs: 0,
      suspendedForMs: null,
      maxIdleSeconds: null,
      lastActivityAgoMs: 0,
      suspendedDurationSeconds: null,
    };
    const h = harness({ sessions: [record(shape)] });
    h.store.refuseSuspending = true;
    const err = await refusal(h.lifecycle.suspend("sbx_lifecycle"));
    expect(err?.code).toBe("not_suspendable");
    expect((await h.store.getSession("sbx_lifecycle"))!.state).toBe("READY");
    // Losing persist_suspending must not reach stop_guest.
    expect(h.shutdowns).toHaveLength(0);
    expect(h.podSuspends).toHaveLength(0);
    expect(h.capacityCalls.suspend).toHaveLength(0);
  });

  it("adopts the Pod's node when the checkpoint has none", async () => {
    const h = harness({
      sessions: [record({ ...baseShape(), state: "SUSPENDING", nodeName: null })],
      podNode: "node-x",
    });
    const session = (await h.store.getSession("sbx_lifecycle"))!;
    await h.lifecycle.finishSuspend(session);
    expect((await h.store.getSession("sbx_lifecycle"))!.nodeName).toBe("node-x");
    expect((await h.store.getSession("sbx_lifecycle"))!.state).toBe("SUSPENDED");
  });

  it("refuses when the SUSPENDED write is lost, and accepts a concurrent SUSPENDED", async () => {
    const lost = harness({ sessions: [record({ ...baseShape(), state: "SUSPENDING" })] });
    lost.store.markSuspended = async () => false;
    const err = await refusal(lost.lifecycle.finishSuspend((await lost.store.getSession("sbx_lifecycle"))!));
    expect(err?.code).toBe("not_suspendable");
    expect((await lost.store.getSession("sbx_lifecycle"))!.state).toBe("SUSPENDING");

    // A concurrent writer completed the checkpoint between the effect and the
    // re-read; the refused write is then the expected answer, not an error.
    const won = harness({ sessions: [record({ ...baseShape(), state: "SUSPENDING" })] });
    won.store.markSuspended = async (id: string) => {
      won.store.forceState(id, "SUSPENDED");
      return false;
    };
    expect(await refusal(won.lifecycle.finishSuspend((await won.store.getSession("sbx_lifecycle"))!))).toBeNull();
    expect((await won.store.getSession("sbx_lifecycle"))!.state).toBe("SUSPENDED");
  });

  it("finishSuspend completes SUSPENDING and is a no-op on SUSPENDED", async () => {
    await fc.assert(
      fc.asyncProperty(stateArb, async (state) => {
        const h = harness({ sessions: [record({ ...baseShape(), state })] });
        const session = (await h.store.getSession("sbx_lifecycle"))!;
        const err = await refusal(h.lifecycle.finishSuspend(session));
        if (state === "SUSPENDED") {
          expect(err).toBeNull();
          expect(h.captures).toHaveLength(0);
          expect(h.capacityCalls.suspend).toHaveLength(0);
        } else if (state === "SUSPENDING") {
          expect(err).toBeNull();
          expect((await h.store.getSession("sbx_lifecycle"))!.state).toBe("SUSPENDED");
        } else {
          expect(err?.code).toBe("not_suspendable");
          expect((await h.store.getSession("sbx_lifecycle"))!.state).toBe(state);
          expect(h.captures).toHaveLength(0);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("reconcileSuspend replays the stop only from SUSPENDING", async () => {
    await fc.assert(
      fc.asyncProperty(stateArb, fc.boolean(), async (state, hasPod) => {
        const h = harness({ sessions: [record({ ...baseShape(), state, hasPod })] });
        const session = (await h.store.getSession("sbx_lifecycle"))!;
        const err = await refusal(h.lifecycle.reconcileSuspend(session));
        if (state === "SUSPENDING") {
          expect(err).toBeNull();
          expect((await h.store.getSession("sbx_lifecycle"))!.state).toBe("SUSPENDED");
          if (hasPod) {
            expect(h.shutdowns.map((call) => call.reason)).toEqual(["suspend"]);
            expect(h.podSuspends).toEqual(["sbx-lifecycle"]);
          }
        } else if (state === "SUSPENDED") {
          // finishSuspend is idempotent: a completed checkpoint is not redone.
          expect(err).toBeNull();
          expect(h.shutdowns).toHaveLength(0);
        } else {
          expect(err?.code).toBe("not_suspendable");
          expect(h.shutdowns).toHaveLength(0);
          expect((await h.store.getSession("sbx_lifecycle"))!.state).toBe(state);
        }
      }),
      { numRuns: 60 },
    );
  });
});
