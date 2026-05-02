import { FridayDomainError } from "#errors";
import type {
  FridayProviderApi,
  FridayProviderAuthMode,
  FridayProviderKind,
  FridayProviderValidationErrorCode,
  FridayProviderValidationState,
} from "../model/friday-provider.types.js";
import { isFridayAnthropicBearerAuthMode } from "../model/friday-provider.types.js";

import {
  FRIDAY_ANTHROPIC_OAUTH_HEADERS,
  FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX,
} from "../oauth/friday-anthropic-oauth.js";

import {
  validateGatewayUrl,
} from "../../agent/tools/friday-agent-gateway-validation.js";

// ─── Validator interface ───

export interface FridayProviderValidator {
  validate(params: {
    kind: FridayProviderKind;
    api: FridayProviderApi;
    baseUrl: string;
    credential: string | null;
    model?: string;
    authMode?: FridayProviderAuthMode;
  }): Promise<FridayProviderValidationState>;
}

// ─── Timeout helper ───

const VALIDATION_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── SSRF guard for provider baseUrl ───

function assertBaseUrlSafe(baseUrl: string, opts?: { allowLoopback?: boolean }): void {
  const result = validateGatewayUrl(baseUrl, { allowLoopback: opts?.allowLoopback });
  if (!result.valid) {
    throw new FridayDomainError("VALIDATION_ERROR", `SSRF_BLOCKED: ${result.error ?? "URL blocked by security policy"}`, { httpStatus: 400 });
  }
}

// ─── Provider-specific validators ───

async function validateOpenAi(
  baseUrl: string,
  credential: string | null,
): Promise<FridayProviderValidationState> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const headers: Record<string, string> = {};
  if (credential) {
    headers["Authorization"] = `Bearer ${credential}`;
  }
  try {
    const res = await fetchWithTimeout(url, { method: "GET", headers });
    if (res.status === 401 || res.status === 403) {
      return makeFailedState("PROVIDER_AUTH_INVALID", "Authentication failed", res.status);
    }
    if (res.status === 402) {
      let msg = "Insufficient credit balance";
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body?.error?.message) msg = body.error.message;
      } catch {
        // ignore parse errors
      }
      return makeFailedState("PROVIDER_PAYMENT_REQUIRED", msg, 402);
    }
    if (!res.ok) {
      return makeFailedState("PROVIDER_UNREACHABLE", `HTTP ${String(res.status)}`, res.status);
    }
    return makeOkState();
  } catch (err) {
    return makeUnreachableState(err);
  }
}

async function validateOpenAiCodex(
  baseUrl: string,
  credential: string | null,
  model?: string,
): Promise<FridayProviderValidationState> {
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    originator: "friday",
    "User-Agent": "friday",
  };
  if (credential) {
    headers.Authorization = `Bearer ${credential}`;
  }
  const body = JSON.stringify({
    model: model?.trim() || "gpt-5.4-mini",
    instructions: "You are Friday. Follow the user's instruction exactly.",
    store: false,
    stream: true,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Reply with OK only." }],
      },
    ],
  });
  try {
    const res = await fetchWithTimeout(url, { method: "POST", headers, body });
    if (res.status === 401 || res.status === 403) {
      return makeFailedState("PROVIDER_AUTH_INVALID", "Authentication failed", res.status);
    }
    if (res.status === 402) {
      let msg = "OpenAI Codex plan or account is not available for this request";
      try {
        const errBody = (await res.json()) as { error?: { message?: string } };
        if (errBody?.error?.message) msg = errBody.error.message;
      } catch {
        // ignore parse errors
      }
      return makeFailedState("PROVIDER_PAYMENT_REQUIRED", msg, 402);
    }
    if (res.ok || res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      return makeOkState();
    }
    return makeFailedState(
      "PROVIDER_UNREACHABLE",
      `HTTP ${String(res.status)}${await readValidationErrorSuffix(res)}`,
      res.status,
    );
  } catch (err) {
    return makeUnreachableState(err);
  }
}

