#!/usr/bin/env node
/**
 * Transfer pipelining feasibility probe.
 *
 * Measures two things against the live stack:
 *   1. window=1 steady-state cost per chunk (from acknowledged offsets),
 *   2. what happens when 1/2/4/8 chunk operations are issued genuinely
 *      concurrently for one transfer.
 *
 * The second measurement is deliberately reported as accepted/busy counts, not
 * as throughput. The current protocol enforces window=1, so this probe does not
 * pretend to measure a pipelined data path. It projects the best-case gain from
 * overlapping only the fixed per-chunk cost; per-byte work is assumed
 * serialized because the guest transfer manager holds one lock and the
 * controller/relay are single event loops.
 */
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxClient, type SessionHandle } from "@x402s/sdk";
import type { TransferOperation } from "@x402s/shared";

const MiB = 1024 * 1024;
const SIZE = Number(process.env.SIZE_MIB ?? 32) * MiB;
const CHUNK_SIZES = (process.env.CHUNKS ?? "524288,1048576").split(",").map(Number);
const WINDOWS = (process.env.WINDOWS ?? "1,2,4,8").split(",").map(Number);
const API = process.env.API_URL ?? "http://localhost:8080";

const client = new SandboxClient({ apiUrl: API, paymentMode: "mock", allowInsecureDev: true });
const dir = await mkdtemp(join(tmpdir(), "x402-pipeline-"));

type RawResult = { ok?: boolean; error?: { code?: string }; committedBytes?: number };
type Operations = {
  transfer(handle: SessionHandle, op: TransferOperation, requestId: string, timeoutMs: number): Promise<RawResult>;
};
const operations = (client as unknown as { operations: Operations }).operations;

function digest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fixture(size: number): Promise<string> {
  const path = join(dir, "payload.bin");
  const block = Buffer.alloc(Math.min(MiB, size), 0x5a);
  const out = createWriteStream(path);
  let left = size;
  while (left > 0) {
    const chunk = block.subarray(0, Math.min(block.length, left));
    out.write(chunk);
    left -= chunk.length;
  }
  await new Promise<void>((resolve) => out.end(resolve));
  return path;
}

