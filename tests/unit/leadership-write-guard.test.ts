/**
 * The store a stand-down leaves behind.
 *
 * `hooks.acquire()` cannot be cancelled. `setWritesBlocked(false)` is a pool
 * connect plus an advisory-lock round trip, and it can resolve after the Lease
 * is gone. Left to the caller, that is a writable store with no role behind it,
 * so `bindLeadership` has to close it again itself.
 *
 * The fake guard keeps the Postgres adapter's ordering: the in-process guard
 * closes synchronously in `releaseWriterLock` and the advisory unlock is the
 * asynchronous part. Nothing here touches Postgres.
 */
import { describe, expect, it } from "vitest";
import { bindLeadership, SoloLeadership } from "../../controller/src/leadership.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every already-queued microtask run. */
async function flush(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met in time");
}

class FakeGuard {
  private open = false;
  /** The advisory lock, held by whichever session took it. */
  private sessionLock = false;
  /** Holds a `setWritesBlocked(false)` before it may take the lock. */
  acquireGate: Promise<void> | null = null;
  /** Holds the unlock round trip after the guard has already closed. */
  unlockGate: Promise<void> | null = null;

  get writesAreBlocked(): boolean {
    return !this.open;
  }

  async setWritesBlocked(blocked: boolean): Promise<void> {
    if (blocked === !this.open) return;
    if (blocked) {
      // `PgConnection.releaseWriterLock`: the guard closes before the round trip.
      this.open = false;
      if (this.unlockGate) await this.unlockGate;
      this.sessionLock = false;
      return;
    }
    if (this.acquireGate) await this.acquireGate;
    if (this.sessionLock) {
      throw new Error("another process holds the store writer lock");
    }
    this.sessionLock = true;
    this.open = true;
  }

  write(): void {
    if (!this.open) {
      throw new Error("refusing write: does not hold the store writer lock");
    }
  }
}

describe("write guard across a stand-down", () => {
  it("closes the guard again when an acquire resolves after the role was lost", async () => {
    const guard = new FakeGuard();
    const gate = deferred();
    guard.acquireGate = gate.promise;
    const order: string[] = [];
    const leadership = new SoloLeadership("local");

    bindLeadership(leadership, {
      acquire: () => guard.setWritesBlocked(false),
      start: () => order.push("start"),
      stop: () => order.push("stop"),
      release: () => {
        order.push("release");
        void guard.setWritesBlocked(true);
      },
    });

    await leadership.start();
    // Mid round trip: nothing is enabled yet, and the loop is waiting on it.
    expect(guard.writesAreBlocked).toBe(true);

    await leadership.stop();
    expect(order).toEqual(["stop", "release"]);
    expect(guard.writesAreBlocked).toBe(true);

    // The round trip finishes after the Lease is gone. This is the write the
    // hook cannot cancel and the caller used to have to compensate for.
    gate.resolve();
    await flush();

    // Closed again, in the safe order, and the loop never started.
    expect(order).toEqual(["stop", "release", "stop", "release"]);
    expect(order).not.toContain("start");
    expect(guard.writesAreBlocked).toBe(true);
    expect(() => guard.write()).toThrow(/does not hold the store writer lock/);
  });

  it("closes the guard again when a timed-out acquire resolves after the stand-down", async () => {
    const guard = new FakeGuard();
    const gate = deferred();
    guard.acquireGate = gate.promise;
    const order: string[] = [];
    const failures: string[] = [];
    const leadership = new SoloLeadership("local");

    bindLeadership(
      leadership,
      {
        acquire: () => guard.setWritesBlocked(false),
        start: () => order.push("start"),
        stop: () => order.push("stop"),
        release: () => {
          order.push("release");
          void guard.setWritesBlocked(true);
        },
        exhausted: (failure) => {
          failures.push(failure);
        },
      },
      {
        attempts: 1,
        unavailableAttempts: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        callTimeoutMs: 10,
      },
    );

    await leadership.start();
    // The deadline wins while the hook is still in its round trip, so the
    // budget is spent and the Lease is handed back with the hook still running.
    await waitFor(() => failures.length > 0);
    expect(leadership.isLeader()).toBe(false);
    expect(guard.writesAreBlocked).toBe(true);

    gate.resolve();
    await flush();

    expect(order).not.toContain("start");
    expect(guard.writesAreBlocked).toBe(true);
    expect(() => guard.write()).toThrow(/does not hold the store writer lock/);
  });

  it("leaves a regained role alone rather than closing its guard", async () => {
    const guard = new FakeGuard();
    const gate = deferred();
    guard.acquireGate = gate.promise;
    const order: string[] = [];
    const leadership = new SoloLeadership("local");

    bindLeadership(leadership, {
      acquire: () => guard.setWritesBlocked(false),
      start: () => order.push("start"),
      stop: () => order.push("stop"),
      release: () => {
        order.push("release");
        void guard.setWritesBlocked(true);
      },
    });

    await leadership.start();
    await leadership.stop();
    // The role comes back before the first acquire finishes. Its write is now
    // ordered by a generation this replica holds, so the repair must not fire
    // and close the guard under a legitimate leader.
    await leadership.start();
    gate.resolve();
    await flush();

    expect(order).toEqual(["stop", "release", "start"]);
    expect(leadership.isLeader()).toBe(true);
    expect(guard.writesAreBlocked).toBe(false);
    expect(() => guard.write()).not.toThrow();
  });
});