async function validateAnthropic(
  baseUrl: string,
  credential: string | null,
  authMode?: FridayProviderAuthMode,
): Promise<FridayProviderValidationState> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const isBearerAuth = isFridayAnthropicBearerAuthMode(authMode);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(isBearerAuth ? FRIDAY_ANTHROPIC_OAUTH_HEADERS : {}),
  };
  if (credential) {
    if (isBearerAuth) {
      headers["Authorization"] = `Bearer ${credential}`;
    } else {
      headers["x-api-key"] = credential;
    }
  }
  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1,
    ...(isBearerAuth
      ? {
          system: [
            { type: "text", text: FRIDAY_ANTHROPIC_OAUTH_SYSTEM_PREFIX },
          ],
        }
      : {}),
    messages: [{ role: "user", content: "hi" }],
  });
  try {
    const res = await fetchWithTimeout(url, { method: "POST", headers, body });
    if (res.status === 401 || res.status === 403) {
      return makeFailedState("PROVIDER_AUTH_INVALID", "Authentication failed", res.status);
    }
    if (res.status === 402) {
      let msg = "Insufficient credit balance";
      try {
        const errBody = (await res.json()) as { error?: { message?: string } };
        if (errBody?.error?.message) msg = errBody.error.message;
      } catch {
        // ignore parse errors
      }
      return makeFailedState("PROVIDER_PAYMENT_REQUIRED", msg, 402);
    }
    // A successful (200) or rate-limited (429) or overloaded (529) response means auth is valid
    if (res.ok || res.status === 429 || res.status === 529) {
      return makeOkState();
    }
    // 400 with "invalid_api_key" is auth failure; credit balance errors are payment-required
    if (res.status === 400) {
      try {
        const errBody = (await res.json()) as { error?: { type?: string; message?: string } };
        if (errBody.error?.type === "invalid_api_key") {
          return makeFailedState("PROVIDER_AUTH_INVALID", errBody.error.message ?? "Invalid API key", 400);
        }
        if (errBody.error?.message && /credit balance/i.test(errBody.error.message)) {
          return makeFailedState("PROVIDER_PAYMENT_REQUIRED", errBody.error.message, 400);
        }
      } catch (err) {
        // ignore parse errors
        console.warn("[friday][provider-validator] response body parse failed:", err instanceof Error ? err.message : String(err));
      }
    }
    return makeFailedState("PROVIDER_UNREACHABLE", `HTTP ${String(res.status)}`, res.status);
  } catch (err) {
    return makeUnreachableState(err);
  }
}

async function validateGoogle(
  baseUrl: string,
  credential: string | null,
): Promise<FridayProviderValidationState> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1beta/models`;
  const headers: Record<string, string> = {};
  if (credential) {
    headers["x-goog-api-key"] = credential;
  }
  try {
    const res = await fetchWithTimeout(url, { method: "GET", headers });
    if (res.status === 401 || res.status === 403) {
      return makeFailedState("PROVIDER_AUTH_INVALID", "Authentication failed", res.status);
    }
    if (res.status === 402) {
      let msg = "Insufficient credit balance";
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body?.error?.message) msg = body.error.message;
      } catch {
        // ignore parse errors
      }
      return makeFailedState("PROVIDER_PAYMENT_REQUIRED", msg, 402);
    }
    if (!res.ok) {
      return makeFailedState("PROVIDER_UNREACHABLE", `HTTP ${String(res.status)}`, res.status);
    }
    return makeOkState();
  } catch (err) {
    return makeUnreachableState(err);
  }
}

async function validateOllama(
  baseUrl: string,
): Promise<FridayProviderValidationState> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/tags`;
  try {
    const res = await fetchWithTimeout(url, { method: "GET" });
    if (!res.ok) {
      return makeFailedState("PROVIDER_UNREACHABLE", `HTTP ${String(res.status)}`, res.status);
    }
    return makeOkState();
  } catch (err) {
    return makeUnreachableState(err);
  }
}

async function validateOpenAiCompatible(
  baseUrl: string,
  credential: string | null,
): Promise<FridayProviderValidationState> {
  // Same as OpenAI — GET /v1/models
  return validateOpenAi(baseUrl, credential);
}

async function readValidationErrorSuffix(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const safe = trimmed
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/gi, "sk-[REDACTED]")
    .slice(0, 500);
  return `: ${safe}`;
}

// ─── State builders ───

function makeOkState(): FridayProviderValidationState {
  return {
    status: "ok",
    checkedAt: new Date().toISOString(),
  };
}

function makeFailedState(
  errorCode: FridayProviderValidationErrorCode,
  errorMessage: string,
  httpStatus?: number,
): FridayProviderValidationState {
  return {
    status: "failed",
    checkedAt: new Date().toISOString(),
    errorCode,
    errorMessage,
    httpStatus,
  };
}

function makeUnreachableState(err: unknown): FridayProviderValidationState {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    status: "failed",
    checkedAt: new Date().toISOString(),
    errorCode: "PROVIDER_UNREACHABLE",
    errorMessage: msg,
  };
}

// ─── Factory ───

export function createFridayProviderValidator(): FridayProviderValidator {
  return {
    async validate(params) {
      // Security: reject baseUrl targeting private/loopback/internal addresses.
      // Ollama is inherently a local-only service, so loopback is allowed for it.
      const isOllamaApi = params.api === "ollama";
      try {
        assertBaseUrlSafe(params.baseUrl, { allowLoopback: isOllamaApi });
      } catch (err) {
        console.warn("[friday][provider-validator] base URL blocked:", err instanceof Error ? err.message : String(err));
        return makeFailedState("PROVIDER_UNREACHABLE", "Base URL blocked by security policy (private/loopback address)");
      }

      // Validate by API protocol, not provider brand.
      // This enables many provider kinds (OpenClaw-style catalog) to share
      // the same transport validation behavior.
      switch (params.api) {
        case "openai-completions":
        case "openai-responses":
          return validateOpenAiCompatible(params.baseUrl, params.credential);
        case "openai-codex-responses":
          return validateOpenAiCodex(params.baseUrl, params.credential, params.model);
        case "anthropic-messages":
          return validateAnthropic(params.baseUrl, params.credential, params.authMode);
        case "google-generative-ai":
          return validateGoogle(params.baseUrl, params.credential);
        case "ollama":
          return validateOllama(params.baseUrl);
        default:
          return validateOpenAiCompatible(params.baseUrl, params.credential);
      }
    },
  };
}
