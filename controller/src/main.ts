/**
 * Controller/relay/proxy entrypoint.
 *
 * One container image runs all three roles so that a local run needs no
 * orchestration; in Kubernetes they are separate Deployments with separate
 * NetworkPolicies (ROLE=controller|relay|proxy).
 */
import http from "node:http";
import https from "node:https";
import type { Server } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadControllerConfig, makeProvisioner, makeRelayClient, type ControllerConfig } from "./config.js";
import { openStore } from "./store-backend.js";
import type { StoreBackend } from "./store/backend.js";
import { createControlApi } from "./control-api.js";
import { createRelay, notifyControllerReady, type RelayServer } from "./relay.js";
import { createEgressProxy } from "./egress-proxy.js";
import { Reconciler } from "./reconciler.js";
import { OperationFence } from "./operation-fence.js";
import { CapacityService } from "./capacity/service.js";
import { collectSqliteMetrics, registerSqliteMetrics } from "./store-metrics.js";
import { bindLeadership, SoloLeadership, type Leadership } from "./leadership.js";
import { makeLeaseLeadership } from "./leadership-lease.js";
import {
  LATENCY_BUCKETS,
  log,
  metrics,
  registerBuildInfo,
  registerRuntimeMetrics,
  startMetricsServer,
} from "@x402s/shared/runtime";

