/**
 * USD price helpers: atomic units in, a rendered price out.
 *
 * Pure on purpose, and separate from `payment.ts`. The payment module owns the
 * x402 schemes and reaches `node:crypto` and libsodium through the commitment
 * code, so a caller that only renders a price (the API status view) would
 * otherwise load that whole graph to format a string.
 */

/** Parse "$0.01" into atomic units at 6 decimals. Throws on anything else. */
export function parseUsdPrice(price: string): { amount: bigint; decimals: number; normalized: string } {
  const m = /^\$?(\d+)(?:\.(\d{1,6}))?$/.exec(price.trim());
  if (!m) throw new Error(`invalid price: ${price}`);
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").padEnd(6, "0");
  return {
    amount: BigInt(whole) * 10n ** 6n + BigInt(frac),
    decimals: 6,
    normalized: `$${whole}.${frac}`,
  };
}

/** Render atomic units as a USD string, trimming trailing zeros. */
export function formatUsd(amountAtomic: string, decimals = 6): string {
  const v = BigInt(amountAtomic);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `$${whole}.${frac}` : `$${whole}`;
}
