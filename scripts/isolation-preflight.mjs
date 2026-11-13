/**
 * Decide whether the release isolation gate runs, is deliberately skipped, or
 * blocks the tag.
 *
 * `security-review/RELEASE_GATE.md` treats isolation as evidence, so the gate
 * fails closed by default. A release owner may still ship without it, but only
 * by dispatching the release by hand with `isolation_skip: true`. A tag push
 * cannot skip: the repository variable this used to read (`ISOLATION_EVIDENCE`)
 * made every tag since v0.1.26 a no-op, so the acknowledgement is now an input
 * that only exists on a workflow_dispatch run and is stamped on the job summary
 * and the release notes when it is used.
 *
 * Three states:
 *   SANDBOX_ISOLATION_RUNNER set         -> run the suites (preferred)
 *   dispatch + ISOLATION_EVIDENCE=none   -> skip, and record the acknowledgement
 *   neither                              -> fail the tag
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
 * @param {{ runner?: string, evidence?: string, dispatch?: boolean }} input
 *   `dispatch` is true only for a `workflow_dispatch` run. Evidence is refused
 *   otherwise, so a tag push cannot reach the skip state even if a future edit
 *   pipes the old repository variable back into the environment.
 * @returns {{ ok: boolean, mode: "run" | "skip" | null, runner: string, message: string }}
 */
export function decide({ runner, evidence, dispatch = false } = {}) {
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

  if (rawEvidence && !EVIDENCE_VALUES.includes(rawEvidence)) {
    // Checked before the trigger so a typo is answered as a typo, not as a
    // policy violation the reader has to work out for themselves.
    return {
      ok: false,
      mode: null,
      runner: "",
      message:
        `ISOLATION_EVIDENCE='${rawEvidence}' is not a recognised acknowledgement ` +
        `(expected: ${EVIDENCE_VALUES.join(", ")})`,
    };
  }

  if (rawEvidence && !dispatch) {
    return {
      ok: false,
      mode: null,
      runner: "",
      message:
        "ISOLATION_EVIDENCE is only accepted from a workflow_dispatch run. A tag push " +
        "must run the suites: set SANDBOX_ISOLATION_RUNNER. To ship without them, " +
        "re-run the release with `gh workflow run release.yml --ref <tag> -f " +
        "isolation_skip=true`, which stamps the skip on the release notes.",
    };
  }

  if (rawEvidence) {
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
      "(preferred), or re-run the release with `gh workflow run release.yml --ref " +
      "<tag> -f isolation_skip=true` to record a deliberate skip on the notes",
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
    "were **not verified** by them. This release continues only because a",
    `workflow_dispatch run set \`isolation_skip=true\` (acknowledgement \`${evidence}\`):`,
    "a tag push cannot take this path.",
    "",
    "Set `SANDBOX_ISOLATION_RUNNER` and re-run the release without the skip",
    "input. See docs/release-process.md#isolation-gate.",
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

/** A skip is possible only on a dispatch run; the workflow enforces it too. */
function isDispatch() {
  return process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
}

function preflight() {
  const result = decide({
    runner: process.env.SANDBOX_ISOLATION_RUNNER,
    evidence: process.env.ISOLATION_EVIDENCE,
    dispatch: isDispatch(),
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
    console.log(
      "::warning title=Isolation gate skipped::the dispatch run set isolation_skip, so the suites did not run.",
    );
    return;
  }
  console.log(`isolation gate: runner ${result.runner}`);
}

function summary() {
  const result = decide({
    runner: process.env.SANDBOX_ISOLATION_RUNNER,
    evidence: process.env.ISOLATION_EVIDENCE,
    dispatch: isDispatch(),
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
    dispatch: isDispatch(),
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
