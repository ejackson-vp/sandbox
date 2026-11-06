#!/usr/bin/env node
/** Directory archive round trip: many small files, streamed as a safe tar.gz. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxClient } from "@x402s/sdk";

const dir = await mkdtemp(join(tmpdir(), "x402-dir-"));
const source = join(dir, "source");
const restored = join(dir, "restored");
await mkdir(source);
const hashes: string[] = [];
for (let i = 0; i < 80; i += 1) {
  const data = Buffer.alloc(32 * 1024);
  for (let j = 0; j < data.length; j += 1) data[j] = (i * 31 + j) & 0xff;
  const path = join(source, `file-${String(i).padStart(3, "0")}.bin`);
  await writeFile(path, data);
  hashes.push(createHash("sha256").update(data).digest("hex"));
}

const client = new SandboxClient({ apiUrl: process.env.API_URL ?? "http://localhost:8080", paymentMode: "mock", allowInsecureDev: true });
let sandbox;
try {
  sandbox = await client.create({ durationSeconds: 300, cpuMillis: 1000, memoryMiB: 1024, diskMiB: 1024 });
  await sandbox.upload(source, "/workspace/dataset");
  const count = await sandbox.exec({ command: ["bash", "-lc", "find /workspace/dataset -type f | wc -l"] });
  if (!count.ok || count.stdout.trim() !== "80") {
    const listing = await sandbox.exec({ command: ["bash", "-lc", "find /workspace/dataset -type f | head -10; find /workspace/dataset -type f | wc -l"] });
    throw new Error(`guest file count: ${count.stdout}; listing: ${"stdout" in listing ? listing.stdout : ""}`);
  }
  await sandbox.download("/workspace/dataset", restored, { archive: true });
  for (let i = 0; i < 80; i += 1) {
    const data = await readFile(join(restored, `file-${String(i).padStart(3, "0")}.bin`));
    if (createHash("sha256").update(data).digest("hex") !== hashes[i]) throw new Error(`file ${i} mismatch`);
  }
  console.log("directory archive: 80 files round trip OK");
} finally {
  if (sandbox) await sandbox.destroy().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
