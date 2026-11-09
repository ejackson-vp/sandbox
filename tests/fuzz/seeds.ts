/**
 * Fuzz run configuration.
 *
 * fast-check prints `{ seed, path }` when a property fails. Set FUZZ_SEED to
 * replay that exact run:
 *
 *   FUZZ_SEED=582526622 npm run test:fuzz
 *
 * Without it, every run explores fresh inputs.
 */
const raw = process.env.FUZZ_SEED;
const parsed = raw ? Number(raw) : Number.NaN;

export const fuzzSeed: { seed?: number } = Number.isFinite(parsed) ? { seed: parsed } : {};
