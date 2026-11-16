/**
 * The create kill switch, as the API sees it (schema v21).
 *
 * This runs once the body has been validated, and before the price is built,
 * before a challenge is issued, before any capacity hold, intent claim or
 * settlement. That position is deliberate:
 *
 *  - a request that is wrong gets its 400 whatever the switch says. Refusing a
 *    malformed body with "try again shortly" would be a lie, and it hides the
 *    client's bug behind an operator's incident;
 *  - a caller must not be charged for a create the operator has stopped, and
 *    must not be handed a 402 challenge its payment cannot be used against, so
 *    the refusal has to precede both;
 *  - the check must be cheap in an incident. It is one internal read of one row
 *    that the controller owns, and no session or payment row is touched.
 *
 * The switch is read, never cached: an operator flips a row and the next create
 * sees it. That is the whole point of a kill switch that is not an env var.
 */
import type { CreateSwitchState } from "@x402s/shared/protocol";
import { CREATE_REFUSALS_TOTAL, log, metrics, publishCreateSwitch } from "@x402s/shared/runtime";
import {
  admissionUnavailable,
  json,
  type CreateSessionResult,
  type CreateSessionUseCaseDeps,
} from "./create-session-contract.js";

/**
 * What a caller reads when the operator left no reason. It has to be true
 * without knowing why: creates are off, reads on live sessions are not.
 */
export const CREATES_DISABLED_MESSAGE =
  "new sessions are temporarily disabled by the operator; existing sessions are unaffected";

/**
 * Count one refusal. The label is the refusal code, which is a closed set: the
 * operator's reason and actor are free text and never become a label value.
 */
function countRefusal(refusal: "creates_disabled" | "admission_unavailable"): void {
  metrics
    .counter(CREATE_REFUSALS_TOTAL, "Create requests refused by the kill switch path")
    .inc({ error: refusal });
}

/**
 * Refuse the create when the switch says so, or when the switch cannot be read.
 *
 * `null` means "continue with the normal x402 path". Anything else is the answer
 * that ends the request.
 *
 * A store read error is fail-closed on purpose: admitting creates while the
 * store that holds the switch is unreachable is exactly the behaviour the switch
 * exists to prevent, and a create admitted during an incident cannot be undone
 * without refunding it. `admission_unavailable` rather than `creates_disabled`
 * says which of the two happened, so an operator is not sent looking for a
 * switch nobody flipped.
 */
export async function refuseWhenCreatesDisabled(
  deps: CreateSessionUseCaseDeps,
): Promise<CreateSessionResult | null> {
  let state: CreateSwitchState;
  try {
    state = await deps.controller.readCreateSwitch();
  } catch (err) {
    // No payment was taken and no challenge was issued: this runs before both.
    log.error("create_switch_unreadable", { error: (err as Error).message });
    countRefusal("admission_unavailable");
    return admissionUnavailable(
      "the create switch could not be read; try again shortly, no payment was taken",
    );
  }

  publishCreateSwitch(metrics, state.enabled);
  if (!state.enabled) return null;

  countRefusal("creates_disabled");
  // The reason is the operator's text and belongs in the body, not in a label or
  // a log line: the caller needs it, the metric must not carry it.
  log.info("create_refused_disabled", { expired: state.expired });
  return json(503, {
    error: "creates_disabled",
    retryable: true,
    message: state.reason.trim() === "" ? CREATES_DISABLED_MESSAGE : state.reason,
  });
}
