/**
 * Control-plane credentials.
 *
 * Two groups, parsed at different points of startup so a missing required
 * setting is refused before anything else in that group is inspected:
 *
 *  - the admin token (and its rotation predecessor), checked before any tier
 *    or capacity setting is read;
 *  - the per-service tokens, checked after transport security.
 *
 * Key separation is part of the contract: no service token may reuse the admin
 * token, and a rotation's previous token is equally forbidden.
 */
import type { Role } from "./role.js";

export interface AdminTokens {
  adminToken: string;
  /** Only present during a rotation overlap window. */
  adminTokenPrevious?: string;
}

export interface ServiceTokens {
  relayAdminToken: string;
  wakeToken: string;
  proxyTokenSecret: string;
}

export function parseAdminTokens(env: NodeJS.ProcessEnv, role: Role): AdminTokens {
  const adminToken = env.ADMIN_TOKEN ?? "";
  if (["controller", "all"].includes(role) && adminToken.length < 16) {
    throw new Error("ADMIN_TOKEN must be set (>=16 chars) for controller roles");
  }
  // Rotation overlap: the new token is presented, the old one is still accepted
  // until every caller has been switched over. Validated here rather than in
  // the control API so a bad pair fails at startup, not on the first request.
  const adminTokenPrevious = env.ADMIN_TOKEN_PREVIOUS ?? "";
  if (adminTokenPrevious.length > 0) {
    if (["controller", "all"].includes(role) && adminTokenPrevious.length < 16) {
      throw new Error("ADMIN_TOKEN_PREVIOUS must be at least 16 characters when set");
    }
    if (adminTokenPrevious === adminToken) {
      throw new Error("ADMIN_TOKEN_PREVIOUS must differ from ADMIN_TOKEN");
    }
  }
  return {
    adminToken,
    ...(adminTokenPrevious ? { adminTokenPrevious } : {}),
  };
}

export function parseServiceTokens(
  env: NodeJS.ProcessEnv,
  role: Role,
  adminToken: string,
  adminTokenPrevious?: string,
): ServiceTokens {
  const requireDistinctToken = (name: string, value: string | undefined): string => {
    if (!value || value.length < 16) {
      throw new Error(`${name} must be set (>=16 chars) and must not reuse ADMIN_TOKEN`);
    }
    if (value === adminToken || (adminTokenPrevious !== undefined && value === adminTokenPrevious)) {
      throw new Error(`${name} must differ from ADMIN_TOKEN (key separation)`);
    }
    return value;
  };
  const needsRelayTokens = role === "all" || role === "controller" || role === "relay";
  const needsProxyToken = role === "all" || role === "controller" || role === "proxy";
  const relayAdminToken = needsRelayTokens
    ? requireDistinctToken("RELAY_ADMIN_TOKEN", env.RELAY_ADMIN_TOKEN)
    : (env.RELAY_ADMIN_TOKEN ?? "");
  const wakeToken = needsRelayTokens
    ? requireDistinctToken("WAKE_TOKEN", env.WAKE_TOKEN)
    : (env.WAKE_TOKEN ?? "");
  const proxyTokenSecret = needsProxyToken
    ? requireDistinctToken("PROXY_TOKEN_SECRET", env.PROXY_TOKEN_SECRET)
    : (env.PROXY_TOKEN_SECRET ?? "");
  return { relayAdminToken, wakeToken, proxyTokenSecret };
}
