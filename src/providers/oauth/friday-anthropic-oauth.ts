/**
 * Anthropic OAuth adapter — PKCE authorization code flow.
 *
 * Ported from Clawdbot's anthropic.js + pkce.js into Friday conventions.
 */

import * as crypto from "node:crypto";

import type {
  FridayOAuthAuthorizationRequest,
  FridayOAuthDeviceAuthorizationRequest,
  FridayOAuthProviderId,
  FridayOAuthTokenSet,
} from "../model/friday-provider.types.js";

import { FridayDomainError } from "#errors";

// ─── Constants ───

export const FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const FRIDAY_ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";

/**
 * Required headers for Anthropic OAuth token authentication.
 * OAuth tokens are NOT accepted via `x-api-key`; they require:
 * - `Authorization: Bearer <token>` (set by caller)
 * - `anthropic-beta` with `oauth-2025-04-20` flag
 * - Claude Code identity headers (`user-agent`, `x-app`)
 * - `anthropic-dangerous-direct-browser-access` flag
 *
 * Discovered via pi-ai SDK's `createClient()` in `providers/anthropic.js`.
 */
export const FRIDAY_ANTHROPIC_OAUTH_HEADERS: Readonly<Record<string, string>> = {
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  "anthropic-dangerous-direct-browser-access": "true",
  "user-agent": "claude-cli/2.1.2 (external, cli)",
  "x-app": "cli",
};

/** System prompt prefix required for OAuth-authenticated Anthropic API calls. */
export const FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";
export const FRIDAY_ANTHROPIC_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const FRIDAY_ANTHROPIC_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const FRIDAY_ANTHROPIC_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

// ─── PKCE ───

export interface FridayPkcePair {
  verifier: string;
  challenge: string;
}

/** Encode bytes as base64url string. */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Generate PKCE code verifier and challenge using Web Crypto API. */
export async function generateFridayPkce(): Promise<FridayPkcePair> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);

  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));

  return { verifier, challenge };
}

// ─── Authorization code parsing ───

export interface FridayAnthropicAuthorizationCodeParts {
  code: string;
  state: string;
}

/** Parses Anthropic pasted code in `code#state` format. */
export function parseFridayAnthropicAuthorizationCode(
  rawAuthorizationCode: string,
): FridayAnthropicAuthorizationCodeParts {
  const hashIdx = rawAuthorizationCode.indexOf("#");
  if (hashIdx < 0) {
    return { code: rawAuthorizationCode, state: "" };
  }
  return {
    code: rawAuthorizationCode.slice(0, hashIdx),
    state: rawAuthorizationCode.slice(hashIdx + 1),
  };
}

// ─── Token response shape ───

interface AnthropicTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

function isAnthropicTokenResponse(v: unknown): v is AnthropicTokenResponse {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.access_token === "string" &&
    typeof o.refresh_token === "string" &&
    typeof o.expires_in === "number" &&
    typeof o.token_type === "string"
  );
}

// ─── Provider adapter ───

export interface FridayOAuthProviderAdapter {
  readonly id: FridayOAuthProviderId;
  readonly displayName: string;
  /** Builds the OAuth authorize URL (PKCE S256). */
  initiateAuthorization(): Promise<FridayOAuthAuthorizationRequest>;
  /** Exchanges an auth code for access/refresh tokens. */
  exchangeAuthorizationCode(input: {
    authorizationCode: string;
    state?: string;
    codeVerifier?: string;
  }): Promise<FridayOAuthTokenSet>;
  /** Refreshes an expired/expiring token set. */
  refreshAccessToken(refreshToken: string): Promise<FridayOAuthTokenSet>;
  /** Optional device-code initiation for headless provider account login. */
  initiateDeviceAuthorization?(): Promise<FridayOAuthDeviceAuthorizationRequest>;
  /** Optional device-code completion for headless provider account login. */
  completeDeviceAuthorization?(input: {
    deviceCodeId: string;
  }): Promise<FridayOAuthTokenSet>;
}

