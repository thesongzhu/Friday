/**
 * Anthropic OAuth adapter.
 *
 * Friday intentionally does not ship a Claude CLI impersonation/OAuth bearer path.
 * Anthropic access is supported through first-party API keys (`x-api-key`) only.
 */

import * as crypto from "node:crypto";

import type {
  FridayOAuthAuthorizationRequest,
  FridayOAuthDeviceAuthorizationRequest,
  FridayOAuthProviderId,
  FridayOAuthTokenSet,
} from "../model/friday-provider.types.js";

import { FridayDomainError } from "#errors";

export const FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE = "ANTHROPIC_OAUTH_DISABLED";
export const FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE =
  "Anthropic OAuth/bearer authentication is disabled in Friday. Configure Anthropic with an API key instead.";

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

/** Parses pasted OAuth code in `code#state` format for legacy callers/tests. */
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

function disabledAnthropicOAuthError(): FridayDomainError {
  return new FridayDomainError(
    FRIDAY_ANTHROPIC_OAUTH_DISABLED_CODE,
    FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE,
    { httpStatus: 400 },
  );
}

/** Creates a fail-closed Anthropic OAuth adapter. Use Anthropic API-key auth instead. */
export function createFridayAnthropicOAuthProvider(
  _deps?: CreateFridayAnthropicOAuthDeps,
): FridayOAuthProviderAdapter {
  return {
    id: "anthropic",
    displayName: "Anthropic (API key required)",

    async initiateAuthorization(): Promise<FridayOAuthAuthorizationRequest> {
      throw disabledAnthropicOAuthError();
    },

    async exchangeAuthorizationCode(): Promise<FridayOAuthTokenSet> {
      throw disabledAnthropicOAuthError();
    },

    async refreshAccessToken(): Promise<FridayOAuthTokenSet> {
      throw disabledAnthropicOAuthError();
    },
  };
}
