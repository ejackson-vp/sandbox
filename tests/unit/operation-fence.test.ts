import { describe, expect, it } from "vitest";
import { OperationFence } from "../../controller/src/operation-fence.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type { RelaySessionState } from "@x402s/shared/protocol";

interface Fenced {
  id: string;
  activeRequestId: string | null;
  execEpoch: number;
}

function harness(initial: Fenced[], opts: { raiseEpochError?: Error; reset?: boolean } = {}) {
  const sessions = new Map(initial.map((session) => [session.id, { ...session }]));
  const states = new Map<string, RelaySessionState | Error>();
  const cleared: Array<{ sessionId: string; requestId: string; epoch: number }> = [];
  const raised: Array<{ sessionId: string; epoch: number }> = [];

  const store = {
    listFencedSessions: (): SessionRecord[] =>
      [...sessions.values()].map((session) => session as unknown as SessionRecord),
    clearFencedGate: (sessionId: string, requestId: string, epoch: number): boolean => {
      const session = sessions.get(sessionId);
      if (!session || session.activeRequestId !== requestId || session.execEpoch !== epoch) return false;
      session.activeRequestId = null;
      cleared.push({ sessionId, requestId, epoch });
      return true;
    },
  } as unknown as PostgresStore;

  const relay = {
    raiseEpoch: async (
      sessionId: string,
      epoch: number,
    ): Promise<{ result: "ok" | "unknown"; withdrawn: number; reset: boolean }> => {
      if (opts.raiseEpochError) throw opts.raiseEpochError;
      raised.push({ sessionId, epoch });
      return { result: "ok", withdrawn: 0, reset: opts.reset ?? false };
    },
    state: async (sessionId: string): Promise<RelaySessionState> => {
      const value = states.get(sessionId);
      if (value instanceof Error) throw value;
      return value ?? { registered: false, connected: false, pending: 0 };
    },
  } as unknown as RelayClient;

  return { fence: new OperationFence(store, relay), states, cleared, raised, sessions };
}

