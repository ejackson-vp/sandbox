/**
 * How a schema refusal becomes a response.
 *
 * Deliberately a copy of the API's helper (`api/src/routes/errors.ts`) rather
 * than an import: the controller is its own workspace and its own deployment
 * unit, and it answers failures differently around this one (its own backstop
 * middleware, its own `ControllerError` status mapping). Sharing a module for
 * one line of JSON would put the public API and the internal control plane in
 * each other's build.
 *
 * The body is a wire contract, not a convenience: `{ error, issues }` with no
 * message field is what the fuzz suite asserts, so the shape lives in one place
 * and no route restates it.
 */
import type { Response } from "express";
import type { core } from "zod";

type Issues = core.$ZodIssue[];

/** The 400 a schema refusal always has: the code and the issues, nothing else. */
export function invalidRequest(res: Response, issues: Issues): void {
  res.status(400).json({ error: "invalid_request", issues });
}
