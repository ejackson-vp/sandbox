import { describe, expect, it } from "vitest";
import { loadTiers } from "@x402s/shared/payment";
import { parseCapacity } from "../../controller/src/config/capacity.js";
import { DEFAULT_LEDGER_AUDIT_INTERVAL_MS, parseLedgerAudit } from "../../controller/src/config/audit.js";
import { parseEgress } from "../../controller/src/config/egress.js";
import { parsePaymentLimits } from "../../controller/src/config/payments.js";
import { parseDataPlanePlacement } from "../../controller/src/config/relay.js";
import { parseWarmPoolAllocation } from "../../controller/src/config/warm-pool.js";

/**
 * Section parsers are behaviour-level seams: each reads only its own variables
 * and rejects its own bad values. Before the split these rules could only be
 * reached through `loadControllerConfig` with a fully valid environment, so a
 * test for one bound had to carry tokens, TLS and a role it did not care about.
 *
 * These cases intentionally use a bare environment. Where a rule needs the
 * tier table it is loaded from the same place the loader loads it.
 */

const tiers = loadTiers({});

describe("warm pool allocation", () => {
  it("defaults to an empty pool on the short tier", () => {
    expect(parseWarmPoolAllocation({}, tiers)).toEqual({
      warmPoolSize: 0,
      warmPoolBaseMin: 0,
      warmPoolTier: "short",
    });
  });

  it("refuses a base share larger than the pool", () => {
    expect(() =>
      parseWarmPoolAllocation({ WARM_POOL_SIZE: "2", WARM_POOL_BASE_MIN: "3" }, tiers),
    ).toThrow(/must not exceed/);
  });

  it("refuses a tier the table does not define", () => {
    expect(() => parseWarmPoolAllocation({ WARM_POOL_TIER: "gigantic" }, tiers)).toThrow(
      /WARM_POOL_TIER/,
    );
  });
});


describe("data plane placement", () => {
  it("refuses more than one replica without a shard template", () => {
    expect(() =>
      parseDataPlanePlacement(
        { RELAY_REPLICAS: "2", RELAY_HOST_TEMPLATE: "relay-headless" },
        "relay",
      ),
    ).toThrow(/RELAY_HOST_TEMPLATE/);
  });

  it("requires an ordinal for a multi-replica relay", () => {
    expect(() =>
      parseDataPlanePlacement(
        { RELAY_REPLICAS: "2", RELAY_HOST_TEMPLATE: "relay-{shard}" },
        "relay",
      ),
    ).toThrow(/SHARD_INDEX is required/);
  });

  it("reads the ordinal from a Kubernetes pod name", () => {
    const placement = parseDataPlanePlacement(
      { RELAY_REPLICAS: "2", RELAY_HOST_TEMPLATE: "relay-{shard}", SHARD_INDEX: "relay-1" },
      "relay",
    );
    expect(placement.shardIndex).toBe(1);
  });

  it("bounds the ordinal by the role's own replica count", () => {
    expect(() => parseDataPlanePlacement({ PROXY_REPLICAS: "2", SHARD_INDEX: "2" }, "proxy")).toThrow(
      /outside the 2-replica range/,
    );
  });

  it("does not bound an ordinal for a controller, which serves no shard", () => {
    const placement = parseDataPlanePlacement({ SHARD_INDEX: "7" }, "controller");
    expect(placement.shardIndex).toBe(7);
    expect(placement.relayReplicas).toBe(1);
    expect(placement.relayHostTemplate).toBe("relay-{shard}.relay-headless");
  });
});

describe("payment limits", () => {
  it("keeps the spend cap as an atomic-unit string", () => {
    expect(parsePaymentLimits({}).payerSpendPerWindow).toBe("50000000");
  });

  it("refuses an amount that is not a whole number of atomic units", () => {
    expect(() => parsePaymentLimits({ PAYER_SPEND_PER_WINDOW: "1.5" })).toThrow(
      /decimal amount/,
    );
  });
});

describe("capacity defaults", () => {
  it("withholds the documented per-node overhead", () => {
    expect(parseCapacity({}).capacityPlatformOverhead).toEqual({
      cpuMillicores: 250,
      memoryMiB: 256,
      storageMiB: 1_024,
    });
  });

  it("refuses an unknown accounting mode", () => {
    expect(() => parseCapacity({ CAPACITY_ACCOUNTING: "sometimes" })).toThrow(
      /CAPACITY_ACCOUNTING/,
    );
  });
});

describe("ledger audit interval", () => {
  it("samples every five minutes by default", () => {
    expect(parseLedgerAudit({}).ledgerAuditIntervalMs).toBe(300_000);
    expect(DEFAULT_LEDGER_AUDIT_INTERVAL_MS).toBe(300_000);
  });

  it("accepts an operator override", () => {
    expect(parseLedgerAudit({ LEDGER_AUDIT_INTERVAL_MS: "900000" }).ledgerAuditIntervalMs).toBe(
      900_000,
    );
  });

  it("refuses an interval outside the supported bounds", () => {
    expect(() => parseLedgerAudit({ LEDGER_AUDIT_INTERVAL_MS: "0" })).toThrow(
      /LEDGER_AUDIT_INTERVAL_MS|invalid integer/,
    );
    // Above an hour the freshness alert would fire between samples by design.
    expect(() => parseLedgerAudit({ LEDGER_AUDIT_INTERVAL_MS: "7200000" })).toThrow(
      /invalid integer/,
    );
  });
});

describe("egress byte budgets", () => {
  it("bounds one session at 1 GiB and the process at 20 GiB an hour by default", () => {
    const egress = parseEgress({});
    expect(egress.egressMaxBytesPerSession).toBe(1024 ** 3);
    expect(egress.egressMaxBytesGlobalWindow).toBe(20 * 1024 ** 3);
    expect(egress.egressBytesWindowMs).toBe(3_600_000);
  });

  it("keeps the connection budgets", () => {
    const egress = parseEgress({});
    expect(egress.egressMaxConnectionsPerSession).toBe(16);
    expect(egress.egressMaxGlobalConnections).toBe(512);
  });

  it("accepts 0 as the off switch for either byte bound", () => {
    const egress = parseEgress({
      EGRESS_MAX_BYTES_PER_SESSION: "0",
      EGRESS_MAX_BYTES_GLOBAL_WINDOW: "0",
    });
    expect(egress.egressMaxBytesPerSession).toBe(0);
    expect(egress.egressMaxBytesGlobalWindow).toBe(0);
  });

  it("refuses a negative or non-integer byte bound", () => {
    expect(() => parseEgress({ EGRESS_MAX_BYTES_PER_SESSION: "-1" })).toThrow(/invalid integer/);
    expect(() => parseEgress({ EGRESS_MAX_BYTES_GLOBAL_WINDOW: "1.5" })).toThrow(/invalid integer/);
  });

  it("bounds the window to a minute and a day", () => {
    expect(() => parseEgress({ EGRESS_BYTES_WINDOW_MS: "0" })).toThrow(/invalid integer/);
    expect(() => parseEgress({ EGRESS_BYTES_WINDOW_MS: "86400001" })).toThrow(/invalid integer/);
  });
});