describe("operation fence", () => {
  it("publishes the recovery epoch to the relay before trusting its state", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }]);
    h.states.set("sbx_1", {
      registered: true,
      connected: true,
      pending: 0,
      statusAt: Date.now(),
      activeRequestId: "",
      epochFloor: 2,
    });

    expect(await h.fence.reconcile()).toEqual({ cleared: 1, held: 0, errors: 0 });
    expect(h.raised).toEqual([{ sessionId: "sbx_1", epoch: 2 }]);
  });

  it("holds the gate while the guest still reports the fenced request active", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }]);
    h.states.set("sbx_1", {
      registered: true,
      connected: true,
      pending: 1,
      statusAt: Date.now(),
      activeRequestId: "req-old",
      epochFloor: 2,
    });

    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 1, errors: 0 });
    expect(h.sessions.get("sbx_1")?.activeRequestId).toBe("req-old");
    expect(h.cleared).toEqual([]);
  });

  it("clears the gate once the guest reports its slot idle", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }]);
    h.states.set("sbx_1", {
      registered: true,
      connected: true,
      pending: 0,
      statusAt: Date.now(),
      activeRequestId: "",
      epochFloor: 2,
    });

    expect(await h.fence.reconcile()).toEqual({ cleared: 1, held: 0, errors: 0 });
    expect(h.cleared).toEqual([{ sessionId: "sbx_1", requestId: "req-old", epoch: 2 }]);
    expect(h.sessions.get("sbx_1")?.activeRequestId).toBeNull();
  });

  it("holds while the relay still has the fenced request outstanding", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }]);
    h.states.set("sbx_1", {
      registered: true,
      connected: true,
      pending: 1,
      statusAt: Date.now(),
      activeRequestId: "",
      epochFloor: 2,
    });

    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 1, errors: 0 });
    expect(h.cleared).toEqual([]);
  });

  it("holds when the relay has not taken the recovery epoch as its floor", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 3 }]);
    h.states.set("sbx_1", {
      registered: true,
      connected: true,
      pending: 0,
      statusAt: Date.now(),
      activeRequestId: "",
      epochFloor: 2,
    });

    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 1, errors: 0 });
    expect(h.cleared).toEqual([]);
  });

  it("clears the gate when no guest is connected, because the command cannot survive the link", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }]);
    h.states.set("sbx_1", { registered: true, connected: false, pending: 0 });

    expect(await h.fence.reconcile()).toEqual({ cleared: 1, held: 0, errors: 0 });
  });

  it("fails closed for a connected guest that has never reported status", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }]);
    h.states.set("sbx_1", { registered: true, connected: true, pending: 0, epochFloor: 2 });

    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 1, errors: 0 });
    expect(h.cleared).toEqual([]);
  });

  it("fails closed when the relay cannot be reached", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }]);
    h.states.set("sbx_1", new Error("relay unavailable"));

    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 0, errors: 1 });
    expect(h.sessions.get("sbx_1")?.activeRequestId).toBe("req-old");
  });

  it("fails closed when the epoch cannot be published", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }], {
      raiseEpochError: new Error("relay unavailable"),
    });
    // Even a state that would allow release must not be trusted: the relay was
    // never told to refuse the old generation.
    h.states.set("sbx_1", { registered: true, connected: false, pending: 0 });

    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 0, errors: 1 });
    expect(h.cleared).toEqual([]);
    expect(h.sessions.get("sbx_1")?.activeRequestId).toBe("req-old");
  });

  it("holds a relay-loss fence until the reconnected guest reports its slot idle", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }]);
    // Relay recovery fenced the operation and asked for an idle report. A
    // disconnected guest is no longer proof the command is gone: the same
    // supervisor reconnects to the replacement relay.
    h.fence.requireGuestIdle("sbx_1");
    h.states.set("sbx_1", { registered: false, connected: false, pending: 0 });
    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 1, errors: 0 });
    expect(h.sessions.get("sbx_1")?.activeRequestId).toBe("req-old");

    // Re-registered, guest not yet connected.
    h.states.set("sbx_1", { registered: true, connected: false, pending: 0, epochFloor: 2 });
    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 1, errors: 0 });

    // Connected, but the new link has not reported status yet.
    h.states.set("sbx_1", { registered: true, connected: true, pending: 0, epochFloor: 2 });
    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 1, errors: 0 });

    // The reconnected guest reports idle: only now may the gate release.
    h.states.set("sbx_1", {
      registered: true,
      connected: true,
      pending: 0,
      epochFloor: 2,
      statusAt: Date.now(),
      activeRequestId: "",
    });
    expect(await h.fence.reconcile()).toEqual({ cleared: 1, held: 0, errors: 0 });
    expect(h.cleared).toEqual([{ sessionId: "sbx_1", requestId: "req-old", epoch: 2 }]);

    // The hold was consumed: a later disconnect is the controller-restart shape
    // (the supervisor exited with its link), not a relay reconnect.
    h.states.set("sbx_1", { registered: true, connected: false, pending: 0 });
    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 0, errors: 0 });
  });

  it("drops a reconnect hold left behind for a session that is no longer fenced", async () => {
    const h = harness([]);
    h.fence.requireGuestIdle("sbx_gone");
    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 0, errors: 0 });
    // A later fence for the same id (a resumed pod reusing the session) is not
    // blocked by the stale marker.
    h.sessions.set("sbx_gone", { id: "sbx_gone", activeRequestId: "req-new", execEpoch: 3 });
    h.states.set("sbx_gone", { registered: true, connected: false, pending: 0 });
    expect(await h.fence.reconcile()).toEqual({ cleared: 1, held: 0, errors: 0 });
  });

  it("clears the gate after a reset so the session lifecycle can take over", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }], { reset: true });
    // The relay withdrew the frame and reset the guest link; no guest remains,
    // so the gate must clear. The reconciler then fails the dead Pod.
    h.states.set("sbx_1", { registered: true, connected: false, pending: 0 });

    expect(await h.fence.reconcile()).toEqual({ cleared: 1, held: 0, errors: 0 });
    expect(h.sessions.get("sbx_1")?.activeRequestId).toBeNull();
  });
});
