/**
 * The transfer loop's arithmetic, over arbitrary sizes.
 *
 * A single example file proves a chunk boundary works for that one length. The
 * invariants below are the ones that have to hold for every length: the chunks
 * of an upload concatenate back to the input, their offsets are each the total
 * committed so far (no gap, no overlap), no chunk exceeds the chosen size, a
 * resume starts exactly at the acknowledged offset, and a download's windows
 * reassemble the source in order. A file that is an exact multiple of the chunk
 * size, one byte over it and one byte under it are all just integers here, and
 * the empty file is the zero case of the same rule.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { TransferReadOperation } from "@x402s/shared/protocol";
import { TransferService } from "../../sdk/src/transfers.js";
import { FakeTransferGuest, SESSION, sha256 } from "../helpers/transfer-guest.js";

const CHUNK_SIZES = [64 * 1024, 100_000, 512 * 1024];
const MAX_SIZE = 400_000;
const RUNS = 30;

let dir: string;
let seq = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "x402-transfer-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function source(bytes: Buffer): string {
  const path = join(dir, `src${seq++}.bin`);
  writeFileSync(path, bytes);
  return path;
}

function target(): string {
  return join(dir, `dst${seq++}.bin`);
}

function harness(bytes: Buffer, withDigest = true) {
  const guest = new FakeTransferGuest();
  guest.content = bytes;
  if (withDigest) guest.digest = sha256(bytes);
  return { guest, transfers: new TransferService(guest.service) };
}

function reads(guest: FakeTransferGuest): TransferReadOperation[] {
  return guest.calls
    .filter((call) => call.operation.op === "transfer.read")
    .map((call) => call.operation as TransferReadOperation);
}

describe("upload chunk arithmetic", () => {
  it("sends contiguous chunks that concatenate back to the file", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: MAX_SIZE }),
        fc.constantFrom(...CHUNK_SIZES),
        async (size, chunkSize) => {
          const bytes = Buffer.alloc(size, 0x5a);
          const { guest, transfers } = harness(Buffer.alloc(0), false);

          const outcome = await transfers.upload(SESSION, source(bytes), "/workspace/p.bin", {
            chunkSize,
          });

          expect(outcome.bytesTransferred).toBe(size);
          expect(outcome.digest).toBe(sha256(bytes));
          expect(Buffer.concat(guest.chunks.map((chunk) => chunk.data)).equals(bytes)).toBe(true);
          // Full chunks until the remainder: the count is the ceiling of the
          // division, and zero length means no chunk at all.
          expect(guest.chunks).toHaveLength(Math.ceil(size / chunkSize));

          let offset = 0;
          for (const chunk of guest.chunks) {
            expect(chunk.offset).toBe(offset);
            expect(chunk.data.length).toBeGreaterThan(0);
            expect(chunk.data.length).toBeLessThanOrEqual(chunkSize);
            offset += chunk.data.length;
          }
          expect(offset).toBe(size);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("resumes from any acknowledged offset without gapping or overlapping", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: MAX_SIZE }),
        fc.constantFrom(...CHUNK_SIZES),
        fc.nat({ max: MAX_SIZE }),
        async (size, chunkSize, requested) => {
          const bytes = Buffer.alloc(size, 0x5b);
          const resumeAt = Math.min(requested, size);
          const { guest, transfers } = harness(Buffer.from(bytes.subarray(0, resumeAt)), false);
          guest.committed = resumeAt;

          const outcome = await transfers.upload(SESSION, source(bytes), "/workspace/r.bin", {
            chunkSize,
            transferId: "resume",
          });

          // What the guest already had, plus what was resent, is the whole file.
          expect(guest.content.equals(bytes)).toBe(true);
          expect(outcome.bytesTransferred).toBe(size);

          let offset = resumeAt;
          for (const chunk of guest.chunks) {
            expect(chunk.offset).toBe(offset);
            expect(chunk.data.length).toBeLessThanOrEqual(chunkSize);
            offset += chunk.data.length;
          }
          expect(offset).toBe(size);
          expect(guest.chunks).toHaveLength(Math.ceil((size - resumeAt) / chunkSize));
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("download chunk arithmetic", () => {
  it("reads contiguous windows that reassemble the source", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: MAX_SIZE }),
        fc.constantFrom(...CHUNK_SIZES),
        async (size, chunkSize) => {
          const bytes = Buffer.alloc(size, 0x5c);
          const { guest, transfers } = harness(bytes);
          const path = target();

          const outcome = await transfers.download(SESSION, "/workspace/s.bin", path, {
            chunkSize,
          });

          let offset = 0;
          for (const read of reads(guest)) {
            expect(read.offset).toBe(offset);
            // The window is the chunk size or whatever is left, never more.
            expect(read.maxBytes).toBe(Math.min(chunkSize, size - offset));
            offset += Math.min(chunkSize, size - offset);
          }
          expect(offset).toBe(size);
          expect(readFileSync(path).equals(bytes)).toBe(true);
          expect(outcome.bytesTransferred).toBe(size);
          expect(outcome.digest).toBe(sha256(bytes));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("resumes a download from any acknowledged offset and still verifies", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: MAX_SIZE }),
        fc.constantFrom(...CHUNK_SIZES),
        fc.nat({ max: MAX_SIZE }),
        async (size, chunkSize, requested) => {
          const bytes = Buffer.alloc(size, 0x5d);
          const resumeAt = Math.min(requested, size);
          const { guest, transfers } = harness(bytes);
          guest.committed = resumeAt;
          const path = target();
          // A resume is only allowed when the part file is exactly the prefix
          // the guest kept.
          writeFileSync(`${path}.x402-part-resume`, bytes.subarray(0, resumeAt));

          const outcome = await transfers.download(SESSION, "/workspace/s.bin", path, {
            chunkSize,
            transferId: "resume",
          });

          const issued = reads(guest);
          expect(issued[0]?.offset ?? resumeAt).toBe(resumeAt);
          expect(readFileSync(path).equals(bytes)).toBe(true);
          expect(outcome.bytesTransferred).toBe(size);
          expect(outcome.digest).toBe(sha256(bytes));
        },
      ),
      { numRuns: RUNS },
    );
  });
});
