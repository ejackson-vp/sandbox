/**
 * Minimal end-to-end SDK example: buy a session, run commands, move a file,
 * destroy the session.
 *
 *   API_URL=http://localhost:8080 npx tsx examples/sdk-session.ts
 */
import { SandboxClient, FileSessionStore } from "@x402s/sdk";

const apiUrl = process.env.API_URL ?? "http://localhost:8080";

const client = new SandboxClient({
  apiUrl,
  paymentMode: "mock",
  store: new FileSessionStore(),
});

const session = await client.createSession({ tier: "standard" });
console.log(`session: ${session.sessionId}`);

try {
  const ready = await client.waitForReady(session);
  console.log(
    `ready: ${ready.state}, expires ${ready.leaseExpiresAt}, ` +
      `attestation ${ready.attestation?.evidenceType} (insecureDevOnly=${ready.attestation?.insecureDevOnly})`,
  );

  const version = await client.exec(session, { command: ["python3", "--version"] });
  if (version.ok) console.log(`python: ${version.stdout.trim()}`);

  const write = await client.exec(session, {
    command: ["bash", "-c", "mkdir -p /workspace/out && echo 'hello from sdk' > /workspace/out/greeting.txt"],
  });
  if (!write.ok || write.exitCode !== 0) throw new Error("write failed");

  const read = await client.exec(session, { command: ["cat", "/workspace/out/greeting.txt"] });
  if (read.ok) console.log(`read: ${read.stdout.trim()}`);

  const list = await client.listFiles(session, "/workspace/out");
  if (list.ok) console.log(`files: ${list.entries.map((e) => e.path).join(", ")}`);

  const file = await client.getFile(session, "/workspace/out/greeting.txt");
  if (file.ok) console.log(`downloaded: ${Buffer.from(file.dataBase64, "base64").toString().trim()}`);

  const upload = await client.putFile(session, {
    path: "/workspace/out/script.js",
    data: Buffer.from('console.log("node inside the sandbox");\n'),
  });
  if (!upload.ok) throw new Error(`upload failed: ${upload.error?.code}`);

  const node = await client.exec(session, { command: ["node", "/workspace/out/script.js"] });
  if (node.ok) console.log(`node: ${node.stdout.trim()}`);
} finally {
  const final = await client.destroy(session);
  console.log(`destroyed: ${final?.state ?? "DESTROYED"}`);
}
