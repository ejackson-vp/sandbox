/**
 * The on-disk session store the CLI keeps under ~/.config/x402-sandbox.
 *
 * What matters here is not that JSON round-trips: it is that the capability and
 * the X25519 private key land in a 0600 file inside a 0700 directory, and that
 * one corrupt file cannot hide the handles next to it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSessionStore, type StoredSession } from "../../sdk/src/session-store.js";

const ID = "sbx_0123456789abcdef01234567";
const OTHER_ID = "sbx_fedcba9876543210fedcba98";

let root: string;
let store: FileSessionStore;

function record(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    apiUrl: "http://localhost:8080",
    sessionId: ID,
    capability: "cap_abc",
    clientPublicKey: Buffer.alloc(32, 1).toString("base64"),
    clientPrivateKey: Buffer.alloc(32, 2).toString("base64"),
    clientNonce: "nonce_abc",
    createdAt: 1_767_225_600_000,
    tier: "standard",
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "x402-store-"));
  store = new FileSessionStore(join(root, "store"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.X402_SANDBOX_HOME;
});

describe("round trip", () => {
  it("returns exactly what it saved", () => {
    const saved = record();
    store.save(saved);
    expect(store.get(ID)).toEqual(saved);
  });

  it("keeps the capability and the private key readable for the next process", () => {
    store.save(record());
    const onDisk = JSON.parse(readFileSync(join(root, "store", `${ID}.json`), "utf8")) as StoredSession;
    expect(onDisk.capability).toBe("cap_abc");
    expect(onDisk.clientPrivateKey).toBe(Buffer.alloc(32, 2).toString("base64"));
  });

  it("returns null for a session it has never seen", () => {
    expect(store.get(OTHER_ID)).toBeNull();
  });

  it("lists every stored handle", () => {
    store.save(record());
    store.save(record({ sessionId: OTHER_ID, tier: "short" }));
    const ids = store.list()
      .map((s) => s.sessionId)
      .sort();
    expect(ids).toEqual([ID, OTHER_ID].sort());
  });

  it("overwrites an existing handle instead of duplicating it", () => {
    store.save(record());
    store.save(record({ tier: "long" }));
    expect(store.list()).toHaveLength(1);
    expect(store.get(ID)?.tier).toBe("long");
  });

  it("removes a handle and tolerates removing it twice", () => {
    store.save(record());
    store.remove(ID);
    expect(store.get(ID)).toBeNull();
    expect(() => store.remove(ID)).not.toThrow();
    expect(store.list()).toEqual([]);
  });

  it("survives a handle with optional fields absent", () => {
    store.save(record({ tier: undefined }));
    const loaded = store.get(ID);
    expect(loaded).not.toBeNull();
    expect(loaded?.tier).toBeUndefined();
  });
});

describe("permissions", () => {
  it("creates the directory 0700", () => {
    const mode = statSync(join(root, "store")).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("writes the handle 0600", () => {
    store.save(record());
    const mode = statSync(join(root, "store", `${ID}.json`)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tightens the directory again when it already exists with a looser mode", () => {
    const dir = join(root, "loose");
    mkdirSync(dir, { mode: 0o755 });
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    new FileSessionStore(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("tightens a handle file that was already on disk with a looser mode", () => {
    const dir = join(root, "store");
    const file = join(dir, `${ID}.json`);
    writeFileSync(file, JSON.stringify(record()), { mode: 0o644 });
    expect(statSync(file).mode & 0o777).toBe(0o644);
    store.save(record());
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("corrupted and hostile input", () => {
  it("skips a corrupt file when listing", () => {
    store.save(record());
    writeFileSync(join(root, "store", `${OTHER_ID}.json`), "{ this is not json");
    const ids = store.list().map((s) => s.sessionId);
    expect(ids).toEqual([ID]);
  });

  it("throws when asked for the corrupt handle by id", () => {
    // get() is the direct lookup: a caller that names a session gets the parse
    // error rather than a silent null, so the CLI reports it instead of
    // pretending the handle is missing.
    writeFileSync(join(root, "store", `${OTHER_ID}.json`), "{ this is not json");
    expect(() => store.get(OTHER_ID)).toThrow(SyntaxError);
  });

  it("ignores files that are not handles", () => {
    store.save(record());
    writeFileSync(join(root, "store", "README"), "notes");
    writeFileSync(join(root, "store", "other.json.bak"), "{}");
    expect(store.list()).toHaveLength(1);
  });

  it.each(["", "sbx_", "sbx_short", "../escape", ID.slice(0, -1), `${ID}/../x`, "sbx_0123456789ABCDEF01234567"])(
    "refuses %j as a session id",
    (id) => {
      expect(() => store.get(id)).toThrow(`invalid session id ${id}`);
      expect(() => store.save(record({ sessionId: id }))).toThrow(`invalid session id ${id}`);
      expect(() => store.remove(id)).toThrow(`invalid session id ${id}`);
    },
  );
});

describe("default location", () => {
  it("uses X402_SANDBOX_HOME when it is set", () => {
    process.env.X402_SANDBOX_HOME = join(root, "from-env");
    const fromEnv = new FileSessionStore();
    fromEnv.save(record());
    expect(statSync(join(root, "from-env", `${ID}.json`)).mode & 0o777).toBe(0o600);
    expect(new FileSessionStore(join(root, "from-env")).get(ID)?.sessionId).toBe(ID);
  });
});
