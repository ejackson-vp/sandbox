/**
 * Upload is one bounded loop, and every number in it is a contract with the
 * guest.
 *
 * The guest verifies the final size and SHA-256 and only then renames staging
 * into place, so the bytes the SDK sends have to be exactly the file, in order,
 * with offsets that neither gap nor overlap. Three things can go wrong at the
 * seam and each has a different owner: the chunk size decides whether one
 * sealed envelope still fits the 2 MiB budget the API enforces, the offset
 * decides whether the guest can append, and the digest decides whether the file
 * is published at all. A chunk over 1 MiB fails the envelope budget on the
 * transport; a wrong offset is a rejected chunk, not a corrupt file; a wrong
 * digest is a refusal at the very end, after the whole file has crossed the
 * wire.
 *
 * The fake guest in `tests/helpers/transfer-guest.ts` keeps a committed offset
 * and refuses anything that does not line up, which is what makes these
 * assertions about behaviour rather than about the call count.
 */
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHUNK_SIZE,
  TransferError,
  TransferService,
  type TransferProgress,
} from "../../sdk/src/transfers.js";
import type { OperationError } from "@x402s/shared/protocol";
import { FakeTransferGuest, SESSION, sha256 } from "../helpers/transfer-guest.js";

const MIN_CHUNK = 64 * 1024;
const MAX_CHUNK = 1024 * 1024;

let dir: string;
let seq = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "x402-upload-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function file(bytes: Buffer | number): string {
  const path = join(dir, `f${seq++}.bin`);
  writeFileSync(path, typeof bytes === "number" ? Buffer.alloc(bytes, 0x61) : bytes);
  return path;
}

/** How many file descriptors this process holds. `/dev/fd` is `/proc/self/fd`
 * on Linux, and the count only moves when something is opened or closed. */
function openFileCount(): number {
  return readdirSync("/dev/fd").length;
}

function harness() {
  const guest = new FakeTransferGuest();
  return { guest, transfers: new TransferService(guest.service) };
}

/** Await a failure and insist it is the class the SDK promises callers. */
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

describe("chunk size selection", () => {
  it("sends the default 512 KiB chunk when the caller does not choose one", async () => {
    const { guest, transfers } = harness();

    await transfers.upload(SESSION, file(4_096), "/workspace/a.bin");

    // The default is the number the envelope budget was sized for, not whatever
    // the arithmetic happens to produce.
    expect(DEFAULT_CHUNK_SIZE).toBe(512 * 1024);
    expect(guest.init().chunkSize).toBe(524_288);
  });

  it("accepts a chunk size exactly at each bound", async () => {
    for (const chunkSize of [MIN_CHUNK, MAX_CHUNK]) {
      const { guest, transfers } = harness();
      await transfers.upload(SESSION, file(10), "/workspace/a.bin", { chunkSize });
      expect(guest.init().chunkSize, `chunkSize ${chunkSize}`).toBe(chunkSize);
    }
  });

  it("refuses a chunk size outside the bounds or not a whole number", async () => {
    // One byte past each bound, a fractional size, zero, a size below the floor
    // and a size above the ceiling: the condition is a disjunction, so a mutant
    // that turns it into a conjunction lets the last two through.
    for (const chunkSize of [MIN_CHUNK - 1, MAX_CHUNK + 1, MIN_CHUNK + 0.5, 0, 1, 2 * MAX_CHUNK]) {
      const { guest, transfers } = harness();
      const error = await failure(
        transfers.upload(SESSION, file(10), "/workspace/a.bin", { chunkSize }),
      );
      expect(error.code, `chunkSize ${chunkSize}`).toBe("invalid_chunk_size");
      expect(error.message).toBe(`chunkSize must be between ${MIN_CHUNK} and ${MAX_CHUNK} bytes`);
      // Refused before the path is read or a transport is opened.
      expect(guest.calls).toHaveLength(0);
    }
  });
});

