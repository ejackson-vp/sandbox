/**
 * Relay generation recovery.
 *
 * The relay registry is in memory, so a relay restart drops the registration and
 * every guest socket on that shard. These tests pin the controller's half of the
 * reconnect contract with a controllable relay surface:
 *
 *   - the first observation establishes a baseline and fences nothing (startup
 *     recovery already covered anything in flight before this process);
 *   - a generation change fences each session's interrupted operation exactly
 *     once, re-registers every READY/ACTIVE session, and asks the fence to hold
 *     until the guest reports idle;
 *   - a guest that does not come back inside the grace ends the session with
 *     `failure:relay_lost`, not `guest_exited`.
 */
import { describe, expect, it } from "vitest";
import { RelayRecovery } from "../../controller/src/relay-recovery.js";
import type { OperationFence } from "../../controller/src/operation-fence.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { RelayRecoveryStore } from "../../controller/src/store/ports.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import type { RelayStateSnapshot } from "@x402s/shared/protocol";

interface FakeSession {
  id: string;
  state: "READY" | "ACTIVE";
  relayTokenHash: string | null;
  activeRequestId: string | null;
  execEpoch: number;
  requestFenced: boolean;
  leaseExpiresAt: number;
}

function session(overrides: Partial<FakeSession> & Pick<FakeSession, "id">): FakeSession {
  return {
    state: "READY",
    relayTokenHash: "h".repeat(64),
    activeRequestId: null,
    execEpoch: 1,
    requestFenced: false,
    leaseExpiresAt: Date.now() + 300_000,
    ...overrides,
  };
}

function harness(
  sessions: FakeSession[],
  opts: { now?: number; limit?: number; graceMs?: number } = {},
) {
  const byId = new Map(sessions.map((entry) => [entry.id, entry]));
  const relay = {
    generation: "gen-a",
    registered: new Set(sessions.map((entry) => entry.id)),
    connected: new Set(sessions.map((entry) => entry.id)),
    /** Sessions whose state read throws, as a relay that is down would. */
    unreachable: new Set<string>(),
    registrations: [] as Array<{ sessionId: string; tokenHash: string; ttlMs: number }>,
    async state(sessionId: string): Promise<RelayStateSnapshot> {
      if (relay.unreachable.has(sessionId)) throw new Error("fetch failed");
      return {
        registered: relay.registered.has(sessionId),
        connected: relay.connected.has(sessionId) && relay.registered.has(sessionId),
        pending: 0,
        generation: relay.generation,
      };
    },
    async registerCurrent(
      sessionId: string,
      tokenHash: string,
      ttlMs: number,
    ): Promise<{ generation: string; attempts: number }> {
      relay.registrations.push({ sessionId, tokenHash, ttlMs });
      relay.registered.add(sessionId);
      return { generation: relay.generation, attempts: 1 };
    },
  };

  const fenceCalls: string[] = [];
  const fence = {
    requireGuestIdle(sessionId: string): void {
      fenceCalls.push(sessionId);
    },
  } as unknown as OperationFence;

  const terminated: Array<{ id: string; reason: string; code?: string }> = [];
  const recoveries: string[] = [];
  const store = {
    async listRelaySessions(limit: number, after: string | null = null): Promise<SessionRecord[]> {
      return [...byId.values()]
        .filter((entry) => after === null || entry.id > after)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((entry) => entry as unknown as SessionRecord);
    },
    async recoverSessionOperation(sessionId: string) {
      const entry = byId.get(sessionId)!;
      if (!entry.activeRequestId || entry.requestFenced) return { requestId: null, epoch: null };
      entry.requestFenced = true;
      entry.execEpoch += 1;
      recoveries.push(sessionId);
      return { requestId: entry.activeRequestId, epoch: entry.execEpoch };
    },
    async requestTermination(sessionId: string, reason: string, failure?: { code?: string }) {
      terminated.push({ id: sessionId, reason, code: failure?.code });
      return true;
    },
  } as unknown as RelayRecoveryStore;

  let now = opts.now ?? 1_000_000;
  const cfg = {
    relayLossGraceMs: opts.graceMs ?? 5_000,
    relayRegistrationTimeoutMs: 1_000,
    scanLimit: opts.limit,
  };
  const recovery = new RelayRecovery(
    cfg,
    store,
    relay as unknown as RelayClient,
    fence,
    () => now,
  );

  return {
    recovery,
    relay,
    store,
    fenceCalls,
    terminated,
    recoveries,
    sessions: byId,
    advance(ms: number) {
      now += ms;
    },
    nowValue() {
      return now;
    },
  };
}

