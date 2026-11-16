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
  /**
   * The variable name, when the caller knows it. Without it the message names
   * only the value, which is ambiguous on a process with a dozen integer
   * settings; with it an operator gets `MAX_DISK_MIB=512x` rather than `512x`.
   */
  name?: string,
): number {
  const n = value === undefined || value === "" ? def : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    const subject = name ? `${name}=${value}` : `${value}`;
    throw new Error(`invalid integer config value ${subject} (expected ${min}..${max})`);
  }
  return n;
}

/**
 * The one default for `ALLOW_INSECURE_DEV`, and the one parser for it.
 *
 * The flag switches off the two checks that make a deployment safe to point at
 * real money: it accepts simulated dev attestation and an unpinned guest image.
 * It used to be parsed twice, with opposite defaults. The API defaulted it to
 * `PAYMENT_MODE === "mock"` and the controller defaulted it to `true`, so a
 * mainnet deployment that simply omitted the variable had the API enforcing the
 * real-money rules while the controller beside it accepted dev evidence and a
 * moved tag. False is the only default both processes can defend; a deployment
 * that wants the dev path says so once, and each process refuses the
 * combination it cannot serve (`PAYMENT_MODE=mainnet` with this on).
 *
 * An unrecognised value is false rather than an error for the same reason: a
 * typo then fails closed in both processes (mock refuses to start, the
 * controller demands a pinned digest) instead of silently enabling the path.
 */
export const ALLOW_INSECURE_DEV_DEFAULT = false;

export function envAllowInsecureDev(env: Record<string, string | undefined>): boolean {
  return envBool(env.ALLOW_INSECURE_DEV, ALLOW_INSECURE_DEV_DEFAULT);
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
