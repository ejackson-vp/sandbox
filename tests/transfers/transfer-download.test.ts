/**
 * Download is the same loop as upload with the checks on the other side.
 *
 * The guest hashes the source once at init and serves a window per read; the
 * client writes each window at the offset it asked for, then hashes the local
 * part file and compares. Two failures matter more than the rest. A gap or a
 * duplicate in the sequence produces a file that is quietly wrong until the
 * digest catches it, and a digest mismatch must be refused: the destination is
 * published by renaming the part file, so any path that renames before
 * verifying hands the caller a corrupt file at the name they trusted. The part
 * file also makes resume possible, which is why the local size has to agree
 * with the offset the guest acknowledges before a single read is issued.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHUNK_SIZE,
  TransferError,
  TransferService,
  type TransferProgress,
} from "../../sdk/src/transfers.js";
import { FakeTransferGuest, SESSION, sha256 } from "../helpers/transfer-guest.js";

const MIN_CHUNK = 64 * 1024;

let dir: string;
let seq = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "x402-download-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function local(): string {
  return join(dir, `out${seq++}.bin`);
}

/** How many file descriptors this process holds. `/dev/fd` is `/proc/self/fd`
 * on Linux, and the count only moves when something is opened or closed. */
function openFileCount(): number {
  return readdirSync("/dev/fd").length;
}

function partPath(localPath: string, transferId: string): string {
  return `${localPath}.x402-part-${transferId}`;
}

function harness(source: Buffer, withDigest = true) {
  const guest = new FakeTransferGuest();
  guest.content = source;
  if (withDigest) guest.digest = sha256(source);
  return { guest, transfers: new TransferService(guest.service) };
}

async function failure(promise: Promise<unknown>): Promise<TransferError> {
  return promise.then(
    () => {
      throw new Error("expected the transfer to fail");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(TransferError);
      return error as TransferError;
    },
  );
}

