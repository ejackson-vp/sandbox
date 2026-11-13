/**
 * Bound how long a caller waits for one call.
 *
 * This stops a hung call from stalling a renewal or retry loop. It does not
 * cancel the work: the underlying promise keeps running and may still settle
 * after the deadline, so a caller acting on a late success has to re-check its
 * own authority first.
 */

/** One Kubernetes or store call must not outlive a renewal window. */
export const CALL_TIMEOUT_MS = 1_500;

/** Reject after `ms` so a hung call cannot stall its caller. */
export async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
