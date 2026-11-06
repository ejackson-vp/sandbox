#!/usr/bin/env node
/** WebSocket round-trip through the sealed relay. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxClient } from "../sdk/src/index.js";

const API = process.env.API_URL ?? "http://localhost:8080";

async function main(): Promise<void> {
  const client = new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    log: (line) => console.log(line),
  });
  const server = readFileSync(join(process.cwd(), "scripts/ws-echo-server.js"));

  const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
  await client.waitForReady(handle);
  await client.putFile(handle, { path: "ws-echo-server.js", data: server });
  await client.startService(handle, {
    name: "ws",
    command: ["node", "ws-echo-server.js"],
    port: 18084,
  });

  const ws = await client.openWebSocket(handle, { port: 18084, path: "/" });
  await ws.send("hello-ws");
  const reply = await ws.read();
  console.log(`ws reply: ${reply.data?.toString() ?? "<none>"} (binary=${reply.binary})`);
  await ws.close();
  await client.stopService(handle, "ws");
  await client.destroy(handle);

  if (reply.data?.toString() !== "hello-ws") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
