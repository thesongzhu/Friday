import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authStorage } from "../../../ui/src/lib/storage/auth-storage";

describe("authStorage", () => {
  beforeEach(() => {
    const local = new Map<string, string>();
    const session = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => {
          local.set(key, value);
        },
        removeItem: (key: string) => {
          local.delete(key);
        },
        clear: () => {
          local.clear();
        },
      },
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => {
          session.set(key, value);
        },
        removeItem: (key: string) => {
          session.delete(key);
        },
        clear: () => {
          session.clear();
        },
      },
    });
  });

  afterEach(() => {
    authStorage.clear();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("keeps new access and refresh tokens out of localStorage", () => {
    authStorage.setTokens("access-token", "refresh-token");

    expect(authStorage.getAccessToken()).toBe("access-token");
    expect(authStorage.getRefreshToken()).toBe("refresh-token");
    expect(localStorage.getItem("friday.auth.accessToken")).toBeNull();
    expect(localStorage.getItem("friday.auth.refreshToken")).toBeNull();
    expect(sessionStorage.getItem("friday.auth.sessionAccessToken")).toBeNull();
  });

  it("persists only the short-lived access token in sessionStorage when an expiry is supplied", () => {
    authStorage.setTokens("access-token", "refresh-token", 60);

    expect(authStorage.getAccessToken()).toBe("access-token");
    expect(authStorage.getRefreshToken()).toBe("refresh-token");
    expect(localStorage.getItem("friday.auth.accessToken")).toBeNull();
    expect(localStorage.getItem("friday.auth.refreshToken")).toBeNull();
    expect(sessionStorage.getItem("friday.auth.sessionAccessToken")).toBe("access-token");
    expect(sessionStorage.getItem("friday.auth.refreshToken")).toBeNull();
  });

  it("does not persist refresh tokens in sessionStorage", () => {
    authStorage.setTokens("access-token", "refresh-token", 60);
    authStorage.clear();

    expect(sessionStorage.getItem("friday.auth.sessionAccessToken")).toBeNull();
    expect(sessionStorage.getItem("friday.auth.sessionAccessTokenExpiresAt")).toBeNull();
    expect(sessionStorage.getItem("friday.auth.refreshToken")).toBeNull();
  });

  it("migrates legacy localStorage tokens into memory and clears them", () => {
    localStorage.setItem("friday.auth.accessToken", "legacy-access");
    localStorage.setItem("friday.auth.refreshToken", "legacy-refresh");

    expect(authStorage.getAccessToken()).toBe("legacy-access");
    expect(authStorage.getRefreshToken()).toBe("legacy-refresh");
    expect(localStorage.getItem("friday.auth.accessToken")).toBeNull();
    expect(localStorage.getItem("friday.auth.refreshToken")).toBeNull();
  });
});
