import { HEADER_NAME, HEADER_VALUE } from "../types.ts";
import type {
  Me, OpsRequest, OpsResponse, ReceiptsResponse, RestoreRequest, RestoreResult, Snapshot,
} from "../types.ts";

export class NetworkError extends Error {
  readonly timedOut: boolean;

  constructor(cause: unknown, timedOut = false) {
    super("Could not reach the Family Tab server.", { cause });
    this.name = "NetworkError";
    this.timedOut = timedOut;
  }
}

export class AuthError extends Error {
  constructor() {
    super("Sign in to Family Tab to continue syncing.");
    this.name = "AuthError";
  }
}

export class ServerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ServerError";
    this.status = status;
    this.code = code;
  }
}

export const loginURL = "/auth/login";

const REQUEST_TIMEOUT_MS = 20_000;
const RESTORE_TIMEOUT_MS = 60_000;

export function createApi(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
  async function request<T>(path: string, decode: (r: Response) => Promise<T>, body?: unknown,
    method = body === undefined ? "GET" : "POST", timeout = REQUEST_TIMEOUT_MS) {
    const headers = new Headers({ [HEADER_NAME]: HEADER_VALUE });
    if (body !== undefined) headers.set("Content-Type", "application/json");

    const authRedirect = path.startsWith("/auth/");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetcher(path, {
        method,
        credentials: "same-origin",
        redirect: authRedirect ? "manual" : "follow",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status === 401) throw new AuthError();
      const redirect = authRedirect && (response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400));
      if (!response.ok && !redirect) {
        const error = await response.json().catch(() => {
          controller.signal.throwIfAborted();
          return null;
        });
        throw new ServerError(response.status, error?.error ?? "http_error",
          error?.message ?? `Server returned HTTP ${response.status}.`);
      }
      try {
        return await decode(response);
      } catch (error) {
        controller.signal.throwIfAborted();
        if (error instanceof TypeError || error instanceof ServerError) throw error;
        throw new ServerError(response.status, "invalid_response", "The server response was invalid.");
      }
    } catch (error) {
      if (error instanceof AuthError || error instanceof ServerError) throw error;
      throw new NetworkError(error, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
    }
  }

  function json<T>(path: string, body?: unknown) {
    return request<T>(path, r => r.json(), body);
  }

  return {
    health: () => request("/healthz", r => r.text()),
    // Use loginURL for top-level SSO navigation.
    login: () => request(loginURL, async r => r),
    callback: (query: URLSearchParams) => request(`/auth/callback?${query}`, async r => r),
    logout: () => request("/api/logout", async r => {
      if (r.status !== 204) throw new ServerError(r.status, "invalid_response", "Expected HTTP 204 from sign-out.");
    }, undefined, "POST"),
    me: () => json<Me>("/api/me"),
    snapshot: () => json<Snapshot>("/api/snapshot"),
    receipts: (opIds: string[]) => json<ReceiptsResponse>("/api/sync/receipts", { opIds }),
    ops: (body: OpsRequest) => json<OpsResponse>("/api/sync/ops", body),
    restore: (body: RestoreRequest) => request<RestoreResult>("/api/restore", r => r.json(), body, "POST", RESTORE_TIMEOUT_MS),
  };
}

export type Api = ReturnType<typeof createApi>;
