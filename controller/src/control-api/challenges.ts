/**
 * Server-issued challenge nonces (#47, F-07).
 *
 * The API asks for one when it writes a 402 and burns it when the signed
 * commitment arrives. The nonce is what makes the commitment a *fresh* proof:
 * without it the same wallet signature is a valid retry forever, which is
 * exactly the residual F-07 documented.
 *
 * Authenticated like every other `/internal` route (admin token or CN=api mTLS).
 */
import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import { ChallengeNonceCapacityError } from "../store/challenges.js";
import { burnChallengeNonceSchema } from "../control-api-schemas.js";
import type { ControlApiDeps } from "./types.js";

export function registerChallengeNonceRoutes(app: Express, deps: ControlApiDeps): void {
  const cfg = deps.cfg;

  app.post("/internal/challenge-nonces", (_req: Request, res: Response) => {
    const nonce = `cn_${randomBytes(16).toString("hex")}`;
    try {
      const issued = deps.store.issueChallengeNonce(
        nonce,
        cfg.challengeNonceTtlMs,
        cfg.challengeNonceMaxActive,
      );
      res.status(201).json(issued);
    } catch (err) {
      if (err instanceof ChallengeNonceCapacityError) {
        // A full table is a capacity answer, not a 500: the API turns it into a
        // retryable 503 and the client re-challenges.
        res.status(503).json({ error: "challenge_capacity", retryable: true });
        return;
      }
      throw err;
    }
  });

  app.post("/internal/challenge-nonces/:nonce/burn", (req: Request, res: Response) => {
    const parsed = burnChallengeNonceSchema.safeParse({
      nonce: String(req.params.nonce ?? ""),
      paymentKey: (req.body ?? {}).paymentKey,
    });
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    res.json(deps.store.burnChallengeNonce(parsed.data.nonce, parsed.data.paymentKey));
  });
}