async function main(): Promise<void> {
  const cfg = loadControllerConfig();

  // Register metric families eagerly (bounded labels only).
  metrics.histogram("sandbox_provision_duration_seconds", "Entitlement to pod create", LATENCY_BUCKETS);
  metrics.histogram("sandbox_ready_duration_seconds", "Entitlement to READY", LATENCY_BUCKETS);
  metrics.histogram("sandbox_exec_duration_seconds", "Operation duration", LATENCY_BUCKETS);
  metrics.histogram("sandbox_cleanup_duration_seconds", "TERMINATING to cleanup complete", LATENCY_BUCKETS);
  metrics.histogram("sandbox_reconcile_duration_seconds", "Reconcile pass duration", LATENCY_BUCKETS);
  metrics.gauge("sandbox_reconcile_queue_depth", "Sessions waiting for a reconcile worker, by phase");
  metrics.gauge("sandbox_reconcile_in_flight", "Sessions currently being reconciled, by phase");
  metrics.histogram(
    "sandbox_reconcile_queue_wait_seconds",
    "Time a session waited for a reconcile worker, by phase",
    LATENCY_BUCKETS,
  );
  metrics.counter("sandbox_exec_total", "Operations by result");
  metrics.counter("sandbox_sessions_created_total", "Entitlements created");
  metrics.counter("sandbox_sessions_failed_total", "Sessions that ended in FAILED or EXPIRED");
  metrics.counter("sandbox_refunds_total", "Payment refund outcomes");
  metrics.counter("sandbox_budget_rejections_total", "Create-budget rejections by scope");
  metrics.counter("sandbox_provision_failures_total", "Sessions failed during provisioning by reason");
  metrics.gauge("sandbox_sessions_active", "Sessions in READY or ACTIVE");
  registerSqliteMetrics(metrics);

  // Scrape-time collectors. The listener exists for every role so a scrape
  // config can target API, controller and relay on the same port.
  const runtime = registerRuntimeMetrics();
  registerBuildInfo();
  const collectors: Array<() => void | Promise<void>> = [() => runtime.collect()];
  let metricsServer: Server | undefined;
  if (cfg.metricsPort > 0) {
    metricsServer = await startMetricsServer({
      port: cfg.metricsPort,
      host: cfg.metricsHost,
      onScrape: async () => {
        // Awaited one at a time: the SQLite gauges are read from the database
        // file, and the scrape that reported them should be the scrape they
        // were measured for.
        for (const collect of collectors) await collect();
      },
    });
    log.info("metrics_listening", { port: cfg.metricsPort, host: cfg.metricsHost, role: cfg.role });
  }
  const closeMetrics = () => {
    runtime.stop();
    metricsServer?.close();
  };

  if (cfg.role === "relay") {
    const relayOpts = {
      adminToken: cfg.relayAdminToken,
      controllerUrl: cfg.controllerUrl,
      wakeToken: cfg.wakeToken,
      ...(cfg.relayTls ? { controlTls: cfg.relayTls } : {}),
      ...(cfg.shardIndex !== undefined ? { shardIndex: cfg.shardIndex } : {}),
      replicas: cfg.relayReplicas,
    };
    const relay = createRelay(relayOpts);
    collectors.push(() => relay.collectMetrics());
    await listenRelay(relay, cfg);
    // A replacement relay has an empty registry. Wake the controller so
    // PROVISIONING sessions re-register now instead of on the next poll.
    notifyControllerReady(relayOpts);
    installShutdown(async () => {
      closeMetrics();
      await relay.close();
    });
    return;
  }

  if (cfg.role === "proxy") {
    const proxy = createEgressProxy({
      tokenSecret: cfg.proxyTokenSecret,
      allowedPorts: cfg.allowedPorts,
      allowedHostSuffixes: cfg.allowedHostSuffixes,
      deniedCidrs: cfg.deniedCidrs,
      maxConnectionsPerSession: cfg.egressMaxConnectionsPerSession,
      maxGlobalConnections: cfg.egressMaxGlobalConnections,
      ...(cfg.shardIndex !== undefined ? { shardIndex: cfg.shardIndex } : {}),
      replicas: cfg.proxyReplicas,
    });
    await listen(proxy.server, cfg.proxyPort);
    log.info("egress_proxy_listening", {
      port: cfg.proxyPort,
      allowedPorts: cfg.allowedPorts,
      deniedCidrs: cfg.deniedCidrs,
    });
    installShutdown(async () => {
      closeMetrics();
      await proxy.close();
    });
    return;
  }

  // controller (or "all": controller + relay + proxy in one process)
  // One writer, still: a second replica is a standby, not a second scheduler.
  // The election is decided before the store opens so a standby never takes the
  // writer lock or migrates the schema (docs/adr/0009, docs/adr/0010).
  const leadership: Leadership = cfg.leaderElection
    ? makeLeaseLeadership(cfg)
    : new SoloLeadership(cfg.leaderIdentity);
  if (cfg.storeBackend === "sqlite") mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const store: StoreBackend = await openStore(cfg, { writer: leadership.isLeader() });
  if (cfg.storeBackend === "sqlite") collectors.push(() => collectSqliteMetrics(store));
  log.info("leadership_mode", {
    mode: leadership.mode,
    identity: leadership.identity,
    storeBackend: cfg.storeBackend,
    reason: cfg.leaderElection ? "kubernetes_lease" : cfg.kubeEnabled ? "leader_election_off" : "kubernetes_disabled",
  });

  const shutdown: Array<() => Promise<void>> = [];

  if (cfg.relayEnabled) {
    const relayOpts = {
      adminToken: cfg.relayAdminToken,
      controllerUrl: cfg.controllerUrl,
      wakeToken: cfg.wakeToken,
      ...(cfg.relayTls ? { controlTls: cfg.relayTls } : {}),
      ...(cfg.shardIndex !== undefined ? { shardIndex: cfg.shardIndex } : {}),
      replicas: cfg.relayReplicas,
    };
    const relay = createRelay(relayOpts);
    collectors.push(() => relay.collectMetrics());
    await listenRelay(relay, cfg);
    // No-op until the control listener starts; the first reconcile pass covers
    // startup in a single process.
    notifyControllerReady(relayOpts);
    shutdown.push(() => relay.close());
  }

  if (cfg.proxyEnabled) {
    const proxy = createEgressProxy({
      tokenSecret: cfg.proxyTokenSecret,
      allowedPorts: cfg.allowedPorts,
      allowedHostSuffixes: cfg.allowedHostSuffixes,
      deniedCidrs: cfg.deniedCidrs,
      maxConnectionsPerSession: cfg.egressMaxConnectionsPerSession,
      maxGlobalConnections: cfg.egressMaxGlobalConnections,
      ...(cfg.shardIndex !== undefined ? { shardIndex: cfg.shardIndex } : {}),
      replicas: cfg.proxyReplicas,
    });
    await listen(proxy.server, cfg.proxyPort);
    log.info("egress_proxy_listening", { port: cfg.proxyPort });
    shutdown.push(() => proxy.close());
  }

  const provisioner = makeProvisioner(cfg);
  const relay = makeRelayClient(cfg);
  const fence = new OperationFence(store, relay);
  const capacity = new CapacityService({ cfg, store, provisioner });

  let wake: (() => void) | undefined;
  let suspend: ((id: string) => Promise<void>) | undefined;
  let resume: ((id: string) => Promise<void>) | undefined;
  const control = createControlApi({
    cfg,
    store,
    relay,
    provisioner,
    capacity,
    leadership,
    wake: () => wake?.(),
    suspend: (id) => {
      if (!suspend) return Promise.reject(new Error("reconciler not started"));
      return suspend(id);
    },
    resume: (id) => {
      if (!resume) return Promise.reject(new Error("reconciler not started"));
      return resume(id);
    },
  });
  const server = http.createServer(control);
  await listen(server, cfg.controllerPort);

  // Separate listener for the API only. The plain HTTP port stays for the relay
  // (wake) and for kubelet probes, which cannot present a client certificate.
  let tlsServer: https.Server | undefined;
  if (cfg.tlsPort) {
    tlsServer = https.createServer(
      {
        key: readFileSync(cfg.tlsKeyFile!),
        cert: readFileSync(cfg.tlsCertFile!),
        ca: readFileSync(cfg.tlsCaFile!),
        requestCert: true,
        rejectUnauthorized: true,
      },
      control,
    );
    await listen(tlsServer, cfg.tlsPort);
  }

  log.info("controller_listening", {
    port: cfg.controllerPort,
    tlsPort: cfg.tlsPort,
    sandboxNamespace: cfg.sandboxNamespace,
    runtimeClass: cfg.runtimeClass,
    executionMode: cfg.executionMode,
    kubeEnabled: cfg.kubeEnabled,
  });

  const reconciler = new Reconciler({ cfg, store, provisioner, relay, capacity, fence });
  wake = () => {
    // A nudge can land on a standby: the relay pings whatever CONTROLLER_URL
    // resolves to. Readiness keeps traffic off a follower; this keeps the loop
    // off it too.
    if (leadership.isLeader()) reconciler.wake();
  };
  suspend = (id) => reconciler.suspendSession(id);
  resume = (id) => reconciler.resumeSession(id);

  bindLeadership(leadership, {
    acquire: async () => {
      // The lease is ours: writes first, because recovery is itself a write.
      // On Postgres this is where the advisory writer lock is taken, so a lock
      // held by a stale process fails here rather than on the first request.
      await store.setWritesBlocked(false);
      const recovered = await store.recoverInterruptedOperations();
      if (recovered.requests > 0 || recovered.sessions > 0) {
        log.warn("sandbox_operations_recovered", recovered);
      }
      // Unblock any startup fence as soon as the relay is reachable. The control
      // API fails closed until this succeeds, and the reconciler retries it.
      void fence.reconcile().catch((err) => {
        log.warn("operation_fence_startup_failed", { error: (err as Error).message });
      });
      log.info("leadership_acquired", { mode: leadership.mode, identity: leadership.identity });
    },
    start: () => reconciler.start(),
    stop: () => reconciler.stop(),
    release: () => {
      // The guard closes synchronously inside the adapter, even when the unlock
      // is an async round trip, so the next write is refused before this returns.
      // Awaiting here would only delay handing the lease over.
      void Promise.resolve(store.setWritesBlocked(true)).catch((err: unknown) => {
        log.error("store_write_guard_failed", { error: (err as Error).message });
      });
      log.warn("leadership_released", { mode: leadership.mode, identity: leadership.identity });
    },
  });

  installShutdown(async () => {
    // Order: stop scheduling, refuse writes, then hand the lease over.
    reconciler.stop();
    await store.setWritesBlocked(true);
    await leadership.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tlsServer) await new Promise<void>((resolve) => tlsServer!.close(() => resolve()));
    for (const fn of shutdown) await fn();
    closeMetrics();
    await store.close();
  });

  await leadership.start();
  if (!leadership.isLeader()) {
    // A standby: readyz answers 503 until the lease moves.
    log.info("leadership_standby", { mode: leadership.mode, identity: leadership.identity });
  }
}

async function listenRelay(relay: RelayServer, cfg: ControllerConfig): Promise<void> {
  await listen(relay.server, cfg.relayPort);
  if (relay.controlServer) {
    await listen(relay.controlServer, cfg.relayControlPort);
    log.info("relay_control_listening", {
      port: cfg.relayControlPort,
      clientCn: "controller",
      generation: relay.generation,
    });
  } else {
    // Local-dev/test fallback only. A cluster relay refuses to start without
    // RELAY_TLS_* (controller/src/config.ts).
    log.warn("relay_control_plaintext", { port: cfg.relayPort, generation: relay.generation });
  }
  log.info("relay_listening", { port: cfg.relayPort, generation: relay.generation });
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });
}

function installShutdown(fn: () => Promise<void>): void {
  let done = false;
  const run = async (signal: string) => {
    if (done) return;
    done = true;
    log.info("shutting_down", { signal });
    try {
      await fn();
      process.exit(0);
    } catch (err) {
      log.error("shutdown_failed", { error: (err as Error).message });
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void run("SIGTERM"));
  process.on("SIGINT", () => void run("SIGINT"));
}

main().catch((err) => {
  log.error("fatal_startup_error", { error: (err as Error).message });
  process.exit(1);
});
