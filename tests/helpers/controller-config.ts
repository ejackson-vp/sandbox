/**
 * A controller configuration built by the real loader, for tests that need the
 * policy defaults without a cluster.
 *
 * Property tests drive one module through its ports, so they need `cfg` to be
 * the same shape the process would build: a hand-written object cast to
 * `ControllerConfig` silently reads `undefined` the day the module starts
 * consulting another field. The unrelated required settings (tokens, database
 * URL, image digest) are supplied once here instead of fifteen lines per file.
 */
import { loadControllerConfig, type ControllerConfig } from "../../controller/src/config.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

export function controllerConfig(extra: NodeJS.ProcessEnv = {}): ControllerConfig {
  return loadControllerConfig({
    ADMIN_TOKEN: "a".repeat(24),
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DATABASE_URL: "postgres://user:pw@db:5432/sandbox",
    GUEST_IMAGE: "ghcr.io/example/guest:0.1.0",
    GUEST_IMAGE_DIGEST: DIGEST,
    ...extra,
  });
}
