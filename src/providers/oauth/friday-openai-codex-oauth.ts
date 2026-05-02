/**
 * OpenAI Codex OAuth adapter.
 *
 * This follows OpenClaw's ChatGPT/Codex subscription-auth route: device-code
 * login is the primary headless flow, while PKCE authorization-code support is
 * kept for browser/manual clients.
 */

import * as crypto from "node:crypto";

import { FridayDomainError } from "#errors";

import type {
  FridayOAuthAuthorizationRequest,
  FridayOAuthDeviceAuthorizationRequest,
  FridayOAuthTokenSet,
} from "../model/friday-provider.types.js";

import { generateFridayPkce } from "./friday-anthropic-oauth.js";
import type { FridayOAuthProviderAdapter } from "./friday-anthropic-oauth.js";

export const FRIDAY_OPENAI_CODEX_OAUTH_PROVIDER_ID = "openai-codex";
export const FRIDAY_OPENAI_CODEX_OAUTH_AUTH_BASE_URL = "https://auth.openai.com";
export const FRIDAY_OPENAI_CODEX_OAUTH_AUTHORIZE_URL = `${FRIDAY_OPENAI_CODEX_OAUTH_AUTH_BASE_URL}/oauth/authorize`;
export const FRIDAY_OPENAI_CODEX_OAUTH_TOKEN_URL = `${FRIDAY_OPENAI_CODEX_OAUTH_AUTH_BASE_URL}/oauth/token`;
export const FRIDAY_OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const FRIDAY_OPENAI_CODEX_OAUTH_BROWSER_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
export const FRIDAY_OPENAI_CODEX_OAUTH_DEVICE_REDIRECT_URI = `${FRIDAY_OPENAI_CODEX_OAUTH_AUTH_BASE_URL}/deviceauth/callback`;
export const FRIDAY_OPENAI_CODEX_OAUTH_DEVICE_VERIFICATION_URL = `${FRIDAY_OPENAI_CODEX_OAUTH_AUTH_BASE_URL}/codex/device`;
export const FRIDAY_OPENAI_CODEX_OAUTH_SCOPES = "openid profile email";

const DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const PENDING_TTL_MS = 10 * 60_000;

interface CreateFridayOpenAICodexOAuthDeps {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

interface OpenAICodexTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number | string;
  token_type?: string;
  scope?: string;
}

interface PendingPkce {
  verifier: string;
  createdAt: number;
}

interface PendingDeviceCode {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAtMs: number;
}

function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeExpiresAt(nowMs: number, token: OpenAICodexTokenResponse): string {
  const expiresInRaw = token.expires_in;
  const expiresInSeconds = typeof expiresInRaw === "number" && Number.isFinite(expiresInRaw)
    ? expiresInRaw
    : typeof expiresInRaw === "string" && /^\d+$/.test(expiresInRaw.trim())
      ? Number.parseInt(expiresInRaw.trim(), 10)
      : undefined;
  if (expiresInSeconds && expiresInSeconds > 0) {
    return new Date(nowMs + expiresInSeconds * 1000 - 5 * 60 * 1000).toISOString();
  }

  const jwtExpiry = resolveJwtExpiryMs(token.access_token);
  return new Date((jwtExpiry ?? nowMs) - 5 * 60 * 1000).toISOString();
}

function resolveJwtExpiryMs(accessToken: string): number | undefined {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    const exp = typeof payload.exp === "number"
      ? payload.exp
      : typeof payload.exp === "string" && /^\d+$/.test(payload.exp)
        ? Number.parseInt(payload.exp, 10)
        : undefined;
    return exp && exp > 0 ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function resolveIdentityMetadata(accessToken: string): Record<string, unknown> {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const profile = payload["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
    const accountId = trimString(auth?.chatgpt_account_id);
    const accountUserId = trimString(auth?.chatgpt_account_user_id);
    const chatgptPlanType = trimString(auth?.chatgpt_plan_type);
    const email = trimString(profile?.email);
    return {
      ...(accountId ? { accountId } : {}),
      ...(accountUserId ? { accountUserId } : {}),
      ...(chatgptPlanType ? { chatgptPlanType } : {}),
      ...(email ? { email, profileName: email } : {}),
    };
  } catch {
    return {};
  }
}

function isTokenResponse(value: unknown): value is OpenAICodexTokenResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.access_token === "string" && typeof record.refresh_token === "string";
}

