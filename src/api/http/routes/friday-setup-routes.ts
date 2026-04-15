import * as os from "node:os";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridaySqliteLayer } from "#state";
import {
  createFridaySecretRepository,
  detectFridayProviderKindFromApiKey,
  encryptSecret,
  FRIDAY_PROVIDER_KIND_SET,
  type FridayProviderApi,
  type FridayProviderAuthMode,
  type FridayProviderKind,
  type FridayProviderService,
  getFridayProviderAuthModesForBackend,
  getFridayProviderCapability,
  getFridayProviderPreset,
  getMasterKey,
  isFridayProviderAuthModeSupportedForKind,
} from "#providers";
import type { FridaySkillRegistry } from "#skills";
import {
  buildFridayChannelSecretRef,
  buildFridayChannelSecretRefKey,
  FRIDAY_CHANNEL_SECRET_SCOPE,
  FRIDAY_SUPPORTED_CHANNEL_KINDS,
  getFridayChannelSecretFieldDescriptors,
  parseFridayChannelsConfig,
} from "#channels";
import type { FridaySupportedChannelKind } from "#channels";
import { FridayDomainError } from "#errors";
import { validateGatewayUrl } from "../../../agent/tools/friday-agent-gateway-validation.js";
import { parseFridaySecretInput } from "../../../security/friday-secret-ref.js";

// ─── Types ───

type SetupStepId = "welcome" | "security" | "communication" | "provider" | "network" | "channels" | "skills" | "done";
type NetworkMode = "local" | "network" | "custom";

interface DetectProviderRequest {
  apiKey?: string;
  kind?: FridayProviderKind;
  baseUrl?: string;
  authMode?: FridayProviderAuthMode;
}

interface DetectProviderResponse {
  kind: FridayProviderKind;
  confidence: "high" | "medium" | "low";
  baseUrl: string;
  api: FridayProviderApi;
  authMode: FridayProviderAuthMode;
  availableModels: string[];
  defaultModel?: string;
  validated: boolean;
  latencyMs?: number;
  warnings: string[];
}

interface SetupStatusResponse {
  needsSetup: boolean;
  setupCompletedAt: string | null;
  providerCount: number;
  channelCount: number;
  skillsCount: number;
  network: {
    host: string;
    port: number;
    mode: NetworkMode;
    previewUrls: string[];
  };
}

interface SetupNetworkRequest {
  mode: NetworkMode;
  host?: string;
  port: number;
}

interface SetupNetworkResponse {
  host: string;
  port: number;
  mode: NetworkMode;
  previewUrls: string[];
  restartRequired: boolean;
}

interface SetupCompleteRequest {
  completedSteps: SetupStepId[];
  skippedSteps: SetupStepId[];
}

interface SetupCompleteResponse {
  setupCompletedAt: string;
}

interface SetupChannelsRequest {
  channels: Array<{
    kind: FridaySupportedChannelKind;
    enabled: boolean;
    config: Record<string, unknown>;
  }>;
}

interface SetupChannelsResponse {
  savedKinds: string[];
}

// ─── DB row type ───

