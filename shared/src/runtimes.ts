/**
 * Supported guest runtime profiles.
 *
 * A runtime profile selects a prepared toolchain image layer under
 * `/runtimes/<name>`; the guest loads `/runtimes/<name>/profile.json` when
 * `RUNTIME_PROFILE` names it. The list is the public noun: a create request may
 * only ask for one of these, and an unknown name is rejected before any
 * payment is taken.
 */

export const SUPPORTED_RUNTIMES = ["base", "python", "node"] as const;

export type RuntimeName = (typeof SUPPORTED_RUNTIMES)[number];

/** Historical behaviour: a session with no runtime is a base session. */
export const DEFAULT_RUNTIME: RuntimeName = "base";

export function isSupportedRuntime(value: unknown): value is RuntimeName {
  return typeof value === "string" && (SUPPORTED_RUNTIMES as readonly string[]).includes(value);
}

export type RuntimeResolution =
  | { ok: true; runtime: RuntimeName }
  | { ok: false; code: "unsupported_runtime"; message: string };

/**
 * Normalise a requested runtime. Absent (or empty) means `base`; anything
 * outside {@link SUPPORTED_RUNTIMES} is an error the caller must surface as a
 * 400 before pricing or payment.
 */
export function resolveRuntime(value: string | null | undefined): RuntimeResolution {
  if (value === undefined || value === null || value === "") {
    return { ok: true, runtime: DEFAULT_RUNTIME };
  }
  if (isSupportedRuntime(value)) return { ok: true, runtime: value };
  return {
    ok: false,
    code: "unsupported_runtime",
    message: `runtime "${value}" is not available; supported runtimes: ${SUPPORTED_RUNTIMES.join(", ")}`,
  };
}