export interface CreateFridayAnthropicOAuthDeps {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

/** Creates Anthropic OAuth adapter with initiate/exchange/refresh support. */
export function createFridayAnthropicOAuthProvider(
  deps?: CreateFridayAnthropicOAuthDeps,
): FridayOAuthProviderAdapter {
  const fetchFn = deps?.fetchImpl ?? globalThis.fetch;
  const nowMs = deps?.nowMs ?? (() => Date.now());

  // Store PKCE verifier for exchange step (keyed by state) with TTL
  const PENDING_VERIFIER_TTL_MS = 10 * 60 * 1000; // 10 minutes
  const pendingVerifiers = new Map<string, { verifier: string; createdAt: number }>();

  /** Remove pending verifiers older than TTL. */
  function cleanupExpiredVerifiers(): void {
    const cutoff = nowMs() - PENDING_VERIFIER_TTL_MS;
    for (const [state, entry] of pendingVerifiers) {
      if (entry.createdAt < cutoff) {
        pendingVerifiers.delete(state);
      }
    }
  }

  return {
    id: "anthropic",
    displayName: "Anthropic (Claude Pro/Max)",

    async initiateAuthorization(): Promise<FridayOAuthAuthorizationRequest> {
      // Clean up expired pending verifiers on each initiation
      cleanupExpiredVerifiers();

      const { verifier, challenge } = await generateFridayPkce();

      // Generate separate random state (SEC-006: state ≠ verifier)
      const stateBytes = new Uint8Array(32);
      crypto.getRandomValues(stateBytes);
      const state = base64urlEncode(stateBytes);

      const authParams = new URLSearchParams({
        code: "true",
        client_id: FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID,
        response_type: "code",
        redirect_uri: FRIDAY_ANTHROPIC_OAUTH_REDIRECT_URI,
        scope: FRIDAY_ANTHROPIC_OAUTH_SCOPES,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      });

      const authorizationUrl = `${FRIDAY_ANTHROPIC_OAUTH_AUTHORIZE_URL}?${authParams.toString()}`;

      // Store verifier keyed by state with timestamp for TTL cleanup
      pendingVerifiers.set(state, { verifier, createdAt: nowMs() });

      return {
        authorizationUrl,
        state,
        codeVerifier: verifier,
        scopes: FRIDAY_ANTHROPIC_OAUTH_SCOPES.split(" "),
      };
    },

    async exchangeAuthorizationCode(input): Promise<FridayOAuthTokenSet> {
      const { code, state: parsedState } = parseFridayAnthropicAuthorizationCode(
        input.authorizationCode,
      );
      const state = input.state ?? parsedState;

      // SEC-006: strictly require stored verifier — never fall back to caller-provided codeVerifier
      const storedEntry = pendingVerifiers.get(state);
      if (!storedEntry) {
        throw new FridayDomainError(
          "OAUTH_UNKNOWN_STATE",
          "No PKCE verifier found for the provided state",
          { httpStatus: 400 },
        );
      }

      // SEC-006: enforce TTL on exchange — reject stale verifiers (10 min)
      const PKCE_TTL_MS = 10 * 60 * 1000;
      if (nowMs() - storedEntry.createdAt > PKCE_TTL_MS) {
        pendingVerifiers.delete(state);
        throw new FridayDomainError(
          "OAUTH_STATE_EXPIRED",
          "PKCE authorization state has expired (10 minute limit)",
          { httpStatus: 400 },
        );
      }
      const codeVerifier = storedEntry.verifier;

      const response = await fetchFn(FRIDAY_ANTHROPIC_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID,
          code,
          state,
          redirect_uri: FRIDAY_ANTHROPIC_OAUTH_REDIRECT_URI,
          code_verifier: codeVerifier,
        }),
      });

      if (!response.ok) {
        // Consume body but don't leak it in error messages
        await response.text();
        throw new FridayDomainError(
          "OAUTH_TOKEN_EXCHANGE_FAILED",
          `Token exchange failed (HTTP ${response.status})`,
          { httpStatus: 502 },
        );
      }

      const data: unknown = await response.json();
      if (!isAnthropicTokenResponse(data)) {
        throw new FridayDomainError("INTERNAL_ERROR", "Anthropic token response has unexpected shape", { httpStatus: 500 });
      }

      // Clean up stored verifier
      pendingVerifiers.delete(state);

      // Calculate expiry: current time + expires_in seconds − 5 min buffer
      const expiresAt = new Date(nowMs() + data.expires_in * 1000 - 5 * 60 * 1000).toISOString();

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        tokenType: data.token_type,
        scope: data.scope ?? FRIDAY_ANTHROPIC_OAUTH_SCOPES,
      };
    },

    async refreshAccessToken(refreshToken): Promise<FridayOAuthTokenSet> {
      const response = await fetchFn(FRIDAY_ANTHROPIC_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: FRIDAY_ANTHROPIC_OAUTH_CLIENT_ID,
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        // Consume body but don't leak it in error messages
        await response.text();
        throw new FridayDomainError(
          "OAUTH_TOKEN_REFRESH_FAILED",
          `Token refresh failed (HTTP ${response.status})`,
          { httpStatus: 502 },
        );
      }

      const data: unknown = await response.json();
      if (!isAnthropicTokenResponse(data)) {
        throw new FridayDomainError("INTERNAL_ERROR", "Anthropic token refresh response has unexpected shape", { httpStatus: 500 });
      }

      const expiresAt = new Date(nowMs() + data.expires_in * 1000 - 5 * 60 * 1000).toISOString();

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        tokenType: data.token_type,
        scope: data.scope ?? FRIDAY_ANTHROPIC_OAUTH_SCOPES,
      };
    },
  };
}
