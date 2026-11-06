/**
 * Reconciliation loop: the only component that mutates session state.
 *
 *  PAID          -> register relay session + create pod
 *  PROVISIONING  -> READY when the guest hello (with evidence) arrives; the
 *                   immutable lease deadline is set here (ready + duration)
 *  READY/ACTIVE  -> TERMINATING on lease expiry or client destroy
 *  TERMINATING   -> ask the guest to stop, delete the pod, purge relay state,
 *                   then finalise as EXPIRED / DESTROYED / FAILED
 *
 * Deadline enforcement never depends on the untrusted guest cooperating: the
 * controller's clock decides, and pod deletion is the backstop.
 */
import type { RelaySessionState } from "@x402s/shared";
import type { ControllerConfig } from "./config.js";
import type { Provisioner } from "./k8s.js";
import type { RelayClient } from "./relay-client.js";
import type { SessionRecord, Store } from "./store.js";
import { newOpaqueToken, sha256Hex } from "./tokens.js";
import { proxyTokenFor } from "./config.js";
import { log } from "./log.js";

export interface ReconcilerDeps {
  cfg: ControllerConfig;
  store: Store;
  provisioner: Provisioner;
  relay: RelayClient;
  now?: () => number;
  /** Override for tests: resolves service addresses without Kubernetes. */
  serviceAddress?: (name: string) => Promise<{ host: string; port: number } | null>;
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => number;

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.cfg.reconcileIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const session of this.deps.store.listNonTerminal()) {
        try {
          await this.reconcileSession(session);
        } catch (err) {
          log.error("reconcile_session_failed", {
            sessionId: session.id,
            state: session.state,
            error: (err as Error).message,
          });
        }
      }
      for (const session of this.deps.store.listTerminalWithPod()) {
        if (!session.podName) continue;
        await this.deps.provisioner.deletePod(session.podName, 0).catch(() => undefined);
        this.deps.store.clearPod(session.id);
      }
      await this.sweepOrphanPods();
    } catch (err) {
      log.error("reconcile_pass_failed", { error: (err as Error).message });
    } finally {
      this.running = false;
    }
  }

  private async reconcileSession(session: SessionRecord): Promise<void> {
    switch (session.state) {
      case "PAID":
        await this.provision(session);
        break;
      case "PROVISIONING":
        await this.awaitReady(session);
        break;
      case "READY":
      case "ACTIVE":
        await this.enforceLease(session);
        break;
      case "TERMINATING":
        await this.terminate(session);
        break;
      default:
        break;
    }
  }

  private async serviceAddress(name: string): Promise<{ host: string; port: number } | null> {
    if (this.deps.serviceAddress) return this.deps.serviceAddress(name);
    return this.deps.provisioner.getServiceAddress(name);
  }

  private async provision(session: SessionRecord): Promise<void> {
    const relayAddr = await this.serviceAddress(this.deps.cfg.relayServiceName);
    const proxyAddr = await this.serviceAddress(this.deps.cfg.proxyServiceName);
    if (!relayAddr || !proxyAddr) {
      log.warn("sandbox_services_unavailable", {
        sessionId: session.id,
        relay: Boolean(relayAddr),
        proxy: Boolean(proxyAddr),
      });
      return;
    }

    const guestToken = newOpaqueToken(32);
    const tokenHash = sha256Hex(guestToken);
    const ttlMs =
      this.deps.cfg.provisioningTimeoutMs + session.durationSeconds * 1000 + 5 * 60_000;
    try {
      await this.deps.relay.register(session.id, tokenHash, ttlMs);
    } catch (err) {
      if ((err as { status?: number }).status !== 409) {
        log.warn("relay_register_failed", { sessionId: session.id, error: (err as Error).message });
        return;
      }
    }
    this.deps.store.setRelayToken(session.id, tokenHash);

    const relayUrl = `ws://${relayAddr.host}:${relayAddr.port}/guest?session=${encodeURIComponent(session.id)}`;
    const proxyUrl = `http://${proxyAddr.host}:${proxyAddr.port}`;

    const { podName } = await this.deps.provisioner.createPod({
      sessionId: session.id,
      leaseSeconds: session.durationSeconds,
      limits: session.limits,
      clientPublicKey: session.clientPublicKey,
      clientNonce: session.clientNonce,
      guestToken,
      relayUrl,
      relayHost: relayAddr.host,
      relayPort: relayAddr.port,
      proxyUrl,
      proxyToken: proxyTokenFor(this.deps.cfg, session.id),
      image: this.deps.cfg.guestImage,
      imageDigest: this.deps.cfg.guestImageDigest,
      runtimeClass: this.deps.cfg.runtimeClass,
      executionMode: this.deps.cfg.executionMode,
      workspaceDir: this.deps.cfg.workspaceDir,
    });

    this.deps.store.setProvisioning(session.id, podName);
    log.info("sandbox_provisioning", {
      sessionId: session.id,
      podName,
      runtimeClass: this.deps.cfg.runtimeClass,
      tier: session.tier,
      leaseSeconds: session.durationSeconds,
    });
  }

  private async awaitReady(session: SessionRecord): Promise<void> {
    const age = this.now() - (session.paidAt ?? session.createdAt);
    if (age > this.deps.cfg.provisioningTimeoutMs) {
      this.deps.store.requestTermination(session.id, "failure:provisioning_timeout", {
        code: "provisioning_timeout",
        message: "sandbox did not become ready in time",
      });
      log.warn("sandbox_provisioning_timeout", { sessionId: session.id, ageMs: age });
      return;
    }

    if (session.relayTokenHash) {
      try {
        const state = await this.deps.relay.state(session.id);
        if (!state.registered) {
          await this.deps.relay.register(
            session.id,
            session.relayTokenHash,
            this.deps.cfg.provisioningTimeoutMs + session.durationSeconds * 1000 + 300_000,
          );
        }
        if (state.connected && state.attestation) {
          const readyAt = this.now();
          const leaseExpiresAt = readyAt + session.durationSeconds * 1000;
          const ok = this.deps.store.setReady(
            session.id,
            readyAt,
            leaseExpiresAt,
            JSON.stringify(state.attestation),
            state.attestation.guestPublicKey,
          );
          if (ok) {
            log.info("sandbox_ready", {
              sessionId: session.id,
              evidenceType: state.attestation.evidenceType,
              insecureDevOnly: state.attestation.insecureDevOnly,
              leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
            });
          }
        }
      } catch (err) {
        log.warn("relay_state_check_failed", { sessionId: session.id, error: (err as Error).message });
      }
    }

    if (session.podName) {
      const pod = await this.deps.provisioner.getPod(session.podName).catch(() => null);
      if (pod && (pod.phase === "Failed" || pod.phase === "Succeeded")) {
        this.deps.store.requestTermination(session.id, "failure:pod_terminated", {
          code: "pod_terminated",
          message: `pod reached phase ${pod.phase}`,
        });
      }
    }
  }

  private async enforceLease(session: SessionRecord): Promise<void> {
    if (session.destroyRequested) {
      this.deps.store.requestTermination(session.id, "client_destroy");
      return;
    }
    const deadline = session.leaseExpiresAt;
    if (deadline === null) return;
    const now = this.now();
    if (now > deadline + this.deps.cfg.leaseGraceMs) {
      this.deps.store.requestTermination(session.id, "lease_expired");
      log.warn("sandbox_lease_expired", { sessionId: session.id, state: session.state, overrunMs: now - deadline });
    }
  }

  private async terminate(session: SessionRecord): Promise<void> {
    // Ask the guest to stop so it can kill descendants before the pod goes away.
    try {
      await this.deps.relay.shutdown(session.id, session.terminationReason ?? "terminated");
    } catch {
      /* relay may already be gone */
    }

    if (session.podName) {
      await this.deps.provisioner.deletePod(session.podName, 1).catch(() => undefined);
      this.deps.store.clearPod(session.id);
    }
    if (session.relayPurgedAt === null) {
      try {
        await this.deps.relay.purge(session.id);
        this.deps.store.markRelayPurged(session.id);
      } catch (err) {
        log.warn("relay_purge_failed", { sessionId: session.id, error: (err as Error).message });
      }
    }
    const finalState = this.deps.store.finalizeTermination(session.id);
    log.info("sandbox_destroyed", {
      sessionId: session.id,
      state: finalState ?? "unknown",
      reason: session.terminationReason ?? "unknown",
    });
  }

  /** Delete pods that no session owns, or that outlived every possible deadline. */
  private async sweepOrphanPods(): Promise<void> {
    let pods;
    try {
      pods = await this.deps.provisioner.listSandboxPods();
    } catch {
      return;
    }
    const now = this.now();
    for (const pod of pods) {
      const session = pod.sessionId ? this.deps.store.getSession(pod.sessionId) : null;
      const terminal =
        !session || ["DESTROYED", "EXPIRED", "FAILED", "TERMINATING"].includes(session.state);
      const tooOld = pod.createdAt > 0 && now - pod.createdAt > this.deps.cfg.maxPodAgeMs;
      if (terminal || tooOld) {
        await this.deps.provisioner.deletePod(pod.name, 0).catch(() => undefined);
        log.warn("orphan_pod_reaped", {
          podName: pod.name,
          sessionId: pod.sessionId || undefined,
          reason: terminal ? "no_live_session" : "max_age",
        });
        if (session && session.state !== "TERMINATING") {
          this.deps.store.requestTermination(session.id, "failure:reaped", {
            code: "reaped",
            message: "sandbox exceeded the maximum pod age",
          });
        }
      }
    }
  }
}

export type { RelaySessionState };
