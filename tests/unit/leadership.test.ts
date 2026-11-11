/**
 * Leader election without a cluster.
 *
 * The fake client keeps one Lease and enforces the same compare-and-swap the
 * API server does: a replace built on a stale `resourceVersion` fails with 409.
 * That is the property the safety argument rests on, so the tests exercise it
 * rather than mocking "you won".
 */
import { describe, expect, it } from "vitest";
import {
  bindLeadership,
  SoloLeadership,
  type Leadership,
} from "../../controller/src/leadership.js";
import {
  LeaseLeadership,
  microTime,
  type LeaseClient,
  type LeaseRecord,
  type LeaseSnapshot,
} from "../../controller/src/leadership-lease.js";

const NAMESPACE = "sandbox-system";
const NAME = "controller-leader";

function conflict(): Error {
  return Object.assign(new Error("the object has been modified"), { code: 409 });
}

class FakeLeaseClient implements LeaseClient {
  private snapshot: LeaseSnapshot | null = null;
  private version = 0;
  /** When set, every API call fails the way an unreachable server does. */
  down: Error | null = null;
  reads = 0;
  creates = 0;
  replaces = 0;

  async read(): Promise<LeaseSnapshot | null> {
    this.failIfDown();
    this.reads += 1;
    return this.snapshot ? clone(this.snapshot) : null;
  }

  async create(
    _name: string,
    _namespace: string,
    record: LeaseRecord,
  ): Promise<LeaseSnapshot> {
    this.failIfDown();
    if (this.snapshot) throw conflict();
    this.creates += 1;
    return this.store(record);
  }

  async replace(
    _name: string,
    _namespace: string,
    record: LeaseRecord,
    resourceVersion: string,
  ): Promise<LeaseSnapshot> {
    this.failIfDown();
    if (!this.snapshot) throw Object.assign(new Error("not found"), { code: 404 });
    if (this.snapshot.resourceVersion !== resourceVersion) throw conflict();
    this.replaces += 1;
    return this.store(record);
  }

  /** Seed a lease held by someone else, as a leader that already exists would. */
  seed(record: LeaseRecord): void {
    this.store(record);
  }

  get holder(): string | null {
    return this.snapshot?.record.holderIdentity ?? null;
  }

  get record(): LeaseRecord {
    if (!this.snapshot) throw new Error("no lease");
    return this.snapshot.record;
  }

  private store(record: LeaseRecord): LeaseSnapshot {
    this.version += 1;
    this.snapshot = { record: { ...record }, resourceVersion: String(this.version) };
    return clone(this.snapshot);
  }

  private failIfDown(): void {
    if (this.down) throw this.down;
  }
}

function clone(snapshot: LeaseSnapshot): LeaseSnapshot {
  return { record: { ...snapshot.record }, resourceVersion: snapshot.resourceVersion };
}

interface TestClock {
  now: () => number;
  mono: () => number;
  /** Advance both clocks: the normal case. */
  advance: (ms: number) => void;
  /** Advance only the wall clock, as an NTP step would. */
  advanceWallOnly: (ms: number) => void;
}

function clock(start = 1_000_000): TestClock {
  let wall = start;
  let mono = 5_000;
  return {
    now: () => wall,
    mono: () => mono,
    advance: (ms) => {
      wall += ms;
      mono += ms;
    },
    advanceWallOnly: (ms) => {
      wall += ms;
    },
  };
}

function makeLease(client: LeaseClient, time: TestClock, identity: string): LeaseLeadership {
  return new LeaseLeadership({
    client,
    namespace: NAMESPACE,
    name: NAME,
    identity,
    renewIntervalMs: 2_000,
    leaseDurationMs: 10_000,
    callTimeoutMs: 500,
    now: time.now,
    monotonic: time.mono,
  });
}

function seedHolder(holder: string, acquireTimeMs = 0): LeaseRecord {
  return {
    holderIdentity: holder,
    leaseDurationSeconds: 10,
    acquireTime: microTime(acquireTimeMs),
    renewTime: microTime(acquireTimeMs),
    leaseTransitions: 1,
  };
}

