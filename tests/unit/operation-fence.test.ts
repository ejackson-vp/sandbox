import { describe, expect, it } from "vitest";
import { OperationFence } from "../../controller/src/operation-fence.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { SessionRecord, Store } from "../../controller/src/store.js";
import type { RelaySessionState } from "@x402s/shared";

interface Fenced {
  id: string;
  activeRequestId: string | null;
  execEpoch: number;
}

function harness(initial: Fenced[]) {
  const sessions = new Map(initial.map((session) => [session.id, { ...session }]));
  const states = new Map<string, RelaySessionState | Error>();
  const cleared: Array<{ sessionId: string; requestId: string; epoch: number }> = [];

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
  } as unknown as Store;

  const relay = {
    state: async (sessionId: string): Promise<RelaySessionState> => {
      const value = states.get(sessionId);
      if (value instanceof Error) throw value;
      return value ?? { registered: false, connected: false, pending: 0 };
    },
  } as unknown as RelayClient;

  return { fence: new OperationFence(store, relay), states, cleared, sessions };
}

describe("operation fence", () => {
  it("holds the gate while the guest still reports the fenced request active", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }]);
    h.states.set("sbx_1", {
      registered: true,
      connected: true,
      pending: 1,
      statusAt: Date.now(),
      activeRequestId: "req-old",
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
    h.states.set("sbx_1", { registered: true, connected: true, pending: 0 });

    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 1, errors: 0 });
    expect(h.cleared).toEqual([]);
  });

  it("fails closed when the relay cannot be reached", async () => {
    const h = harness([{ id: "sbx_1", activeRequestId: "req-old", execEpoch: 2 }]);
    h.states.set("sbx_1", new Error("relay unavailable"));

    expect(await h.fence.reconcile()).toEqual({ cleared: 0, held: 0, errors: 1 });
    expect(h.sessions.get("sbx_1")?.activeRequestId).toBe("req-old");
  });
});
