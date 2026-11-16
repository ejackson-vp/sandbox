/**
 * The 402 challenge: the one place a payment requirement becomes a response.
 *
 * A 402 must never leave without a fresh, single-use challenge nonce (#47): the
 * value is bound into the signed client commitment, so the wallet signature is
 * only good for this challenge. When the controller cannot mint one, the honest
 * answer is a retryable 503 rather than a 402 the client can never satisfy.
 */
import type { Response } from "express";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import type { x402ResourceServer } from "@x402/core/server";
import { log } from "@x402s/shared/runtime";
import type { ControllerClient } from "../controller-client.js";

/** What the challenge advertises about the resource it protects. */
export interface ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
  serviceName: string;
}

export interface PaymentRequiredWriterDeps {
  controller: Pick<ControllerClient, "issueChallengeNonce">;
  resourceServer: Pick<x402ResourceServer, "createPaymentRequiredResponse">;
  resourceInfo: ResourceInfo;
}

export type PaymentRequiredWriter = (
  res: Response,
  requirement: PaymentRequirements,
  error: string,
) => Promise<void>;

export function createPaymentRequiredWriter(deps: PaymentRequiredWriterDeps): PaymentRequiredWriter {
  return async (res, requirement, error) => {
    let challenge: { nonce: string; expiresAt: number };
    try {
      challenge = await deps.controller.issueChallengeNonce();
    } catch (err) {
      log.error("challenge_nonce_unavailable", { error: (err as Error).message });
      res.setHeader("Retry-After", "2");
      res.status(503).json({ error: "challenge_unavailable", retryable: true, message: "try again shortly" });
      return;
    }
    // Merge into `extra` rather than replacing it: @x402/evm keeps the token's
    // EIP-712 domain fields there.
    const withNonce: PaymentRequirements = {
      ...requirement,
      extra: { ...(requirement.extra ?? {}), challengeNonce: challenge.nonce },
    };
    const required = await deps.resourceServer.createPaymentRequiredResponse([withNonce], deps.resourceInfo, error);
    res
      .status(402)
      .setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(required))
      .json({
        ...required,
        error,
        // Also top-level: a client can read it without unpacking `accepts`.
        challengeNonce: challenge.nonce,
        challengeNonceExpiresAt: new Date(challenge.expiresAt).toISOString(),
      });
  };
}
