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
