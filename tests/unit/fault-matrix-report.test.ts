/**
 * The nightly workflow trusts the fault-matrix wrapper to turn harness stdout
 * into artifacts and to fail on a budget breach. These tests pin that contract
 * without a cluster: parsing, presets, the Markdown table and JUnit counts.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractReport, renderSummary, securitySummary, selectCases } from "../../scripts/fault-matrix.mjs";

const provisioningReport = {
  target: "controller",
  count: 50,
  convergedMs: 33_400,
  convergenceBudgetMs: 60_000,
  podCount: 50,
  reservations: { total: 50, held: 0, allocated: 50, suspended: 0, releasing: 0 },
  terminal: [],
  failures: [],
};

function summary(overrides: Record<string, unknown> = {}) {
  const entry = {
    case: "controller-kill",
    target: "controller",
    action: "kill",
    scenario: "provisioning",
    sessions: 50,
    budgetMs: 60_000,
    passed: true,
    exitCode: 0,
    durationMs: 95_000,
    convergedMs: 33_400,
    failureReasons: [] as string[],
    stderrTail: "",
    report: provisioningReport,
    ...overrides,
  };
  return {
    generatedAt: "2026-11-10T04:20:00.000Z",
    preset: "full",
    apiUrl: "http://localhost:8080",
    namespace: "sandbox-system",
    kubeContext: "kind-x402-sandbox",
    passed: entry.passed ? 1 : 0,
    failed: entry.passed ? 0 : 1,
    cases: [entry],
  };
}

describe("fault matrix report", () => {
  it("extracts the JSON block after progress output", () => {
    const stdout = [
      "creating 50 paid sessions...",
      "created 50; waiting for provisioning before killing controller",
      JSON.stringify(provisioningReport, null, 2),
      "destroying sessions...",
      "cleanup: pods=0 reservations={\"total\":0}",
    ].join("\n");
    expect(extractReport(stdout)).toEqual(provisioningReport);
  });

  it("takes the last block when a run prints more than one", () => {
    const stdout = [
      JSON.stringify({ convergedMs: 1 }, null, 2),
      "=== fault run 2/2 ===",
      JSON.stringify({ convergedMs: 2 }, null, 2),
    ].join("\n");
    expect(extractReport(stdout)).toEqual({ convergedMs: 2 });
  });

  it("returns null when the harness printed no result", () => {
    expect(extractReport("convergence loop timed out")).toBeNull();
  });

  it("resolves presets and explicit case lists", () => {
    expect(selectCases("smoke").map((entry: { name: string }) => entry.name)).toEqual([
      "api-kill",
      "controller-pause",
      "relay-pause",
    ]);
    expect(selectCases("relay-kill,api-kill").map((entry: { name: string }) => entry.name)).toEqual([
      "relay-kill",
      "api-kill",
    ]);
    expect(() => selectCases("not-a-case")).toThrow(/unknown FAULT_MATRIX value/);
  });

  it("renders pass rows and a budget failure", () => {
    const pass = renderSummary(summary(), null);
    expect(pass).toContain("**1/1 scenarios passed**");
    expect(pass).toContain("| controller-kill | controller | kill | 50 | 33.4 s | 60.0 s | pass |");
    expect(pass).toContain("pods 50/50, reservations 50 (allocated 50)");

    const fail = renderSummary(summary({
      passed: false,
      exitCode: 1,
      convergedMs: 71_000,
      failureReasons: ["convergence 71000ms exceeded budget 60000ms"],
      stderrTail: "convergence 71000ms exceeded budget 60000ms",
    }), null);
    expect(fail).toContain("**0/1 scenarios passed**");
    expect(fail).toContain("| controller-kill | controller | kill | 50 | 71.0 s | 60.0 s | **fail** |");
    expect(fail).toContain("failure: convergence 71000ms exceeded budget 60000ms");
  });

  it("counts JUnit cases and names only the failing ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "fault-matrix-"));
    writeFileSync(join(dir, "junit.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="tests/security" tests="3" failures="1" errors="0" skipped="1">
    <testcase name="denies direct egress" classname="network"/>
    <testcase name="blocks metadata endpoint" classname="network"><failure message="boom"/></testcase>
    <testcase name="warm pool" classname="warm-pool"><skipped/></testcase>
  </testsuite>
</testsuites>
`);
    expect(securitySummary(dir)).toEqual({
      testcases: 3,
      failures: 1,
      errors: 0,
      skipped: 1,
      failedTests: ["blocks metadata endpoint"],
    });
    expect(securitySummary(join(dir, "absent"))).toBeNull();
  });
});