function tokenSetFromResponse(token: OpenAICodexTokenResponse, nowMs: number): FridayOAuthTokenSet {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: normalizeExpiresAt(nowMs, token),
    tokenType: token.token_type ?? "Bearer",
    scope: token.scope ?? FRIDAY_OPENAI_CODEX_OAUTH_SCOPES,
    metadata: resolveIdentityMetadata(token.access_token),
  };
}

async function readJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new FridayDomainError(
      "OAUTH_TOKEN_EXCHANGE_FAILED",
      `${label} failed (HTTP ${response.status})`,
      { httpStatus: 502 },
    );
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new FridayDomainError("INTERNAL_ERROR", `${label} returned an unexpected response shape`, { httpStatus: 500 });
}

function headers(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    originator: "friday",
    "User-Agent": "friday",
  };
}

function normalizeIntervalMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.max(Math.trunc(value * 1000), DEVICE_CODE_MIN_INTERVAL_MS);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Math.max(Number.parseInt(value.trim(), 10) * 1000, DEVICE_CODE_MIN_INTERVAL_MS);
  }
  return DEVICE_CODE_DEFAULT_INTERVAL_MS;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFridayOpenAICodexOAuthProvider(
  deps?: CreateFridayOpenAICodexOAuthDeps,
): FridayOAuthProviderAdapter {
  const fetchFn = deps?.fetchImpl ?? globalThis.fetch;
  const nowMs = deps?.nowMs ?? (() => Date.now());
  const pendingPkce = new Map<string, PendingPkce>();
  const pendingDeviceCodes = new Map<string, PendingDeviceCode>();

  function cleanup(): void {
    const cutoff = nowMs() - PENDING_TTL_MS;
    for (const [state, entry] of pendingPkce) {
      if (entry.createdAt < cutoff) pendingPkce.delete(state);
    }
    const now = nowMs();
    for (const [id, entry] of pendingDeviceCodes) {
      if (entry.expiresAtMs <= now) pendingDeviceCodes.delete(id);
    }
  }

  async function exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<FridayOAuthTokenSet> {
    const response = await fetchFn(FRIDAY_OPENAI_CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: headers("application/x-www-form-urlencoded"),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: FRIDAY_OPENAI_CODEX_OAUTH_CLIENT_ID,
        code_verifier: input.codeVerifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await readJsonResponse(response, "OpenAI Codex token exchange");
    if (!isTokenResponse(json)) {
      throw new FridayDomainError("INTERNAL_ERROR", "OpenAI Codex token response has unexpected shape", { httpStatus: 500 });
    }
    return tokenSetFromResponse(json, nowMs());
  }

  return {
    id: FRIDAY_OPENAI_CODEX_OAUTH_PROVIDER_ID,
    displayName: "OpenAI Codex (ChatGPT subscription)",

    async initiateAuthorization(): Promise<FridayOAuthAuthorizationRequest> {
      cleanup();
      const { verifier, challenge } = await generateFridayPkce();
      const state = randomState();
      pendingPkce.set(state, { verifier, createdAt: nowMs() });
      const params = new URLSearchParams({
        client_id: FRIDAY_OPENAI_CODEX_OAUTH_CLIENT_ID,
        response_type: "code",
        redirect_uri: FRIDAY_OPENAI_CODEX_OAUTH_BROWSER_REDIRECT_URI,
        scope: FRIDAY_OPENAI_CODEX_OAUTH_SCOPES,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      });
      return {
        authorizationUrl: `${FRIDAY_OPENAI_CODEX_OAUTH_AUTHORIZE_URL}?${params.toString()}`,
        state,
        codeVerifier: verifier,
        scopes: FRIDAY_OPENAI_CODEX_OAUTH_SCOPES.split(" "),
      };
    },

    async exchangeAuthorizationCode(input): Promise<FridayOAuthTokenSet> {
      cleanup();
      const state = input.state ?? "";
      const pending = pendingPkce.get(state);
      if (!pending) {
        throw new FridayDomainError("OAUTH_UNKNOWN_STATE", "No PKCE verifier found for the provided state", { httpStatus: 400 });
      }
      pendingPkce.delete(state);
      return exchangeAuthorizationCode({
        code: input.authorizationCode,
        codeVerifier: pending.verifier,
        redirectUri: FRIDAY_OPENAI_CODEX_OAUTH_BROWSER_REDIRECT_URI,
      });
    },

    async refreshAccessToken(refreshToken): Promise<FridayOAuthTokenSet> {
      const response = await fetchFn(FRIDAY_OPENAI_CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: headers("application/x-www-form-urlencoded"),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: FRIDAY_OPENAI_CODEX_OAUTH_CLIENT_ID,
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = await readJsonResponse(response, "OpenAI Codex token refresh");
      if (!isTokenResponse(json)) {
        throw new FridayDomainError("INTERNAL_ERROR", "OpenAI Codex token refresh response has unexpected shape", { httpStatus: 500 });
      }
      return tokenSetFromResponse(json, nowMs());
    },

    async initiateDeviceAuthorization(): Promise<FridayOAuthDeviceAuthorizationRequest> {
      cleanup();
      const response = await fetchFn(`${FRIDAY_OPENAI_CODEX_OAUTH_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
        method: "POST",
        headers: headers("application/json"),
        body: JSON.stringify({ client_id: FRIDAY_OPENAI_CODEX_OAUTH_CLIENT_ID }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = await readJsonResponse(response, "OpenAI Codex device code request");
      const deviceAuthId = trimString(json.device_auth_id);
      const userCode = trimString(json.user_code) ?? trimString(json.usercode);
      if (!deviceAuthId || !userCode) {
        throw new FridayDomainError("INTERNAL_ERROR", "OpenAI Codex device-code response has unexpected shape", { httpStatus: 500 });
      }

      const deviceCodeId = crypto.randomUUID();
      const intervalMs = normalizeIntervalMs(json.interval);
      const expiresAtMs = nowMs() + DEVICE_CODE_TIMEOUT_MS;
      pendingDeviceCodes.set(deviceCodeId, {
        deviceAuthId,
        userCode,
        intervalMs,
        expiresAtMs,
      });

      return {
        providerId: "",
        oauthProvider: FRIDAY_OPENAI_CODEX_OAUTH_PROVIDER_ID,
        deviceCodeId,
        verificationUrl: FRIDAY_OPENAI_CODEX_OAUTH_DEVICE_VERIFICATION_URL,
        userCode,
        expiresAt: new Date(expiresAtMs).toISOString(),
        intervalMs,
        scopes: FRIDAY_OPENAI_CODEX_OAUTH_SCOPES.split(" "),
      };
    },

    async completeDeviceAuthorization(input): Promise<FridayOAuthTokenSet> {
      cleanup();
      const pending = pendingDeviceCodes.get(input.deviceCodeId);
      if (!pending) {
        throw new FridayDomainError("OAUTH_UNKNOWN_STATE", "No pending OpenAI Codex device-code login found", { httpStatus: 400 });
      }

      while (nowMs() < pending.expiresAtMs) {
        const response = await fetchFn(`${FRIDAY_OPENAI_CODEX_OAUTH_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: headers("application/json"),
          body: JSON.stringify({
            device_auth_id: pending.deviceAuthId,
            user_code: pending.userCode,
          }),
          signal: AbortSignal.timeout(15_000),
        });

        const bodyText = await response.text();
        if (response.ok) {
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            throw new FridayDomainError("INTERNAL_ERROR", "OpenAI Codex device authorization response has unexpected shape", { httpStatus: 500 });
          }
          const authorizationCode = trimString(json.authorization_code);
          const codeVerifier = trimString(json.code_verifier);
          if (!authorizationCode || !codeVerifier) {
            throw new FridayDomainError("INTERNAL_ERROR", "OpenAI Codex device authorization response was missing exchange data", { httpStatus: 500 });
          }
          pendingDeviceCodes.delete(input.deviceCodeId);
          return exchangeAuthorizationCode({
            code: authorizationCode,
            codeVerifier,
            redirectUri: FRIDAY_OPENAI_CODEX_OAUTH_DEVICE_REDIRECT_URI,
          });
        }

        if (response.status === 403 || response.status === 404) {
          await sleep(Math.min(pending.intervalMs, Math.max(0, pending.expiresAtMs - nowMs())));
          continue;
        }

        throw new FridayDomainError(
          "OAUTH_TOKEN_EXCHANGE_FAILED",
          `OpenAI Codex device authorization failed (HTTP ${response.status})`,
          { httpStatus: 502 },
        );
      }

      pendingDeviceCodes.delete(input.deviceCodeId);
      throw new FridayDomainError("OAUTH_STATE_EXPIRED", "OpenAI Codex device-code login expired", { httpStatus: 400 });
    },
  };
}
