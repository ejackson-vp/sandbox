#!/usr/bin/env node
/**
 * SSE demo: a Python event-stream server in the sandbox, read chunk-by-chunk
 * through the sealed relay.
 */
import { SandboxClient } from "../sdk/src/index.js";

const API = process.env.API_URL ?? "http://localhost:8080";

const SSE_SERVER = [
  "from http.server import BaseHTTPRequestHandler, HTTPServer",
  "import time",
  "class H(BaseHTTPRequestHandler):",
  "    def do_GET(self):",
  "        self.send_response(200)",
  "        self.send_header('Content-Type', 'text/event-stream')",
  "        self.end_headers()",
  "        for i in range(5):",
  "            self.wfile.write(f'data: tick {i}\\n\\n'.encode())",
  "            self.wfile.flush()",
  "            time.sleep(0.2)",
  "HTTPServer(('127.0.0.1', 18082), H).serve_forever()",
].join("\n");

async function main(): Promise<void> {
  const client = new SandboxClient({
    apiUrl: API,
    paymentMode: "mock",
    allowInsecureDev: true,
    log: (line) => console.log(line),
  });

  const handle = await client.createSession({ tier: "custom", durationSeconds: 60 });
  await client.waitForReady(handle);
  await client.putFile(handle, { path: "sse.py", data: Buffer.from(SSE_SERVER) });
  await client.startService(handle, { name: "sse", command: ["python3", "sse.py"], port: 18082 });

  const stream = await client.openHttpStream(handle, { port: 18082, path: "/events" });
  let text = "";
  let done = false;
  while (!done) {
    const part = await stream.read();
    if (part.chunk) {
      text += part.chunk.toString();
      process.stdout.write(part.chunk);
    }
    done = part.done;
  }
  await stream.close();
  await client.stopService(handle, "sse");
  await client.destroy(handle);

  if (!text.includes("tick 0") || !text.includes("tick 4")) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