describe("relay generation recovery", () => {
  it("records the first generation as a baseline and fences nothing", async () => {
    const h = harness([session({ id: "sbx_1", activeRequestId: "req-old" })]);
    const result = await h.recovery.reconcile();
    expect(result).toMatchObject({ scanned: 1, fenced: 0, reregistered: 0, lost: 0, errors: 0 });
    expect(h.recoveries).toEqual([]);
    expect(h.relay.registrations).toEqual([]);
    expect(h.fenceCalls).toEqual([]);
  });

  it("fences once and re-registers every READY/ACTIVE session after a generation change", async () => {
    const h = harness([
      session({ id: "sbx_ready", state: "READY", activeRequestId: "req-old" }),
      session({ id: "sbx_active", state: "ACTIVE" }),
    ]);
    // Baseline on the old relay.
    expect(await h.recovery.reconcile()).toMatchObject({ fenced: 0, reregistered: 0 });

    // The relay is replaced: its registry is empty and every guest is dropped.
    h.relay.generation = "gen-b";
    h.relay.registered.clear();
    h.relay.connected.clear();

    const changed = await h.recovery.reconcile();
    expect(changed).toMatchObject({ scanned: 2, fenced: 1, reregistered: 2, lost: 0, errors: 0 });
    // Exactly one fence, for the interrupted request only.
    expect(h.recoveries).toEqual(["sbx_ready"]);
    expect(h.sessions.get("sbx_ready")).toMatchObject({ execEpoch: 2, requestFenced: true });
    // The same token hash the create path minted, for both session states.
    expect(h.relay.registrations.map((entry) => entry.sessionId).sort()).toEqual([
      "sbx_active",
      "sbx_ready",
    ]);
    expect(h.relay.registrations.every((entry) => entry.tokenHash === "h".repeat(64))).toBe(true);
    expect(h.relay.registrations.every((entry) => entry.ttlMs > 300_000)).toBe(true);
    // The gate is held until the reconnected guest reports its slot idle.
    expect(h.fenceCalls).toEqual(["sbx_ready"]);

    // A second pass on the same generation does not fence or re-register again.
    h.relay.connected.add("sbx_ready");
    h.relay.connected.add("sbx_active");
    const steady = await h.recovery.reconcile();
    expect(steady).toMatchObject({ fenced: 0, reregistered: 0, lost: 0 });
    expect(h.recoveries).toEqual(["sbx_ready"]);
    expect(h.relay.registrations).toHaveLength(2);
  });

  it("re-registers a READY session whose registration disappeared on the same generation", async () => {
    const h = harness([session({ id: "sbx_1", activeRequestId: "req-old" })]);
    await h.recovery.reconcile();
    // The entry was purged (or expired) without a relay process change.
    h.relay.registered.delete("sbx_1");
    h.relay.connected.delete("sbx_1");

    expect(await h.recovery.reconcile()).toMatchObject({ fenced: 1, reregistered: 1 });
    expect(h.recoveries).toEqual(["sbx_1"]);
    expect(h.fenceCalls).toEqual(["sbx_1"]);
  });

  it("holds a fenced session that was already recovered by startup, without bumping twice", async () => {
    const h = harness([
      session({
        id: "sbx_1",
        activeRequestId: "req-old",
        execEpoch: 2,
        requestFenced: true,
      }),
    ]);
    h.relay.generation = "gen-b";
    h.relay.registered.clear();
    h.relay.connected.clear();

    expect(await h.recovery.reconcile()).toMatchObject({ fenced: 0, reregistered: 1 });
    // No second epoch bump, but the gate still waits for the reconnected guest.
    expect(h.sessions.get("sbx_1")?.execEpoch).toBe(2);
    expect(h.fenceCalls).toEqual(["sbx_1"]);
  });

  it("ends the session with relay_lost when the guest does not return inside the grace", async () => {
    const h = harness([session({ id: "sbx_1" })]);
    await h.recovery.reconcile();

    // The relay is gone: no snapshot, and the guest has nothing to dial.
    h.relay.unreachable.add("sbx_1");
    expect(await h.recovery.reconcile()).toMatchObject({ errors: 1, lost: 0 });
    h.advance(4_000);
    expect(await h.recovery.reconcile()).toMatchObject({ lost: 0 });

    h.advance(1_500);
    expect(await h.recovery.reconcile()).toMatchObject({ lost: 1 });
    expect(h.terminated).toEqual([
      { id: "sbx_1", reason: "failure:relay_lost", code: "relay_lost" },
    ]);
    // Asked once, not on every pass.
    await h.recovery.reconcile();
    expect(h.terminated).toHaveLength(1);
  });

  it("pages through more sessions than one pass may inspect", async () => {
    const h = harness(
      [
        session({ id: "sbx_a" }),
        session({ id: "sbx_b" }),
        session({ id: "sbx_c" }),
      ],
      { limit: 2 },
    );
    expect(await h.recovery.reconcile()).toMatchObject({ scanned: 2 });
    expect(await h.recovery.reconcile()).toMatchObject({ scanned: 1 });
    // The sweep wrapped: the next pass starts again from the first page.
    expect(await h.recovery.reconcile()).toMatchObject({ scanned: 2 });

    // A generation change is seen on both pages, so every session is fenced and
    // re-registered over the sweep rather than only the first page.
    h.relay.generation = "gen-b";
    h.relay.registered.clear();
    h.relay.connected.clear();
    await h.recovery.reconcile();
    await h.recovery.reconcile();
    expect(h.relay.registrations.map((entry) => entry.sessionId).sort()).toEqual([
      "sbx_a",
      "sbx_b",
      "sbx_c",
    ]);
  });

  it("declares relay_lost at the lease bound when the grace outlives the lease", async () => {
    const start = 1_000_000;
    const leaseExpiresAt = start + 5_000;
    const h = harness([session({ id: "sbx_short", leaseExpiresAt })], {
      now: start,
      graceMs: 60_000,
    });
    h.relay.unreachable.add("sbx_short");

    // The loss is noticed, but the guest still has time: no termination yet,
    // even though the grace alone would wait a full minute.
    expect(await h.recovery.reconcile()).toMatchObject({ lost: 0 });
    h.advance(3_900);
    expect(await h.recovery.reconcile()).toMatchObject({ lost: 0 });
    expect(h.terminated).toEqual([]);

    // One second before the lease, which is before enforceLease may request
    // `lease_expired` (leaseExpiresAt + leaseGraceMs).
    h.advance(100);
    expect(await h.recovery.reconcile()).toMatchObject({ lost: 1 });
    expect(h.terminated).toEqual([
      { id: "sbx_short", reason: "failure:relay_lost", code: "relay_lost" },
    ]);
    expect(h.nowValue()).toBeLessThan(leaseExpiresAt);
  });

  it("declares relay_lost on the pass that notices an already-expiring lease", async () => {
    const start = 1_000_000;
    const h = harness([session({ id: "sbx_tiny", leaseExpiresAt: start + 500 })], {
      now: start,
      graceMs: 60_000,
    });
    h.relay.unreachable.add("sbx_tiny");
    // The lease is inside the margin, so waiting for the grace would lose the
    // session to lease_expired first.
    expect(await h.recovery.reconcile()).toMatchObject({ lost: 1 });
    expect(h.terminated).toEqual([
      { id: "sbx_tiny", reason: "failure:relay_lost", code: "relay_lost" },
    ]);
  });

  it("does not run the grace while the guest stays connected", async () => {
    const h = harness([session({ id: "sbx_1" })]);
    await h.recovery.reconcile();
    h.advance(60_000);
    expect(await h.recovery.reconcile()).toMatchObject({ lost: 0, reregistered: 0 });
    expect(h.terminated).toEqual([]);
  });

  it("clears the grace when the guest reconnects before it expires", async () => {
    const h = harness([session({ id: "sbx_1" })]);
    await h.recovery.reconcile();
    h.relay.unreachable.add("sbx_1");
    await h.recovery.reconcile();
    h.advance(4_000);

    // The relay returns on a new generation and the guest reconnects.
    h.relay.unreachable.delete("sbx_1");
    h.relay.generation = "gen-b";
    h.relay.registered.clear();
    h.relay.connected.clear();
    await h.recovery.reconcile();
    h.relay.connected.add("sbx_1");
    h.advance(2_000);
    expect(await h.recovery.reconcile()).toMatchObject({ lost: 0 });
    h.advance(60_000);
    expect(await h.recovery.reconcile()).toMatchObject({ lost: 0 });
    expect(h.terminated).toEqual([]);
  });
});
