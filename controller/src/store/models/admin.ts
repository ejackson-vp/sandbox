/**
 * The operator-controlled create surface: the payer allowlist (ADR 0013), the
 * create kill switch, and the single-use challenge nonce the create handshake
 * burns (F-07).
 *
 * The control API reads and writes these; the reconciler never does, which is
 * why they sit apart from the session and money rows.
 */
import type { SessionTier } from "@x402s/shared/protocol";

/**
 * One allowlist entry, as the operator set it (ADR 0013).
 *
 * `maxTier` and `maxConcurrent` are ceilings on what a free session may
 * consume, applied on top of the shared per-window and concurrency budgets.
 */
/** What an operator writes to add or replace an entry. */
export interface AllowlistEntryInput {
  address: string;
  label: string;
  maxTier: SessionTier;
  maxConcurrent: number;
}

export interface PayerAllowlistEntry {
  address: string;
  label: string;
  maxTier: SessionTier;
  maxConcurrent: number;
  createdAt: number;
  disabledAt: number | null;
}

/**
 * The authorize answer. A refusal names why, so the API can distinguish "not on
 * the list" (the normal 402 path) from a broken lookup (fail closed with 503).
 */
export type AllowlistDecision =
  | { allowed: true; label: string; maxTier: SessionTier; maxConcurrent: number }
  | {
      allowed: false;
      reason: "not_allowlisted" | "disabled" | "tier_not_allowed" | "concurrency_exhausted";
    };

/**
 * The create kill switch (schema v21).
 *
 * One row, not a process setting: an operator flips it without a rollout, it
 * survives a restart, and every API replica reads the same answer from the
 * controller. `enabled` is already the *effective* state, so a row whose
 * `expiresAt` has passed reads as disabled and `expired` says which of the two
 * happened. An absent row is not an error: it means no operator has ever
 * flipped it, and creates are admitted.
 */
export interface CreateSwitchState {
  /** True when new creates are refused. */
  enabled: boolean;
  /** Why the state was set. Empty when no row has ever been written. */
  reason: string;
  /** Who set it: a free-text actor string, never a credential. */
  actor: string;
  /** When it was set, epoch ms; null when no row has ever been written. */
  changedAt: number | null;
  /** When it turns itself off, epoch ms, or null for "until disabled". */
  expiresAt: number | null;
  /** The row expired rather than being disabled by an operator. */
  expired: boolean;
}

/** What an operator asks the controller to write. */
export interface CreateSwitchWrite {
  enabled: boolean;
  /** Required when enabling: the reason an operator at 2am will read. */
  reason: string;
  actor: string;
  /** Enable only: epoch ms at which it turns itself off, or null. */
  until: number | null;
}

/**
 * A refused write. `until_in_past` is an operator mistake, not an outage: an
 * enable that is already over would leave a row that says "on" and behaves off.
 */
export type CreateSwitchWriteResult =
  | { ok: true; state: CreateSwitchState }
  | { ok: false; reason: "until_in_past" };
/**
 * Single-use challenge nonce outcome (F-07). Shared by the store port and the
 * control API, which maps each status to a response.
 */
export type ChallengeBurnResult =
  | { status: "burned" }
  /** The same payment already burned this nonce: the retry/recovery path. */
  | { status: "replay" }
  | { status: "expired" }
  | { status: "unknown" }
  /** A different payment already burned this nonce. */
  | { status: "reused" };

export class ChallengeNonceCapacityError extends Error {
  constructor(active: number, max: number) {
    super(`challenge nonce table is full (${active}/${max}); refusing to issue`);
    this.name = "ChallengeNonceCapacityError";
  }
}