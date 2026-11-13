/**
 * Request schemas and the plaintext guard shared by all routes.
 */
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { MAX_LEASE_SECONDS } from "@x402s/shared/protocol";


export const createSchema = z.object({
  tier: z.enum(["short", "standard", "extended", "long", "custom"]).optional(),
  /**
   * Guest runtime profile. Kept as a plain string so an unknown name reaches
   * `resolveSessionSpec` and returns a specific 400 code rather than a generic
   * schema error.
   */
  runtime: z.string().min(1).max(64).optional(),
  durationSeconds: z.number().int().min(1).max(MAX_LEASE_SECONDS).optional(),
  cpuMillis: z.number().int().positive().optional(),
  memoryMiB: z.number().int().positive().optional(),
  diskMiB: z.number().int().positive().optional(),
  clientPublicKey: z.string().min(40).max(64),
  clientNonce: z.string().min(40).max(64),
  /** Server-issued single-use challenge value from the 402 response. */
  challengeNonce: z.string().regex(/^cn_[0-9a-f]{32}$/).optional(),
  /** Payer-wallet proof over the client commitment; required on paid requests. */
  clientSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).optional(),
  baselineCpuMillis: z.number().int().min(50).optional(),
  baselineMemoryMiB: z.number().int().min(64).optional(),
  idlePolicy: z
    .object({
      maxIdleSeconds: z.number().int().min(1).max(28800).optional(),
      suspendedDurationSeconds: z.number().int().min(1).max(28800).optional(),
      autoResume: z.boolean().optional(),
    })
    .optional(),
  maxLifetimeSeconds: z.number().int().min(1).max(28800).optional(),
});

export const requestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

/**
 * Client-computed SHA-256 of the canonical operation plaintext, used only to
 * bind the idempotency key to the request. The API cannot verify it (it never
 * sees the plaintext); the controller stores it and refuses a retry that
 * disagrees with it.
 */
export const payloadHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const operationSchema = z.object({
  requestId: requestIdSchema,
  envelope: z.string().min(1).max(16 * 1024 * 1024),
  /**
   * Optional so a client that does not compute a canonical hash keeps the
   * ciphertext binding. Needed because sealing is non-deterministic: without
   * it, re-sealing the same operation under the same request id would look
   * like a different payload.
   */
  payloadHash: payloadHashSchema.optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  /**
   * How long the API holds the request open before answering `202 pending`.
   *
   * Capped at 90 s, below the 100 s timeout a proxied request gets at the edge
   * (Cloudflare answers 524 there). A longer wait means the client loses the 202
   * and the request id it needs to re-poll, so the cap is a contract, not a
   * tuning knob. Raise it only above a proxy that allows longer requests.
   */
  waitMs: z.number().int().min(0).max(90_000).optional(),
});

/** Fields that must never be accepted as JSON: they imply plaintext. */
const FORBIDDEN_FIELDS = [
  "code",
  "source",
  "script",
  "command",
  "args",
  "argv",
  "env",
  "cwd",
  "stdin",
  "stdout",
  "stderr",
  "content",
  "data",
  "plaintext",
];

export function rejectPlaintextBodies(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  if (body && typeof body === "object") {
    for (const field of FORBIDDEN_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        res.status(400).json({
          error: "plaintext_not_accepted",
          message:
            "this endpoint only accepts ciphertext; encrypt your operation for the attested guest key",
          field,
        });
        return;
      }
    }
  }
  next();
}
