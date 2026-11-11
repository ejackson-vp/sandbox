/**
 * Identity of a warm pod, independent of its session.
 *
 * A warm pod is only claimable by a controller whose current guest image,
 * runtime class, execution mode, workspace and pod-shaped limits match the
 * values it booted with. The hash keeps the annotation bounded and makes the
 * comparison a single string; the raw digest is stored separately for
 * diagnostics and evidence.
 */
import { createHash } from "node:crypto";
import type { SessionLimits } from "@x402s/shared/protocol";

export const WARM_IDENTITY_ANNOTATION = "x402.io/warm-identity";
export const WARM_IMAGE_DIGEST_ANNOTATION = "x402.io/image-digest";

export interface WarmPoolIdentityInput {
  imageDigest: string;
  runtimeClass: string;
  executionMode: string;
  workspaceDir: string;
  limits: Pick<SessionLimits, "cpuMillis" | "memoryMiB" | "diskMiB">;
}

export function warmPoolIdentity(input: WarmPoolIdentityInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.imageDigest,
        input.runtimeClass,
        input.executionMode,
        input.workspaceDir,
        input.limits.cpuMillis,
        input.limits.memoryMiB,
        input.limits.diskMiB,
      ]),
    )
    .digest("hex");
}
