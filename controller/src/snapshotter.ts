/**
 * Checkpoint storage port.
 *
 * The local implementation is a no-op: the per-session PVC is the checkpoint.
 * A Firecracker/Kata adapter can capture and restore memory + disk behind the
 * same interface without teaching the lifecycle use cases about snapshots.
 * Implementations must be idempotent; the reconciler may retry a transition
 * after a crash.
 */
import type { SessionRecord } from "./store.js";

export interface Snapshotter {
  /** Capture the session's checkpoint. Called before compute is released. */
  capture(session: SessionRecord): Promise<void>;
  /** Make the checkpoint ready for a new guest. Called before pod creation. */
  restore(session: SessionRecord): Promise<void>;
  /** Drop the checkpoint. Called once termination is final. */
  discard(session: SessionRecord): Promise<void>;
}

export class NoopSnapshotter implements Snapshotter {
  async capture(_session: SessionRecord): Promise<void> {}
  async restore(_session: SessionRecord): Promise<void> {}
  async discard(_session: SessionRecord): Promise<void> {}
}
