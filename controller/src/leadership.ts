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
import { CALL_TIMEOUT_MS, withDeadline } from "./with-deadline.js";

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

/** Why an acquire attempt failed, which decides the retry policy. */
export type AcquireFailure = "lock_refused" | "store_unavailable";

/**
 * The ordering that keeps a handover safe, in one place.
 *
 * Acquiring: writes are enabled (and startup recovery runs) before the loop
 * starts, so the first pass never sees a read-only store.
 *
 * A refusal is retried on the policy for its class. A lock refusal is handed
 * back quickly so a rival can use the role; a store failure is held and retried
 * for longer, because nobody can write meanwhile and a handover buys nothing.
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
  /**
   * Called after the Lease has been released because acquire could not settle.
   *
   * The default exits the process. `main.ts` calls `start()` only at boot, so a
   * replica that stays up after giving the role back is a terminal standby:
   * alive, not ready, and liveness (the event loop) will never restart it.
   * Exiting turns that into a fresh pod, which is bounded churn. Tests pass a
   * spy so the runner survives.
   */
  exhausted?(failure: AcquireFailure): void | Promise<void>;
}

export interface AcquireRetryOptions {
  /** Lock-refused budget: a rival holds the writer lock. */
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Store-unavailable budget: connect failures, timeouts, pool exhaustion. */
  unavailableAttempts?: number;
  unavailableInitialDelayMs?: number;
  unavailableMaxDelayMs?: number;
  /** Ceiling for one acquire attempt. Defaults to the shared 1.5s call ceiling. */
  callTimeoutMs?: number;
}

/**
 * Lock refusal: six attempts, 200ms doubling to 2s, about five seconds.
 *
 * A rival's advisory lock on a closing session is the common case and it clears
 * in well under a lease duration. Shorter than one lease duration (10s), so a
 * Lease this replica cannot back is handed back before another replica would
 * have been entitled to force-acquire it anyway.
 */
const LOCK_ATTEMPTS = 6;
const LOCK_INITIAL_DELAY_MS = 200;
const LOCK_MAX_DELAY_MS = 2_000;

/**
 * Store unavailable: twelve attempts, 1s doubling to 5s, about fifty seconds.
 *
 * A Postgres restart, failover or network blip is measured in tens of seconds.
 * While it lasts no replica can write, so holding the Lease costs nothing and
 * releasing it only churns. Five lease durations rides one out; after that the
 * process exits and lets the kubelet start a fresh one with a fresh pool, which
 * is better than a replica that has not written for a minute but still renews.
 */
const UNAVAILABLE_ATTEMPTS = 12;
const UNAVAILABLE_INITIAL_DELAY_MS = 1_000;
const UNAVAILABLE_MAX_DELAY_MS = 5_000;

