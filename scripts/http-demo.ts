#!/usr/bin/env node
/**
 * Per-session HTTP data plane demo.
 *
 * Starts a Python HTTP server inside the sandbox, then reaches it through the
 * relay. There is no inbound pod networking: the guest dials its own loopback
 * port and the response travels back in a sealed envelope.
 */
import { SandboxClient } from "../sdk/src/index.js";

const API = process.env.API_URL ?? "http://localhost:8080";

async function main(): Promise<void> {
  const client = new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    log: (line) => console.log(line),
  });

  const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
  await client.waitForReady(handle);
  await client.putFile(handle, { path: "index.html", data: Buffer.from("hello from the sandbox\n") });

  const service = await client.startService(handle, {
    name: "web",
    command: ["python3", "-m", "http.server", "18080", "--bind", "127.0.0.1"],
    port: 18080,
  });
  console.log(`service ${service.name} running on 127.0.0.1:${service.port}`);

  const response = await client.http(handle, { port: 18080, path: "/", method: "GET" });
  console.log(`HTTP ${response.status}; body ${JSON.stringify(response.body.toString().slice(0, 40))}`);

  const services = await client.listServices(handle);
  console.log(`services: ${services.map((s) => `${s.name}:${s.port}:${s.state}`).join(", ")}`);

  await client.stopService(handle, "web");
  await client.destroy(handle);

  if (response.status !== 200 || !response.body.toString().includes("hello from the sandbox")) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
