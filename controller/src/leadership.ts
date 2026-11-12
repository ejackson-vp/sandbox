/**
 * Who holds the single-writer role.
 *
 * The store has one writer, and the Postgres adapter enforces that with an
 * advisory lock (docs/adr/0010). A second controller replica is therefore only
 * safe if exactly one of them reconciles at a time, so the process asks this port
 * before it starts the loop and before it reports ready.
 *
 * This buys failover, not throughput: a follower's store connection refuses every
 * write (see `PostgresStore.setWritesBlocked`).
 */
import { log } from "@x402s/shared/runtime";

type LeadershipListener = (isLeader: boolean) => void;

export interface Leadership {
  /** Identity written into the Lease; also what the logs call this replica. */
  readonly identity: string;
  readonly mode: "solo" | "lease";
  /** Acquire (or, in solo mode, assert) the role. Resolves after one attempt. */
  start(): Promise<void>;
  /** Stop renewing, release the role, and notify listeners. */
  stop(): Promise<void>;
  isLeader(): boolean;
  /** Notified only on a transition. Returns an unsubscribe function. */
  onChange(listener: LeadershipListener): () => void;
}

/**
 * Shared listener bookkeeping.
 *
 * `leader` starts false in both implementations: nothing may write before
 * `start()` has decided. A listener that throws is logged rather than allowed
 * to abort the other listeners or the renewal loop.
 */
export abstract class BaseLeadership implements Leadership {
  abstract readonly identity: string;
  abstract readonly mode: "solo" | "lease";
  protected leader = false;
  private readonly listeners = new Set<LeadershipListener>();

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  isLeader(): boolean {
    return this.leader;
  }

  onChange(listener: LeadershipListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected setLeader(next: boolean): void {
    if (next === this.leader) return;
    this.leader = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (err) {
        log.error("leadership_listener_failed", {
          leader: next,
          error: (err as Error).message,
        });
      }
    }
  }
}

/**
 * Always leader. The behaviour of a controller before leader election existed,
 * and the only sensible mode when there is no API server to take a lease from.
 *
 * The role is asserted by `start()`, so `isLeader()` is false until then and
 * there is exactly one code path that enables writes.
 */
export class SoloLeadership extends BaseLeadership {
  readonly mode = "solo" as const;

  constructor(readonly identity: string) {
    super();
  }

  async start(): Promise<void> {
    this.setLeader(true);
  }

  async stop(): Promise<void> {
    this.setLeader(false);
  }
}

/**
 * The ordering that keeps a handover safe, in one place.
 *
 * Acquiring: writes are enabled (and startup recovery runs) before the loop
 * starts, so the first pass never sees a read-only store.
 *
 * Losing: the loop stops scheduling before the store refuses writes. A pass
 * still in flight then fails loudly on the guard instead of writing after
 * another replica may already own the lease.
 */
interface LeadershipHooks {
  /**
   * Enable writes and run anything else only a writer may do. Runs first.
   *
   * Returning a promise defers `start()` until it settles: startup recovery is
   * a store write, and a network store makes it asynchronous. A rejection
   * leaves the loop stopped and is logged, because a replica that could not
   * recover the previous writer's in-flight operations must not reconcile.
   */
  acquire(): void | Promise<void>;
  /** Start the reconcile loop. */
  start(): void;
  /** Stop scheduling reconcile work. */
  stop(): void;
  /** Refuse writes. Always runs after `stop()`. */
  release(): void;
}

export function bindLeadership(leadership: Leadership, hooks: LeadershipHooks): () => void {
  return leadership.onChange((isLeader) => {
    if (isLeader) {
      const acquiring = hooks.acquire();
      // Synchronous hooks keep the old ordering exactly. An async acquire (the
      // controller's recovery write) has to settle before the loop starts, or
      // a pass could reconcile rows the recovery was about to fence.
      if (acquiring instanceof Promise) {
        void (async () => {
          try {
            await acquiring;
            // The role can change while recovery runs. `setLeader(false)`
            // already stopped the loop (or it was never started), so starting it
            // now would reconcile without the lease.
            if (!leadership.isLeader()) return;
            hooks.start();
          } catch (err) {
            log.error("leadership_acquire_failed", { error: (err as Error).message });
          }
        })();
        return;
      }
      hooks.start();
      return;
    }
    hooks.stop();
    hooks.release();
  });
}
