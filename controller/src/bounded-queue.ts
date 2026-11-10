/**
 * Bounded fan-out with queue-wait instrumentation.
 *
 * A reconcile pass has to touch every live session, but doing that one at a
 * time makes one slow Kubernetes or relay call the head of the line for every
 * other session. This runs at most `concurrency` workers, dequeues in listing
 * order, and reports how long each item waited before a worker picked it up.
 *
 * Deliberately small and dependency-free: ordering and fairness belong to the
 * caller (a reconcile pass), not to a general-purpose scheduler.
 */
export interface BoundedRunOptions {
  /** Maximum items in flight at once. Values below 1 are treated as 1. */
  concurrency: number;
  /** Clock used for queue-wait accounting; injectable for tests. */
  now?: () => number;
  /**
   * Called immediately before an item starts. `waitMs` is the time since the
   * pass enqueued it; `depth` is how many items are still waiting behind it.
   */
  onStart?: (waitMs: number, depth: number) => void;
}

export async function runBounded<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  options: BoundedRunOptions,
): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const queuedAt = now();
  const entries = items.map((item) => ({ item, queuedAt }));
  const limit = Math.max(1, Math.min(Math.floor(options.concurrency), entries.length));
  let next = 0;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const entry = entries[index];
      if (!entry) return;
      options.onStart?.(Math.max(0, now() - entry.queuedAt), entries.length - index - 1);
      await worker(entry.item);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
}
