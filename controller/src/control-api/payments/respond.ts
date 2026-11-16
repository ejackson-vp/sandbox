/**
 * The completion answer.
 *
 * The session view is folded in so the API does not need a second round trip
 * (`GET /internal/sessions/:id`) on the create critical path. Kept additive: an
 * older API ignores the extra field.
 *
 * Every branch that has a session to hand back uses this shape: a fresh create,
 * an idempotent replay, an already-settled intent and a claim lost to the worker
 * that settled it.
 */
import type { IntentCompletion } from "@x402s/shared/protocol";
import { describeSession } from "../../session-view.js";
import type { ControlApiDeps } from "../types.js";

export async function completionResponse(
  store: ControlApiDeps["store"],
  sessionId: string | null,
  created: boolean,
): Promise<IntentCompletion> {
  const session = sessionId ? await describeSession(store, sessionId) : null;
  return {
    sessionId,
    state: "PAID" as const,
    created,
    ...(session ? { session } : {}),
  };
}
