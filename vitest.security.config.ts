/**
 * Cluster-backed suites: `tests/security` against a live kind + Cilium cluster.
 *
 * Separate from `vitest.config.ts` for one reason. The root config has a
 * `globalSetup` that refuses to start without `DATABASE_URL`, because the unit
 * and integration suites need Postgres. The isolation suite needs a cluster and
 * a running deployment, and touches no database at all, so reusing the root
 * config made `make security-test` fail on a correctly built cluster with a
 * message about Postgres. That is the kind of error that teaches people to stop
 * running the suite that proves the isolation claim.
 *
 * It is not a coverage source. The lines it reaches are measured by the suites
 * that run without a cluster, and instrumenting a run that spends most of its
 * time waiting on packets would only add noise.
 *
 * The files, all included by the glob below: `network.test.ts` (packet-level
 * isolation), `workload.test.ts` (lifecycle and pod hardening),
 * `warm-pool.test.ts` (pool identity), `attacker.test.ts` (anonymous abuse:
 * create floods, XFF spoofing, oversized bodies, slowloris, capability brute
 * force, cross-session relay credentials, private egress and DNS rebinding).
 * Each skips loudly when its own precondition is missing;
 * `scripts/isolation-gate.sh` fails a release when the two it requires produced
 * no executed tests.
 */
import { defineConfig } from "vitest/config";
import { resolveConfig, tsSpecifierPlugin } from "./vitest.shared.js";

export default defineConfig({
  plugins: [tsSpecifierPlugin],
  resolve: resolveConfig,
  test: {
    include: ["tests/security/**/*.test.ts"],
    // Every case dials a real workload through a real relay and waits for a
    // packet-level outcome, so the default 60s per test is not enough.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: "forks",
    fileParallelism: false,
  },
});
