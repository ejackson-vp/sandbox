/**
 * Decide whether the release isolation gate runs, is deliberately skipped, or
 * blocks the tag.
 *
 * `security-review/RELEASE_GATE.md` treats isolation as evidence, so the gate
 * fails closed by default. Eric's decision: a release owner may skip it on
 * purpose, but only by stating so in a repository variable, and the skip is
 * stamped on the job summary and the release notes. Neither variable set is
 * still a failure, so a skip cannot happen by forgetting to configure a runner.
 *
 * Three states:
 *   SANDBOX_ISOLATION_RUNNER set   -> run the suites (preferred)
 *   ISOLATION_EVIDENCE=none        -> skip, and record the acknowledgement
 *   neither                        -> fail the tag
 *
 * Exported for tests; run directly by the workflow.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The only acknowledgement value. A typo must not silently skip the gate. */
export const EVIDENCE_VALUES = ["none"];

const RUNNER_PLACEHOLDER = JSON.stringify(["ubuntu-latest"]);

/**
 * @param {{ runner?: string, evidence?: string }} input
 * @returns {{ ok: boolean, mode: "run" | "skip" | null, runner: string, message: string }}
 */
export function decide({ runner, evidence } = {}) {
  const rawRunner = String(runner ?? "").trim();
  const rawEvidence = String(evidence ?? "").trim();

  if (rawRunner) {
    let labels;
    try {
      labels = JSON.parse(rawRunner);
    } catch {
      return {
        ok: false,
        mode: null,
        runner: "",
        message: `SANDBOX_ISOLATION_RUNNER is not valid JSON: ${rawRunner}`,
      };
    }
    if (
      !Array.isArray(labels) ||
      labels.length === 0 ||
      labels.some((label) => typeof label !== "string" || label.trim() === "")
    ) {
      return {
        ok: false,
        mode: null,
        runner: "",
        message: "SANDBOX_ISOLATION_RUNNER must be a non-empty JSON array of runner label strings",
      };
    }
    return { ok: true, mode: "run", runner: rawRunner, message: "" };
  }

  if (rawEvidence) {
    if (!EVIDENCE_VALUES.includes(rawEvidence)) {
      return {
        ok: false,
        mode: null,
        runner: "",
        message:
          `ISOLATION_EVIDENCE='${rawEvidence}' is not a recognised acknowledgement ` +
          `(expected: ${EVIDENCE_VALUES.join(", ")})`,
      };
    }
    return {
      ok: true,
      mode: "skip",
      // A skipped job still needs a runner; hosted is enough for the warning.
      runner: RUNNER_PLACEHOLDER,
      message: skippedMessage(rawEvidence),
    };
  }

  return {
    ok: false,
    mode: null,
    runner: "",
    message:
      "no isolation runner and no acknowledgement: set SANDBOX_ISOLATION_RUNNER " +
      "(preferred), or ISOLATION_EVIDENCE=none to record a deliberate skip",
  };
}

/**
 * The warning shown in the job summary and the release notes. Shared so the two
 * cannot drift; the release step prints this exact block.
 */
export function skippedMessage(evidence = "none") {
  return [
    "## ⚠️ Isolation suites were not run for this tag",
    "",
    "The Cilium packet-level suite and the Kata boot probe did not execute, so",
    "tenant isolation is **unverified** and the control and guest image digests",
    "were **not verified** by them. This release continues only because the",
    `repository variable \`ISOLATION_EVIDENCE=${evidence}\` acknowledges the skip.`,
    "",
    "Set `SANDBOX_ISOLATION_RUNNER`, re-run the release, and remove",
    "`ISOLATION_EVIDENCE`. See docs/release-process.md#isolation-gate.",
  ].join("\n");
}

function appendSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function writeOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
}

/** Multiline GITHUB_OUTPUT uses a delimiter, never raw newlines. */
function writeMultiline(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `EOF_${name.toUpperCase()}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function preflight() {
  const result = decide({
    runner: process.env.SANDBOX_ISOLATION_RUNNER,
    evidence: process.env.ISOLATION_EVIDENCE,
  });
  if (!result.ok) {
    console.log(`::error title=Isolation gate not configured::${result.message}`);
    appendSummary(`### Release blocked: no isolation evidence\n\n${result.message}`);
    process.exitCode = 1;
    return;
  }
  writeOutputs({ mode: result.mode, runner: result.runner });
  if (result.mode === "skip") {
    console.log(result.message);
    appendSummary(result.message);
    console.log("::warning title=Isolation gate skipped::ISOLATION_EVIDENCE is set, so the suites did not run.");
    return;
  }
  console.log(`isolation gate: runner ${result.runner}`);
}

function summary() {
  const result = decide({
    runner: process.env.SANDBOX_ISOLATION_RUNNER,
    evidence: process.env.ISOLATION_EVIDENCE,
  });
  if (result.mode !== "skip") return;
  console.log(result.message);
  appendSummary(result.message);
}

/**
 * Body fragment for the GitHub Release. Empty when the suites ran. If the
 * preflight is unconfigured this returns empty rather than failing: by the time
 * this step runs the tags are already promoted, and a failure here would leave
 * a promoted release with no entry at all. The preflight job is what blocks
 * that state before promotion.
 */
function releaseNote() {
  const result = decide({
    runner: process.env.SANDBOX_ISOLATION_RUNNER,
    evidence: process.env.ISOLATION_EVIDENCE,
  });
  const body = result.mode === "skip" ? result.message : "";
  writeMultiline("body", body);
  if (body) console.log(body);
}

const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const command = process.argv[2] ?? "preflight";
  if (command === "preflight") preflight();
  else if (command === "summary") summary();
  else if (command === "release-note") releaseNote();
  else {
    console.error(`unknown command '${command}' (expected: preflight, summary, release-note)`);
    process.exitCode = 2;
  }
}
