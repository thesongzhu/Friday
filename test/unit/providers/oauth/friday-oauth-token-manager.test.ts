import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridayOAuthProviderRegistry,
  createFridayOAuthTokenManager,
} from "#providers";
import type {
  FridayOAuthProviderAdapter,
  FridayOAuthTokenManager,
  FridayOAuthCredentialStore,
} from "#providers";
import type { FridayOAuthCredential, FridayOAuthTokenSet } from "#providers";

// ─── Helpers ───

function createMockAdapter(overrides?: Partial<FridayOAuthProviderAdapter>): FridayOAuthProviderAdapter {
  return {
    id: "anthropic",
    displayName: "Anthropic (test)",
    initiateAuthorization: vi.fn(),
    exchangeAuthorizationCode: vi.fn(),
    refreshAccessToken: vi.fn().mockResolvedValue({
      accessToken: "refreshed-at",
      refreshToken: "refreshed-rt",
      expiresAt: "2026-02-18T12:00:00.000Z",
      tokenType: "Bearer",
      scope: "test",
    } satisfies FridayOAuthTokenSet),
    ...overrides,
  };
}

function createMockStore(initial?: FridayOAuthCredential | null): FridayOAuthCredentialStore {
  let storedCredential = initial ?? null;
  return {
    getByProviderProfileId: vi.fn((_providerProfileId: string) => storedCredential),
    upsert: vi.fn((input) => {
      storedCredential = {
        id: "cred-1",
        providerProfileId: input.providerProfileId,
        oauthProvider: input.oauthProvider,
        accessToken: input.tokenSet.accessToken,
        refreshToken: input.tokenSet.refreshToken,
        tokenType: input.tokenSet.tokenType,
        scope: input.tokenSet.scope,
        expiresAt: input.tokenSet.expiresAt,
        createdAt: "2026-02-18T10:00:00.000Z",
        updatedAt: "2026-02-18T10:00:00.000Z",
      };
      return storedCredential;
    }),
    deleteByProviderProfileId: vi.fn((_providerProfileId: string) => {
      const had = storedCredential !== null;
      storedCredential = null;
      return had;
    }),
  };
}

describe("FridayOAuthProviderRegistry", () => {
  it("registers and retrieves adapters", () => {
    const adapter = createMockAdapter();
    const registry = createFridayOAuthProviderRegistry([adapter]);

    expect(registry.get("anthropic")).toBe(adapter);
    expect(registry.get("anthropic")).not.toBeNull();
    expect(registry.list()).toHaveLength(1);
  });

  it("returns null for unregistered provider", () => {
    const registry = createFridayOAuthProviderRegistry();
    expect(registry.get("anthropic")).toBeNull();
  });

  it("overwrites existing adapter on re-register", () => {
    const adapter1 = createMockAdapter({ displayName: "v1" });
    const adapter2 = createMockAdapter({ displayName: "v2" });
    const registry = createFridayOAuthProviderRegistry([adapter1]);

    registry.register(adapter2);
    expect(registry.get("anthropic")?.displayName).toBe("v2");
    expect(registry.list()).toHaveLength(1);
  });
});

describe("FridayOAuthTokenManager", () => {
  const NOW_MS = 1708272000000;
  let adapter: FridayOAuthProviderAdapter;
  let store: FridayOAuthCredentialStore;
  let manager: FridayOAuthTokenManager;

  beforeEach(() => {
    adapter = createMockAdapter();
    store = createMockStore();
    const registry = createFridayOAuthProviderRegistry([adapter]);
    manager = createFridayOAuthTokenManager({
      credentialStore: store,
      providerRegistry: registry,
      nowMs: () => NOW_MS,
    });
  });

  describe("saveTokenSet", () => {
    it("delegates to credential store upsert", () => {
      const credential = manager.saveTokenSet({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
        tokenSet: {
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: "2026-02-18T11:00:00.000Z",
          tokenType: "Bearer",
          scope: "test",
        },
      });

      expect(store.upsert).toHaveBeenCalledOnce();
      expect(credential.accessToken).toBe("at");
    });
  });

  describe("getValidAccessToken", () => {
    it("returns null when no credentials exist", async () => {
      const result = await manager.getValidAccessToken({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
      });
      expect(result).toBeNull();
    });

    it("returns access token when not expired", async () => {
      // Set up store with a credential that expires in the future
      const futureExpiry = new Date(NOW_MS + 3600 * 1000).toISOString();
      const storeWithCred = createMockStore({
        id: "cred-1",
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
        accessToken: "valid-at",
        refreshToken: "rt",
        tokenType: "Bearer",
        scope: "test",
        expiresAt: futureExpiry,
        createdAt: "2026-02-18T10:00:00.000Z",
        updatedAt: "2026-02-18T10:00:00.000Z",
      });

      const registry = createFridayOAuthProviderRegistry([adapter]);
      const mgr = createFridayOAuthTokenManager({
        credentialStore: storeWithCred,
        providerRegistry: registry,
        nowMs: () => NOW_MS,
      });

      const result = await mgr.getValidAccessToken({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
      });
      expect(result).toBe("valid-at");
      expect(adapter.refreshAccessToken).not.toHaveBeenCalled();
    });

    it("refreshes and returns new token when expired", async () => {
      const pastExpiry = new Date(NOW_MS - 1000).toISOString();
      const storeWithExpired = createMockStore({
        id: "cred-1",
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
        accessToken: "expired-at",
        refreshToken: "rt-for-refresh",
        tokenType: "Bearer",
        scope: "test",
        expiresAt: pastExpiry,
        createdAt: "2026-02-18T10:00:00.000Z",
        updatedAt: "2026-02-18T10:00:00.000Z",
      });

      const registry = createFridayOAuthProviderRegistry([adapter]);
      const mgr = createFridayOAuthTokenManager({
        credentialStore: storeWithExpired,
        providerRegistry: registry,
        nowMs: () => NOW_MS,
      });

      const result = await mgr.getValidAccessToken({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
      });

      expect(result).toBe("refreshed-at");
      expect(adapter.refreshAccessToken).toHaveBeenCalledWith("rt-for-refresh");
      expect(storeWithExpired.upsert).toHaveBeenCalledOnce();
    });

    it("returns null when adapter not found for refresh", async () => {
      const pastExpiry = new Date(NOW_MS - 1000).toISOString();
      const storeWithExpired = createMockStore({
        id: "cred-1",
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
        accessToken: "expired-at",
        refreshToken: "rt",
        tokenType: "Bearer",
        scope: "test",
        expiresAt: pastExpiry,
        createdAt: "2026-02-18T10:00:00.000Z",
        updatedAt: "2026-02-18T10:00:00.000Z",
      });

      // Empty registry — no adapter
      const registry = createFridayOAuthProviderRegistry();
      const mgr = createFridayOAuthTokenManager({
        credentialStore: storeWithExpired,
        providerRegistry: registry,
        nowMs: () => NOW_MS,
      });

      const result = await mgr.getValidAccessToken({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
      });
      expect(result).toBeNull();
    });
  });

  describe("clear", () => {
    it("delegates to credential store delete", () => {
      manager.saveTokenSet({
        providerProfileId: "prov-1",
        oauthProvider: "anthropic",
        tokenSet: {
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: "2026-02-18T11:00:00.000Z",
          tokenType: "Bearer",
          scope: "test",
        },
      });

      const result = manager.clear("prov-1");
      expect(result).toBe(true);
      expect(store.deleteByProviderProfileId).toHaveBeenCalledWith("prov-1");
    });
  });
});
