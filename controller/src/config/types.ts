/**
 * The controller configuration surface.
 *
 * The shape is the contract: every field here is read by a service, and each
 * section parser in this directory returns a `Pick` of it. Splitting the
 * loaders must never change this type, so it lives on its own and `config.ts`
 * re-exports it for existing importers.
 */
import type { Role } from "./role.js";
import type { RelayTlsOptions } from "../relay.js";
import type { RelayClientTlsOptions } from "../relay-client.js";
import type { RuntimeProfileCatalog } from "../runtime-profiles.js";
import type { PlatformLimits, TierTable } from "@x402s/shared/payment";

export interface ControllerConfig {
  role: Role;
  controllerPort: number;
  /** Private scrape listener. 0 disables it (tests / non-Kubernetes runs). */
  metricsPort: number;
  metricsHost: string;
  /** Optional HTTPS listener for the API; a client cert with CN=api is required. */
  tlsPort?: number;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  tlsCaFile?: string;
  relayPort: number;
  /** mTLS listener for the controller-facing relay control routes. */
  relayControlPort: number;
  /** Server certificate/key/client CA for the relay control listener. */
  relayTls?: RelayTlsOptions;
  /** Controller client certificate/key/CA for the relay control listener. */
  relayClientTls?: RelayClientTlsOptions;
  proxyPort: number;
  adminToken: string;
  /**
   * Previous admin token, accepted but never presented, for the overlap window
   * of a rotation. Undefined when no rotation is in progress.
   */
  adminTokenPrevious?: string;
  relayAdminToken: string;
  /** Low-privilege token the relay uses to nudge the reconciler. */
  wakeToken: string;
  controllerUrl: string;
  proxyTokenSecret: string;
  /**
   * Postgres connection string. Required: Postgres is the only store backend
   * (ADR 0010 shipped, SQLite removed), so a controller without this refuses to
   * start.
   */
  databaseUrl: string;
  sandboxNamespace: string;
  controlNamespace: string;
  guestImageDigest: string;
  /** Image reference actually used in the pod spec: `repo@sha256:…` when pinned. */
  guestImageRef: string;
  /**
   * Selectable runtime profiles, always including `base` built from
   * `GUEST_IMAGE`/`GUEST_IMAGE_DIGEST`. A session may only name a profile that
   * is listed here.
   */
  runtimeProfiles: RuntimeProfileCatalog;
  runtimeClass: string;
  executionMode: "dev" | "kata";
  allowInsecureDev: boolean;
  kubeEnabled: boolean;
  /**
   * Hold the single-writer role through a Kubernetes Lease instead of assuming
   * it. On by default whenever Kubernetes is enabled; `LEADER_ELECTION=off` is
   * the escape hatch (docs/adr/0009).
   */
  leaderElection: boolean;
  /** Lease holder identity: POD_NAME, falling back to the host name. */
  leaderIdentity: string;
  /** Lease object name, created in `controlNamespace`. */
  leaderLeaseName: string;
  relayEnabled: boolean;
  proxyEnabled: boolean;
  relayBaseUrl: string;
  relayServiceName: string;
  proxyServiceName: string;
  /**
   * Headless Services that publish per-pod endpoint hostnames (`relay-0`).
   * Shard resolution reads these: the ClusterIP Service's EndpointSlice entries
   * carry addresses but no hostname, so a shard can never be matched there.
   */
  relayHeadlessService: string;
  proxyHeadlessService: string;
  workspaceDir: string;
  provisioningTimeoutMs: number;
  /**
   * How long one create may retry relay registration against the current
   * generation before the pass gives up (the session stays PAID and is retried
   * on the next tick).
   */
  relayRegistrationTimeoutMs: number;
  /**
   * How long a READY/ACTIVE session may be without a live guest link after its
   * relay generation changed (or its registration disappeared) before the
   * controller ends it with `failure:relay_lost`. The guest reconnects inside
   * this window; longer than a relay rollout (observed 7-27s), shorter than the
   * shortest lease worth saving.
   */
  relayLossGraceMs: number;
  leaseGraceMs: number;
  reconcileIntervalMs: number;
  /** Max sessions reconciled in parallel per phase; 1 restores sequential passes. */
  reconcileConcurrency: number;
  /**
   * Max sessions selected for dispatch in one readiness pass. Bounds both the
   * SQL read and the work a tick can enqueue when many sessions are due.
   */
  reconcileBudget: number;
  maxPodAgeMs: number;
  relayResponseWaitMs: number;
  allowedPorts: number[];
  allowedHostSuffixes: string[];
  deniedCidrs: string[];
  egressMaxConnectionsPerSession: number;
  egressMaxGlobalConnections: number;
  tiers: TierTable;
  platformLimits: PlatformLimits;
  /** Pre-booted, unleased sandboxes kept ready for fast claims (0 = off). */
  warmPoolSize: number;
  /**
   * Share of `warmPoolSize` reserved for `base`. Language profiles start at
   * zero and grow from demand, but may never push the total over the budget.
   */
  warmPoolBaseMin: number;
  /** Pods added to a profile when a claim misses. */
  warmPoolGrowthStep: number;
  /** Minimum gap between two growths of one profile. */
  warmPoolCooldownMs: number;
  /** How long a profile must go unused before its extra pods may be drained. */
  warmPoolIdleDrainMs: number;
  /** Window over which a miss counts as demand for a profile. */
  warmPoolDemandWindowMs: number;
  warmPoolTier: keyof TierTable;
  warmPoolTtlMs: number;
  warmClaimTimeoutMs: number;
  /** Pin a resumed checkpoint to the node that owns its local-path PVC. */
  pinCheckpointNode: boolean;
  /**
   * Delete a workspace PVC that no session owns once it is this old. Checkpoint
   * volumes are plaintext, so this bounds the exposure window for a volume left
   * behind by a lost session row.
   */
  orphanPvcGraceMs: number;
  /** 0 = unlimited; otherwise the number of concurrent cold provisions. */
  maxConcurrentProvisioning: number;
  /** 0 = no queue timeout; otherwise fail a PAID session after this wait. */
  provisionQueueTimeoutMs: number;
  /** Capacity admission is on by default; disable only for local debugging. */
  capacityEnabled: boolean;
  /** baseline = guarantee requests; peak = reserve limits (no overcommit). */
  capacityAccounting: "baseline" | "peak";
  /** Provisional payment hold lifetime. */
  capacityHoldTtlMs: number;
  /** Per-node headroom withheld from sandboxes for system workloads. */
  capacityPlatformOverhead: { cpuMillicores: number; memoryMiB: number; storageMiB: number };
  /** Optional test/demo ceilings; 0 means use the node's allocatable values. */
  capacityNodeCpuOverrideMillis: number;
  capacityNodeMemoryOverrideMiB: number;
  /**
   * SHA-256 hex digests of guest measurements the controller accepts on hello.
   * Empty (the default) means measurement is not pinned, matching the behaviour
   * before this option existed.
   */
  guestMeasurementAllowlist: string[];
  /**
   * Relay and proxy replica counts. Above 1, provisioning pins each session to
   * a shard-specific pod address and the credential carries the shard, so a
   * misrouted connection can be rejected instead of served.
   */
  relayReplicas: number;
  proxyReplicas: number;
  /** Pod host template for a shard; must contain `{shard}` when replicas > 1. */
  relayHostTemplate: string;
  proxyHostTemplate: string;
  /**
   * Pod ordinal of this relay/proxy process. Unset (the default) accepts any
   * shard, which is the single-replica behaviour and keeps existing tokens
   * valid.
   */
  shardIndex?: number;
  /**
   * Lifetime of a server-issued challenge nonce (#47). A client that takes
   * longer than this to get its payment signed re-challenges once.
   */
  challengeNonceTtlMs: number;
  /** Hard cap on unburned, unexpired nonces; 0 disables the cap. */
  challengeNonceMaxActive: number;
  /** Fixed window for the durable create budget (#48). */
  budgetWindowMs: number;
  /** Creates one payer may attempt per window, durable across restarts. */
  payerCreatesPerWindow: number;
  /** Atomic units (USDC 6dp) one verified payer may settle per window. */
  payerSpendPerWindow: string;
  /** Concurrent non-terminal sessions per payer; 0 disables the check. */
  payerConcurrentSessions: number;
  /** Creates across all payers per window; independent of any client field. */
  globalCreatesPerWindow: number;
  /** Concurrent non-terminal sessions cluster-wide; 0 disables the check. */
  globalConcurrentSessions: number;
  /** Payment mode stamped on ledger rows written by settlement recovery. */
  paymentMode: "mock" | "testnet";
  /** Facilitator base URL for settlement lookup; empty disables recovery's lookup. */
  facilitatorUrl: string;
  /**
   * Operator-owned refund endpoint. Empty leaves real-mode refunds
   * REFUND_PENDING, which is the honest default: this process holds no signing
   * authority.
   */
  refundWebhookUrl: string;
  refundWebhookToken: string;
  /** Give up on a refund after this many failed attempts. */
  refundMaxAttempts: number;
  /** First retry delay; doubles per attempt up to one hour. */
  refundRetryBaseMs: number;
  /**
   * Lease on a claimed refund. A pass that dies leaves the row `REFUND_SENDING`
   * until this elapses, then the next pass retries with the same key.
   */
  refundClaimLeaseMs: number;
  /** Reconcile intents that settled but never reached an entitlement (#31). */
  settlementRecoveryEnabled: boolean;
  /** How long a claim may sit before recovery treats it as a crash. */
  settlementRecoveryGraceMs: number;
}