interface RetryPolicy {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

interface ResolvedAcquireOptions {
  lock: RetryPolicy;
  unavailable: RetryPolicy;
  callTimeoutMs: number;
}

type AcquireOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * A `WriterLockUnavailableError` means a rival holds the lock, so the role
 * should move. Everything else (connect refused, timeout, pool exhausted,
 * migration failure) means this replica cannot reach the store, and while that
 * lasts no other replica can write either, so the role is worth keeping.
 *
 * Matched by `name` so the leadership port does not import the Postgres
 * adapter. The class sets `name` in its constructor.
 */
function classifyAcquireError(error: unknown): AcquireFailure {
  return (error as { name?: unknown } | null)?.name === "WriterLockUnavailableError"
    ? "lock_refused"
    : "store_unavailable";
}

async function attemptAcquire(
  hooks: LeadershipHooks,
  timeoutMs: number,
): Promise<AcquireOutcome> {
  try {
    // The hook can hang on a socket with no deadline of its own. A late success
    // is harmless: the next attempt re-runs the whole hook, recovery included.
    await withDeadline(Promise.resolve(hooks.acquire()), timeoutMs, "leadership acquire");
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Settle the first attempt with a deadline, without an extra `await`.
 *
 * The first attempt starts from the leadership listener, and its ordering is
 * pinned: an already-resolved acquire must reach `start()` in the same number
 * of microtasks it did before the deadline existed. A promise race would add a
 * hop, so this attaches the callbacks directly.
 */
function settleFirstAttempt(
  first: Promise<void>,
  timeoutMs: number,
  settle: (outcome: AcquireOutcome) => void,
): void {
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (outcome: AcquireOutcome) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    settle(outcome);
  };
  timer = setTimeout(
    () =>
      finish({
        ok: false,
        error: new Error(`leadership acquire timed out after ${timeoutMs}ms`),
      }),
    timeoutMs,
  );
  timer.unref?.();
  first.then(
    () => finish({ ok: true }),
    (error) => finish({ ok: false, error }),
  );
}

function backoff(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // A pending retry must not be the reason the process stays alive.
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The process is not restarting itself: the kubelet will, as a fresh standby. */
function exitForRestart(failure: AcquireFailure): void {
  log.error("leadership_acquire_exhausted", { failure, action: "exit_for_restart" });
  process.exit(1);
}

async function giveUp(
  leadership: Leadership,
  hooks: LeadershipHooks,
  failure: AcquireFailure,
  attempts: number,
  error: unknown,
): Promise<void> {
  log.error("leadership_acquire_failed", {
    failure,
    attempts,
    error: (error as Error).message,
    action: "releasing_lease",
  });
  // Hand the role over first, then decide how to come back. Releasing is what
  // lets the replica that can take the lock win it; exiting is what stops this
  // one from sitting on a role it cannot use. The exhausted hook must run even
  // if the release throws, or a failed handover would leave the replica dormant.
  try {
    await leadership.stop();
  } catch (error) {
    log.error("leadership_step_down_failed", { error: (error as Error).message });
  }
  const exhausted = hooks.exhausted ?? exitForRestart;
  await exhausted(failure);
}

/**
 * Settle the acquire hook, retrying a refusal on a policy chosen by its class.
 *
 * A lock refusal is handed back quickly: a rival can use the role. A store
 * failure is held and retried for longer: nobody can write, so a handover buys
 * nothing. After either budget the Lease is released and the exhausted hook
 * runs (by default, exit for a restart).
 *
 * Never throws: the caller is an event listener, and a rejected task there would
 * only surface as an unhandled rejection.
 */
async function acquireWithRetry(
  leadership: Leadership,
  hooks: LeadershipHooks,
  options: ResolvedAcquireOptions,
  first: AcquireOutcome,
): Promise<void> {
  let outcome = first;
  let lockFailures = 0;
  let unavailableFailures = 0;
  try {
    for (;;) {
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
      const failure = classifyAcquireError(outcome.error);
      const policy = failure === "lock_refused" ? options.lock : options.unavailable;
      const attempts =
        failure === "lock_refused" ? ++lockFailures : ++unavailableFailures;
      if (attempts >= policy.attempts) {
        await giveUp(leadership, hooks, failure, attempts, outcome.error);
        return;
      }
      const delayMs = Math.min(
        policy.initialDelayMs * 2 ** (attempts - 1),
        policy.maxDelayMs,
      );
      log.warn("leadership_acquire_retry", {
        failure,
        attempt: attempts,
        delayMs,
        error: (outcome.error as Error).message,
      });
      await backoff(delayMs);
      // Do not enable writes on a replica that lost the role while waiting.
      if (!leadership.isLeader()) return;
      outcome = await attemptAcquire(hooks, options.callTimeoutMs);
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
  const options: ResolvedAcquireOptions = {
    lock: {
      attempts: Math.max(1, retry.attempts ?? LOCK_ATTEMPTS),
      initialDelayMs: Math.max(0, retry.initialDelayMs ?? LOCK_INITIAL_DELAY_MS),
      maxDelayMs: Math.max(0, retry.maxDelayMs ?? LOCK_MAX_DELAY_MS),
    },
    unavailable: {
      attempts: Math.max(1, retry.unavailableAttempts ?? UNAVAILABLE_ATTEMPTS),
      initialDelayMs: Math.max(
        0,
        retry.unavailableInitialDelayMs ?? UNAVAILABLE_INITIAL_DELAY_MS,
      ),
      maxDelayMs: Math.max(0, retry.unavailableMaxDelayMs ?? UNAVAILABLE_MAX_DELAY_MS),
    },
    callTimeoutMs: Math.max(1, retry.callTimeoutMs ?? CALL_TIMEOUT_MS),
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
        settleFirstAttempt(first, options.callTimeoutMs, (outcome) => {
          void acquireWithRetry(leadership, hooks, options, outcome);
        });
        return;
      }
      hooks.start();
      return;
    }
    hooks.stop();
    hooks.release();
  });
}
