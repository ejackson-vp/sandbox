/**
 * Local session credential store.
 *
 * A session handle needs three things to keep working across CLI invocations:
 * the session id, the possession capability, and the client's X25519 private key
 * (the guest encrypts results to it). They are written to a mode-0600 file under
 * the user's config directory. Nothing is stored server-side except the
 * capability hash.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StoredSession {
  apiUrl: string;
  sessionId: string;
  capability: string;
  clientPublicKey: string;
  clientPrivateKey: string;
  clientNonce: string;
  createdAt: number;
  leaseExpiresAt?: number;
  tier?: string;
  /** Pinned after first successful attestation verification. */
  guestPublicKey?: string;
}

export class FileSessionStore {
  constructor(private readonly dir = process.env.X402_SANDBOX_HOME ?? join(homedir(), ".config", "x402-sandbox")) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      /* best effort */
    }
  }

  private path(sessionId: string): string {
    if (!/^sbx_[0-9a-f]{24}$/.test(sessionId)) throw new Error(`invalid session id ${sessionId}`);
    return join(this.dir, `${sessionId}.json`);
  }

  save(session: StoredSession): void {
    const file = this.path(session.sessionId);
    writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }

  get(sessionId: string): StoredSession | null {
    const file = this.path(sessionId);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as StoredSession;
  }

  list(): StoredSession[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), "utf8")) as StoredSession;
        } catch {
          return null;
        }
      })
      .filter((s): s is StoredSession => s !== null);
  }

  remove(sessionId: string): void {
    rmSync(this.path(sessionId), { force: true });
  }
}