describe("solo leadership", () => {
  it("asserts the role on start and reports the transition once", async () => {
    const solo = new SoloLeadership("local");
    const seen: boolean[] = [];
    solo.onChange((isLeader) => seen.push(isLeader));
    expect(solo.isLeader()).toBe(false);

    await solo.start();
    expect(solo.isLeader()).toBe(true);
    expect(seen).toEqual([true]);

    await solo.stop();
    expect(solo.isLeader()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("notifies only on a transition", async () => {
    const solo = new SoloLeadership("local");
    const seen: boolean[] = [];
    solo.onChange((isLeader) => seen.push(isLeader));
    await solo.start();
    await solo.stop();
    await solo.stop();
    expect(seen).toEqual([true, false]);
  });
});

describe("lease leadership", () => {
  it("creates an absent lease and becomes the holder", async () => {
    const client = new FakeLeaseClient();
    const time = clock();
    const lease = makeLease(client, time, "controller-0");
    const seen: boolean[] = [];
    lease.onChange((isLeader) => seen.push(isLeader));

    await lease.start();

    expect(lease.isLeader()).toBe(true);
    expect(seen).toEqual([true]);
    expect(client.holder).toBe("controller-0");
    expect(client.creates).toBe(1);
    expect(client.record.leaseTransitions).toBe(0);
    // MicroTime: exactly six fractional digits, or the API server answers 400.
    expect(client.record.renewTime).toBe(microTime(time.now()));
    expect(client.record.renewTime).toMatch(/\.\d{6}Z$/);
    await lease.stop();
  });

  it("renews the lease it holds without churning the role", async () => {
    const client = new FakeLeaseClient();
    const time = clock();
    const lease = makeLease(client, time, "controller-0");
    const seen: boolean[] = [];
    lease.onChange((isLeader) => seen.push(isLeader));
    await lease.start();
    const renewals = client.replaces;

    time.advance(2_000);
    await lease.tick();

    expect(client.replaces).toBe(renewals + 1);
    expect(client.record.renewTime).toBe(microTime(time.now()));
    expect(client.record.leaseTransitions).toBe(0);
    expect(lease.isLeader()).toBe(true);
    expect(seen).toEqual([true]);
    await lease.stop();
  });

  it("steps down when the lease expires and re-acquires once the API is back", async () => {
    const client = new FakeLeaseClient();
    const time = clock();
    const lease = makeLease(client, time, "controller-0");
    const seen: boolean[] = [];
    lease.onChange((isLeader) => seen.push(isLeader));
    await lease.start();

    client.down = new Error("connect ECONNREFUSED 10.96.0.1:443");
    // Still inside the 10s window: a failed renewal is tolerated.
    time.advance(9_000);
    await lease.tick();
    expect(lease.isLeader()).toBe(true);

    // Past the deadline nobody may keep writing, API or no API.
    time.advance(1_000);
    await lease.tick();
    expect(lease.isLeader()).toBe(false);
    expect(seen).toEqual([true, false]);

    client.down = null;
    time.advance(2_000);
    await lease.tick();
    expect(lease.isLeader()).toBe(true);
    expect(seen).toEqual([true, false, true]);
    await lease.stop();
  });

  it("ignores a wall-clock jump when deciding its own deadline", async () => {
    const client = new FakeLeaseClient();
    const time = clock();
    const lease = makeLease(client, time, "controller-0");
    await lease.start();
    client.down = new Error("connect ECONNREFUSED 10.96.0.1:443");

    // A forward NTP step must not make the process think its lease expired
    // early: the deadline is measured on the monotonic clock.
    time.advanceWallOnly(600_000);
    await lease.tick();
    expect(lease.isLeader()).toBe(true);

    // A real 10s of elapsed time still ends the lease.
    time.advance(10_000);
    await lease.tick();
    expect(lease.isLeader()).toBe(false);
  });

  it("keeps a standby out for as long as the holder renews", async () => {
    const client = new FakeLeaseClient();
    const time = clock();
    const leader = makeLease(client, time, "controller-a");
    const standby = makeLease(client, time, "controller-b");
    await leader.start();
    await standby.start();
    expect(standby.isLeader()).toBe(false);

    // Both replicas poll for a minute while the holder keeps renewing.
    for (let step = 0; step < 30; step += 1) {
      time.advance(2_000);
      await leader.tick();
      await standby.tick();
      expect(standby.isLeader()).toBe(false);
    }

    expect(client.holder).toBe("controller-a");
    await leader.stop();
    await standby.stop();
  });

  it("takes over a lease whose renewal has stalled for a full duration", async () => {
    const client = new FakeLeaseClient();
    const time = clock();
    const leader = makeLease(client, time, "controller-a");
    const standby = makeLease(client, time, "controller-b");
    const seen: boolean[] = [];
    standby.onChange((isLeader) => seen.push(isLeader));
    await leader.start();
    await standby.start();
    expect(client.record.leaseTransitions).toBe(0);

    // The leader dies: nothing renews the lease from here. The standby waits one
    // full duration from its first sighting of the stalled record.
    time.advance(9_000);
    await standby.tick();
    expect(standby.isLeader()).toBe(false);

    time.advance(1_000);
    await standby.tick();
    expect(standby.isLeader()).toBe(true);
    expect(seen).toEqual([true]);
    expect(client.holder).toBe("controller-b");
    expect(client.record.leaseTransitions).toBe(1);
    await standby.stop();
  });

  it("takes a released lease immediately, without waiting out the duration", async () => {
    const client = new FakeLeaseClient();
    const time = clock();
    const leader = makeLease(client, time, "controller-a");
    const standby = makeLease(client, time, "controller-b");
    await leader.start();
    await standby.start();
    expect(standby.isLeader()).toBe(false);

    await leader.stop();
    expect(client.holder).toBe("");
    expect(leader.isLeader()).toBe(false);

    await standby.tick();
    expect(standby.isLeader()).toBe(true);
    expect(client.holder).toBe("controller-b");
    await standby.stop();
  });

  it("steps down when another replica has replaced it", async () => {
    const client = new FakeLeaseClient();
    const time = clock();
    const lease = makeLease(client, time, "controller-a");
    const seen: boolean[] = [];
    lease.onChange((isLeader) => seen.push(isLeader));
    await lease.start();

    // A takeover happened elsewhere (only reachable after our lease expired).
    client.seed(seedHolder("controller-b", time.now()));
    await lease.tick();

    expect(lease.isLeader()).toBe(false);
    expect(seen).toEqual([true, false]);
    await lease.stop();
  });

  it("stays a follower while another replica holds a fresh lease", async () => {
    const client = new FakeLeaseClient();
    const time = clock();
    client.seed(seedHolder("controller-a", time.now()));
    const lease = makeLease(client, time, "controller-b");

    const acquired: string[] = [];
    bindLeadership(lease, {
      acquire: () => {
        acquired.push("acquire");
      },
      start: () => acquired.push("start"),
      stop: () => acquired.push("stop"),
      release: () => acquired.push("release"),
    });

    await lease.start();
    expect(lease.isLeader()).toBe(false);
    expect(acquired).toEqual([]);
    expect(client.creates).toBe(0);

    await lease.stop();
    expect(acquired).toEqual([]);
  });
});

describe("leadership hooks", () => {
  it("enables writes before starting the loop", async () => {
    const order: string[] = [];
    let writesAllowed = false;
    const leadership: Leadership = new SoloLeadership("local");
    bindLeadership(leadership, {
      acquire: () => {
        writesAllowed = true;
        order.push("acquire");
      },
      start: () => {
        expect(writesAllowed).toBe(true);
        order.push("start");
      },
      stop: () => order.push("stop"),
      release: () => {
        writesAllowed = false;
        order.push("release");
      },
    });

    await leadership.start();
    expect(order).toEqual(["acquire", "start"]);

    await leadership.stop();
    expect(order).toEqual(["acquire", "start", "stop", "release"]);
    expect(writesAllowed).toBe(false);
  });

  it("starts the loop only after an asynchronous acquire settles", async () => {
    const order: string[] = [];
    let release!: () => void;
    const recovering = new Promise<void>((resolve) => {
      release = resolve;
    });
    const leadership: Leadership = new SoloLeadership("local");
    bindLeadership(leadership, {
      acquire: async () => {
        order.push("acquire:start");
        await recovering;
        order.push("acquire:done");
      },
      start: () => order.push("start"),
      stop: () => order.push("stop"),
      release: () => order.push("release"),
    });

    await leadership.start();
    // Recovery is a store write now, so the loop waits for it: a pass must not
    // see rows the recovery is about to fence.
    expect(order).toEqual(["acquire:start"]);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["acquire:start", "acquire:done", "start"]);
  });

  it("does not start the loop when the role is lost during an asynchronous acquire", async () => {
    const order: string[] = [];
    let release!: () => void;
    const recovering = new Promise<void>((resolve) => {
      release = resolve;
    });
    const leadership: Leadership = new SoloLeadership("local");
    bindLeadership(leadership, {
      acquire: () => recovering,
      start: () => order.push("start"),
      stop: () => order.push("stop"),
      release: () => order.push("release"),
    });

    await leadership.start();
    await leadership.stop();
    expect(order).toEqual(["stop", "release"]);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["stop", "release"]);
  });
});
