import type { FridayUser } from "@/lib/api/types";

const KEYS = {
  accessToken: "friday.auth.accessToken",
  refreshToken: "friday.auth.refreshToken",
  user: "friday.auth.user",
} as const;

let inMemoryAccessToken: string | null = null;
let inMemoryRefreshToken: string | null = null;

function readAndClearLegacyToken(key: string): string | null {
  const token = localStorage.getItem(key);
  if (token) {
    localStorage.removeItem(key);
  }
  return token;
}

export const authStorage = {
  getAccessToken(): string | null {
    inMemoryAccessToken ??= readAndClearLegacyToken(KEYS.accessToken);
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

  setTokens(accessToken: string, refreshToken: string): void {
    inMemoryAccessToken = accessToken;
    inMemoryRefreshToken = refreshToken;
    localStorage.removeItem(KEYS.accessToken);
    localStorage.removeItem(KEYS.refreshToken);
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
  },
};
