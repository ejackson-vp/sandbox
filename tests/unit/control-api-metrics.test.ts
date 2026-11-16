/**
 * Metric labels are the protocol's operations, not a hand-written subset.
 *
 * The controller used to label six of the twenty-two verbs (exec, transfer,
 * file.put/get/list/stat). The API's executor path sent `op: "operation"`,
 * which was not one of them, so the main exec path and sixteen real ops were
 * counted in a bucket called "other": a cardinality bug that made
 * `sandbox_exec_duration_seconds` and `sandbox_exec_total` look complete while
 * hiding the traffic they exist to measure.
 *
 * Nothing is deliberately excluded from `OP_LABELS`. A verb is either in the
 * protocol union or it is not an operation, so the sets have to be equal.
 */
import { describe, expect, it } from "vitest";
import { GUEST_REQUEST_OPS } from "../../shared/src/entries/protocol.js";
import { OP_LABELS, opLabel } from "../../controller/src/control-api-schemas.js";

describe("operation metric labels", () => {
  it("is exactly the protocol's operation set", () => {
    expect([...OP_LABELS].sort()).toEqual([...GUEST_REQUEST_OPS].sort());
    expect(OP_LABELS.size).toBe(GUEST_REQUEST_OPS.length);
  });

  it("labels the verbs the old set dropped", () => {
    for (const op of [
      "exec",
      "file.put",
      "file.get",
      "file.list",
      "file.stat",
      "transfer.init",
      "transfer.chunk",
      "transfer.complete",
      "transfer.status",
      "transfer.read",
      "transfer.cancel",
      "service.start",
      "service.stop",
      "service.list",
      "http.request",
      "http.stream.open",
      "http.stream.read",
      "http.stream.close",
      "ws.open",
      "ws.read",
      "ws.send",
      "ws.close",
    ]) {
      expect(opLabel(op)).toBe(op);
    }
  });

  it("publishes no label at all when the verb is unknown", () => {
    // The sealed path cannot name a verb, and a bucket for that would read as a
    // measurement of "other". `undefined` means the dimension is omitted.
    expect(opLabel(undefined)).toBeUndefined();
    expect(opLabel("operation")).toBeUndefined();
    expect(opLabel("file.rename")).toBeUndefined();
    expect(opLabel("toString")).toBeUndefined();
  });
});