describe("upload", () => {
  it("slices the file in order and completes with its own digest", async () => {
    const { guest, transfers } = harness();
    const bytes = Buffer.alloc(2 * MIN_CHUNK + 100, 0x62);

    const outcome = await transfers.upload(SESSION, file(bytes), "/workspace/out.bin", {
      chunkSize: MIN_CHUNK,
    });

    expect(guest.opNames()).toEqual([
      "transfer.init",
      "transfer.chunk",
      "transfer.chunk",
      "transfer.chunk",
      "transfer.complete",
    ]);
    // Offsets are the sum of everything already committed, so they neither gap
    // nor overlap, and the last chunk is the remainder rather than a full one.
    expect(guest.chunks.map((chunk) => chunk.offset)).toEqual([0, MIN_CHUNK, 2 * MIN_CHUNK]);
    expect(guest.chunks.map((chunk) => chunk.data.length)).toEqual([MIN_CHUNK, MIN_CHUNK, 100]);
    expect(Buffer.concat(guest.chunks.map((chunk) => chunk.data)).equals(bytes)).toBe(true);

    expect(guest.init()).toMatchObject({
      op: "transfer.init",
      direction: "upload",
      path: "/workspace/out.bin",
      size: bytes.length,
      chunkSize: MIN_CHUNK,
      archive: false,
    });
    // The guest publishes the file under the digest the client declared, and the
    // client trusts the guest's echo only because it is the same value.
    expect(guest.calls.at(-1)!.operation).toMatchObject({
      op: "transfer.complete",
      transferId: outcome.transferId,
      size: bytes.length,
      digest: sha256(bytes),
    });
    expect(outcome).toEqual({
      transferId: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
      bytesTransferred: bytes.length,
      digest: sha256(bytes),
    });
  });

  it("reports progress against the declared size after init and every chunk", async () => {
    const { transfers } = harness();
    const bytes = Buffer.alloc(MIN_CHUNK + 10, 0x63);
    const seen: TransferProgress[] = [];

    const outcome = await transfers.upload(SESSION, file(bytes), "/workspace/p.bin", {
      chunkSize: MIN_CHUNK,
      onProgress: (progress) => seen.push(progress),
    });

    // The first event is the guest's acknowledged offset, which is zero here but
    // is the resume point on a retry; without it a progress bar starts blank
    // until the first chunk lands.
    expect(seen.map((progress) => progress.bytesTransferred)).toEqual([0, MIN_CHUNK, MIN_CHUNK + 10]);
    for (const progress of seen) {
      expect(progress).toMatchObject({
        transferId: outcome.transferId,
        direction: "upload",
        totalBytes: MIN_CHUNK + 10,
      });
    }
  });

  it("completes an empty file without issuing a chunk", async () => {
    const { guest, transfers } = harness();

    const outcome = await transfers.upload(SESSION, file(Buffer.alloc(0)), "/workspace/empty");

    expect(guest.opNames()).toEqual(["transfer.init", "transfer.complete"]);
    expect(guest.calls.at(-1)!.operation).toMatchObject({ op: "transfer.complete", size: 0 });
    expect(outcome.bytesTransferred).toBe(0);
    expect(outcome.digest).toBe(sha256(""));
  });

  it("passes the archive flag through to init", async () => {
    const { guest, transfers } = harness();

    await transfers.upload(SESSION, file(1), "/workspace/tree", { archive: true });

    expect(guest.init().archive).toBe(true);
  });

  it("refuses a path that is not a regular file before opening a transport", async () => {
    const { guest, transfers } = harness();
    const path = join(dir, "a-directory");
    mkdirSync(path, { recursive: true });

    const error = await failure(transfers.upload(SESSION, path, "/workspace/a.bin"));

    expect(error.code).toBe("not_a_file");
    expect(error.message).toBe("local path is not a regular file");
    expect(guest.calls).toHaveLength(0);
  });

  it("resumes from the offset the guest already acknowledges", async () => {
    const { guest, transfers } = harness();
    const bytes = Buffer.alloc(3 * MIN_CHUNK + 7, 0x64);
    const already = 2 * MIN_CHUNK;
    // The guest durably wrote the first two chunks before the transport died.
    guest.content = Buffer.from(bytes.subarray(0, already));
    guest.committed = already;

    const outcome = await transfers.upload(SESSION, file(bytes), "/workspace/r.bin", {
      chunkSize: MIN_CHUNK,
      transferId: "resume-upload",
    });

    expect(guest.init().transferId).toBe("resume-upload");
    expect(guest.chunks.map((chunk) => chunk.offset)).toEqual([already, 3 * MIN_CHUNK]);
    // The prefix the guest kept plus the resent tail is the whole file, which is
    // the only thing that makes a resume worth doing.
    expect(guest.content.equals(bytes)).toBe(true);
    expect(outcome.transferId).toBe("resume-upload");
    expect(outcome.bytesTransferred).toBe(bytes.length);
  });

  it("stops at the chunk the guest refuses and names the transfer", async () => {
    const { guest, transfers } = harness();
    guest.on = (call) => {
      if (call.operation.op === "transfer.chunk" && guest.chunks.length === 1) {
        return guest.refuse("quota_exceeded", "workspace disk quota exceeded");
      }
    };

    const error = await failure(
      transfers.upload(SESSION, file(4 * MIN_CHUNK), "/workspace/big.bin", { chunkSize: MIN_CHUNK }),
    );

    expect(error.name).toBe("TransferError");
    expect(error.code).toBe("quota_exceeded");
    expect(error.message).toBe("workspace disk quota exceeded");
    expect(error.transferId).toMatch(/^[0-9a-f]{32}$/);
    // The second chunk is the one that failed, so that is where the sequence
    // ends: one committed chunk, no complete, and no cancel (the guest still
    // holds the staging file the caller can resume against).
    expect(guest.chunks.map((chunk) => chunk.offset)).toEqual([0]);
    expect(guest.opNames()).toEqual(["transfer.init", "transfer.chunk", "transfer.chunk"]);
    expect(guest.cancels).toBe(0);
  });

  it("reports a guest refusal that carried no error body", async () => {
    const { guest, transfers } = harness();
    guest.on = (call) => {
      // An older guest, or a relay that dropped the body, can reject without
      // filling in `error`. The caller still gets a coded TransferError rather
      // than a TypeError from reading a property of undefined.
      if (call.operation.op === "transfer.chunk") {
        return { ...guest.answer(), ok: false } as unknown as OperationError;
      }
    };

    const error = await failure(
      transfers.upload(SESSION, file(2 * MIN_CHUNK), "/workspace/blank.bin", { chunkSize: MIN_CHUNK }),
    );

    expect(error.code).toBe("transfer_failed");
    expect(error.message).toBe("transfer failed");
  });

  it("surfaces a local read failure before any operation is issued", async () => {
    const { guest, transfers } = harness();
    const path = file(1_024);
    chmodSync(path, 0o000);
    try {
      const error = await transfers.upload(SESSION, path, "/workspace/unreadable.bin").catch(
        (reason: unknown) => reason,
      );
      // Reading the file for its digest is the first thing that fails, and it
      // fails with the filesystem's own code: nothing was sent, so there is no
      // transfer to report against.
      expect(error).toMatchObject({ code: "EACCES" });
      expect(guest.calls).toHaveLength(0);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("closes the source file before it returns", async () => {
    const { guest, transfers } = harness();
    const before = openFileCount();

    await transfers.upload(SESSION, file(2 * MIN_CHUNK), "/workspace/closed.bin", {
      chunkSize: MIN_CHUNK,
    });

    expect(guest.opNames().at(-1)).toBe("transfer.complete");
    expect(openFileCount()).toBe(before);
  });

  it("surfaces a transport failure as a TransferError, not a raw throw", async () => {
    const { guest, transfers } = harness();
    guest.on = (call) => {
      if (call.operation.op === "transfer.chunk") throw new TypeError("socket hang up");
    };

    const error = await failure(
      transfers.upload(SESSION, file(2 * MIN_CHUNK), "/workspace/net.bin", { chunkSize: MIN_CHUNK }),
    );

    expect(error.code).toBe("transfer_failed");
    expect(error.message).toBe("socket hang up");
    expect(error.transferId).toMatch(/^[0-9a-f]{32}$/);
    expect(guest.cancels).toBe(0);
  });

  it("cancels the guest transfer when the signal aborts mid-upload", async () => {
    const { guest, transfers } = harness();
    const controller = new AbortController();
    guest.on = (call) => {
      if (call.operation.op === "transfer.chunk") controller.abort();
    };

    const error = await failure(
      transfers.upload(SESSION, file(3 * MIN_CHUNK), "/workspace/c.bin", {
        chunkSize: MIN_CHUNK,
        signal: controller.signal,
      }),
    );

    expect(error.code).toBe("transfer_cancelled");
    expect(error.message).toBe("transfer was cancelled");
    // The loop stops before the second chunk; cancel is issued with no signal,
    // because the signal that was passed is already aborted.
    expect(guest.opNames()).toEqual(["transfer.init", "transfer.chunk", "transfer.cancel"]);
    const cancel = guest.calls.at(-1)!;
    expect(cancel.operation).toMatchObject({
      op: "transfer.cancel",
      transferId: error.transferId,
    });
    expect(cancel.signal).toBeUndefined();
  });

  it("stops issuing operations once the deadline is past", async () => {
    const { guest, transfers } = harness();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    guest.on = (call) => {
      if (call.operation.op === "transfer.init") vi.setSystemTime(1_006_000);
    };

    const error = await failure(
      transfers.upload(SESSION, file(2 * MIN_CHUNK), "/workspace/t.bin", {
        chunkSize: MIN_CHUNK,
        timeoutMs: 5_000,
      }),
    );

    expect(error.code).toBe("transfer_timeout");
    expect(error.message).toBe("transfer deadline exceeded");
    // No chunk, and no cancel: a timeout is not a cancellation.
    expect(guest.opNames()).toEqual(["transfer.init"]);
    expect(guest.cancels).toBe(0);
  });

  it("treats the deadline as reached only once it has passed", async () => {
    const { guest, transfers } = harness();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    guest.on = (call) => {
      // Land exactly on the deadline, not past it.
      if (call.operation.op === "transfer.init") vi.setSystemTime(2_005_000);
    };

    const outcome = await transfers.upload(SESSION, file(2 * MIN_CHUNK), "/workspace/edge.bin", {
      chunkSize: MIN_CHUNK,
      timeoutMs: 5_000,
    });

    expect(outcome.bytesTransferred).toBe(2 * MIN_CHUNK);
  });

  it("reports a short read instead of uploading a truncated file", async () => {
    const { guest, transfers } = harness();
    const path = file(2 * MIN_CHUNK);
    // The file is replaced between the stat that declared its size and the read
    // that is supposed to deliver it.
    guest.on = (call) => {
      if (call.operation.op === "transfer.init") truncateSync(path, 0);
    };

    const error = await failure(
      transfers.upload(SESSION, path, "/workspace/short.bin", { chunkSize: MIN_CHUNK }),
    );

    expect(error.code).toBe("short_read");
    expect(error.message).toBe("local file ended before its declared size");
    expect(guest.opNames()).toEqual(["transfer.init"]);
  });

  it("never sends more than the size it declared at init", async () => {
    const { guest, transfers } = harness();
    const path = file(100);
    // The file grows while the transfer is open. The declared size is already
    // with the guest, and the complete operation will be checked against it, so
    // reading a full buffer here would send bytes the guest must reject.
    guest.on = (call) => {
      if (call.operation.op === "transfer.init") appendFileSync(path, Buffer.alloc(5_000, 0x65));
    };

    const outcome = await transfers.upload(SESSION, path, "/workspace/grow.bin", {
      chunkSize: MIN_CHUNK,
    });

    expect(outcome.bytesTransferred).toBe(100);
    expect(guest.content).toHaveLength(100);
    expect(guest.chunks.map((chunk) => chunk.data.length)).toEqual([100]);
  });

  it("gives every operation its own request id, a bounded timeout and the signal", async () => {
    const { guest, transfers } = harness();
    const controller = new AbortController();

    await transfers.upload(SESSION, file(2 * MIN_CHUNK), "/workspace/env.bin", {
      chunkSize: MIN_CHUNK,
      signal: controller.signal,
    });

    const ids = guest.calls.map((call) => call.requestId);
    expect(ids).toHaveLength(4);
    for (const call of guest.calls) {
      expect(call.requestId).toMatch(/^[0-9a-f]{32}$/);
      // Chunks are slices of a bounded whole-transfer budget, not unbounded.
      expect(call.timeoutMs).toBe(60_000);
      expect(call.signal).toBe(controller.signal);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
