/**
 * HTTP listeners, credentials and the base URL peers use to reach this
 * process.
 *
 * The metrics listener lives here too: it is a process port like any other and
 * keeping it next to the API ports preserves the order in which a bad port is
 * refused at startup (the scrape listener is validated right after the
 * controller port, before any relay or proxy port).
 */
import { envInt as int } from "@x402s/shared/env";
import { DEFAULT_METRICS_PORT } from "@x402s/shared/runtime";
import type { AdminTokens, ServiceTokens } from "./tokens.js";
import type { TransportSecurity } from "./tls.js";
import type { ControllerConfig } from "./types.js";

type ServerSettings = Pick<
  ControllerConfig,
  | "controllerPort"
  | "metricsPort"
  | "metricsHost"
  | "tlsPort"
  | "tlsCertFile"
  | "tlsKeyFile"
  | "tlsCaFile"
  | "relayPort"
  | "relayControlPort"
  | "relayTls"
  | "relayClientTls"
  | "proxyPort"
  | "adminToken"
  | "adminTokenPrevious"
  | "relayAdminToken"
  | "wakeToken"
  | "proxyTokenSecret"
  | "controllerUrl"
>;

export function parseServer(
  env: NodeJS.ProcessEnv,
  admin: AdminTokens,
  tokens: ServiceTokens,
  security: TransportSecurity,
): ServerSettings {
  return {
    controllerPort: int(env.X402_CONTROLLER_PORT ?? env.CONTROLLER_PORT, 3001, 1, 65535),
    metricsPort: int(env.METRICS_PORT, DEFAULT_METRICS_PORT, 0, 65535),
    metricsHost: env.METRICS_HOST ?? "0.0.0.0",
    ...security.tls,
    relayPort: int(env.X402_RELAY_PORT ?? env.RELAY_PORT, 8443, 1, 65535),
    relayControlPort: int(env.RELAY_CONTROL_PORT, 8444, 1, 65535),
    ...(security.relayTls ? { relayTls: security.relayTls } : {}),
    ...(security.relayClientTls ? { relayClientTls: security.relayClientTls } : {}),
    proxyPort: int(env.X402_PROXY_PORT ?? env.PROXY_PORT, 3128, 1, 65535),
    adminToken: admin.adminToken,
    ...(admin.adminTokenPrevious ? { adminTokenPrevious: admin.adminTokenPrevious } : {}),
    ...tokens,
    controllerUrl: env.CONTROLLER_URL ?? "http://127.0.0.1:3001",
  };
}
