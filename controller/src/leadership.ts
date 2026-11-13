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
 * A refusal is retried a bounded number of times, then the lease is released:
 * renewing a lease this replica cannot back with the writer lock keeps every
 * other candidate out.
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

export interface AcquireRetryOptions {
  /** Attempts including the first one. */
  attempts?: number;
  /** First backoff, doubled on each retry. */
  initialDelayMs?: number;
  /** Ceiling for a single backoff. */
  maxDelayMs?: number;
}

/**
 * Six attempts, 200ms doubling to 2s: about five seconds in total.
 *
 * Long enough to cover the common refusal, a previous writer's advisory lock on
 * a session that is still closing. Shorter than one lease duration (10s), so a
 * lease that cannot be backed by the lock is handed back before another replica
 * would have been entitled to force-acquire it anyway.
 */
const ACQUIRE_ATTEMPTS = 6;
const ACQUIRE_INITIAL_DELAY_MS = 200;
const ACQUIRE_MAX_DELAY_MS = 2_000;

type AcquireOutcome = { ok: true } | { ok: false; error: unknown };

async function attemptAcquire(hooks: LeadershipHooks): Promise<AcquireOutcome> {
  try {
    await hooks.acquire();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function backoff(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // A pending retry must not be the reason the process stays alive.
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Settle the acquire hook, retrying a refusal a bounded number of times.
 *
 * A refusal is usually the previous writer's advisory lock, still held by a
 * session that is closing, and it clears on its own. Waiting forever is the
 * wrong answer: this replica keeps renewing a lease it cannot use, so no other
 * candidate can take over. After the last attempt the lease is released, which
 * lets the replica that actually holds the lock win it instead.
 *
 * Never throws: the caller is an event listener, and a rejected task there would
 * only surface as an unhandled rejection.
 */
async function acquireWithRetry(
  leadership: Leadership,
  hooks: LeadershipHooks,
  options: Required<AcquireRetryOptions>,
  first: AcquireOutcome,
): Promise<void> {
  let outcome = first;
  try {
    for (let attempt = 1; ; attempt += 1) {
      if (!leadership.isLeader()) {
        // The role moved while this was running. `setLeader(false)` already
        // stopped the loop (or it was never started), so starting it now would
        // reconcile without the lease.
        return;
      }
      if (outcome.ok) {
        hooks.start();
        return;
      }
      if (attempt >= options.attempts) {
        log.error("leadership_acquire_failed", {
          attempts: attempt,
          error: (outcome.error as Error).message,
          action: "releasing_lease",
        });
        await leadership.stop();
        return;
      }
      const delayMs = Math.min(
        options.initialDelayMs * 2 ** (attempt - 1),
        options.maxDelayMs,
      );
      log.warn("leadership_acquire_retry", {
        attempt,
        delayMs,
        error: (outcome.error as Error).message,
      });
      await backoff(delayMs);
      // Do not enable writes on a replica that lost the role while waiting.
      if (!leadership.isLeader()) return;
      outcome = await attemptAcquire(hooks);
    }
  } catch (error) {
    log.error("leadership_acquire_failed", { error: (error as Error).message });
  }
}

export function bindLeadership(
  leadership: Leadership,
  hooks: LeadershipHooks,
  retry: AcquireRetryOptions = {},
): () => void {
  const options: Required<AcquireRetryOptions> = {
    attempts: Math.max(1, retry.attempts ?? ACQUIRE_ATTEMPTS),
    initialDelayMs: Math.max(0, retry.initialDelayMs ?? ACQUIRE_INITIAL_DELAY_MS),
    maxDelayMs: Math.max(0, retry.maxDelayMs ?? ACQUIRE_MAX_DELAY_MS),
  };
  return leadership.onChange((isLeader) => {
    if (isLeader) {
      let first: void | Promise<void>;
      try {
        first = hooks.acquire();
      } catch (error) {
        // A synchronous refusal is retried exactly like an asynchronous one.
        void acquireWithRetry(leadership, hooks, options, { ok: false, error });
        return;
      }
      // Synchronous hooks keep the old ordering exactly. An async acquire (the
      // controller's recovery write) has to settle before the loop starts, or
      // a pass could reconcile rows the recovery was about to fence.
      if (first instanceof Promise) {
        void first.then(
          () => acquireWithRetry(leadership, hooks, options, { ok: true }),
          (error) => acquireWithRetry(leadership, hooks, options, { ok: false, error }),
        );
        return;
      }
      hooks.start();
      return;
    }
    hooks.stop();
    hooks.release();
  });
}
