import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

function imagePresent(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", "x402-sandbox/guest:dev"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!imagePresent())("browser workload compatibility", () => {
  it("documents that the stock guest image has no Chromium runtime", () => {
    const found = execFileSync("docker", [
      "run", "--rm", "--entrypoint", "/bin/sh", "x402-sandbox/guest:dev",
      "-c", "command -v chromium || command -v chromium-browser || command -v google-chrome || true",
    ], { encoding: "utf8" }).trim();
    expect(found).toBe("");
  });
});
