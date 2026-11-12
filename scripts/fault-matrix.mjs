#!/usr/bin/env node
/**
 * Cluster fault matrix runner and report writer.
 *
 *   node scripts/fault-matrix.mjs          run the matrix, write artifacts
 *   node scripts/fault-matrix.mjs report   summarise from artifacts only
 *
 * The fault harness (scripts/control-faults.ts) already measures
 * time-to-convergence, enforces CONVERGENCE_BUDGET_MS and exits nonzero on a
 * budget breach or a state assertion. This wrapper only sequences the real
 * scenarios, captures the JSON block each run prints, and turns the results
 * into artifacts a scheduled run can attach:
 *
 *   artifacts/faults/<case>.json    one machine-readable result per scenario
 *   artifacts/faults/<case>.log     full stdout/stderr of that scenario
 *   artifacts/faults/summary.json   every case plus pass/fail and failures
 *   artifacts/faults/summary.md     the same table as Markdown
 *
 * The harness is not modified: the JSON is the block it already prints. Run
 * with FAULT_MATRIX=smoke for a short subset, or a comma-separated case list.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAMESPACE = process.env.NAMESPACE ?? "sandbox-system";
const API_URL = process.env.API_URL ?? "http://localhost:8080";
const ARTIFACT_DIR = process.env.FAULT_ARTIFACT_DIR ?? join("artifacts", "faults");
const SECURITY_DIR = process.env.FAULT_SECURITY_ARTIFACT_DIR ?? join("artifacts", "security");
const FAIL_FAST = process.env.FAULT_FAIL_FAST === "1";

// Budgets match the defaults documented in docs/control-plane-faults.md.
const CASES = [
  { name: "controller-kill", target: "controller", action: "kill", scenario: "provisioning", sessions: 50, budgetMs: 60_000 },
  { name: "api-kill", target: "api", action: "kill", scenario: "provisioning", sessions: 20, budgetMs: 30_000 },
  { name: "relay-kill", target: "relay", action: "kill", scenario: "provisioning", sessions: 5, budgetMs: 120_000 },
  { name: "relay-create-restart", target: "relay", action: "kill", scenario: "create-restart", sessions: 5, budgetMs: 120_000 },
  { name: "lifecycle-restart", target: "controller", action: "kill", scenario: "lifecycle", sessions: 50, budgetMs: 120_000 },
  { name: "controller-pause", target: "controller", action: "pause", scenario: "provisioning", sessions: 5, budgetMs: 60_000 },
  { name: "api-pause", target: "api", action: "pause", scenario: "provisioning", sessions: 5, budgetMs: 30_000 },
  { name: "relay-pause", target: "relay", action: "pause", scenario: "provisioning", sessions: 5, budgetMs: 60_000 },
];

const PRESETS = {
  full: CASES.map((entry) => entry.name),
  smoke: ["api-kill", "controller-pause", "relay-pause"],
};

export function selectCases(requested = "full") {
  const value = requested.trim();
  const names = PRESETS[value] ?? value.split(",").map((name) => name.trim()).filter(Boolean);
  const known = new Map(CASES.map((entry) => [entry.name, entry]));
  const unknown = names.filter((name) => !known.has(name));
  if (names.length === 0 || unknown.length > 0) {
    throw new Error(`unknown FAULT_MATRIX value '${requested}' (cases: ${[...known.keys()].join(", ")})`);
  }
  return names.map((name) => known.get(name));
}

function selectedCases() {
  return selectCases(process.env.FAULT_MATRIX ?? "full");
}

/** Run the real Makefile target so nightly follows harness changes. */
function harnessCommand() {
  return { command: "make", args: ["test-control-faults"] };
}

/** Extract the last top-level JSON object the harness printed. */
export function extractReport(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (lines[start] !== "{") continue;
    for (let end = lines.length - 1; end > start; end -= 1) {
      if (lines[end] !== "}") continue;
      try {
        return JSON.parse(lines.slice(start, end + 1).join("\n"));
      } catch {
        /* keep shrinking the candidate */
      }
    }
  }
  return null;
}

