/**
 * HTTP transport for the sandbox API: the base URL, the capability header, and
 * the one mapping from a failed response to a `SandboxError`.
 *
 * Everything above this module (session lifecycle, operations, the data plane)
 * speaks in paths and typed errors; only this file knows what a `Response` is.
 */
import { SandboxError, SessionExpiredError, type SessionHandle } from "./types.js";

export class ClientTransport {
  readonly apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  auth(handle: SessionHandle): Record<string, string> {
    return { "x-sandbox-capability": handle.capability };
  }

  async api(
    path: string,
    init: RequestInit = {},
    timeoutMs = 180_000,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  }

  async errorFrom(res: Response, fallback: string): Promise<SandboxError> {
    const text = await res.text().catch(() => "");
    return this.errorFromText(res.status, text, fallback);
  }

  errorFromText(status: number, text: string, fallback: string): SandboxError {
    let code = fallback;
    let message = text.slice(0, 300);
    let requestId: string | undefined;
    try {
      const body = JSON.parse(text) as { error?: string; message?: string; requestId?: string };
      code = body.error ?? fallback;
      message = body.message ?? message;
      requestId = body.requestId;
    } catch {
      /* keep defaults */
    }
    if (status === 410 && /lease|expired/.test(code)) return new SessionExpiredError(message);
    return new SandboxError(code, message, status, requestId);
  }
}