async function rawOp(
  handle: SessionHandle,
  op: Record<string, unknown>,
): Promise<RawResult> {
  const requestId = randomBytes(16).toString("hex");
  return operations.transfer(handle, {
    v: 2,
    sessionId: handle.sessionId,
    clientNonce: handle.clientNonce,
    requestId,
    ...op,
  } as TransferOperation, requestId, 60_000);
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

async function windowOne(handle: SessionHandle, chunkSize: number, remotePath: string): Promise<{
  chunkSize: number;
  chunks: number;
  uploadMs: number;
  MiBs: number;
  meanChunkMs: number;
  p50ChunkMs: number;
  p95ChunkMs: number;
}> {
  const marks: number[] = [];
  const started = performance.now();
  await client.uploadFile(handle, join(dir, "payload.bin"), remotePath, {
    chunkSize,
    onProgress: (progress) => {
      if (progress.bytesTransferred > 0) marks.push(performance.now());
    },
  });
  const uploadMs = performance.now() - started;
  // The first mark includes init; later diffs are ack-to-ack steady state.
  const intervals = marks.slice(1).map((mark, index) => mark - marks[index]!);
  return {
    chunkSize,
    chunks: Math.ceil(SIZE / chunkSize),
    uploadMs: Math.round(uploadMs),
    MiBs: Number((SIZE / MiB / (uploadMs / 1000)).toFixed(2)),
    meanChunkMs: Number((intervals.reduce((sum, value) => sum + value, 0) / Math.max(1, intervals.length)).toFixed(2)),
    p50ChunkMs: Number(percentile(intervals, 0.5).toFixed(2)),
    p95ChunkMs: Number(percentile(intervals, 0.95).toFixed(2)),
  };
}

async function concurrentProbe(
  handle: SessionHandle,
  chunkSize: number,
  window: number,
): Promise<{
  window: number;
  attempted: number;
  accepted: number;
  acceptedOffsets: number[];
  acceptedOverlap: boolean;
  busy: number;
  other: number;
  otherCodes: Record<string, number>;
  batchMs: number;
}> {
  const transferId = randomBytes(16).toString("hex");
  const remotePath = `/workspace/probe-${window}-${randomBytes(4).toString("hex")}.bin`;
  await rawOp(handle, {
    op: "transfer.init",
    transferId,
    direction: "upload",
    path: remotePath,
    size: chunkSize * window,
    chunkSize,
    archive: false,
  });
  const dataBase64 = Buffer.alloc(chunkSize, 0x5a).toString("base64");
  const batchStart = performance.now();
  // Launch all requests before awaiting any of them: this is real concurrency,
  // not a loop over sequential chunks.
  const results = await Promise.all(Array.from({ length: window }, async (_, index) => {
    const start = performance.now();
    try {
      const value = await rawOp(handle, {
        op: "transfer.chunk",
        transferId,
        offset: index * chunkSize,
        dataBase64,
      });
      return { index, start, end: performance.now(), value, error: undefined };
    } catch (err) {
      return { index, start, end: performance.now(), value: undefined, error: err as { code?: string } };
    }
  }));
  const batchMs = performance.now() - batchStart;
  let accepted = 0;
  let busy = 0;
  let other = 0;
  const acceptedOffsets: number[] = [];
  const acceptedIntervals: Array<{ start: number; end: number }> = [];
  const otherCodes: Record<string, number> = {};
  for (const result of results) {
    const offset = result.index * chunkSize;
    if (result.value) {
      if (result.value.ok) {
        accepted += 1;
        acceptedOffsets.push(offset);
        acceptedIntervals.push({ start: result.start - batchStart, end: result.end - batchStart });
      } else {
        other += 1;
        const code = result.value.error?.code ?? "operation_error";
        otherCodes[code] = (otherCodes[code] ?? 0) + 1;
      }
    } else {
      const code = result.error?.code ?? "error";
      if (code === "session_busy") busy += 1;
      else {
        other += 1;
        otherCodes[code] = (otherCodes[code] ?? 0) + 1;
      }
    }
  }
  const ordered = [...acceptedIntervals].sort((a, b) => a.start - b.start);
  const acceptedOverlap = ordered.some((interval, index) => index > 0 && interval.start < ordered[index - 1]!.end);
  await rawOp(handle, { op: "transfer.cancel", transferId }).catch(() => undefined);
  return {
    window,
    attempted: window,
    accepted,
    acceptedOffsets,
    acceptedOverlap,
    busy,
    other,
    otherCodes,
    batchMs: Math.round(batchMs),
  };
}

function project(rows: Array<{ chunkSize: number; meanChunkMs: number }>, chunkSize: number): {
  fixedMs: number;
  perKiBMs: number;
  estimates: Array<{ window: number; chunkMs: number; speedup: number }>;
} | null {
  const small = rows.find((row) => row.chunkSize === 512 * 1024);
  const large = rows.find((row) => row.chunkSize === 1024 * 1024);
  if (!small || !large) return null;
  const perKiBMs = (large.meanChunkMs - small.meanChunkMs) / (1024 - 512);
  const fixedMs = small.meanChunkMs - perKiBMs * 512;
  const base = fixedMs + perKiBMs * (chunkSize / 1024);
  return {
    fixedMs: Number(fixedMs.toFixed(2)),
    perKiBMs: Number(perKiBMs.toFixed(4)),
    estimates: WINDOWS.map((window) => {
      // Fixed per-chunk work (seal, round trip, request handling) may overlap
      // with a window. Per-byte work remains serialized at the guest and on the
      // single event loops, so it is not divided by the window.
      const chunkMs = fixedMs / window + perKiBMs * (chunkSize / 1024);
      return {
        window,
        chunkMs: Number(chunkMs.toFixed(2)),
        speedup: Number((base / chunkMs).toFixed(2)),
      };
    }),
  };
}

const source = await fixture(SIZE);
const expected = await digest(source);
console.log(JSON.stringify({
  sizeMiB: SIZE / MiB,
  chunkSizes: CHUNK_SIZES,
  windows: WINDOWS,
  note: "concurrent windows measure gate behavior, not pipelined throughput",
}, null, 2));

const sandbox = await client.create({
  durationSeconds: 300,
  cpuMillis: 1000,
  memoryMiB: 1024,
  diskMiB: Math.max(256, Math.ceil(SIZE / MiB) + 64),
});
try {
  const windowOneRows = [];
  for (const chunkSize of CHUNK_SIZES) {
    const row = await windowOne(sandbox.handle, chunkSize, `/workspace/window1-${chunkSize}.bin`);
    windowOneRows.push(row);
    console.log(JSON.stringify({ windowOne: row }, null, 2));
  }

  const concurrencyRows = [];
  for (const window of WINDOWS) {
    const chunkSize = CHUNK_SIZES[0]!;
    const row = await concurrentProbe(sandbox.handle, chunkSize, window);
    concurrencyRows.push(row);
    console.log(JSON.stringify({ concurrency: row }, null, 2));
  }

  if ((await digest(join(dir, "payload.bin"))) !== expected) throw new Error("fixture changed");
  console.log(JSON.stringify({
    projections: CHUNK_SIZES.map((chunkSize) => ({
      chunkSize,
      ...project(windowOneRows, chunkSize),
    })),
    concurrency: concurrencyRows,
  }, null, 2));
} finally {
  await sandbox.destroy().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