interface SetupStateRow {
  id: string;
  setup_completed_at: string | null;
  completed_steps: string;
  skipped_steps: string;
  network_mode: string;
  network_host: string;
  network_port: number;
  channels_json: string;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ───

const VALID_KINDS = FRIDAY_PROVIDER_KIND_SET;
const VALID_AUTH_MODES = new Set<string>(["api-key", "bearer-token", "oauth", "token", "none"]);
const VALID_NETWORK_MODES = new Set<string>(["local", "network", "custom"]);
const VALID_CHANNEL_KINDS = new Set<string>(FRIDAY_SUPPORTED_CHANNEL_KINDS);
const VALID_STEP_IDS = new Set<string>(["welcome", "security", "communication", "provider", "network", "channels", "skills", "done"]);

const channelSecretRepository = createFridaySecretRepository();

function parseStepIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((step): step is string => typeof step === "string");
  } catch (err) {
    console.warn("[friday][setup-routes] operation failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function computePreviewUrls(host: string, port: number): string[] {
  const urls: string[] = [];

  if (host === "127.0.0.1" || host === "localhost") {
    urls.push(`http://localhost:${port}`);
    urls.push(`http://127.0.0.1:${port}`);
    return urls;
  }

  // Always include localhost
  urls.push(`http://localhost:${port}`);

  // If binding to 0.0.0.0, enumerate all non-internal IPv4 interfaces
  if (host === "0.0.0.0") {
    const interfaces = os.networkInterfaces();
    for (const ifaces of Object.values(interfaces)) {
      if (!ifaces) continue;
      for (const iface of ifaces) {
        if (iface.family === "IPv4" && !iface.internal) {
          urls.push(`http://${iface.address}:${port}`);
        }
      }
    }
  } else {
    urls.push(`http://${host}:${port}`);
  }

  return urls;
}

// ─── Model fetching ───

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function assertSetupBaseUrlSafe(baseUrl: string, opts?: { allowPrivateNetwork?: boolean }): void {
  const result = validateGatewayUrl(baseUrl, {
    allowLoopback: opts?.allowPrivateNetwork,
    allowPrivate: opts?.allowPrivateNetwork,
  });
  if (!result.valid) {
    throw new FridayDomainError("PROVIDER_UNREACHABLE", `Base URL blocked by security policy: ${result.error ?? "private/loopback address"}`, { httpStatus: 422, details: { hint: "Friday blocks localhost/private IPs by default. For local providers like Ollama, use the setup wizard which enables private network access." } });
  }
}

async function fetchOpenAiModels(baseUrl: string, apiKey: string, ssrf?: { allowPrivateNetwork?: boolean }): Promise<{ models: string[]; defaultModel?: string }> {
  assertSetupBaseUrlSafe(baseUrl, ssrf);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new FridayDomainError("PROVIDER_AUTH_INVALID", "Invalid API key", { httpStatus: 401, details: { hint: "OpenAI keys start with 'sk-'. Check your key at https://platform.openai.com/api-keys" } });
  }
  if (res.status === 429) {
    throw new FridayDomainError("PROVIDER_RATE_LIMITED", "Upstream rate limit", { httpStatus: 429, retryable: true });
  }
  if (!res.ok) {
    throw new FridayDomainError("PROVIDER_UNREACHABLE", `HTTP ${res.status}`, { httpStatus: 422 });
  }
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const allModels = (body.data ?? []).map((m) => m.id);

  // Filter to chat-capable models
  const chatPrefixes = ["gpt-", "o1", "o3", "o4"];
  const chatModels = allModels.filter((id) =>
    chatPrefixes.some((prefix) => id.startsWith(prefix)),
  );

  // Preferred order
  const preferred = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o4-mini", "o3-mini", "o1-mini"];
  const defaultModel = preferred.find((m) => chatModels.includes(m));

  chatModels.sort((a, b) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  return { models: chatModels.length > 0 ? chatModels : allModels, defaultModel };
}

async function fetchAnthropicModels(baseUrl: string, apiKey: string, ssrf?: { allowPrivateNetwork?: boolean }): Promise<{ models: string[]; defaultModel?: string; validated: boolean }> {
  assertSetupBaseUrlSafe(baseUrl, ssrf);
  const models = ["claude-opus-4", "claude-sonnet-4", "claude-haiku-3.5"];

  // Validate key with minimal API call
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new FridayDomainError("PROVIDER_AUTH_INVALID", "Invalid API key", { httpStatus: 401, details: { hint: "Anthropic keys start with 'sk-ant-'. Check your key at https://console.anthropic.com/settings/keys" } });
    }
    if (res.status === 402) {
      let msg = "Insufficient credit balance — add credits at https://console.anthropic.com/settings/billing";
      try {
        const errBody = (await res.json()) as { error?: { message?: string } };
        if (errBody?.error?.message) msg = errBody.error.message;
      } catch {
        // ignore parse errors
      }
      throw new FridayDomainError("PROVIDER_PAYMENT_REQUIRED", msg, { httpStatus: 402, details: { hint: "Your API key is valid but has no credits. Visit https://console.anthropic.com/settings/billing to add credits." } });
    }
    if (res.status === 429) {
      throw new FridayDomainError("PROVIDER_RATE_LIMITED", "Upstream rate limit", { httpStatus: 429, retryable: true });
    }
    // 400 with credit balance error is payment-required
    if (res.status === 400) {
      try {
        const errBody = (await res.json()) as { error?: { type?: string; message?: string } };
        if (errBody?.error?.message && /credit balance/i.test(errBody.error.message)) {
          throw new FridayDomainError("PROVIDER_PAYMENT_REQUIRED", errBody.error.message, { httpStatus: 402, details: { hint: "Your API key is valid but has no credits. Visit https://console.anthropic.com/settings/billing to add credits." } });
        }
      } catch (err) {
        if (err instanceof FridayDomainError) throw err;
        // ignore parse errors
      }
    }
    // 200, 529 all mean the key is valid
    const validated = res.ok || res.status === 529;
    return { models, defaultModel: "claude-sonnet-4", validated };
  } catch (err) {
    if (err instanceof FridayDomainError) {
      throw err;
    }
    throw new FridayDomainError("PROVIDER_UNREACHABLE", "Could not reach Anthropic API", { httpStatus: 422 });
  }
}

