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

/**
 * All three files must be set together or none of them. Returns undefined when
 * the feature is disabled, so callers can fail closed only where it matters.
 */
function parseTlsFiles(
  env: NodeJS.ProcessEnv,
  prefix: string,
): { certFile: string; keyFile: string; caFile: string } | undefined {
  const certFile = env[`${prefix}_CERT_FILE`];
  const keyFile = env[`${prefix}_KEY_FILE`];
  const caFile = env[`${prefix}_CA_FILE`];
  const set = [certFile, keyFile, caFile];
  if (set.every((value) => !value)) return undefined;
  if (set.some((value) => !value)) {
    throw new Error(`${prefix}_CERT_FILE, ${prefix}_KEY_FILE and ${prefix}_CA_FILE must be set together`);
  }
  return { certFile: certFile!, keyFile: keyFile!, caFile: caFile! };
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
  const certFile = env.TLS_CERT_FILE;
  const keyFile = env.TLS_KEY_FILE;
  const caFile = env.TLS_CA_FILE;
  const set = [certFile, keyFile, caFile].filter(Boolean);
  if (tlsPort && set.length !== 3) {
    throw new Error("CONTROLLER_TLS_PORT requires TLS_CERT_FILE, TLS_KEY_FILE and TLS_CA_FILE");
  }
  if (!tlsPort && set.length > 0) {
    throw new Error("TLS_CERT_FILE/TLS_KEY_FILE/TLS_CA_FILE require CONTROLLER_TLS_PORT");
  }
  if (!tlsPort) return {};
  return {
    tlsPort,
    tlsCertFile: certFile!,
    tlsKeyFile: keyFile!,
    tlsCaFile: caFile!,
  };
}

export function parseTransportSecurity(
  env: NodeJS.ProcessEnv,
  kubeEnabled: boolean,
  role: Role,
): TransportSecurity {
  const tls = parseTls(env);
  const relayTls = parseTlsFiles(env, "RELAY_TLS");
  const relayClientTls = parseTlsFiles(env, "RELAY_CLIENT_TLS");
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
