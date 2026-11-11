/**
 * Control API request schemas and metric labels.
 */
import { z } from "zod";
import { MAX_LEASE_SECONDS } from "@x402s/shared/protocol";

const OP_LABELS = new Set(["exec", "transfer", "file.put", "file.get", "file.list", "file.stat"]);
export function opLabel(op: string | undefined): string {
  return op && OP_LABELS.has(op) ? op : "other";
}
const sessionIdPattern = /^sbx_[0-9a-f]{24}$/;

export const intentClaimSchema = z.object({
  paymentKey: z.string().regex(/^[0-9a-f]{64}$/),
  specHash: z.string().regex(/^[0-9a-f]{64}$/),
  staleMs: z.number().int().min(1000).max(600_000).optional(),
});

const idlePolicySchema = z.object({
  maxIdleSeconds: z.number().int().min(1).max(28800).optional(),
  suspendedDurationSeconds: z.number().int().min(1).max(28800).optional(),
  autoResume: z.boolean().optional(),
});

export const specSchema = z.object({
  tier: z.enum(["short", "standard", "extended", "long", "custom"]),
  runtime: z.enum(["base", "python", "node"]).optional(),
  durationSeconds: z.number().int().min(1).max(MAX_LEASE_SECONDS),
  idlePolicy: idlePolicySchema.optional(),
  maxLifetimeSeconds: z.number().int().min(1).max(28800).optional(),
  baseline: z
    .object({
      cpuMillis: z.number().int().min(50),
      memoryMiB: z.number().int().min(64),
    })
    .optional(),
  clientCommitment: z
    .object({ publicKey: z.string().min(1).max(128), nonce: z.string().min(1).max(128) })
    .optional(),
  limits: z.object({
    cpuMillis: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
    diskMiB: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    maxFileBytes: z.number().int().positive(),
    maxCommandSeconds: z.number().int().positive(),
    maxProcesses: z.number().int().positive(),
  }),
});

const timingsSchema = z
  .object({
    apiReceivedAt: z.number().int().optional(),
    paymentVerifyMs: z.number().nonnegative().max(600_000).optional(),
    paymentSettleMs: z.number().nonnegative().max(600_000).optional(),
    entitlementMs: z.number().nonnegative().max(600_000).optional(),
  })
  .optional();

export const completeSchema = z.object({
  claimToken: z.string().regex(/^[0-9a-f]{32,64}$/),
  sessionId: z.string().regex(sessionIdPattern),
  capabilityHash: z.string().regex(/^[0-9a-f]{64}$/),
  capabilityExpiresAt: z.number().int().positive(),
  spec: specSchema,
  clientPublicKey: z.string().min(40).max(64),
  clientNonce: z.string().min(40).max(64),
  clientSigner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  timings: timingsSchema,
  payment: z.object({
    paymentKey: z.string().regex(/^[0-9a-f]{64}$/),
    network: z.string().min(3).max(64),
    scheme: z.string().min(1).max(32),
    asset: z.string().min(1).max(128),
    amount: z.string().regex(/^\d{1,30}$/),
    payTo: z.string().min(2).max(128),
    payer: z.string().min(2).max(128).optional(),
    transaction: z.string().min(1).max(256).optional(),
    mode: z.enum(["mock", "testnet"]),
  }),
});

export const operationSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  envelope: z.string().min(1).max(16 * 1024 * 1024),
  op: z.string().min(1).max(32).optional(),
  waitMs: z.number().int().min(0).max(120_000).optional(),
});
