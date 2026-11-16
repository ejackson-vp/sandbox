/**
 * The three answers every session route shares.
 *
 * `respondControllerError` is the interesting one. A `ControllerError` carries
 * the status and code the client should see, so the default is a straight copy.
 * `translate` lets a route override either, which is how a lease that runs out
 * mid-command becomes 410 instead of the controller's own status. Anything else
 * is the control plane being unreachable: `log` names the failed call when the
 * route passes one, and the client gets 503 without the internal message.
 */
import type { Response } from "express";
import { log } from "@x402s/shared/runtime";
import { ControllerError, type OperationResult } from "../../controller-client.js";
import { requestIdSchema } from "../../schemas.js";

export function respondControllerError(
  res: Response,
  err: unknown,
  options: {
    translate?: (err: ControllerError) => { code?: string; status?: number };
    log?: string;
  } = {},
): void {
  if (!(err instanceof ControllerError)) {
    if (options.log) log.error(options.log, { error: (err as Error).message });
    res.status(503).json({ error: "control_plane_unavailable" });
    return;
  }
  const mapped = options.translate?.(err) ?? {};
  res.status(mapped.status ?? err.status).json({
    error: mapped.code ?? err.code,
    message: err.message,
  });
}

/**
 * Write one operation answer. A pending result is a `202` the client polls, and
 * a finished one carries the sealed envelope; both echo the id the answer is
 * for, so a caller that pipelined two requests can pair them up.
 */
export function writeOperation(res: Response, requestId: string, out: OperationResult): void {
  if (out.pending) {
    res.status(202).json({ state: out.state, requestId, pending: true });
    return;
  }
  res.json({ state: out.state, requestId, envelope: out.envelope });
}

/**
 * The request id a URL carries, or `null` when it is not one we accept. Shared
 * by the poll and the cancel so both refuse the same shapes with the same code.
 */
export function validRequestId(raw: unknown): string | null {
  const requestId = typeof raw === "string" ? raw : "";
  return requestIdSchema.safeParse(requestId).success ? requestId : null;
}
