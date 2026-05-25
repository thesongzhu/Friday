import type { FridayUser } from "@/lib/api/types";

const KEYS = {
  accessToken: "friday.auth.accessToken",
  refreshToken: "friday.auth.refreshToken",
  user: "friday.auth.user",
  sessionAccessToken: "friday.auth.sessionAccessToken",
  sessionAccessTokenExpiresAt: "friday.auth.sessionAccessTokenExpiresAt",
} as const;

let inMemoryAccessToken: string | null = null;
let inMemoryRefreshToken: string | null = null;

function getSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readAndClearLegacyToken(key: string): string | null {
  const token = localStorage.getItem(key);
  if (token) {
    localStorage.removeItem(key);
  }
  return token;
}

function readSessionAccessToken(): string | null {
  const storage = getSessionStorage();
  if (!storage) return null;
  const token = storage.getItem(KEYS.sessionAccessToken);
  const expiresAtRaw = storage.getItem(KEYS.sessionAccessTokenExpiresAt);
  const expiresAtMs = expiresAtRaw ? Number.parseInt(expiresAtRaw, 10) : 0;
  if (!token || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    storage.removeItem(KEYS.sessionAccessToken);
    storage.removeItem(KEYS.sessionAccessTokenExpiresAt);
    return null;
  }
  return token;
}

function writeSessionAccessToken(accessToken: string, expiresInSec?: number): void {
  const storage = getSessionStorage();
  if (!storage) return;
  const ttlSec = typeof expiresInSec === "number" ? expiresInSec : 0;
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    storage.removeItem(KEYS.sessionAccessToken);
    storage.removeItem(KEYS.sessionAccessTokenExpiresAt);
    return;
  }
  const expiresAtMs = Date.now() + Math.max(1, Math.floor(ttlSec - 5)) * 1000;
  storage.setItem(KEYS.sessionAccessToken, accessToken);
  storage.setItem(KEYS.sessionAccessTokenExpiresAt, String(expiresAtMs));
}

function clearSessionAccessToken(): void {
  const storage = getSessionStorage();
  storage?.removeItem(KEYS.sessionAccessToken);
  storage?.removeItem(KEYS.sessionAccessTokenExpiresAt);
}

export const authStorage = {
  getAccessToken(): string | null {
    inMemoryAccessToken ??= readAndClearLegacyToken(KEYS.accessToken) ?? readSessionAccessToken();
    return inMemoryAccessToken;
  },

  getRefreshToken(): string | null {
    inMemoryRefreshToken ??= readAndClearLegacyToken(KEYS.refreshToken);
    return inMemoryRefreshToken;
  },

  getUser(): FridayUser | null {
    const raw = localStorage.getItem(KEYS.user);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FridayUser;
    } catch {
      return null;
    }
  },

  setTokens(accessToken: string, refreshToken: string, expiresInSec?: number): void {
    inMemoryAccessToken = accessToken;
    inMemoryRefreshToken = refreshToken;
    localStorage.removeItem(KEYS.accessToken);
    localStorage.removeItem(KEYS.refreshToken);
    writeSessionAccessToken(accessToken, expiresInSec);
  },

  setUser(user: FridayUser): void {
    localStorage.setItem(KEYS.user, JSON.stringify(user));
  },

  clear(): void {
    inMemoryAccessToken = null;
    inMemoryRefreshToken = null;
    localStorage.removeItem(KEYS.accessToken);
    localStorage.removeItem(KEYS.refreshToken);
    localStorage.removeItem(KEYS.user);
    clearSessionAccessToken();
  },
};
