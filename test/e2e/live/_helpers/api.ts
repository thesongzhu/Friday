/**
 * Generic API helpers for real-scenario E2E tests.
 */

import { authHeaders } from "./real-env.js";
import { liveAnthropicCredentialMessage } from "../../_helpers/live-anthropic.js";
import {
  E2E_TARGET,
  getCloudE2eConfig,
  loginCloudAndGetTokenPair,
  type FridayCloudTokenPair,
} from "./cloud-env.js";

interface FridayErrorEnvelope {
  ok?: boolean;
  error?: {
    code?: string;
    message?: string;
  };
}

interface FridayProviderRuntimeCapabilityRecord {
  capability?: string;
  model?: string;
  verified?: boolean;
  status?: "declared" | "verified" | "failed";
}

interface FridayProviderProfileEnvelope {
  id: string;
  config: {
    runtimeCapabilities?: FridayProviderRuntimeCapabilityRecord[];
  };
}

interface FridayCapabilityDoctorResult {
  providerId?: string;
  capability?: string;
  model?: string;
  status?: string;
  message?: string;
  errorCode?: string;
}

interface FridayCapabilityDoctorReportEnvelope {
  capabilityResults?: FridayCapabilityDoctorResult[];
}

const TOKEN_RECOVERABLE_CODES = new Set(["TOKEN_EXPIRED", "AUTH_INVALID"]);
const AUTH_STATE_BY_BASE_URL = new Map<string, { accessToken: string; refreshToken?: string }>();
const LOCAL_PASSPHRASE =
  process.env.FRIDAY_TEST_LOCAL_PASSPHRASE
  ?? process.env.FRIDAY_LOCAL_PASSPHRASE
  ?? "friday-test-local-passphrase-123";

async function loginAndGetTokenPair(
  baseUrl: string,
): Promise<FridayCloudTokenPair> {
  if (E2E_TARGET === "cloud") {
    const cloudConfig = getCloudE2eConfig();
    if (!cloudConfig) {
      throw new Error("[Cloud E2E] Cloud target selected but cloud config is unavailable");
    }
    return loginCloudAndGetTokenPair(baseUrl, cloudConfig);
  }
  return loginLocalAndGetTokenPair(baseUrl);
}

