/**
 * OAuth token manager with lazy refresh and provider registry.
 */

import type {
  FridayOAuthCredential,
  FridayOAuthProviderId,
  FridayOAuthTokenSet,
} from "../model/friday-provider.types.js";

import type { FridayOAuthProviderAdapter } from "./friday-anthropic-oauth.js";
import type { FridayOAuthCredentialStore } from "./friday-oauth-credential-store.js";

// ─── Provider registry ───

export interface FridayOAuthProviderRegistry {
  /** Returns provider adapter by id or null when missing. */
  get(providerId: FridayOAuthProviderId): FridayOAuthProviderAdapter | null;
  /** Registers/overwrites an OAuth provider adapter. */
  register(provider: FridayOAuthProviderAdapter): void;
  /** Lists all registered OAuth adapters. */
  list(): FridayOAuthProviderAdapter[];
}

/** Creates in-memory OAuth provider registry for extensibility. */
export function createFridayOAuthProviderRegistry(
  providers?: readonly FridayOAuthProviderAdapter[],
): FridayOAuthProviderRegistry {
  const adapters = new Map<FridayOAuthProviderId, FridayOAuthProviderAdapter>();
  if (providers) {
    for (const p of providers) {
      adapters.set(p.id, p);
    }
  }

  return {
    get(providerId) {
      return adapters.get(providerId) ?? null;
    },
    register(provider) {
      adapters.set(provider.id, provider);
    },
    list() {
      return [...adapters.values()];
    },
  };
}

// ─── Token manager ───

export interface FridayOAuthTokenManager {
  /** Stores token set after successful login callback exchange. */
  saveTokenSet(input: {
    providerProfileId: string;
    oauthProvider: FridayOAuthProviderId;
    tokenSet: FridayOAuthTokenSet;
  }): FridayOAuthCredential;
  /** Resolves valid access token; refreshes and persists if near expiry. */
  getValidAccessToken(input: {
    providerProfileId: string;
    oauthProvider: FridayOAuthProviderId;
  }): Promise<string | null>;
  /** Deletes stored OAuth credentials for provider profile. */
  clear(providerProfileId: string): boolean;
}

export interface CreateFridayOAuthTokenManagerDeps {
  credentialStore: FridayOAuthCredentialStore;
  providerRegistry: FridayOAuthProviderRegistry;
  nowMs?: () => number;
}

/** Maximum age for an inflight refresh before it's considered stale and discarded. */
const INFLIGHT_REFRESH_MAX_AGE_MS = 30_000;

/** Timeout for a single refresh attempt. */
const REFRESH_TIMEOUT_MS = 30_000;

/** Creates lazy-refresh token manager with single-flight refresh per provider profile. */
export function createFridayOAuthTokenManager(
  deps: CreateFridayOAuthTokenManagerDeps,
): FridayOAuthTokenManager {
  const nowMs = deps.nowMs ?? (() => Date.now());

  // Single-flight: prevent concurrent refreshes for the same profile
  const inflightRefreshes = new Map<
    string,
    { promise: Promise<string | null>; startedAt: number }
  >();

  return {
    saveTokenSet(input) {
      return deps.credentialStore.upsert(input);
    },

    async getValidAccessToken(input) {
      const credential = deps.credentialStore.getByProviderProfileId(
        input.providerProfileId,
      );
      if (!credential) return null;

      const expiresAtMs = new Date(credential.expiresAt).getTime();
      const now = nowMs();

      // Still valid — return current access token
      if (expiresAtMs > now) {
        return credential.accessToken;
      }

      // Expired — need to refresh
      const flightKey = `${input.providerProfileId}:${input.oauthProvider}`;
      const existing = inflightRefreshes.get(flightKey);
      if (existing) {
        // If the inflight refresh has been pending too long, discard it and retry
        if (nowMs() - existing.startedAt > INFLIGHT_REFRESH_MAX_AGE_MS) {
          inflightRefreshes.delete(flightKey);
        } else {
          return existing.promise;
        }
      }

      const refreshPromise = (async (): Promise<string | null> => {
        try {
          // Double-check: re-read from DB in case another caller already refreshed
          const freshCredential = deps.credentialStore.getByProviderProfileId(
            input.providerProfileId,
          );
          if (freshCredential) {
            const freshExpiresAtMs = new Date(freshCredential.expiresAt).getTime();
            if (freshExpiresAtMs > nowMs()) {
              return freshCredential.accessToken;
            }
          }

          const adapter = deps.providerRegistry.get(input.oauthProvider);
          if (!adapter) return null;

          const tokenToRefresh = freshCredential?.refreshToken ?? credential.refreshToken;

          // Wrap refresh in a timeout to prevent hanging forever
          const newTokenSet = await Promise.race([
            adapter.refreshAccessToken(tokenToRefresh),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("OAuth token refresh timed out")),
                REFRESH_TIMEOUT_MS,
              ),
            ),
          ]);

          deps.credentialStore.upsert({
            providerProfileId: input.providerProfileId,
            oauthProvider: input.oauthProvider,
            tokenSet: newTokenSet,
          });

          return newTokenSet.accessToken;
        } finally {
          inflightRefreshes.delete(flightKey);
        }
      })();

      inflightRefreshes.set(flightKey, { promise: refreshPromise, startedAt: nowMs() });
      return refreshPromise;
    },

    clear(providerProfileId) {
      return deps.credentialStore.deleteByProviderProfileId(providerProfileId);
    },
  };
}
