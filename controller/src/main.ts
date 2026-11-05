/**
 * Controller/relay/proxy entrypoint.
 *
 * One container image runs all three roles so that a local run needs no
 * orchestration; in Kubernetes they are separate Deployments with separate
 * NetworkPolicies (ROLE=controller|relay|proxy).
 */
import http from "node:http";
import express from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadControllerConfig, makeProvisioner, makeRelayClient } from "./config.js";
import { Store } from "./store.js";
import { createControlApi } from "./control-api.js";
import { createRelay } from "./relay.js";
import { createEgressProxy } from "./egress-proxy.js";
import { Reconciler } from "./reconciler.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const cfg = loadControllerConfig();

  if (cfg.role === "relay") {
    const relay = createRelay({ adminToken: cfg.relayAdminToken });
    await listen(relay.server, cfg.relayPort);
    log.info("relay_listening", { port: cfg.relayPort });
    installShutdown(async () => relay.close());
    return;
  }

  if (cfg.role === "proxy") {
    const proxy = createEgressProxy({
      tokenSecret: cfg.proxyTokenSecret,
      allowedPorts: cfg.allowedPorts,
      allowedHostSuffixes: cfg.allowedHostSuffixes,
      deniedCidrs: cfg.deniedCidrs,
    });
    await listen(proxy.server, cfg.proxyPort);
    log.info("egress_proxy_listening", {
      port: cfg.proxyPort,
      allowedPorts: cfg.allowedPorts,
      deniedCidrs: cfg.deniedCidrs,
    });
    installShutdown(async () => proxy.close());
    return;
  }

  // controller (or "all": controller + relay + proxy in one process)
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const store = new Store(cfg.dbPath);

  const shutdown: Array<() => Promise<void>> = [];

  if (cfg.relayEnabled) {
    const relay = createRelay({ adminToken: cfg.relayAdminToken });
    await listen(relay.server, cfg.relayPort);
    log.info("relay_listening", { port: cfg.relayPort });
    shutdown.push(() => relay.close());
  }

  if (cfg.proxyEnabled) {
    const proxy = createEgressProxy({
      tokenSecret: cfg.proxyTokenSecret,
      allowedPorts: cfg.allowedPorts,
      allowedHostSuffixes: cfg.allowedHostSuffixes,
      deniedCidrs: cfg.deniedCidrs,
    });
    await listen(proxy.server, cfg.proxyPort);
    log.info("egress_proxy_listening", { port: cfg.proxyPort });
    shutdown.push(() => proxy.close());
  }

  const provisioner = makeProvisioner(cfg);
  const relay = makeRelayClient(cfg);

  const control = createControlApi({ cfg, store, relay });
  const server = http.createServer(control);
  await listen(server, cfg.controllerPort);
  log.info("controller_listening", {
    port: cfg.controllerPort,
    sandboxNamespace: cfg.sandboxNamespace,
    runtimeClass: cfg.runtimeClass,
    executionMode: cfg.executionMode,
    kubeEnabled: cfg.kubeEnabled,
  });

  const reconciler = new Reconciler({ cfg, store, provisioner, relay });
  reconciler.start();

  installShutdown(async () => {
    reconciler.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const fn of shutdown) await fn();
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
