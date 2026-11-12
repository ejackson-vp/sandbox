/**
 * Transport security: listeners, server certificates and the relay mTLS pair.
 *
 * The controller has two independent TLS stories and they fail closed
 * differently:
 *
 *  - the optional public HTTPS listener (`CONTROLLER_TLS_PORT` plus one cert
 *    set), which is off by default;
 *  - the relay control listener's mTLS material (`RELAY_TLS_*` on the server,
 *    `RELAY_CLIENT_TLS_*` on the controller), which a cluster relay must have
 *    and which must match the scheme of `RELAY_URL`.
 */
import { envTlsFiles } from "@x402s/shared/env";
import type { RelayTlsOptions } from "../relay.js";
import type { RelayClientTlsOptions } from "../relay-client.js";
import type { Role } from "./role.js";
import type { ControllerConfig } from "./types.js";

type PublicTls =
  | Pick<ControllerConfig, "tlsPort" | "tlsCertFile" | "tlsKeyFile" | "tlsCaFile">
  | Record<string, never>;

export interface TransportSecurity {
  tls: PublicTls;
  relayTls?: RelayTlsOptions;
  relayClientTls?: RelayClientTlsOptions;
}

function parseTlsPort(env: NodeJS.ProcessEnv): number | undefined {
  const tlsPortRaw = env.CONTROLLER_TLS_PORT ?? "0";
  const tlsPortNum = Number(tlsPortRaw);
  const tlsPort =
    Number.isInteger(tlsPortNum) && tlsPortNum > 0 && tlsPortNum <= 65535 ? tlsPortNum : undefined;
  if (tlsPortRaw !== "0" && !tlsPort) throw new Error(`invalid CONTROLLER_TLS_PORT ${tlsPortRaw}`);
  return tlsPort;
}

function parseTls(env: NodeJS.ProcessEnv): PublicTls {
  const tlsPort = parseTlsPort(env);
  const files = envTlsFiles(env, "TLS");
  // The port turns the listener on, so a port with no certificates and a
  // certificate set with no port are both misconfiguration, not "disabled".
  if (tlsPort && !files) {
    throw new Error("CONTROLLER_TLS_PORT requires TLS_CERT_FILE, TLS_KEY_FILE and TLS_CA_FILE");
  }
  if (!tlsPort && files) {
    throw new Error("TLS_CERT_FILE/TLS_KEY_FILE/TLS_CA_FILE require CONTROLLER_TLS_PORT");
  }
  if (!tlsPort || !files) return {};
  return {
    tlsPort,
    tlsCertFile: files.certFile,
    tlsKeyFile: files.keyFile,
    tlsCaFile: files.caFile,
  };
}

export function parseTransportSecurity(
  env: NodeJS.ProcessEnv,
  kubeEnabled: boolean,
  role: Role,
): TransportSecurity {
  const tls = parseTls(env);
  const relayTls = envTlsFiles(env, "RELAY_TLS");
  const relayClientTls = envTlsFiles(env, "RELAY_CLIENT_TLS");
  // A cluster relay must never expose the control routes over plaintext. The
  // local process and unit tests may run without certificates.
  if (kubeEnabled && (role === "relay" || role === "all") && !relayTls) {
    throw new Error("RELAY_TLS_CERT_FILE/RELAY_TLS_KEY_FILE/RELAY_TLS_CA_FILE are required for a relay when KUBERNETES_ENABLED is true");
  }
  if (relayClientTls && !/^https:/i.test(env.RELAY_URL ?? "")) {
    throw new Error("RELAY_CLIENT_TLS_* requires an https:// RELAY_URL");
  }
  if (!relayClientTls && /^https:/i.test(env.RELAY_URL ?? "")) {
    throw new Error("RELAY_CLIENT_TLS_CERT_FILE/RELAY_CLIENT_TLS_KEY_FILE/RELAY_CLIENT_TLS_CA_FILE are required for an https:// RELAY_URL");
  }
  return {
    tls,
    ...(relayTls ? { relayTls } : {}),
    ...(relayClientTls ? { relayClientTls } : {}),
  };
}
