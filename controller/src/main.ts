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
import { loadControllerConfig, makeProvisioner, makeRelayClient } from "./config.js";
import { Store } from "./store.js";
import { createControlApi } from "./control-api.js";
import { createRelay, notifyControllerReady } from "./relay.js";
import { createEgressProxy } from "./egress-proxy.js";
import { Reconciler } from "./reconciler.js";
import { OperationFence } from "./operation-fence.js";
import { CapacityService } from "./capacity/service.js";
import { collectSqliteMetrics, registerSqliteMetrics } from "./store-metrics.js";
import {
  LATENCY_BUCKETS,
  metrics,
  registerBuildInfo,
  registerRuntimeMetrics,
  startMetricsServer,
} from "@x402s/shared";
import { log } from "@x402s/shared";

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
  metrics.counter("sandbox_provision_failures_total", "Sessions failed during provisioning by reason");
  metrics.gauge("sandbox_sessions_active", "Sessions in READY or ACTIVE");
  registerSqliteMetrics(metrics);

  // Scrape-time collectors. The listener exists for every role so a scrape
  // config can target API, controller and relay on the same port.
  const runtime = registerRuntimeMetrics();
  registerBuildInfo();
  const collectors: Array<() => void> = [() => runtime.collect()];
  let metricsServer: Server | undefined;
  if (cfg.metricsPort > 0) {
    metricsServer = await startMetricsServer({
      port: cfg.metricsPort,
      host: cfg.metricsHost,
      onScrape: () => {
        for (const collect of collectors) collect();
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
    };
    const relay = createRelay(relayOpts);
    collectors.push(() => relay.collectMetrics());
    await listen(relay.server, cfg.relayPort);
    log.info("relay_listening", { port: cfg.relayPort, generation: relay.generation });
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
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const store = new Store(cfg.dbPath);
  collectors.push(() => collectSqliteMetrics(store));
  const recovered = store.recoverInterruptedOperations();
  if (recovered.requests > 0 || recovered.sessions > 0) {
    log.warn("sandbox_operations_recovered", recovered);
  }

  const shutdown: Array<() => Promise<void>> = [];

  if (cfg.relayEnabled) {
    const relayOpts = {
      adminToken: cfg.relayAdminToken,
      controllerUrl: cfg.controllerUrl,
      wakeToken: cfg.wakeToken,
    };
    const relay = createRelay(relayOpts);
    collectors.push(() => relay.collectMetrics());
    await listen(relay.server, cfg.relayPort);
    log.info("relay_listening", { port: cfg.relayPort, generation: relay.generation });
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
    });
    await listen(proxy.server, cfg.proxyPort);
    log.info("egress_proxy_listening", { port: cfg.proxyPort });
    shutdown.push(() => proxy.close());
  }

  const provisioner = makeProvisioner(cfg);
  const relay = makeRelayClient(cfg);
  const fence = new OperationFence(store, relay);
  // Unblock any startup fence as soon as the relay is reachable. The control
  // API fails closed until this succeeds, and the reconciler retries it.
  void fence.reconcile().catch((err) => {
    log.warn("operation_fence_startup_failed", { error: (err as Error).message });
  });
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
  wake = () => reconciler.wake();
  suspend = (id) => reconciler.suspendSession(id);
  resume = (id) => reconciler.resumeSession(id);
  reconciler.start();

  installShutdown(async () => {
    reconciler.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tlsServer) await new Promise<void>((resolve) => tlsServer!.close(() => resolve()));
    for (const fn of shutdown) await fn();
    closeMetrics();
    store.close();
  });
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
