/**
 * Reconciliation loop: the only component that mutates sandbox state.
 *
 * Responsibilities
 *  - PAID -> PROVISIONING: register the session at the relay, mint an ephemeral
 *    guest token + proxy token, create the pod.
 *  - PROVISIONING -> READY: wait for the guest's hello (evidence bound to this
 *    session and the customer nonce). The execution window starts HERE.
 *  - READY/RUNNING -> COMPLETED: pick up the encrypted result from the relay.
 *  - independent deadline enforcement (guest watchdog is not trusted).
 *  - teardown: delete pods, purge relay state, drop ephemeral data.
 *  - orphan sweep: delete pods whose session is unknown or terminal, and pods
 *    older than MAX_POD_AGE, including after a controller crash/restart.
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

  /** One reconciliation pass. Exposed for tests and crash-recovery debugging. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sessions = this.deps.store.listNonTerminal();
      for (const session of sessions) {
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
      case "RUNNING":
        await this.enforceDeadline(session);
        break;
      case "COMPLETED":
        await this.finishCompleted(session);
        break;
      case "EXPIRED":
      case "FAILED":
        await this.teardown(session);
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
      // Retry on the next tick; do not fail fast, services may still be coming up.
      log.warn("sandbox_services_unavailable", { sessionId: session.id, relay: Boolean(relayAddr), proxy: Boolean(proxyAddr) });
      return;
    }

    const guestToken = newOpaqueToken(32);
    const tokenHash = sha256Hex(guestToken);
    try {
      await this.deps.relay.register(session.id, tokenHash, 15 * 60_000);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 409) {
        log.warn("relay_register_failed", { sessionId: session.id, error: (err as Error).message });
        return;
      }
    }
    this.deps.store.setRelayToken(session.id, tokenHash);

    // The guest token is NOT placed in the URL or the main container env: the
    // bootstrap init container writes it to a 0400 file that the guest reads and
    // deletes before any customer payload arrives.
    const relayUrl = `ws://${relayAddr.host}:${relayAddr.port}/guest?session=${encodeURIComponent(session.id)}`;
    const proxyUrl = `http://${proxyAddr.host}:${proxyAddr.port}`;

    const { podName } = await this.deps.provisioner.createPod({
      sessionId: session.id,
      durationSeconds: session.durationSeconds,
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
    });

    const moved = this.deps.store.setProvisioning(session.id, podName);
    objectNoop(moved);
    log.info("sandbox_provisioning", { sessionId: session.id, podName, runtimeClass: this.deps.cfg.runtimeClass });
  }

  private async awaitReady(session: SessionRecord): Promise<void> {
    const age = this.now() - session.createdAt;
    if (age > this.deps.cfg.provisioningTimeoutMs) {
      this.deps.store.markFailed(session.id, "provisioning_timeout", "sandbox did not become ready in time");
      log.warn("sandbox_provisioning_timeout", { sessionId: session.id, ageMs: age });
      return;
    }

    // Re-register if the relay restarted and lost in-memory state.
    if (session.relayTokenHash) {
      try {
        const state = await this.deps.relay.state(session.id);
        if (!state.registered) {
          await this.deps.relay.register(session.id, session.relayTokenHash, 15 * 60_000);
        }
        if (state.connected && state.attestation) {
          const readyAt = this.now();
          const deadline = readyAt + session.durationSeconds * 1000;
          const ok = this.deps.store.setReady(
            session.id,
            readyAt,
            deadline,
            JSON.stringify(state.attestation),
            state.attestation.guestPublicKey,
          );
          if (ok) {
            log.info("sandbox_ready", {
              sessionId: session.id,
              evidenceType: state.attestation.evidenceType,
              insecureDevOnly: state.attestation.insecureDevOnly,
              executionDeadline: new Date(deadline).toISOString(),
            });
          }
        }
      } catch (err) {
        log.warn("relay_state_check_failed", { sessionId: session.id, error: (err as Error).message });
      }
    }

    // Pod-level failures: a pod that will never start should fail the session
    // instead of burning the provisioning budget.
    if (session.podName) {
      const pod = await this.deps.provisioner.getPod(session.podName).catch(() => null);
      if (pod && (pod.phase === "Failed" || pod.phase === "Succeeded")) {
        this.deps.store.markFailed(session.id, "pod_terminated", `pod reached phase ${pod.phase}`);
      }
    }
  }

  private async enforceDeadline(session: SessionRecord): Promise<void> {
    const deadline = session.executionDeadlineAt;
    if (!deadline) return;

    if (session.destroyRequested) {
      this.deps.store.markFailed(session.id, "cancelled_by_client", "sandbox destroyed at customer request");
      return;
    }

    const now = this.now();
    if (now > deadline + this.deps.cfg.executionGraceMs) {
      const code = session.state === "RUNNING" ? "execution_timeout" : "execution_window_elapsed";
      this.deps.store.markExpired(session.id, code, "execution window ended; sandbox terminated");
      log.warn("sandbox_expired", { sessionId: session.id, state: session.state, overrunMs: now - deadline });
      return;
    }

    // Pick up a guest result proactively so the CLI sees COMPLETED promptly.
    if (session.state === "RUNNING") {
      try {
        const state = await this.deps.relay.state(session.id);
        if (state.resultAvailable) {
          this.deps.store.markCompleted(session.id);
          log.info("sandbox_completed", { sessionId: session.id });
        }
        if (state.error && !state.resultAvailable) {
          this.deps.store.markFailed(session.id, "guest_error", state.error);
        }
      } catch {
        /* relay hiccup: retry next tick */
      }
    }
  }

  private async finishCompleted(session: SessionRecord): Promise<void> {
    // Execution state is discarded as soon as it completes: delete the pod now.
    if (session.podName) {
      const pod = await this.deps.provisioner.getPod(session.podName).catch(() => null);
      if (pod) {
        await this.deps.provisioner.deletePod(session.podName, 0).catch(() => undefined);
      } else {
        this.deps.store.clearPod(session.id);
      }
    }

    if (session.destroyRequested) {
      await this.purgeRelay(session);
      this.deps.store.markDestroyed(session.id);
      return;
    }

    const completedAt = session.completedAt ?? this.now();
    const fetched = session.resultFetchedAt !== null;
    const expired = this.now() > completedAt + this.deps.cfg.resultTtlMs;
    if (fetched || expired) {
      await this.purgeRelay(session);
      this.deps.store.markDestroyed(session.id);
      log.info("sandbox_destroyed", { sessionId: session.id, reason: fetched ? "result_fetched" : "result_ttl" });
    }
  }

  private async teardown(session: SessionRecord): Promise<void> {
    if (session.podName) {
      const pod = await this.deps.provisioner.getPod(session.podName).catch(() => null);
      if (pod) {
        await this.deps.provisioner.deletePod(session.podName, 0).catch(() => undefined);
      }
    }
    await this.purgeRelay(session);
    this.deps.store.noteDestroyed(session.id);
  }

  private async purgeRelay(session: SessionRecord): Promise<void> {
    if (session.relayPurgedAt !== null) return;
    try {
      await this.deps.relay.purge(session.id);
      this.deps.store.markRelayPurged(session.id);
    } catch (err) {
      log.warn("relay_purge_failed", { sessionId: session.id, error: (err as Error).message });
    }
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
      const orphan = !session || ["DESTROYED", "EXPIRED", "FAILED", "COMPLETED"].includes(session.state);
      const tooOld = pod.createdAt > 0 && now - pod.createdAt > this.deps.cfg.maxPodAgeMs;
      if (orphan || tooOld) {
        await this.deps.provisioner.deletePod(pod.name, 0).catch(() => undefined);
        log.warn("orphan_pod_reaped", {
          podName: pod.name,
          sessionId: pod.sessionId || undefined,
          reason: orphan ? "no_live_session" : "max_age",
        });
        if (session && !["DESTROYED", "EXPIRED", "FAILED", "COMPLETED"].includes(session.state)) {
          this.deps.store.markFailed(session.id, "reaped", "sandbox exceeded maximum age");
        }
      }
    }
  }
}

function objectNoop(_v: unknown): void {
  /* keeps intentional ignored return values explicit */
}
