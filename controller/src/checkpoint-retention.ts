/**
 * Checkpoint retention: when may an unowned workspace PVC be deleted?
 *
 * A checkpoint volume is plaintext (docs/adr/0007-checkpoint-at-rest-plaintext.md),
 * so the only control on the at-rest exposure window is deletion. The normal
 * path deletes the PVC during termination; this decision function covers the
 * residues: a terminal session whose cleanup was interrupted, and a volume that
 * no session row claims at all (for example after a database restore).
 *
 * It is intentionally conservative: an unknown creation time or a non-terminal
 * session means "keep". A wrongly kept plaintext volume is an exposure window; a
 * wrongly deleted volume is data loss for a paid session.
 *
 * The session is typed as the two fields this decision reads and nothing more,
 * so `state` is a `SessionState` and "is it terminal" is answered by the shared
 * vocabulary. A locally listed set of terminal states would compile fine while
 * omitting the next one, and the volume for that state would never be reaped.
 */
import { isTerminal } from "@x402s/shared/protocol";
import type { SessionRecord } from "./store/models/session.js";

export interface WorkspacePvcInfo {
  name: string;
  /** `x402.io/session` label; empty when the volume is unattributable. */
  sessionId: string;
  /** Creation timestamp in ms; 0 when Kubernetes did not report one. */
  createdAt: number;
  /** True once Kubernetes has accepted a delete (deletionTimestamp is set). */
  deleting: boolean;
}

interface PvcReapInput {
  pvc: WorkspacePvcInfo;
  /**
   * The session row that claims the volume, or null when nothing does. Only the
   * identity and the state are read; `TERMINATING` is not terminal and still
   * owns its volume until its cleanup finishes.
   */
  session: Pick<SessionRecord, "id" | "state"> | null;
  now: number;
  orphanGraceMs: number;
}

type PvcReapReason = "terminal_session" | "no_session" | "unattributed";

export function workspacePvcReapReason(input: PvcReapInput): PvcReapReason | null {
  const { pvc, session, now, orphanGraceMs } = input;
  // Already accepted for deletion. Re-reporting it every housekeeping tick
  // would only spam the metric and log until the finalizer clears.
  if (pvc.deleting) return null;
  if (session) {
    return isTerminal(session.state) ? "terminal_session" : null;
  }
  // No owner. Wait out the grace period so a session row that is about to be
  // written, or a slow database restore, cannot race the sweep.
  if (pvc.createdAt <= 0) return null;
  if (now - pvc.createdAt < orphanGraceMs) return null;
  return pvc.sessionId ? "no_session" : "unattributed";
}