async function loginLocalAndGetTokenPair(
  baseUrl: string,
): Promise<{ accessToken: string; refreshToken?: string }> {
  const bootstrapStatusRes = await fetch(`${baseUrl}/v1/auth/bootstrap/status`);
  const bootstrapStatus = (await bootstrapStatusRes.json()) as {
    ok?: boolean;
    data?: { bootstrapRequired?: boolean };
    bootstrapRequired?: boolean;
  };
  const bootstrapRequired =
    bootstrapStatus.data?.bootstrapRequired ?? bootstrapStatus.bootstrapRequired ?? false;
  if (bootstrapRequired) {
    const bootstrapRes = await fetch(`${baseUrl}/v1/auth/bootstrap/local-passphrase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
    });
    const bootstrapJson = (await bootstrapRes.json()) as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    };
    if (!bootstrapRes.ok || bootstrapJson.ok === false) {
      throw new Error(`Failed to bootstrap local auth token: ${JSON.stringify(bootstrapJson)}`);
    }
  }

  const loginRes = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPassphrase: LOCAL_PASSPHRASE }),
  });
  const loginJson = (await loginRes.json()) as {
    ok: boolean;
    data?: { accessToken?: string; refreshToken?: string };
    error?: { code?: string; message?: string };
  };
  if (!loginRes.ok || !loginJson.ok || !loginJson.data?.accessToken) {
    throw new Error(`Failed to refresh local auth token: ${JSON.stringify(loginJson)}`);
  }
  return {
    accessToken: loginJson.data.accessToken,
    refreshToken: loginJson.data.refreshToken,
  };
}

async function refreshAccessToken(
  baseUrl: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string }> {
  const refreshRes = await fetch(`${baseUrl}/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const refreshJson = (await refreshRes.json()) as {
    ok: boolean;
    data?: { accessToken?: string; refreshToken?: string };
    error?: { code?: string; message?: string; retryAfterMs?: number };
  };
  if (!refreshRes.ok || !refreshJson.ok || !refreshJson.data?.accessToken) {
    throw new Error(`Failed to refresh access token: ${JSON.stringify(refreshJson)}`);
  }
  return {
    accessToken: refreshJson.data.accessToken,
    refreshToken: refreshJson.data.refreshToken ?? refreshToken,
  };
}

// ─── Generic fetch helper ───

export async function apiFetch<T>(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<{ status: number; json: T }> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const doRequest = async (accessToken: string) => fetch(`${baseUrl}${path}`, {
      method,
      headers: authHeaders(accessToken),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    let authState = AUTH_STATE_BY_BASE_URL.get(baseUrl);
    if (!authState) {
      const cloudConfig = E2E_TARGET === "cloud" ? getCloudE2eConfig() : null;
      authState = {
        accessToken: token,
        ...(cloudConfig?.refreshToken ? { refreshToken: cloudConfig.refreshToken } : {}),
      };
      AUTH_STATE_BY_BASE_URL.set(baseUrl, authState);
    }

    let res = await doRequest(authState.accessToken);
    let json = (await res.json()) as T;

    // Long-running live suites can outlive access tokens; retry once with refreshed/re-authenticated token.
    if (res.status === 401) {
      const envelope = json as FridayErrorEnvelope;
      const errorCode = envelope.error?.code;
      if (errorCode && TOKEN_RECOVERABLE_CODES.has(errorCode)) {
        try {
          if (authState.refreshToken) {
            authState = await refreshAccessToken(baseUrl, authState.refreshToken);
          } else {
            authState = await loginAndGetTokenPair(baseUrl);
          }
        } catch {
          // Fallback: if refresh path fails, force a single re-login.
          authState = await loginAndGetTokenPair(baseUrl);
        }
        AUTH_STATE_BY_BASE_URL.set(baseUrl, authState);
        res = await doRequest(authState.accessToken);
        json = (await res.json()) as T;
      }
    }

    return { status: res.status, json };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`apiFetch timeout/error on ${method} ${path}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Specific helpers ───

export async function createOllamaProvider(
  baseUrl: string,
  token: string,
  opts: {
    name: string;
    ollamaBaseUrl: string;
    models: string[];
    defaultModel: string;
  },
): Promise<string> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: { provider: { id: string } };
  }>(baseUrl, token, "POST", "/v1/providers", {
    kind: "ollama",
    name: opts.name,
    baseUrl: opts.ollamaBaseUrl,
    authMode: "none",
    api: "ollama",
    supportedModels: opts.models,
    defaultModel: opts.defaultModel,
    enabled: true,
    validateOnSave: false,
  });
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to create Ollama provider: ${JSON.stringify(json)}`);
  }
  return json.data.provider.id;
}

export async function createOpenAiProvider(
  baseUrl: string,
  token: string,
  opts: {
    name: string;
    openAiBaseUrl: string;
    models: string[];
    defaultModel: string;
    apiKeyEnvRef?: string;
  },
): Promise<string> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: { provider: { id: string } };
  }>(baseUrl, token, "POST", "/v1/providers", {
    kind: "openai",
    name: opts.name,
    baseUrl: opts.openAiBaseUrl,
    authMode: "api-key",
    api: "openai-responses",
    apiKey: opts.apiKeyEnvRef ?? "$OPENAI_API_KEY",
    supportedModels: opts.models,
    defaultModel: opts.defaultModel,
    enabled: true,
    validateOnSave: false,
  });
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to create OpenAI provider: ${JSON.stringify(json)}`);
  }
  return json.data.provider.id;
}

export async function createDeepSeekProvider(
  baseUrl: string,
  token: string,
  opts: {
    name: string;
    deepSeekBaseUrl: string;
    models: string[];
    defaultModel: string;
    apiKeyEnvRef?: string;
  },
): Promise<string> {
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: { provider: { id: string } };
  }>(baseUrl, token, "POST", "/v1/providers", {
    kind: "deepseek",
    name: opts.name,
    baseUrl: opts.deepSeekBaseUrl,
    authMode: "bearer-token",
    api: "openai-completions",
    apiKey: opts.apiKeyEnvRef ?? "$DEEPSEEK_API_KEY",
    preserveEnvRef: true,
    supportedModels: opts.models,
    defaultModel: opts.defaultModel,
    enabled: true,
    validateOnSave: false,
  });
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to create DeepSeek provider: ${JSON.stringify(json)}`);
  }
  return json.data.provider.id;
}

