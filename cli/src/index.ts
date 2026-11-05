#!/usr/bin/env node
/**
 * `sandbox` CLI.
 *
 *   sandbox run hello.py --duration 60 --allow-insecure-dev --payment-mode mock
 *   sandbox agent-demo hello.py --allow-insecure-dev
 *   sandbox pricing
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPayer, type PaymentMode } from "./payment.js";
import { runWorkflow, type RunOutcome } from "./workflow.js";
import { createAgentPayer } from "./agent-demo.js";

const HELP = `x402 confidential sandbox client

Usage:
  sandbox run <file.py> [options]      buy one execution and run the file
  sandbox agent-demo <file.py>         same, using the x402 client SDK end to end
  sandbox pricing                      show the server's current price
  sandbox version

Options:
  --duration <seconds>        execution window, 1..60 (default 60)
  --payment-mode <mode>       mock | testnet (default mock)
  --api-url <url>             API base URL (default http://localhost:8080)
  --allow-insecure-dev        required to accept simulated attestation
  --require-hardware          reject anything that is not hardware-attested
  --expected-measurement <h>  pin the guest measurement (hex sha256)
  --keep                      do not destroy the sandbox after the run
  --json                      machine-readable output
  --quiet                     suppress progress notes
  -h, --help
`;

function num(value: string | undefined, def: number): number {
  if (value === undefined) return def;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`invalid number: ${value}`);
  return n;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      duration: { type: "string", default: "60" },
      "payment-mode": { type: "string", default: "mock" },
      "api-url": { type: "string", default: "http://localhost:8080" },
      "allow-insecure-dev": { type: "boolean", default: false },
      "require-hardware": { type: "boolean", default: false },
      "expected-measurement": { type: "string" },
      keep: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0] ?? "help";
  if (values.help || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "version") {
    process.stdout.write("sandbox 0.1.0\n");
    return 0;
  }

  const apiUrl = String(values["api-url"]);

  if (command === "pricing") {
    const res = await fetch(`${apiUrl}/v1/pricing`);
    const body = await res.json();
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return res.ok ? 0 : 1;
  }

  if (command !== "run" && command !== "agent-demo") {
    process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
    return 2;
  }

  const file = positionals[1];
  if (!file) {
    process.stderr.write("missing <file.py>\n");
    return 2;
  }

  const paymentMode = String(values["payment-mode"]) as PaymentMode;
  if (paymentMode !== "mock" && paymentMode !== "testnet") {
    process.stderr.write(`invalid --payment-mode: ${paymentMode}\n`);
    return 2;
  }

  const durationSeconds = Math.trunc(num(values.duration as string, 60));
  if (durationSeconds < 1 || durationSeconds > 60) {
    process.stderr.write("--duration must be between 1 and 60 seconds\n");
    return 2;
  }

  const allowInsecureDev = Boolean(values["allow-insecure-dev"]);
  const requireHardware = Boolean(values["require-hardware"]);
  const json = Boolean(values.json);
  const quiet = Boolean(values.quiet);

  if (!allowInsecureDev && !requireHardware) {
    process.stderr.write(
      "refusing to run: simulated attestation requires --allow-insecure-dev\n" +
        "(or pass --require-hardware to demand SEV-SNP/TDX evidence, which this deployment does not provide)\n",
    );
    return 2;
  }

  const code = await readFile(file, "utf8");
  const say = (line: string) => {
    if (!json) process.stdout.write(line + "\n");
  };
  const note = (line: string) => {
    if (!json && !quiet) process.stderr.write(line + "\n");
  };

  const payer =
    command === "agent-demo"
      ? await createAgentPayer(paymentMode, apiUrl, json ? () => {} : (l) => process.stderr.write(`agent: ${l}\n`))
      : createPayer(paymentMode);

  const started = Date.now();
  const outcome = await runWorkflow({
    apiUrl,
    code,
    durationSeconds,
    allowInsecureDev,
    requireHardware,
    expectedMeasurement: values["expected-measurement"] as string | undefined,
    keepSandbox: Boolean(values.keep),
    json,
    payer,
    say,
    note,
  });

  render(outcome, { json, quiet });
  if (!outcome.result) return 1;
  if (outcome.result.timedOut) return 124; // conventional timeout code
  return Math.max(0, Math.min(125, outcome.result.exitCode));
}

function render(outcome: RunOutcome, opts: { json: boolean; quiet: boolean }): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
    return;
  }
  if (outcome.error) {
    process.stderr.write(`\nError: ${outcome.error}\n`);
    process.stderr.write(`Sandbox: ${outcome.state.toLowerCase()}\n`);
    return;
  }
  const result = outcome.result!;
  process.stdout.write("\n");
  if (result.stdout) {
    process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
  }
  if (result.stderr) {
    process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : result.stderr + "\n");
  }
  process.stdout.write("\n");
  process.stdout.write(`Exit code: ${result.exitCode}\n`);
  process.stdout.write(`Execution: ${(result.durationMs / 1000).toFixed(1)}s\n`);
  if (result.timedOut) process.stdout.write("Timed out: yes (execution budget exhausted)\n");
  if (result.truncated.stdout || result.truncated.stderr) {
    process.stdout.write("Output truncated: yes (size limit reached)\n");
  }
  process.stdout.write(`Sandbox: ${outcome.state.toLowerCase()}\n`);

  if (!opts.quiet) {
    const insecure = outcome.attestation?.insecureDevOnly ?? true;
    if (insecure) {
      process.stderr.write(
        "\n! SIMULATED ATTESTATION (INSECURE_DEV_ONLY): code ran in a non-confidential sandbox.\n" +
          "! Do not use this mode for secrets or hostile code.\n",
      );
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: Error) => {
    process.stderr.write(`fatal: ${err.message}\n`);
    process.exit(1);
  });
