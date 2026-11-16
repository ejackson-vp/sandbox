/**
 * How a failure becomes a response.
 *
 * Two shapes, and every route shares them rather than restating the body:
 *
 *  - `invalidRequest`: a zod failure is a 400 that carries the issues, so the
 *    client is told which field it got wrong instead of that something went
 *    wrong;
 *  - `errorBackstop`: the last middleware, for a handler that threw instead of
 *    answering. A parse or validation failure is the client's, never a 500, and
 *    a body over the limit is a 413 rather than a dropped socket.
 */
import type { NextFunction, Request, Response } from "express";
import { ZodError, type core } from "zod";
import { log } from "@x402s/shared/runtime";

type Issues = core.$ZodIssue[];

/** The 400 a schema refusal always has: the code and the issues, nothing else. */
export function invalidRequest(res: Response, issues: Issues): void {
  res.status(400).json({ error: "invalid_request", issues });
}

export function errorBackstop(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Every current route uses safeParse and answers 400 itself. This is the
  // backstop for a handler that throws a schema error instead: a validation
  // failure is a client error, never a 500.
  if (err instanceof ZodError) {
    invalidRequest(res, err.issues);
    return;
  }
  if (err.name === "PayloadTooLargeError" || (err as { type?: string }).type === "entity.too.large") {
    res.status(413).json({ error: "payload_too_large" });
    return;
  }
  if (err.name === "SyntaxError") {
    res.status(400).json({ error: "invalid_json" });
    return;
  }
  log.error("unhandled_error", { error: err.message });
  res.status(500).json({ error: "internal_error" });
}
