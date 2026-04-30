import { authStorage } from "@/lib/storage/auth-storage";
import { recordClientApiError, recordClientApiEvent } from "@/lib/diagnostics/client-stability";
import { ApiError, AuthExpiredError, type ApiEnvelope, type RefreshResponse } from "./types";

// ─── Single-flight refresh guard ───

let refreshPromise: Promise<void> | null = null;

function buildInvalidResponseError(path: string, res: Response, body: string): ApiError {
  const contentType = res.headers.get("content-type") ?? "unknown content-type";
  const trimmed = body.trim();
  const looksLikeHtml = contentType.includes("text/html") || trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
  const details = looksLikeHtml
    ? `Expected Friday API JSON from ${path}, but received HTML instead. This usually means the current UI origin is not proxying /v1 to the Friday API.`
    : `Expected Friday API JSON from ${path}, but received ${contentType}.`;

  return new ApiError("INVALID_RESPONSE", "Friday API returned an unexpected response.", res.status, false, undefined, details);
}

async function readEnvelope<T>(path: string, res: Response): Promise<ApiEnvelope<T>> {
  const body = await res.text();
  if (body.trim().length === 0) {
    throw new ApiError(
      "INVALID_RESPONSE",
      "Friday API returned an empty response.",
      res.status,
      false,
      undefined,
      `Expected Friday API JSON from ${path}, but the response body was empty.`,
    );
  }

  try {
    return JSON.parse(body) as ApiEnvelope<T>;
  } catch {
    throw buildInvalidResponseError(path, res, body);
  }
}

async function doRefresh(): Promise<void> {
  const refreshToken = authStorage.getRefreshToken();
  if (!refreshToken) {
    authStorage.clear();
    throw new AuthExpiredError();
  }

  const res = await fetch("/v1/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    authStorage.clear();
    throw new AuthExpiredError();
  }

  const envelope = await readEnvelope<RefreshResponse>("/v1/auth/refresh", res);
  if (!envelope.ok) {
    authStorage.clear();
    throw new AuthExpiredError();
  }

  authStorage.setTokens(envelope.data.accessToken, envelope.data.refreshToken);
}

async function refreshSession(): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

function canRefreshSession(path: string): boolean {
  return !path.startsWith("/v1/auth/");
}

// ─── Core fetch wrapper ───

async function apiFetch<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const headers = new Headers(init.headers);

  const token = authStorage.getAccessToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch (error) {
    recordClientApiError({
      path,
      method: init.method ?? "GET",
      kind: "network",
      durationMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt),
    });
    throw new ApiError(
      "NETWORK_ERROR",
      "Could not reach the Friday API.",
      0,
      false,
      undefined,
      `The current origin could not reach ${path}. Verify that the active UI origin forwards /v1 requests to the Friday API.`,
    );
  }

  if (res.status === 401 && retry && canRefreshSession(path)) {
    try {
      if (token) {
        await refreshSession();
      } else {
        throw new AuthExpiredError();
      }
    } catch {
      throw new AuthExpiredError();
    }
    return apiFetch<T>(path, init, false);
  }

  const envelope = await readEnvelope<T>(path, res);

  if (!envelope.ok) {
    recordClientApiError({
      path,
      method: init.method ?? "GET",
      kind: "api",
      status: res.status,
      code: envelope.error.code,
      durationMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt),
    });
    throw new ApiError(
      envelope.error.code,
      envelope.error.message,
      res.status,
      envelope.error.retryable,
      envelope.error.retryAfterMs,
    );
  }

  recordClientApiEvent({
    path,
    method: init.method ?? "GET",
    status: res.status,
    durationMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt),
  });

  return envelope.data;
}

// ─── Typed API client ───

export const apiClient = {
  get<T>(path: string, init?: RequestInit): Promise<T> {
    return apiFetch<T>(path, { ...init, method: "GET" });
  },

  post<TReq, TRes>(path: string, body: TReq, init?: RequestInit): Promise<TRes> {
    return apiFetch<TRes>(path, {
      ...init,
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  patch<TReq, TRes>(path: string, body: TReq, init?: RequestInit): Promise<TRes> {
    return apiFetch<TRes>(path, {
      ...init,
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  put<TReq, TRes>(path: string, body: TReq, init?: RequestInit): Promise<TRes> {
    return apiFetch<TRes>(path, {
      ...init,
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  del<T>(path: string, init?: RequestInit): Promise<T> {
    return apiFetch<T>(path, { ...init, method: "DELETE" });
  },

  refreshSession,

  clearSession(): void {
    authStorage.clear();
  },
};
