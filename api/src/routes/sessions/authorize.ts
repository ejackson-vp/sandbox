/**
 * The capability check every session route starts with.
 *
 * One limiter for the whole session surface, because the read limit is a
 * product limit on reads, not a limit per route. The token is a possession
 * capability: the server keeps only its SHA-256, so the check is a hash compare
 * against the session row, and a token signed by a retired key id is refused
 * before that compare so retiring a key takes effect immediately.
 */
import type { Request, Response } from "express";
import { ringAcceptsToken, safeEqualHex, sha256Hex } from "@x402s/shared/crypto";
import { log, recordAuthFailure, recordRateLimited } from "@x402s/shared/runtime";
import type { ApiConfig } from "../../config.js";
import { RateLimiter } from "../../admission.js";
import { ControllerError, type ControllerClient, type SessionView } from "../../controller-client.js";

export interface SessionsDeps {
  config: ApiConfig;
  controller: ControllerClient;
}

/** Resolves the session behind the capability, or writes the refusal and returns null. */
export type Authorizer = (req: Request, res: Response) => Promise<SessionView | null>;

export function createAuthorizer(deps: SessionsDeps): Authorizer {
  const readLimiter = new RateLimiter(deps.config.readRateBurst, deps.config.readRateRefill);

  return async (req, res) => {
    if (!readLimiter.take(req.ip ?? "unknown")) {
      recordRateLimited("read");
      res.status(429).json({ error: "rate_limited" });
      return null;
    }
    const capability = readCapability(req, res);
    if (capability === null) return null;
    const session = await loadSession(deps.controller, req, res);
    if (session === null) return null;
    if (!acceptsCapability(deps.config, session, capability)) {
      recordAuthFailure("capability_invalid");
      res.status(404).json({ error: "session_not_found" });
      return null;
    }
    if (Date.now() > session.capabilityExpiresAt) {
      recordAuthFailure("capability_expired");
      res.status(410).json({ error: "capability_expired" });
      return null;
    }
    return session;
  };
}

function readCapability(req: Request, res: Response): string | null {
  const capability = req.header("x-sandbox-capability");
  if (!capability || capability.length < 20 || capability.length > 128) {
    recordAuthFailure("capability_missing");
    res.status(401).json({ error: "capability_required" });
    return null;
  }
  return capability;
}

async function loadSession(
  controller: ControllerClient,
  req: Request,
  res: Response,
): Promise<SessionView | null> {
  const id = String(req.params.id ?? "");
  try {
    return await controller.getSession(id);
  } catch (err) {
    if (err instanceof ControllerError && err.status === 404) {
      res.status(404).json({ error: "session_not_found" });
      return null;
    }
    log.error("session_lookup_failed", { error: (err as Error).message });
    res.status(503).json({ error: "control_plane_unavailable" });
    return null;
  }
}

function acceptsCapability(config: ApiConfig, session: SessionView, capability: string): boolean {
  // Legacy tokens carry no key id and are covered by the hash alone.
  if (!ringAcceptsToken(config.capabilityKeys, capability)) return false;
  return safeEqualHex(sha256Hex(capability), session.capabilityHash);
}
