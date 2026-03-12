import type { FridayUser } from "@/lib/api/types";

const KEYS = {
  accessToken: "friday.auth.accessToken",
  refreshToken: "friday.auth.refreshToken",
  user: "friday.auth.user",
} as const;

export const authStorage = {
  getAccessToken(): string | null {
    return localStorage.getItem(KEYS.accessToken);
  },

  getRefreshToken(): string | null {
    return localStorage.getItem(KEYS.refreshToken);
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
    localStorage.setItem(KEYS.accessToken, accessToken);
    localStorage.setItem(KEYS.refreshToken, refreshToken);
  },

  setUser(user: FridayUser): void {
    localStorage.setItem(KEYS.user, JSON.stringify(user));
  },

  clear(): void {
    localStorage.removeItem(KEYS.accessToken);
    localStorage.removeItem(KEYS.refreshToken);
    localStorage.removeItem(KEYS.user);
  },
};
