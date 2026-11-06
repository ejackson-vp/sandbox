import { describe, expect, it } from "vitest";
import { TransferError, TransferService } from "../../sdk/src/transfers.js";
import type { OperationService } from "../../sdk/src/operations.js";
import type { SessionHandle } from "../../sdk/src/types.js";

const handle: SessionHandle = {
  sessionId: "sbx_test",
  capability: "cap",
  clientPublicKey: new Uint8Array(32),
  clientPrivateKey: new Uint8Array(32),
  clientNonce: "nonce",
  createdAt: 0,
};

describe("streaming transfer contract", () => {
  it("binds transfer failures to the transfer id", () => {
    const error = new TransferError("integrity_failed", "bad digest", "transfer-123");
    expect(error).toBeInstanceOf(TransferError);
    expect(error.code).toBe("integrity_failed");
    expect(error.transferId).toBe("transfer-123");
  });

  it("rejects unsafe chunk sizes before opening a transport", async () => {
    const service = new TransferService({} as OperationService);
    await expect(service.upload(handle, "/does/not/exist", "/workspace/x", { chunkSize: 1 }))
      .rejects.toMatchObject({ code: "invalid_chunk_size" });
  });
});