describe("download", () => {
  it("reads the source in order, verifies it and renames the part into place", async () => {
    const source = Buffer.alloc(2 * MIN_CHUNK + 100, 0x71);
    const { guest, transfers } = harness(source);
    const target = local();

    const outcome = await transfers.download(SESSION, "/workspace/source.bin", target, {
      chunkSize: MIN_CHUNK,
    });

    expect(guest.opNames()).toEqual(["transfer.init", "transfer.read", "transfer.read", "transfer.read"]);
    // Each read asks for the window at the offset already written, and the last
    // one is clamped to what remains rather than a full chunk.
    expect(guest.calls.filter((call) => call.operation.op === "transfer.read").map((call) => call.operation)).toMatchObject([
      { offset: 0, maxBytes: MIN_CHUNK },
      { offset: MIN_CHUNK, maxBytes: MIN_CHUNK },
      { offset: 2 * MIN_CHUNK, maxBytes: 100 },
    ]);
    expect(guest.init()).toMatchObject({
      op: "transfer.init",
      direction: "download",
      path: "/workspace/source.bin",
      chunkSize: MIN_CHUNK,
      archive: false,
    });

    expect(readFileSync(target).equals(source)).toBe(true);
    expect(existsSync(partPath(target, outcome.transferId))).toBe(false);
    expect(outcome).toEqual({
      transferId: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
      bytesTransferred: source.length,
      digest: sha256(source),
    });
    // A download never issues complete: the guest already hashed the source and
    // the client is the one verifying.
    expect(guest.opNames()).not.toContain("transfer.complete");
  });

  it("creates the destination directory and reports progress as bytes land", async () => {
    const source = Buffer.alloc(MIN_CHUNK + 5, 0x72);
    const { transfers } = harness(source);
    const target = join(dir, "nested", "deeper", "out.bin");
    const seen: TransferProgress[] = [];

    const outcome = await transfers.download(SESSION, "/workspace/s.bin", target, {
      chunkSize: MIN_CHUNK,
      onProgress: (progress) => seen.push(progress),
    });

    expect(existsSync(target)).toBe(true);
    expect(seen.map((progress) => progress.bytesTransferred)).toEqual([0, MIN_CHUNK, MIN_CHUNK + 5]);
    for (const progress of seen) {
      expect(progress).toMatchObject({
        transferId: outcome.transferId,
        direction: "download",
        totalBytes: source.length,
      });
    }
  });

  it("uses the default chunk size as the read window when none is given", async () => {
    const source = Buffer.alloc(4_096, 0x73);
    const { guest, transfers } = harness(source);

    await transfers.download(SESSION, "/workspace/s.bin", local());

    expect(guest.init().chunkSize).toBe(DEFAULT_CHUNK_SIZE);
    expect(guest.calls.filter((call) => call.operation.op === "transfer.read")).toHaveLength(1);
  });

  it("completes an empty source without issuing a read", async () => {
    const { guest, transfers } = harness(Buffer.alloc(0));
    const target = local();

    const outcome = await transfers.download(SESSION, "/workspace/empty.bin", target);

    expect(guest.opNames()).toEqual(["transfer.init"]);
    expect(readFileSync(target)).toHaveLength(0);
    expect(outcome.bytesTransferred).toBe(0);
    expect(outcome.digest).toBe(sha256(""));
  });

  it("skips digest verification when the guest reports no digest", async () => {
    const source = Buffer.alloc(MIN_CHUNK, 0x74);
    const { transfers } = harness(source, false);
    const target = local();

    const outcome = await transfers.download(SESSION, "/workspace/s.bin", target, {
      chunkSize: MIN_CHUNK,
    });

    // Nothing to compare against, so the local hash is reported but not used as
    // a gate.
    expect(readFileSync(target).equals(source)).toBe(true);
    expect(outcome.digest).toBe(sha256(source));
  });

  it("refuses a download whose digest does not match and never publishes it", async () => {
    const source = Buffer.alloc(MIN_CHUNK, 0x75);
    const { guest, transfers } = harness(source);
    guest.digest = "0".repeat(64);
    const target = local();

    const error = await failure(
      transfers.download(SESSION, "/workspace/s.bin", target, { chunkSize: MIN_CHUNK }),
    );

    expect(error.name).toBe("TransferError");
    expect(error.code).toBe("integrity_failed");
    expect(error.message).toBe("downloaded file SHA-256 does not match the source");
    // The rename is the publication step; a mismatch must die before it.
    expect(existsSync(target)).toBe(false);
    // The guest already completed its side, so there is nothing to cancel.
    expect(guest.cancels).toBe(0);
    expect(guest.opNames()).not.toContain("transfer.cancel");
  });

  it("refuses a duplicate window instead of writing it into the file", async () => {
    const source = Buffer.from(Array.from({ length: 2 * MIN_CHUNK + 50 }, (_, i) => i % 251));
    const { guest, transfers } = harness(source);
    const target = local();
    // A guest that ignores the offset it was asked for and serves the first
    // window again. The bytes look fine at every step; only the digest can see
    // that the middle of the file is a copy of the start.
    guest.on = (call) => {
      if (call.operation.op === "transfer.read") {
        return guest.answer({
          chunkBase64: source.subarray(0, call.operation.maxBytes).toString("base64"),
        });
      }
    };

    const error = await failure(
      transfers.download(SESSION, "/workspace/s.bin", target, { chunkSize: MIN_CHUNK }),
    );

    expect(error.code).toBe("integrity_failed");
    expect(existsSync(target)).toBe(false);
  });

  it("resumes from the offset the guest acknowledges using the part file", async () => {
    const source = Buffer.alloc(2 * MIN_CHUNK + 100, 0x76);
    const { guest, transfers } = harness(source);
    const target = local();
    const already = 2 * MIN_CHUNK;
    const transferId = "resume-download";
    writeFileSync(partPath(target, transferId), source.subarray(0, already));
    guest.committed = already;

    const outcome = await transfers.download(SESSION, "/workspace/s.bin", target, {
      chunkSize: MIN_CHUNK,
      transferId,
    });

    expect(guest.init().transferId).toBe(transferId);
    expect(outcome.transferId).toBe(transferId);
    expect(
      guest.calls.filter((call) => call.operation.op === "transfer.read").map((call) => call.operation),
    ).toMatchObject([{ offset: already, maxBytes: 100 }]);
    expect(readFileSync(target).equals(source)).toBe(true);
    expect(existsSync(partPath(target, transferId))).toBe(false);
  });

  it("refuses to resume when the local part disagrees with the guest", async () => {
    const source = Buffer.alloc(2 * MIN_CHUNK, 0x77);
    const { guest, transfers } = harness(source);
    const target = local();
    const transferId = "stale-download";
    // The part file holds more than the guest kept: continuing would write a
    // file with a hole or a duplicate in the middle of it.
    writeFileSync(partPath(target, transferId), source.subarray(0, MIN_CHUNK));
    guest.committed = MIN_CHUNK + 1;

    const error = await failure(
      transfers.download(SESSION, "/workspace/s.bin", target, { chunkSize: MIN_CHUNK, transferId }),
    );

    expect(error.code).toBe("resume_mismatch");
    expect(error.message).toBe(
      `local partial size ${MIN_CHUNK} does not match acknowledged offset ${MIN_CHUNK + 1}`,
    );
    // Refused before the first read, and the destination is untouched.
    expect(guest.opNames()).toEqual(["transfer.init"]);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(partPath(target, transferId))).toHaveLength(MIN_CHUNK);
  });

  it("starts a resume with no part file only when the guest has nothing either", async () => {
    const source = Buffer.alloc(MIN_CHUNK + 3, 0x78);
    const { transfers } = harness(source);
    const target = local();

    const outcome = await transfers.download(SESSION, "/workspace/s.bin", target, {
      chunkSize: MIN_CHUNK,
      transferId: "empty-resume",
    });

    expect(outcome.bytesTransferred).toBe(source.length);
    expect(readFileSync(target).equals(source)).toBe(true);
  });

  it("closes the part file before publishing it", async () => {
    const source = Buffer.alloc(2 * MIN_CHUNK, 0x7d);
    const { guest, transfers } = harness(source);
    const target = local();
    const before = openFileCount();

    await transfers.download(SESSION, "/workspace/s.bin", target, { chunkSize: MIN_CHUNK });

    expect(guest.opNames().at(-1)).toBe("transfer.read");
    expect(openFileCount()).toBe(before);
  });

  it("stops when the guest returns no chunk", async () => {
    const source = Buffer.alloc(MIN_CHUNK, 0x79);
    const { guest, transfers } = harness(source);
    guest.on = (call) => {
      if (call.operation.op === "transfer.read") return guest.answer({ chunkBase64: undefined });
    };
    const target = local();

    const error = await failure(
      transfers.download(SESSION, "/workspace/s.bin", target, { chunkSize: MIN_CHUNK }),
    );

    expect(error.code).toBe("missing_chunk");
    expect(error.message).toBe("guest returned no download chunk");
    expect(existsSync(target)).toBe(false);
  });

  it("cancels and removes the part when the signal aborts mid-download", async () => {
    const source = Buffer.alloc(3 * MIN_CHUNK, 0x7a);
    const { guest, transfers } = harness(source);
    const target = local();
    const controller = new AbortController();
    guest.on = (call) => {
      if (call.operation.op === "transfer.read") controller.abort();
    };

    const error = await failure(
      transfers.download(SESSION, "/workspace/s.bin", target, {
        chunkSize: MIN_CHUNK,
        signal: controller.signal,
      }),
    );

    expect(error.code).toBe("transfer_cancelled");
    expect(guest.opNames()).toEqual(["transfer.init", "transfer.read", "transfer.cancel"]);
    expect(guest.cancels).toBe(1);
    expect(existsSync(partPath(target, error.transferId!))).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("names the stage a transport failure happened in", async () => {
    for (const stage of ["init", "read"] as const) {
      const source = Buffer.alloc(MIN_CHUNK, 0x7b);
      const { guest, transfers } = harness(source);
      guest.on = (call) => {
        if (call.operation.op === `transfer.${stage === "init" ? "init" : "read"}`) {
          throw new TypeError("socket hang up");
        }
      };

      const error = await failure(
        transfers.download(SESSION, "/workspace/s.bin", local(), { chunkSize: MIN_CHUNK }),
      );

      expect(error.code).toBe("transfer_failed");
      expect(error.message).toBe(`${stage}: socket hang up`);
    }
  });

  it("stops issuing reads once the deadline is past", async () => {
    const source = Buffer.alloc(2 * MIN_CHUNK, 0x7c);
    const { guest, transfers } = harness(source);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(3_000_000);
    guest.on = (call) => {
      if (call.operation.op === "transfer.init") vi.setSystemTime(3_004_000);
    };

    const error = await failure(
      transfers.download(SESSION, "/workspace/s.bin", local(), {
        chunkSize: MIN_CHUNK,
        timeoutMs: 3_000,
      }),
    );

    expect(error.code).toBe("transfer_timeout");
    expect(guest.opNames()).toEqual(["transfer.init"]);
  });
});
