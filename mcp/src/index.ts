#!/usr/bin/env node
/**
 * throwbox as an MCP server.
 *
 * The point of the pairing: an agent that can already pay for things over x402
 * can buy a machine for one command without a human, an account or a key. The
 * client that launches this server holds the wallet; the server quotes, pays,
 * executes and destroys, and nothing about the wallet reaches the model.
 *
 * stdout is the MCP channel. Everything a human might read goes to stderr, or
 * the transport desynchronises and the client drops the server.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SandboxClient } from "@x402s/sdk";
import { z } from "zod";
import { loadMcpConfig } from "./config.js";
import { readPricing, renderRun, runOne, type RunInput } from "./tools.js";

const VERSION = "0.1.0";

const RUN_DESCRIPTION =
  "Run one shell command in a fresh, disposable Linux machine and return its output. " +
  "The machine is created for this call and destroyed when it returns: no session is left " +
  "behind, and nothing written to /workspace survives. Paid per call in USDC over x402. " +
  "Use pricing first when the cost matters.";

/** The tool surface. Kept in one place so the advertised schema is auditable. */
const runSchema = {
  command: z.string().min(1).describe("Shell command line, run as /bin/sh -lc."),
  files: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .optional()
    .describe("Files written under /workspace before the command, by relative path."),
  tier: z
    .enum(["short", "standard", "extended", "long"])
    .optional()
    .describe("Session size and lease. Defaults to the server's THROWBOX_TIER."),
  runtime: z
    .enum(["base", "python", "node"])
    .optional()
    .describe("Guest runtime profile. Defaults to base."),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe("Wall-clock cap for the command, below the lease."),
};

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `${message}\n\nNo session was left behind. The payment path is: 402 quote, sign, settle, create. A refused payment means the wallet in EVM_PRIVATE_KEY is unfunded or the price changed; both answer on pricing.`,
      },
    ],
  };
}

async function main(): Promise<void> {
  const config = loadMcpConfig();
  const client = new SandboxClient({
    apiUrl: config.apiUrl,
    paymentMode: config.paymentMode,
    log: (line) => process.stderr.write(`throwbox-mcp: ${line}\n`),
  });
  const server = new McpServer({ name: "throwbox", version: VERSION });

  server.registerTool(
    "pricing",
    {
      title: "throwbox pricing",
      description:
        "The live price table: tiers, lease length, machine size and the payment network. " +
        "Free to call, and the cheapest way to answer what a run will cost.",
      inputSchema: {},
    },
    async () => {
      try {
        return text(JSON.stringify(await readPricing(config.apiUrl), null, 2));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "run",
    { title: "run in a throwbox", description: RUN_DESCRIPTION, inputSchema: runSchema },
    async (args: RunInput) => {
      try {
        return text(renderRun(await runOne(client, config, args)));
      } catch (error) {
        return failure(error);
      }
    },
  );

  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `throwbox-mcp: ready (${config.apiUrl}, ${config.paymentMode}, default tier ${config.defaultTier})\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`throwbox-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
