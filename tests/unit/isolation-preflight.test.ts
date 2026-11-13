/**
 * The release gate must not die silently, and must not let a release through
 * silently either. These pin the three states the preflight script decides:
 * a configured runner, a deliberate acknowledgement, and neither.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide, EVIDENCE_VALUES, skippedMessage } from "../../scripts/isolation-preflight.mjs";

const SCRIPT = join(process.cwd(), "scripts/isolation-preflight.mjs");
const RUNNER = JSON.stringify(["self-hosted", "linux", "x64", "sandbox-isolation"]);

function outputs(file: string): Record<string, string> {
  if (!readFileSync(file, "utf8").trim()) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

describe("isolation preflight decision", () => {
  it("runs the suites when a runner is configured", () => {
    const result = decide({ runner: RUNNER, evidence: "" });
    expect(result).toEqual({ ok: true, mode: "run", runner: RUNNER, message: "" });
  });

  it("skips only on an explicit acknowledgement from a dispatch run", () => {
    const result = decide({ runner: "", evidence: "none", dispatch: true });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("skip");
    // A skipped job still needs somewhere to run the warning step.
    expect(result.runner).toBe(JSON.stringify(["ubuntu-latest"]));
    expect(result.message).toContain("Isolation suites were not run for this tag");
    expect(result.message).toContain("isolation_skip=true");
    expect(result.message).toContain("unverified");
  });

  it("refuses the acknowledgement on a tag push, which is how the gate was skipped", () => {
    // This is the regression: until PR3 the skip came from a repository
    // variable, so a tag push could pass the gate without running anything.
    const result = decide({ runner: "", evidence: "none", dispatch: false });
    expect(result.ok).toBe(false);
    expect(result.mode).toBeNull();
    expect(result.message).toContain("only accepted from a workflow_dispatch run");
    expect(result.message).toContain("SANDBOX_ISOLATION_RUNNER");
  });

  it("blocks when neither is set, so the skip cannot be accidental", () => {
    const result = decide({ runner: "", evidence: "" });
    expect(result.ok).toBe(false);
    expect(result.mode).toBeNull();
    expect(result.message).toContain("SANDBOX_ISOLATION_RUNNER");
    expect(result.message).toContain("isolation_skip=true");
  });

  it("does not accept an unknown acknowledgement value", () => {
    const result = decide({ runner: "", evidence: "yes" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a recognised acknowledgement");
    expect(EVIDENCE_VALUES).toEqual(["none"]);
  });

  it("rejects a malformed runner or label list", () => {
    expect(decide({ runner: "self-hosted", evidence: "" }).message).toContain("not valid JSON");
    expect(decide({ runner: "[]", evidence: "" }).message).toContain("non-empty JSON array");
    expect(decide({ runner: '["self-hosted", ""]', evidence: "" }).message).toContain("non-empty JSON array");
  });

  it("never silently combines a runner with an acknowledgement", () => {
    // The runner wins: the suites run even if the acknowledgement was also set.
    const result = decide({ runner: RUNNER, evidence: "none", dispatch: true });
    expect(result.mode).toBe("run");
    expect(result.message).toBe("");
    expect(decide({ runner: RUNNER, evidence: "none" }).mode).toBe("run");
  });

  it("renders one warning block shared by the summary and the release notes", () => {
    expect(skippedMessage("none")).toBe(skippedMessage());
    expect(skippedMessage().split("\n")[0]).toBe("## ⚠️ Isolation suites were not run for this tag");
  });
});

describe("isolation preflight CLI", () => {
  function run(env: Record<string, string>): { status: number; output: Record<string, string>; summary: string; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), "x402-preflight-"));
    const outputFile = join(dir, "output");
    const summaryFile = join(dir, "summary");
    writeFileSync(outputFile, "");
    writeFileSync(summaryFile, "");
    let status = 0;
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [SCRIPT, "preflight"], {
        env: {
          ...process.env,
          // Pinned so the result does not depend on the event that happened to
          // start this CI run. A dispatch test overrides it explicitly.
          GITHUB_EVENT_NAME: "push",
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: summaryFile,
          ...env,
        },
        encoding: "utf8",
      });
    } catch (err) {
      const failure = err as { status?: number; stdout?: string };
      status = failure.status ?? 1;
      stdout = failure.stdout ?? "";
    }
    return {
      status,
      output: outputs(outputFile),
      summary: readFileSync(summaryFile, "utf8"),
      stdout,
    };
  }

  it("state 1: runner set, exits 0 and selects the run mode", () => {
    const result = run({ SANDBOX_ISOLATION_RUNNER: RUNNER, ISOLATION_EVIDENCE: "" });
    expect(result.status).toBe(0);
    expect(result.output).toEqual({ mode: "run", runner: RUNNER });
    expect(result.summary).toBe("");
  });

  it("state 2: dispatch acknowledgement, exits 0 and records the warning", () => {
    const result = run({
      SANDBOX_ISOLATION_RUNNER: "",
      ISOLATION_EVIDENCE: "none",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    });
    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({ mode: "skip", runner: JSON.stringify(["ubuntu-latest"]) });
    expect(result.summary).toContain("Isolation suites were not run for this tag");
    expect(result.summary).toContain("isolation_skip=true");
  });

  it("state 2 is unreachable from a tag push, even with the old variable set", () => {
    const result = run({
      SANDBOX_ISOLATION_RUNNER: "",
      ISOLATION_EVIDENCE: "none",
      GITHUB_EVENT_NAME: "push",
    });
    expect(result.status).toBe(1);
    expect(result.output).toEqual({});
    expect(result.stdout).toContain("only accepted from a workflow_dispatch run");
  });

  it("state 3: neither set, exits 1 with no mode and an error annotation", () => {
    const result = run({ SANDBOX_ISOLATION_RUNNER: "", ISOLATION_EVIDENCE: "" });
    expect(result.status).toBe(1);
    expect(result.output).toEqual({});
    expect(result.stdout).toContain("::error title=Isolation gate not configured::");
    expect(result.summary).toContain("Release blocked: no isolation evidence");
  });

  it("release-note mode is empty when the suites ran", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-preflight-"));
    const outputFile = join(dir, "output");
    writeFileSync(outputFile, "");
    execFileSync(process.execPath, [SCRIPT, "release-note"], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputFile,
        SANDBOX_ISOLATION_RUNNER: RUNNER,
        ISOLATION_EVIDENCE: "",
      },
      encoding: "utf8",
    });
    expect(readFileSync(outputFile, "utf8")).toContain("body<<EOF_BODY\n\nEOF_BODY");
  });
});