async function fetchGoogleModels(baseUrl: string, apiKey: string, ssrf?: { allowPrivateNetwork?: boolean }): Promise<{ models: string[]; defaultModel?: string }> {
  assertSetupBaseUrlSafe(baseUrl, ssrf);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1beta/models`;
  const res = await fetchWithTimeout(url, { method: "GET", headers: { "x-goog-api-key": apiKey } });
  if (res.status === 401 || res.status === 403) {
    throw new FridayDomainError("PROVIDER_AUTH_INVALID", "Invalid API key", { httpStatus: 401, details: { hint: "Google AI keys can be generated at https://aistudio.google.com/app/apikey" } });
  }
  if (res.status === 429) {
    throw new FridayDomainError("PROVIDER_RATE_LIMITED", "Upstream rate limit", { httpStatus: 429, retryable: true });
  }
  if (!res.ok) {
    throw new FridayDomainError("PROVIDER_UNREACHABLE", `HTTP ${res.status}`, { httpStatus: 422 });
  }
  const body = (await res.json()) as {
    models?: Array<{
      name: string;
      supportedGenerationMethods?: string[];
    }>;
  };

  const models = (body.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));

  // Default to newest stable Gemini model
  const defaultModel = models.find((m) => m.startsWith("gemini-2")) ??
    models.find((m) => m.startsWith("gemini-1.5")) ??
    models[0];

  return { models, defaultModel };
}

async function fetchOllamaModels(baseUrl: string, ssrf?: { allowPrivateNetwork?: boolean }): Promise<{ models: string[]; defaultModel?: string }> {
  assertSetupBaseUrlSafe(baseUrl, ssrf);
  const url = `${baseUrl.replace(/\/+$/, "")}/api/tags`;
  const res = await fetchWithTimeout(url, { method: "GET" });
  if (!res.ok) {
    throw new FridayDomainError("PROVIDER_UNREACHABLE", `Ollama not reachable (HTTP ${res.status})`, { httpStatus: 422 });
  }
  const body = (await res.json()) as { models?: Array<{ name: string }> };
  const models = (body.models ?? []).map((m) => m.name);
  return { models, defaultModel: models[0] };
}

async function fetchCompatibleModels(baseUrl: string, apiKey?: string, ssrf?: { allowPrivateNetwork?: boolean }): Promise<{ models: string[]; defaultModel?: string }> {
  assertSetupBaseUrlSafe(baseUrl, ssrf);
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetchWithTimeout(url, { method: "GET", headers });
  if (res.status === 401 || res.status === 403) {
    throw new FridayDomainError("PROVIDER_AUTH_INVALID", "Invalid API key", { httpStatus: 401, details: { hint: "Verify the API key is correct and the provider supports the OpenAI-compatible /v1/models endpoint" } });
  }
  if (res.status === 429) {
    throw new FridayDomainError("PROVIDER_RATE_LIMITED", "Upstream rate limit", { httpStatus: 429, retryable: true });
  }
  if (!res.ok) {
    throw new FridayDomainError("PROVIDER_UNREACHABLE", `HTTP ${res.status}`, { httpStatus: 422 });
  }
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  const models = (body.data ?? []).map((m) => m.id);
  return { models, defaultModel: models[0] };
}

// ─── Dependencies ───

export interface FridaySetupRoutesDeps {
  db: FridaySqliteLayer;
  providerService: FridayProviderService;
  skillRegistry: FridaySkillRegistry;
  nowIso: () => string;
  runningHost: string;
  runningPort: number;
  /** Allow loopback/private network addresses for self-hosted deployments using local providers. */
  allowPrivateNetwork?: boolean;
}

// ─── Factory ───

export function createFridaySetupRoutes(
  deps: FridaySetupRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {

  function getSetupState(): SetupStateRow {
    return deps.db.withReadConnection((db) => {
      const row = db.prepare("SELECT * FROM friday_setup_state WHERE id = 'singleton'").get() as SetupStateRow | undefined;
      if (!row) {
        // Should never happen after migration, but handle gracefully
        return {
          id: "singleton",
          setup_completed_at: null,
          completed_steps: "[]",
          skipped_steps: "[]",
          network_mode: "local",
          network_host: "127.0.0.1",
          network_port: 3141,
          channels_json: "[]",
          created_at: deps.nowIso(),
          updated_at: deps.nowIso(),
        };
      }
      return { ...row, channels_json: row.channels_json ?? "[]" };
    });
  }

  return [
    // ─── GET /v1/setup/status ───
    {
      operationId: "setup.status",
      method: "GET",
      path: "/v1/setup/status",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(): Promise<SetupStatusResponse> {
        const state = getSetupState();
        const providers = await deps.providerService.listProviders();
        const skills = deps.skillRegistry.list();

        const channelCount = (() => {
          try {
            const parsed = JSON.parse(state.channels_json);
            if (!Array.isArray(parsed)) return 0;
            return parsed.filter((entry) =>
              typeof entry === "object" &&
              entry !== null &&
              (entry as { enabled?: unknown }).enabled === true,
            ).length;
          } catch (err) {
    console.warn("[friday][setup-routes] operation failed:", err instanceof Error ? err.message : String(err));
            return 0;
          }
        })();

        const host = deps.runningHost ?? state.network_host;
        const port = deps.runningPort ?? state.network_port;
        const mode = state.network_mode as NetworkMode;

        const completedSteps = parseStepIds(state.completed_steps);
        const completedByStepState = completedSteps.includes("done");
        let setupCompletedAt = state.setup_completed_at;

        // Backward-compat / self-heal: older runs may have "done" in steps but null timestamp.
        if (!setupCompletedAt && completedByStepState) {
          const repairedAt = state.updated_at || deps.nowIso();
          deps.db.withWriteTransaction((db) => {
            db.prepare(
              `UPDATE friday_setup_state
               SET setup_completed_at = ?, updated_at = ?
               WHERE id = 'singleton'`,
            ).run(repairedAt, deps.nowIso());
          });
          setupCompletedAt = repairedAt;
        }

        return {
          needsSetup: setupCompletedAt === null,
          setupCompletedAt,
          providerCount: providers.length,
          channelCount,
          skillsCount: skills.length,
          network: {
            host,
            port,
            mode,
            previewUrls: computePreviewUrls(host, port),
          },
        };
      },
    },

    // ─── POST /v1/providers/detect ───
    {
      operationId: "providers.detect",
      method: "POST",
      path: "/v1/providers/detect",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      rateLimitPolicyId: "provider.validate",
      async handler(ctx): Promise<DetectProviderResponse> {
        const body = ctx.body as DetectProviderRequest | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
        }

        const apiKey = typeof body.apiKey === "string" ? body.apiKey : undefined;
        const explicitKind = typeof body.kind === "string" && VALID_KINDS.has(body.kind) ? body.kind as FridayProviderKind : undefined;
        const explicitBaseUrl = typeof body.baseUrl === "string" ? body.baseUrl : undefined;
        const explicitAuthMode = typeof body.authMode === "string"
          ? (VALID_AUTH_MODES.has(body.authMode) ? body.authMode as FridayProviderAuthMode : undefined)
          : undefined;
        if (body.authMode !== undefined && !explicitAuthMode) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            `authMode must be one of: ${Array.from(VALID_AUTH_MODES).join(", ")}`,
            { httpStatus: 400 },
          );
        }

        // Detect provider kind
        let kind: FridayProviderKind;
        let confidence: "high" | "medium" | "low";

        if (explicitKind) {
          kind = explicitKind;
          confidence = "high";
        } else if (!apiKey && explicitBaseUrl && (explicitBaseUrl.includes("localhost:11434") || explicitBaseUrl.includes("127.0.0.1:11434"))) {
          kind = "ollama";
          confidence = "high";
        } else if (apiKey) {
          const detected = detectFridayProviderKindFromApiKey(apiKey);
          kind = detected.kind;
          confidence = detected.confidence;
        } else {
          throw new FridayDomainError("VALIDATION_ERROR", "Either apiKey, kind, or baseUrl (for Ollama) is required", { httpStatus: 400 });
        }

        // Get preset config
        const preset = getFridayProviderPreset(kind, explicitBaseUrl);
        const baseUrl = explicitBaseUrl ?? preset.baseUrl;
        const api = preset.api;
        const authMode = explicitAuthMode ?? preset.authMode;
        const capability = getFridayProviderCapability(kind);

        if (!isFridayProviderAuthModeSupportedForKind(kind, authMode)) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            `authMode '${authMode}' is not supported for '${kind}'. Supported: ${getFridayProviderAuthModesForBackend(kind, capability.supportedBackendKinds[0] ?? "http").join(", ")}`,
            { httpStatus: 400 },
          );
        }

        // Require credential unless this provider supports keyless or OAuth-first onboarding.
        if ((authMode === "api-key" || authMode === "bearer-token") && !apiKey) {
          throw new FridayDomainError("VALIDATION_ERROR", `API key is required for ${kind} provider`, { httpStatus: 400 });
        }

        if (!baseUrl) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            `baseUrl is required for ${kind} provider`,
            { httpStatus: 400 },
          );
        }

        // Fetch models
        const warnings: string[] = [];
        let availableModels: string[] = [];
        let defaultModel: string | undefined;
        let validated = false;
        let latencyMs: number | undefined;

        const startMs = Date.now();

        const ssrf = { allowPrivateNetwork: deps.allowPrivateNetwork };

        try {
          switch (api) {
            case "openai-completions":
            case "openai-responses": {
              const result = kind === "openai"
                ? await fetchOpenAiModels(baseUrl, apiKey!, ssrf)
                : await fetchCompatibleModels(baseUrl, apiKey, ssrf);
              availableModels = result.models;
              defaultModel = result.defaultModel;
              validated = true;
              break;
            }
            case "anthropic-messages": {
              if ((authMode === "oauth" || authMode === "token") && !apiKey) {
                availableModels = ["claude-opus-4", "claude-sonnet-4", "claude-haiku-3.5"];
                defaultModel = "claude-sonnet-4";
                validated = false;
                warnings.push(
                  authMode === "oauth"
                    ? "OAuth selected: complete login before provider validation."
                    : "Token selected: paste setup-token before provider validation.",
                );
              } else {
                const result = await fetchAnthropicModels(baseUrl, apiKey!, ssrf);
                availableModels = result.models;
                defaultModel = result.defaultModel;
                validated = result.validated;
                if (!result.validated) {
                  warnings.push("Could not validate API key — models listed are defaults");
                }
              }
              break;
            }
            case "google-generative-ai": {
              const result = await fetchGoogleModels(baseUrl, apiKey!, ssrf);
              availableModels = result.models;
              defaultModel = result.defaultModel;
              validated = true;
              break;
            }
            case "ollama": {
              const result = await fetchOllamaModels(baseUrl, ssrf);
              availableModels = result.models;
              defaultModel = result.defaultModel;
              validated = true;
              if (availableModels.length === 0) {
                warnings.push("No models installed in Ollama — run 'ollama pull <model>' first");
              }
              break;
            }
            default: {
              const result = await fetchCompatibleModels(baseUrl, apiKey, ssrf);
              availableModels = result.models;
              defaultModel = result.defaultModel;
              validated = true;
              break;
            }
          }
        } catch (err) {
          if (err instanceof FridayDomainError) {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          throw new FridayDomainError("PROVIDER_UNREACHABLE", `Could not reach provider: ${msg}`, { httpStatus: 422 });
        }

        latencyMs = Date.now() - startMs;

        return {
          kind,
          confidence,
          baseUrl,
          api,
          authMode,
          availableModels,
          defaultModel,
          validated,
          latencyMs,
          warnings,
        };
      },
    },

    // ─── GET /v1/setup/network ───
    {
      operationId: "setup.network.get",
      method: "GET",
      path: "/v1/setup/network",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(): Promise<SetupNetworkResponse> {
        const state = getSetupState();
        const host = state.network_host;
        const port = state.network_port;
        const mode = state.network_mode as NetworkMode;

        return {
          host,
          port,
          mode,
          previewUrls: computePreviewUrls(host, port),
          restartRequired: false,
        };
      },
    },

    // ─── POST /v1/setup/network ───
    {
      operationId: "setup.network.save",
      method: "POST",
      path: "/v1/setup/network",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx): Promise<SetupNetworkResponse> {
        const body = ctx.body as SetupNetworkRequest | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
        }

        const mode = body.mode;
        if (!mode || !VALID_NETWORK_MODES.has(mode)) {
          throw new FridayDomainError("VALIDATION_ERROR", `mode must be one of: ${[...VALID_NETWORK_MODES].join(", ")}`, { httpStatus: 400 });
        }

        const port = body.port;
        if (typeof port !== "number" || port < 1 || port > 65535) {
          throw new FridayDomainError("VALIDATION_ERROR", "port must be a number between 1 and 65535", { httpStatus: 400 });
        }

        let host: string;
        switch (mode) {
          case "local":
            host = "127.0.0.1";
            break;
          case "network":
            host = "0.0.0.0";
            break;
          case "custom":
            if (typeof body.host !== "string" || body.host.trim() === "") {
              throw new FridayDomainError("VALIDATION_ERROR", "host is required for custom mode", { httpStatus: 400 });
            }
            host = body.host.trim();
            break;
          default:
            host = "127.0.0.1";
        }

        const now = deps.nowIso();

        deps.db.withWriteTransaction((db) => {
          db.prepare(
            `INSERT OR IGNORE INTO friday_setup_state (id, created_at, updated_at)
             VALUES ('singleton', ?, ?)`,
          ).run(now, now);
          db.prepare(
            `UPDATE friday_setup_state SET network_mode = ?, network_host = ?, network_port = ?, updated_at = ? WHERE id = 'singleton'`,
          ).run(mode, host, port, now);
        });

        // Check if restart is required (compare both host and port)
        const restartRequired = port !== deps.runningPort || host !== deps.runningHost;

        return {
          host,
          port,
          mode: mode as NetworkMode,
          previewUrls: computePreviewUrls(host, port),
          restartRequired,
        };
      },
    },

    // ─── POST /v1/setup/channels ───
    {
      operationId: "setup.channels.save",
      method: "POST",
      path: "/v1/setup/channels",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx): Promise<SetupChannelsResponse> {
        const body = ctx.body as SetupChannelsRequest | null;
        if (!body || typeof body !== "object" || !Array.isArray(body.channels)) {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body must contain a channels array", { httpStatus: 400 });
        }

        const channelSlotCounter = new Map<FridaySupportedChannelKind, number>();

        const nextChannelSlot = (kind: FridaySupportedChannelKind): number => {
          const current = channelSlotCounter.get(kind) ?? 0;
          channelSlotCounter.set(kind, current + 1);
          return current;
        };

        const secretWrites: Array<{ refKey: string; plaintext: string }> = [];
        const persistedChannels: SetupChannelsRequest["channels"] = [];

        // Validate and normalize each channel entry
        const enabledInstances: Array<Record<string, unknown>> = [];
        for (const ch of body.channels) {
          if (!ch || typeof ch !== "object") {
            throw new FridayDomainError("VALIDATION_ERROR", "Each channel must be an object", { httpStatus: 400 });
          }
          if (typeof ch.kind !== "string" || !VALID_CHANNEL_KINDS.has(ch.kind)) {
            throw new FridayDomainError("VALIDATION_ERROR", `Invalid channel kind: ${String(ch.kind)}`, { httpStatus: 400 });
          }
          if (typeof ch.enabled !== "boolean") {
            throw new FridayDomainError("VALIDATION_ERROR", `enabled must be a boolean for channel ${ch.kind}`, { httpStatus: 400 });
          }
          if (ch.config !== null && ch.config !== undefined && (typeof ch.config !== "object" || Array.isArray(ch.config))) {
            throw new FridayDomainError("VALIDATION_ERROR", `config must be an object for channel ${ch.kind}`, { httpStatus: 400 });
          }

          const kind = ch.kind as FridaySupportedChannelKind;
          const slot = nextChannelSlot(kind);
          const config = { ...(ch.config ?? {}) } as Record<string, unknown>;
          const secretFields = getFridayChannelSecretFieldDescriptors(kind, config);

          for (const field of secretFields) {
            const rawValue = config[field.field];
            const value = typeof rawValue === "string" ? rawValue.trim() : "";

            if (value.length === 0) {
              if (ch.enabled && field.required) {
                const reasonSuffix = field.reason ? ` (${field.reason})` : "";
                throw new FridayDomainError(
                  "VALIDATION_ERROR",
                  `Missing required secret field "${field.field}" for channel ${kind}${reasonSuffix}`,
                  { httpStatus: 400 },
                );
              }
              continue;
            }

            const parsedSecret = parseFridaySecretInput(value, {
              secretRefPrefixes: ["secret://channel/", "secret://"],
            });
            if (parsedSecret.kind !== "inline") {
              config[field.field] = value;
              continue;
            }

            const refKey = buildFridayChannelSecretRefKey(kind, slot, field.field);
            secretWrites.push({ refKey, plaintext: value });
            config[field.field] = buildFridayChannelSecretRef(refKey);
          }

          persistedChannels.push({
            kind,
            enabled: ch.enabled,
            config,
          });

          if (ch.enabled) {
            enabledInstances.push({
              kind,
              enabled: true,
              ...config,
            });
          }
        }

        if (enabledInstances.length > 0) {
          try {
            parseFridayChannelsConfig({
              enabled: true,
              instances: enabledInstances,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              `Invalid enabled channel config: ${message}`,
              { httpStatus: 400 },
            );
          }
        }

        if (secretWrites.length > 0) {
          const masterKey = getMasterKey();
          const now = deps.nowIso();
          deps.db.withWriteTransaction((db) => {
            for (const write of secretWrites) {
              const envelope = encryptSecret(write.plaintext, masterKey);
              channelSecretRepository.upsert(db, {
                id: `channel-secret:${write.refKey}`,
                scope: FRIDAY_CHANNEL_SECRET_SCOPE,
                refKey: write.refKey,
                encryptedValue: JSON.stringify(envelope),
                keyId: "master-v1",
                nowIso: now,
              });
            }
          });
        }

        const now = deps.nowIso();
        const channelsJson = JSON.stringify(persistedChannels);

        deps.db.withWriteTransaction((db) => {
          db.prepare(
            `INSERT OR IGNORE INTO friday_setup_state (id, created_at, updated_at)
             VALUES ('singleton', ?, ?)`,
          ).run(now, now);
          db.prepare(
            `UPDATE friday_setup_state SET channels_json = ?, updated_at = ? WHERE id = 'singleton'`,
          ).run(channelsJson, now);
        });

        const savedKinds = persistedChannels
          .filter((ch) => ch.enabled)
          .map((ch) => ch.kind);

        return { savedKinds };
      },
    },

    // ─── POST /v1/setup/complete ───
    {
      operationId: "setup.complete",
      method: "POST",
      path: "/v1/setup/complete",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx): Promise<SetupCompleteResponse> {
        const body = ctx.body as SetupCompleteRequest | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
        }

        const completedSteps = Array.isArray(body.completedSteps) ? body.completedSteps : [];
        const skippedSteps = Array.isArray(body.skippedSteps) ? body.skippedSteps : [];

        // Validate that all step IDs are known
        for (const step of completedSteps) {
          if (typeof step !== "string" || !VALID_STEP_IDS.has(step)) {
            throw new FridayDomainError("VALIDATION_ERROR", `Unknown step ID in completedSteps: ${String(step)}`, { httpStatus: 400 });
          }
        }
        for (const step of skippedSteps) {
          if (typeof step !== "string" || !VALID_STEP_IDS.has(step)) {
            throw new FridayDomainError("VALIDATION_ERROR", `Unknown step ID in skippedSteps: ${String(step)}`, { httpStatus: 400 });
          }
        }

        // "done" must always be persisted as the completion sentinel.
        const normalizedCompletedSteps = Array.from(
          new Set([...completedSteps, "done"]),
        );

        const now = deps.nowIso();

        deps.db.withWriteTransaction((db) => {
          db.prepare(
            `INSERT OR IGNORE INTO friday_setup_state (id, created_at, updated_at)
             VALUES ('singleton', ?, ?)`,
          ).run(now, now);
          db.prepare(
            `UPDATE friday_setup_state
             SET setup_completed_at = ?, completed_steps = ?, skipped_steps = ?, updated_at = ?
             WHERE id = 'singleton'`,
          ).run(now, JSON.stringify(normalizedCompletedSteps), JSON.stringify(skippedSteps), now);
        });

        return { setupCompletedAt: now };
      },
    },
  ];
}
