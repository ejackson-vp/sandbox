/**
 * Identity of a warm pod, independent of its session.
 *
 * A warm pod is only claimable by a controller whose current runtime profile,
 * guest image, runtime class, execution mode, workspace and pod-shaped limits
 * match the values it booted with. The hash keeps the annotation bounded and
 * makes the comparison a single string; the raw digest and profile name are
 * stored separately for diagnostics and evidence.
 */
import { createHash } from "node:crypto";
import type { SessionLimits } from "@x402s/shared/protocol";

export const WARM_IDENTITY_ANNOTATION = "x402.io/warm-identity";
export const WARM_IMAGE_DIGEST_ANNOTATION = "x402.io/image-digest";
/**
 * Runtime profile a warm pod booted. Set as both a label (cheap filtering on
 * `listWarmPods`) and an annotation (survives a label key collision with the
 * rest of the pool plumbing).
 */
export const WARM_RUNTIME_ANNOTATION = "x402.io/runtime";
export const WARM_RUNTIME_LABEL = "x402.io/runtime";

export interface WarmPoolIdentityInput {
  /** Profile name, `base` for the default guest image. */
  runtime: string;
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
        input.runtime,
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
