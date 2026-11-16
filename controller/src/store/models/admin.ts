/**
 * The operator-controlled create surface: the payer allowlist (ADR 0013), the
 * create kill switch, and the single-use challenge nonce the create handshake
 * burns (F-07).
 *
 * The control API reads and writes these; the reconciler never does, which is
 * why they sit apart from the session and money rows.
 */
import type {
  AllowlistDecision,
  ChallengeBurnResult,
  CreateSwitchState,
  IssuedChallengeNonce,
  SessionTier,
} from "@x402s/shared/protocol";

/**
 * The four answers the API reads back are declared in shared, so the client
 * parses the same declarations the routes produce. Only the rows an operator
 * writes are declared here.
 */
export type {
  AllowlistDecision,
  ChallengeBurnResult,
  CreateSwitchState,
  IssuedChallengeNonce,
};

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

export class ChallengeNonceCapacityError extends Error {
  constructor(active: number, max: number) {
    super(`challenge nonce table is full (${active}/${max}); refusing to issue`);
    this.name = "ChallengeNonceCapacityError";
  }
}