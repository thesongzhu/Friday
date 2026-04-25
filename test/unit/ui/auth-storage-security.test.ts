import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authStorage } from "../../../ui/src/lib/storage/auth-storage";

describe("authStorage", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
  });

  afterEach(() => {
    authStorage.clear();
    localStorage.clear();
  });

  it("keeps new access and refresh tokens out of localStorage", () => {
    authStorage.setTokens("access-token", "refresh-token");

    expect(authStorage.getAccessToken()).toBe("access-token");
    expect(authStorage.getRefreshToken()).toBe("refresh-token");
    expect(localStorage.getItem("friday.auth.accessToken")).toBeNull();
    expect(localStorage.getItem("friday.auth.refreshToken")).toBeNull();
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
