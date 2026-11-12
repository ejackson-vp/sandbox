/**
 * Environment parsing shared by the API and controller configuration loaders.
 *
 * These throw on malformed values instead of silently defaulting: a typo in a
 * limit should stop startup, not produce a surprising runtime policy.
 */

export function envBool(value: string | undefined, def = false): boolean {
  if (value === undefined || value === "") return def;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function envInt(
  value: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  const n = value === undefined || value === "" ? def : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`invalid integer config value ${value} (expected ${min}..${max})`);
  }
  return n;
}

/**
 * A certificate, key and CA file set, all three or none.
 *
 * Splitting a TLS pair across two deployments is the failure this refuses: a
 * server with a certificate and no key, or a client with a key it cannot
 * verify, would otherwise only fail at the first handshake. `prefix` names the
 * variable family (`TLS`, `RELAY_TLS`, `CONTROLLER_TLS`), so the message names
 * the variables the operator set.
 */
export function envTlsFiles(
  env: Record<string, string | undefined>,
  prefix: string,
): { certFile: string; keyFile: string; caFile: string } | undefined {
  const certFile = env[`${prefix}_CERT_FILE`];
  const keyFile = env[`${prefix}_KEY_FILE`];
  const caFile = env[`${prefix}_CA_FILE`];
  const set = [certFile, keyFile, caFile];
  if (set.every((value) => !value)) return undefined;
  if (set.some((value) => !value)) {
    throw new Error(
      `${prefix}_CERT_FILE, ${prefix}_KEY_FILE and ${prefix}_CA_FILE must be set together`,
    );
  }
  return { certFile: certFile!, keyFile: keyFile!, caFile: caFile! };
}
