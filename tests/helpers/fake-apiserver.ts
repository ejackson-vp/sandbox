/**
 * A fake Kubernetes API server: a fixture, not a simulator.
 *
 * It answers exactly the verbs `controller/src/k8s.ts` and
 * `controller/src/k8s-nodes.ts` send today, and answers them with the shapes a
 * real apiserver returns, including the `Status` body on an error. Anything
 * else gets a 501 that names the verb and path, so a new call in product code
 * fails here instead of passing against a permissive double that accepts
 * everything.
 *
 * Every request is recorded before it is routed, so a test can assert the body
 * the controller actually put on the wire. The wire format is the contract with
 * the cluster: a PodSpec mistake is a security bug, and a mock of our own
 * method would not catch it.
 *
 * Kept intentionally small: no watch, no resourceVersion, no admission, no
 * status subresource. PATCH is recorded but not applied, because the provisioner
 * ignores the reply and only the operations it sent matter.
 */
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import * as k8s from "@kubernetes/client-node";

/** What a test gets to inspect after the provisioner has made a call. */
export interface KubeRequest {
  method: string;
  /** Path only, no query string. */
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  /** Parsed JSON, the raw text if it was not JSON, or undefined for no body. */
  body: unknown;
}

interface Reply {
  status: number;
  body?: unknown;
}

interface Failure {
  method: string;
  path: RegExp;
  status: number;
}

export const FAKE_TOKEN = "fake-apiserver-token";
const API_VERSION = "v1";

const PODS = /^\/api\/v1\/namespaces\/[^/]+\/pods$/;
const POD = /^\/api\/v1\/namespaces\/[^/]+\/pods\/([^/]+)$/;
const PVCS = /^\/api\/v1\/namespaces\/[^/]+\/persistentvolumeclaims$/;
const PVC = /^\/api\/v1\/namespaces\/[^/]+\/persistentvolumeclaims\/([^/]+)$/;
const NODES = /^\/api\/v1\/nodes$/;
const NODE = /^\/api\/v1\/nodes\/([^/]+)$/;

const REASONS: Record<number, string> = {
  403: "Forbidden",
  404: "NotFound",
  409: "AlreadyExists",
  422: "Invalid",
  500: "InternalError",
  501: "MethodNotAllowed",
};

function statusFailure(code: number, message: string): Reply {
  return {
    status: code,
    body: {
      kind: "Status",
      apiVersion: API_VERSION,
      status: "Failure",
      reason: REASONS[code] ?? "Unknown",
      message,
      code,
    },
  };
}

function metadataOf(object: unknown): {
  name?: string;
  labels?: Record<string, string>;
} {
  const metadata = (object as { metadata?: { name?: string; labels?: Record<string, string> } })
    .metadata;
  return metadata ?? {};
}

/**
 * The apiserver does the filtering; the controller only sends the selector.
 * Enough of the grammar for the two-term selectors this code uses.
 */
function selectorMatches(object: unknown, selector: string | undefined): boolean {
  if (!selector) return true;
  const labels = metadataOf(object).labels ?? {};
  return selector.split(",").every((term) => {
    const [key, value] = term.split("=");
    return key !== undefined && labels[key] === value;
  });
}

export class FakeApiServer {
  readonly requests: KubeRequest[] = [];

  private readonly pods = new Map<string, unknown>();
  private readonly pvcs = new Map<string, unknown>();
  private readonly nodes = new Map<string, unknown>();
  private readonly failures: Failure[] = [];
  private server: http.Server | undefined;
  private port = 0;

  static async start(): Promise<FakeApiServer> {
    const fake = new FakeApiServer();
    await fake.listen();
    return fake;
  }

  /** Base URL, for a KubeConfig or a direct probe. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** A kubeconfig pointed at this server, with a bearer token to assert on. */
  kubeConfig(): k8s.KubeConfig {
    const kc = new k8s.KubeConfig();
    kc.loadFromOptions({
      clusters: [
        {
          name: "fake",
          server: this.url,
          // The generated client refuses a plain-`http:` server unless this is
          // true. There is no TLS here to verify, so the flag only serves as
          // the "yes, really, plain http" switch.
          skipTLSVerify: true,
        },
      ],
      users: [{ name: "controller", token: FAKE_TOKEN }],
      contexts: [{ name: "fake", cluster: "fake", user: "controller" }],
      currentContext: "fake",
    });
    return kc;
  }

  seedPod(pod: unknown): this {
    return this.seed(this.pods, pod);
  }

  seedPvc(pvc: unknown): this {
    return this.seed(this.pvcs, pvc);
  }

  seedNode(node: unknown): this {
    return this.seed(this.nodes, node);
  }

