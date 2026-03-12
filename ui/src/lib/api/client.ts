import { authStorage } from "@/lib/storage/auth-storage";
import { ApiError, AuthExpiredError, type ApiEnvelope, type RefreshResponse } from "./types";

// ─── Single-flight refresh guard ───

let refreshPromise: Promise<void> | null = null;

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

  const envelope = (await res.json()) as ApiEnvelope<RefreshResponse>;
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

// ─── Core fetch wrapper ───

async function apiFetch<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);

  const token = authStorage.getAccessToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, { ...init, headers });

  // Handle 401 with retry
  if (res.status === 401 && token && retry) {
    try {
      await refreshSession();
    } catch {
      throw new AuthExpiredError();
    }
    return apiFetch<T>(path, init, false);
  }

  const envelope = (await res.json()) as ApiEnvelope<T>;

  if (!envelope.ok) {
    throw new ApiError(
      envelope.error.code,
      envelope.error.message,
      res.status,
      envelope.error.retryable,
      envelope.error.retryAfterMs,
    );
  }

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
