/**
 * The capacity decision as the API sees it.
 *
 * The controller's own `AdmissionDecision` and `ReservationAdmission` carry
 * placement detail the API must not act on: the plan, the reservation row, the
 * node's free capacity afterwards. Two routes were serialising those rows
 * directly, which is how the API's copy of the type came to promise a top-level
 * `nodeId` that a hold never sent.
 *
 * One projection, at the boundary, into the shared `CapacityDecision`. The
 * route sends exactly this, so what the API parses is a type both sides import.
 */
import type { CapacityDecision } from "@x402s/shared/protocol";
import type { ReservationAdmission } from "./reservation-store.js";
import type { AdmissionDecision } from "./types.js";

export function toCapacityDecision(
  admission: AdmissionDecision | ReservationAdmission,
): CapacityDecision {
  if (!admission.admitted) return admission;
  const { reservation } = admission;
  return {
    admitted: true,
    nodeId: reservation.nodeId,
    reservation: { nodeId: reservation.nodeId },
    ...("availableAfter" in admission ? { availableAfter: admission.availableAfter } : {}),
  };
}