export async function createAnthropicProvider(
  baseUrl: string,
  token: string,
  opts: {
    name: string;
    anthropicBaseUrl: string;
    models: string[];
    defaultModel: string;
    apiKeyEnvRef?: string;
  },
): Promise<string> {
  if (typeof opts.apiKeyEnvRef !== "string" || opts.apiKeyEnvRef.trim().length === 0) { // pragma: allowlist secret
    throw new Error(liveAnthropicCredentialMessage());
  }
  const { status, json } = await apiFetch<{
    ok: boolean;
    data: { provider: { id: string } };
  }>(baseUrl, token, "POST", "/v1/providers", {
    kind: "anthropic",
    name: opts.name,
    baseUrl: opts.anthropicBaseUrl,
    authMode: "api-key",
    api: "anthropic-messages",
    apiKey: opts.apiKeyEnvRef,
    supportedModels: opts.models,
    defaultModel: opts.defaultModel,
    enabled: true,
    validateOnSave: false,
  });
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to create Anthropic provider: ${JSON.stringify(json)}`);
  }
  return json.data.provider.id;
}

export async function verifyProviderTextCapability(
  baseUrl: string,
  token: string,
  providerId: string,
  model: string,
  opts: { doctorProviderIds?: string[]; runDoctor?: boolean } = {},
): Promise<void> {
  let doctorReport: FridayCapabilityDoctorReportEnvelope | undefined;
  if (opts.runDoctor !== false) {
    const doctorProviderIds = opts.doctorProviderIds ?? [providerId];
    const doctorRes = await apiFetch<{
      ok: boolean;
      data?: FridayCapabilityDoctorReportEnvelope;
      error?: { code?: string; message?: string };
    }>(
      baseUrl,
      token,
      "POST",
      "/v1/capabilities/doctor",
      { providerIds: doctorProviderIds },
      { timeoutMs: 180_000 },
    );
    if (doctorRes.status !== 200 || !doctorRes.json.ok) {
      throw new Error(`Capability doctor failed: ${JSON.stringify(doctorRes.json)}`);
    }
    doctorReport = doctorRes.json.data;
  }

  const providerRes = await apiFetch<{
    ok: boolean;
    data?: { provider?: FridayProviderProfileEnvelope };
    error?: { code?: string; message?: string };
  }>(baseUrl, token, "GET", `/v1/providers/${encodeURIComponent(providerId)}`);
  if (providerRes.status !== 200 || !providerRes.json.ok || !providerRes.json.data?.provider) {
    throw new Error(`Failed to read provider after capability doctor: ${JSON.stringify(providerRes.json)}`);
  }

  const capabilities = providerRes.json.data.provider.config.runtimeCapabilities ?? [];
  const verifiedText = capabilities.some((entry) =>
    entry.capability === "text"
    && (!entry.model || entry.model === model)
    && (entry.status === "verified" || entry.verified === true)
  );
  if (verifiedText) {
    return;
  }

  const doctorTextResults = (doctorReport?.capabilityResults ?? [])
    .filter((entry) =>
      entry.providerId === providerId
      && entry.capability === "text"
      && entry.model === model
    )
    .map((entry) => ({
      status: entry.status,
      errorCode: entry.errorCode,
      message: entry.message,
    }));
  throw new Error(
    `Provider ${providerId} did not verify text capability for ${model}: ${JSON.stringify(doctorTextResults)}`,
  );
}

export async function setModelRouting(
  baseUrl: string,
  token: string,
  defaultProviderId: string,
  fallbackProviderIds: string[] = [],
): Promise<void> {
  const { status, json } = await apiFetch<{ ok: boolean }>(
    baseUrl,
    token,
    "PUT",
    "/v1/model-routing",
    { defaultProviderId, fallbackProviderIds },
  );
  if (status !== 200 || !json.ok) {
    throw new Error(`Failed to set model routing: ${JSON.stringify(json)}`);
  }
}

/**
 * Create Ollama fast + code providers and set routing to fast as default.
 * Returns { fastProviderId, codeProviderId }.
 */
export async function ensureOllamaProviders(
  baseUrl: string,
  token: string,
  ollamaBaseUrl: string,
  fastModel: string,
  codeModel: string,
  opts: { namePrefix?: string } = {},
): Promise<{ fastProviderId: string; codeProviderId: string }> {
  const normalizedPrefix = opts.namePrefix?.trim();
  const fastName = normalizedPrefix
    ? `${normalizedPrefix} Ollama Fast (E2E)`
    : "Ollama Fast (E2E)";
  const codeName = normalizedPrefix
    ? `${normalizedPrefix} Ollama Code (E2E)`
    : "Ollama Code (E2E)";

  const fastProviderId = await createOllamaProvider(baseUrl, token, {
    name: fastName,
    ollamaBaseUrl,
    models: [fastModel],
    defaultModel: fastModel,
  });

  const codeProviderId = await createOllamaProvider(baseUrl, token, {
    name: codeName,
    ollamaBaseUrl,
    models: [codeModel],
    defaultModel: codeModel,
  });

  await setModelRouting(baseUrl, token, fastProviderId, [codeProviderId]);
  await verifyProviderTextCapability(baseUrl, token, fastProviderId, fastModel, {
    doctorProviderIds: [fastProviderId, codeProviderId],
  });
  await verifyProviderTextCapability(baseUrl, token, codeProviderId, codeModel, { runDoctor: false });

  return { fastProviderId, codeProviderId };
}

/**
 * Create OpenAI fast + code providers and set routing to fast as default.
 * Returns { fastProviderId, codeProviderId }.
 */
export async function ensureOpenAiProviders(
  baseUrl: string,
  token: string,
  openAiBaseUrl: string,
  fastModel: string,
  codeModel: string,
  apiKeyEnvRef?: string,
  opts: { namePrefix?: string } = {},
): Promise<{ fastProviderId: string; codeProviderId: string }> {
  const normalizedPrefix = opts.namePrefix?.trim();
  const fastName = normalizedPrefix
    ? `${normalizedPrefix} OpenAI Fast (E2E)`
    : "OpenAI Fast (E2E)";
  const codeName = normalizedPrefix
    ? `${normalizedPrefix} OpenAI Code (E2E)`
    : "OpenAI Code (E2E)";

  const fastProviderId = await createOpenAiProvider(baseUrl, token, {
    name: fastName,
    openAiBaseUrl,
    models: [fastModel],
    defaultModel: fastModel,
    apiKeyEnvRef,
  });

  const codeProviderId = await createOpenAiProvider(baseUrl, token, {
    name: codeName,
    openAiBaseUrl,
    models: [codeModel],
    defaultModel: codeModel,
    apiKeyEnvRef,
  });

  await setModelRouting(baseUrl, token, fastProviderId, [codeProviderId]);
  await verifyProviderTextCapability(baseUrl, token, fastProviderId, fastModel, {
    doctorProviderIds: [fastProviderId, codeProviderId],
  });
  await verifyProviderTextCapability(baseUrl, token, codeProviderId, codeModel, { runDoctor: false });

  return { fastProviderId, codeProviderId };
}

/**
 * Create DeepSeek fast + code providers and set routing to fast as default.
 * Returns { fastProviderId, codeProviderId }.
 */
export async function ensureDeepSeekProviders(
  baseUrl: string,
  token: string,
  deepSeekBaseUrl: string,
  fastModel: string,
  codeModel: string,
  apiKeyEnvRef?: string,
  opts: { namePrefix?: string } = {},
): Promise<{ fastProviderId: string; codeProviderId: string }> {
  const normalizedPrefix = opts.namePrefix?.trim();
  const fastName = normalizedPrefix
    ? `${normalizedPrefix} DeepSeek Fast (E2E)`
    : "DeepSeek Fast (E2E)";
  const codeName = normalizedPrefix
    ? `${normalizedPrefix} DeepSeek Code (E2E)`
    : "DeepSeek Code (E2E)";

  const fastProviderId = await createDeepSeekProvider(baseUrl, token, {
    name: fastName,
    deepSeekBaseUrl,
    models: [fastModel],
    defaultModel: fastModel,
    apiKeyEnvRef,
  });

  const codeProviderId = await createDeepSeekProvider(baseUrl, token, {
    name: codeName,
    deepSeekBaseUrl,
    models: [codeModel],
    defaultModel: codeModel,
    apiKeyEnvRef,
  });

  await setModelRouting(baseUrl, token, fastProviderId, [codeProviderId]);
  await verifyProviderTextCapability(baseUrl, token, fastProviderId, fastModel, {
    doctorProviderIds: [fastProviderId, codeProviderId],
  });
  await verifyProviderTextCapability(baseUrl, token, codeProviderId, codeModel, { runDoctor: false });

  return { fastProviderId, codeProviderId };
}

/**
 * Create Anthropic fast + code providers and set routing to fast as default.
 * Returns { fastProviderId, codeProviderId }.
 */
export async function ensureAnthropicProviders(
  baseUrl: string,
  token: string,
  anthropicBaseUrl: string,
  fastModel: string,
  codeModel: string,
  apiKeyEnvRef: string,
  opts: { namePrefix?: string } = {},
): Promise<{ fastProviderId: string; codeProviderId: string }> {
  const normalizedPrefix = opts.namePrefix?.trim();
  const fastName = normalizedPrefix
    ? `${normalizedPrefix} Anthropic Fast (E2E)`
    : "Anthropic Fast (E2E)";
  const codeName = normalizedPrefix
    ? `${normalizedPrefix} Anthropic Code (E2E)`
    : "Anthropic Code (E2E)";

  const fastProviderId = await createAnthropicProvider(baseUrl, token, {
    name: fastName,
    anthropicBaseUrl,
    models: [fastModel],
    defaultModel: fastModel,
    apiKeyEnvRef,
  });

  const codeProviderId = await createAnthropicProvider(baseUrl, token, {
    name: codeName,
    anthropicBaseUrl,
    models: [codeModel],
    defaultModel: codeModel,
    apiKeyEnvRef,
  });

  await setModelRouting(baseUrl, token, fastProviderId, [codeProviderId]);
  await verifyProviderTextCapability(baseUrl, token, fastProviderId, fastModel, {
    doctorProviderIds: [fastProviderId, codeProviderId],
  });
  await verifyProviderTextCapability(baseUrl, token, codeProviderId, codeModel, { runDoctor: false });

  return { fastProviderId, codeProviderId };
}