function tail(text, limit = 40) {
  return text.split(/\r?\n/).filter(Boolean).slice(-limit).join("\n");
}

function kubectl(args, requestTimeout = "20s") {
  return execFileSync("kubectl", [...args, `--request-timeout=${requestTimeout}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function healthz(timeoutMs = 2_000) {
  try {
    const res = await fetch(`${API_URL}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Local runs and kind runners reach the API through a port-forward. Start one
 * when API_URL is loopback and nothing is listening, and tear it down after.
 */
async function ensureApi() {
  if (await healthz()) return () => {};
  const url = new URL(API_URL);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (!loopback) {
    throw new Error(`API ${API_URL}/healthz is unreachable and is not loopback, so no port-forward was attempted`);
  }
  const localPort = url.port || "80";
  const forward = spawn("kubectl", ["-n", NAMESPACE, "port-forward", "svc/api", `${localPort}:3000`], { stdio: "ignore" });
  forward.on("error", () => {});
  const stop = () => forward.kill("SIGTERM");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await healthz()) {
      console.log(`[fault-matrix] port-forwarded svc/api to ${API_URL}`);
      return stop;
    }
    if (forward.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  stop();
  throw new Error(`API ${API_URL}/healthz did not become ready (is the cluster deployed?)`);
}

function ensureCluster() {
  try {
    kubectl(["get", "namespace", NAMESPACE]);
  } catch (err) {
    if (err?.code === "ENOENT") throw new Error("kubectl is not installed or not on PATH");
    const detail = String(err?.stderr ?? "").trim().split("\n")[0] ?? "";
    throw new Error(
      `namespace ${NAMESPACE} is not reachable${detail ? ` (${detail})` : ""}: ` +
        `point KUBECONFIG at a deployed cluster (make up locally, or SANDBOX_FAULT_KUBECONFIG on the runner)`,
    );
  }
}

async function runCase(spec, index, total) {
  const startedAt = new Date();
  const started = Date.now();
  const { command, args } = harnessCommand();
  console.log(`\n[fault-matrix] ${index + 1}/${total} ${spec.name}: ${spec.target} ${spec.action} ` +
    `(${spec.scenario}, ${spec.sessions} sessions, budget ${spec.budgetMs}ms)`);

  const child = spawn(command, args, {
    env: {
      ...process.env,
      TARGET: spec.target,
      SCENARIO: spec.scenario,
      ACTION: spec.action,
      SESSIONS: String(spec.sessions),
      CONVERGENCE_BUDGET_MS: String(spec.budgetMs),
      REPEAT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  const exitCode = await new Promise((resolve) => {
    child.on("error", (err) => {
      stderr += `\n${err.message}\n`;
      resolve(127);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

  const durationMs = Date.now() - started;
  const report = extractReport(stdout);
  const failureReasons = [];
  if (exitCode !== 0) failureReasons.push(`make test-control-faults exited ${exitCode}`);
  if (!report) failureReasons.push("no JSON result was printed by the harness");
  if (report?.convergedMs != null && report.convergenceBudgetMs != null &&
      report.convergedMs > report.convergenceBudgetMs) {
    failureReasons.push(`convergence ${report.convergedMs}ms exceeded budget ${report.convergenceBudgetMs}ms`);
  }
  const passed = exitCode === 0 && report !== null && failureReasons.length === 0;

  const payload = {
    case: spec.name,
    target: spec.target,
    action: spec.action,
    scenario: spec.scenario,
    sessions: spec.sessions,
    budgetMs: spec.budgetMs,
    passed,
    exitCode,
    durationMs,
    convergedMs: report?.convergedMs ?? null,
    startedAt: startedAt.toISOString(),
    failureReasons,
    stderrTail: passed ? "" : tail(stderr),
    report,
  };

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(join(ARTIFACT_DIR, `${spec.name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(
    join(ARTIFACT_DIR, `${spec.name}.log`),
    [
      `# ${spec.name}: TARGET=${spec.target} SCENARIO=${spec.scenario} ACTION=${spec.action} ` +
        `SESSIONS=${spec.sessions} CONVERGENCE_BUDGET_MS=${spec.budgetMs}`,
      `# exit=${exitCode} durationMs=${durationMs} passed=${passed}`,
      "",
      stdout,
      stderr ? `\n--- stderr ---\n${stderr}` : "",
    ].join("\n"),
  );

  console.log(`[fault-matrix] ${spec.name}: ${passed ? "PASS" : "FAIL"}` +
    (report?.convergedMs != null ? ` (converged ${report.convergedMs}ms)` : ""));
  if (!passed) for (const reason of failureReasons) console.error(`[fault-matrix]   ${reason}`);
  return payload;
}

function seconds(ms) {
  return ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`;
}

function caseDetail(entry) {
  const report = entry.report;
  if (!report) return entry.failureReasons.join("; ") || "no result";
  switch (entry.case) {
    case "relay-kill":
      return `survived ${report.survived}/${report.count}, terminal ${report.terminal}, ` +
        `operations outcome-unknown ${report.operationsOutcomeUnknown ?? report.operationsUnresolved}/${report.count}, ` +
        `new execs ${report.newExecSucceeded}/${report.count}, pending ${report.pendingAtKill}, ` +
        `pods ${report.podCount}, reservations ${report.reservations?.total ?? "?"}`;
    case "relay-pause":
      return `operations ok ${report.operationsSucceeded}/${report.count}, terminal ${report.terminal}, ` +
        `pods ${report.podCount}, reservations ${report.reservations?.total ?? "?"}`;
    case "lifecycle-restart":
      return `restart ${seconds(report.restartConvergedMs)}, resume ${seconds(report.resumeMs)}, ` +
        `pods ${report.podsBeforeResume}→${report.podsAfterResume}, ` +
        `allocated ${report.reservationsBefore?.allocated}→${report.reservationsAfter?.allocated}, ` +
        `failures ${report.failures?.length ?? 0}`;
    default:
      return `pods ${report.podCount}/${report.count}, reservations ${report.reservations?.total ?? "?"} ` +
        `(allocated ${report.reservations?.allocated ?? "?"}), terminal ${report.terminal?.length ?? 0}, ` +
        `failures ${report.failures?.length ?? 0}`;
  }
}

/** Names of failing test cases in a JUnit XML file (self-closing tags included). */
function failedTestNames(xml) {
  const names = [];
  let index = 0;
  while ((index = xml.indexOf("<testcase", index)) !== -1) {
    const tagEnd = xml.indexOf(">", index);
    if (tagEnd === -1) break;
    const attrs = xml.slice(index + "<testcase".length, tagEnd);
    const selfClosing = attrs.trimEnd().endsWith("/");
    let body = "";
    let next = tagEnd + 1;
    if (!selfClosing) {
      const close = xml.indexOf("</testcase>", tagEnd);
      if (close === -1) break;
      body = xml.slice(tagEnd + 1, close);
      next = close + "</testcase>".length;
    }
    if (/<failure\b|<error\b/.test(body)) names.push(/name="([^"]*)"/.exec(attrs)?.[1] ?? "unnamed");
    index = next;
  }
  return names.slice(0, 10);
}

export function securitySummary(directory = SECURITY_DIR) {
  const file = join(directory, "junit.xml");
  if (!existsSync(file)) return null;
  const xml = readFileSync(file, "utf8");
  const count = (pattern) => (xml.match(pattern) ?? []).length;
  return {
    testcases: count(/<testcase\b/g),
    failures: count(/<failure\b/g),
    errors: count(/<error\b/g),
    skipped: count(/<skipped\b/g),
    failedTests: failedTestNames(xml),
  };
}

export function renderSummary(summary, security) {
  const rows = summary.cases.map((entry) =>
    `| ${entry.case} | ${entry.target} | ${entry.action} | ${entry.sessions} | ` +
    `${seconds(entry.convergedMs)} | ${seconds(entry.budgetMs)} | ${entry.passed ? "pass" : "**fail**"} |`);
  const lines = [
    `# Nightly cluster fault matrix`,
    "",
    `- Generated: ${summary.generatedAt}`,
    `- Preset: \`${summary.preset}\``,
    `- Cluster context: \`${summary.kubeContext}\` (namespace \`${summary.namespace}\`, API \`${summary.apiUrl}\`)`,
    `- Result: **${summary.passed}/${summary.cases.length} scenarios passed**`,
    "",
    "| Case | Target | Action | Sessions | Convergence | Budget | Result |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "## Scenario detail",
    "",
  ];
  for (const entry of summary.cases) {
    lines.push(`### ${entry.case} — ${entry.passed ? "pass" : "fail"}`, "", `- ${caseDetail(entry)}`);
    if (entry.failureReasons.length > 0) {
      lines.push(...entry.failureReasons.map((reason) => `- failure: ${reason}`));
    }
    if (entry.stderrTail) {
      lines.push("", "```", entry.stderrTail, "```");
    }
    lines.push("");
  }
  lines.push("## Cluster security suite", "");
  if (security) {
    lines.push(`- ${security.testcases} test cases, ${security.failures} failures, ` +
      `${security.errors} errors, ${security.skipped} skipped`);
    if (security.failedTests.length > 0) {
      lines.push(...security.failedTests.map((name) => `- failed: ${name}`));
    }
  } else {
    lines.push("- no `artifacts/security/junit.xml` was recorded");
  }
  lines.push("");
  return lines.join("\n");
}

function currentContext() {
  try {
    return kubectl(["config", "current-context"]);
  } catch {
    return "unknown";
  }
}

async function run() {
  const cases = selectedCases();
  ensureCluster();
  const stopForward = await ensureApi();
  const preset = process.env.FAULT_MATRIX ?? "full";
  const results = [];
  try {
    for (const [index, spec] of cases.entries()) {
      const result = await runCase(spec, index, cases.length);
      results.push(result);
      if (!result.passed && FAIL_FAST) break;
    }
  } finally {
    stopForward();
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    preset,
    apiUrl: API_URL,
    namespace: NAMESPACE,
    kubeContext: currentContext(),
    passed: results.filter((entry) => entry.passed).length,
    failed: results.filter((entry) => !entry.passed).length,
    cases: results,
  };
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(join(ARTIFACT_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const markdown = renderSummary(summary, securitySummary());
  writeFileSync(join(ARTIFACT_DIR, "summary.md"), markdown);

  console.log(`\n${markdown}`);
  console.log(`\n[fault-matrix] ${summary.passed}/${summary.cases.length} passed; artifacts in ${ARTIFACT_DIR}`);
  if (summary.failed > 0) process.exitCode = 1;
}

/** Emit CI annotations and the job summary from artifacts, without a cluster. */
function report() {
  const file = join(ARTIFACT_DIR, "summary.json");
  if (!existsSync(file)) {
    console.log("::error title=Fault matrix::no summary.json artifact; the matrix did not run");
    process.exitCode = 1;
    return;
  }
  const summary = JSON.parse(readFileSync(file, "utf8"));
  summary.passed = summary.cases.filter((entry) => entry.passed).length;
  summary.failed = summary.cases.length - summary.passed;
  const markdown = renderSummary(summary, securitySummary());
  writeFileSync(join(ARTIFACT_DIR, "summary.md"), markdown);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  for (const entry of summary.cases.filter((item) => !item.passed)) {
    console.log(`::error title=Fault matrix: ${entry.case}::${entry.failureReasons.join("; ") || "scenario failed"}`);
  }
  const security = securitySummary();
  if (security && security.failures + security.errors > 0) {
    console.log(`::error title=Cluster security suite::${security.failures} failures, ` +
      `${security.errors} errors (${security.failedTests.join(", ") || "see junit artifact"})`);
  }
  if (summary.failed > 0 || (security && security.failures + security.errors > 0)) process.exitCode = 1;
}

const command = process.argv[2] ?? "run";
const invokedDirectly = Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!invokedDirectly) {
  // Imported for tests: only the exported helpers are used.
} else if (command === "report") {
  report();
} else if (command === "run") {
  run().catch((err) => {
    console.error(`[fault-matrix] ${err.message}`);
    process.exitCode = 1;
  });
} else {
  console.error(`unknown command '${command}' (expected: run, report)`);
  process.exitCode = 2;
}