  /**
   * Make the next matching call fail, for the paths a cluster reaches without
   * a bug in the controller: a conflict, a deleted object, a dead apiserver.
   */
  failNext(method: string, path: RegExp, status = 500): this {
    this.failures.push({ method, path, status });
    return this;
  }

  /** Requests matching a method and path prefix; the body is what tests read. */
  calls(method: string, path: RegExp = /.*/): KubeRequest[] {
    return this.requests.filter(
      (request) => request.method === method && path.test(request.path),
    );
  }

  close(): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    // Undici keeps connections alive, so `close` alone waits for a socket the
    // client has no reason to drop.
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private seed(store: Map<string, unknown>, object: unknown): this {
    const name = metadataOf(object).name;
    if (name === undefined) throw new Error("a seeded object needs metadata.name");
    store.set(name, object);
    return this;
  }

  private listen(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const request = this.record(req, Buffer.concat(chunks).toString("utf8"));
        const reply = this.reply(request);
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
      });
    });
    return new Promise((resolve) => {
      this.server?.listen(0, "127.0.0.1", () => {
        this.port = (this.server?.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  private record(req: http.IncomingMessage, raw: string): KubeRequest {
    const url = new URL(req.url ?? "/", this.url);
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    let body: unknown;
    if (raw !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const request: KubeRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query,
      headers: req.headers,
      body,
    };
    this.requests.push(request);
    return request;
  }

  private reply(request: KubeRequest): Reply {
    const injected = this.takeFailure(request);
    if (injected) return injected;

    if (PODS.test(request.path)) {
      if (request.method === "GET") return this.list(this.pods, "PodList", request.query);
      if (request.method === "POST") return this.create(this.pods, request.body);
    }

    const pod = POD.exec(request.path);
    if (pod) {
      const name = decodeURIComponent(pod[1] ?? "");
      if (request.method === "GET") return this.read(this.pods, "pods", name);
      if (request.method === "DELETE") return this.remove(this.pods, "pods", name);
      if (request.method === "PATCH") return this.read(this.pods, "pods", name);
    }

    if (PVCS.test(request.path)) {
      if (request.method === "GET") {
        return this.list(this.pvcs, "PersistentVolumeClaimList", request.query);
      }
      if (request.method === "POST") return this.create(this.pvcs, request.body);
    }

    const pvc = PVC.exec(request.path);
    if (pvc) {
      const name = decodeURIComponent(pvc[1] ?? "");
      if (request.method === "GET") {
        return this.read(this.pvcs, "persistentvolumeclaims", name);
      }
      if (request.method === "DELETE") {
        return this.remove(this.pvcs, "persistentvolumeclaims", name);
      }
    }

    if (NODES.test(request.path) && request.method === "GET") {
      return {
        status: 200,
        body: { apiVersion: API_VERSION, kind: "NodeList", items: [...this.nodes.values()] },
      };
    }

    const node = NODE.exec(request.path);
    if (node && request.method === "GET") {
      return this.read(this.nodes, "nodes", decodeURIComponent(node[1] ?? ""));
    }

    return statusFailure(
      501,
      `fake apiserver has no handler for ${request.method} ${request.path}; ` +
        "add the verb to tests/helpers/fake-apiserver.ts if product code now calls it",
    );
  }

  private takeFailure(request: KubeRequest): Reply | null {
    const index = this.failures.findIndex(
      (failure) => failure.method === request.method && failure.path.test(request.path),
    );
    if (index === -1) return null;
    const failure = this.failures[index];
    if (!failure) return null;
    this.failures.splice(index, 1);
    return statusFailure(failure.status, `injected ${failure.status} for ${request.path}`);
  }

  private list(store: Map<string, unknown>, kind: string, query: Record<string, string>): Reply {
    const items = [...store.values()].filter((object) =>
      selectorMatches(object, query.labelSelector),
    );
    return { status: 200, body: { apiVersion: API_VERSION, kind, items } };
  }

  private read(store: Map<string, unknown>, resource: string, name: string): Reply {
    const object = store.get(name);
    if (!object) return statusFailure(404, `${resource} "${name}" not found`);
    return { status: 200, body: object };
  }

  private create(store: Map<string, unknown>, body: unknown): Reply {
    const name = metadataOf(body).name;
    if (name === undefined) return statusFailure(422, "metadata.name is required");
    if (store.has(name)) return statusFailure(409, `already exists: "${name}"`);
    store.set(name, body);
    return { status: 201, body };
  }

  private remove(store: Map<string, unknown>, resource: string, name: string): Reply {
    if (!store.has(name)) return statusFailure(404, `${resource} "${name}" not found`);
    store.delete(name);
    return { status: 200, body: { kind: "Status", apiVersion: API_VERSION, status: "Success" } };
  }
}
