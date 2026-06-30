import { FridayDomainError } from "#errors";
import type { FridayProviderApi, FridayProviderKind, FridayProviderProfile } from "../model/friday-provider.types.js";
import { FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE } from "../oauth/friday-anthropic-oauth.js";
import type { FridayProviderService } from "./friday-provider-service.types.js";

const DEFAULT_OAUTH_PROVIDER_KIND: FridayProviderKind = "openai-codex";
const SUPPORTED_OAUTH_PROVIDER_KINDS = new Set<FridayProviderKind>([
  "openai-codex",
]);

export interface FridayOAuthProviderSelectionInput {
  providerId?: string;
  kind?: FridayProviderKind;
  name?: string;
  baseUrl?: string;
  api?: FridayProviderApi;
  supportedModels?: string[];
  defaultModel?: string;
  enabled?: boolean;
}

export type FridayOAuthProviderSelectionResolution =
  | "explicit"
  | "reused-existing"
  | "reused-by-name"
  | "reused-by-default-model"
  | "reused-routing-default"
  | "reused-enabled"
  | "auto-created";

export interface FridayResolvedOAuthProviderSelection {
  provider: FridayProviderProfile;
  resolution: FridayOAuthProviderSelectionResolution;
}

export async function resolveOrProvisionOAuthProvider(
  providerService: FridayProviderService,
  input: FridayOAuthProviderSelectionInput,
): Promise<FridayResolvedOAuthProviderSelection> {
  if (input.providerId) {
    const provider = await requireProviderById(providerService, input.providerId, "oauth_init");
    assertOAuthReadyProvider(provider, "oauth_init");
    return { provider, resolution: "explicit" };
  }

  const kind = readOAuthProviderKind(input.kind);
  const existing = await selectReusableOAuthProvider(providerService, input, kind);
  if (existing) {
    return existing;
  }

  const supportedModels = input.supportedModels && input.supportedModels.length > 0
    ? input.supportedModels
    : getDefaultModels(kind);
  const defaultModel = input.defaultModel ?? supportedModels[0];
  const provider = await providerService.createProvider({
    kind,
    name: input.name ?? getDefaultOAuthProviderName(kind),
    baseUrl: input.baseUrl ?? getDefaultBaseUrl(kind),
    authMode: "oauth",
    api: input.api ?? getDefaultApi(kind),
    supportedModels,
    defaultModel,
    enabled: input.enabled ?? true,
    validateOnSave: false,
  });

  return { provider, resolution: "auto-created" };
}

export async function resolveExistingOAuthProvider(
  providerService: FridayProviderService,
  input: FridayOAuthProviderSelectionInput,
  actionLabel: "oauth_complete",
): Promise<FridayResolvedOAuthProviderSelection> {
  if (input.providerId) {
    const provider = await requireProviderById(providerService, input.providerId, actionLabel);
    assertOAuthReadyProvider(provider, actionLabel);
    return { provider, resolution: "explicit" };
  }

  const kind = readOAuthProviderKind(input.kind);
  const existing = await selectReusableOAuthProvider(providerService, input, kind);
  if (!existing) {
    throw new FridayDomainError("VALIDATION_ERROR",
      `No ${kind} OAuth provider is configured yet. Run oauth_init first or specify providerId.`,
      { httpStatus: 400 },
    );
  }

  return existing;
}

async function selectReusableOAuthProvider(
  providerService: FridayProviderService,
  input: FridayOAuthProviderSelectionInput,
  kind: FridayProviderKind,
): Promise<FridayResolvedOAuthProviderSelection | null> {
  const candidates = (await providerService.listProviders()).filter((provider) =>
    provider.kind === kind && provider.config.authMode === "oauth"
  );

  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return { provider: candidates[0]!, resolution: "reused-existing" };
  }

  if (input.name) {
    const namedMatches = candidates.filter((provider) =>
      provider.name.localeCompare(input.name!, undefined, { sensitivity: "accent" }) === 0
    );
    if (namedMatches.length === 1) {
      return { provider: namedMatches[0]!, resolution: "reused-by-name" };
    }
    if (namedMatches.length > 1) {
      throw new FridayDomainError("VALIDATION_ERROR",
        `Multiple ${kind} OAuth providers match name "${input.name}". Specify providerId.`,
        { httpStatus: 400 },
      );
    }
  }

  if (input.defaultModel) {
    const modelMatches = candidates.filter((provider) =>
      provider.defaultModel === input.defaultModel
    );
    if (modelMatches.length === 1) {
      return { provider: modelMatches[0]!, resolution: "reused-by-default-model" };
    }
    if (modelMatches.length > 1) {
      throw new FridayDomainError("VALIDATION_ERROR",
        `Multiple ${kind} OAuth providers use default model "${input.defaultModel}". Specify providerId.`,
        { httpStatus: 400 },
      );
    }
  }

  const routing = await safeGetRoutingConfig(providerService);
  if (routing?.defaultProviderId) {
    const routed = candidates.find((provider) => provider.id === routing.defaultProviderId);
    if (routed) {
      return { provider: routed, resolution: "reused-routing-default" };
    }
  }

  const enabledCandidates = candidates.filter((provider) => provider.enabled);
  if (enabledCandidates.length === 1) {
    return { provider: enabledCandidates[0]!, resolution: "reused-enabled" };
  }

  throw new FridayDomainError("VALIDATION_ERROR",
    `Multiple ${kind} OAuth providers are available. Specify providerId. Candidates: ${candidates.map(formatProviderCandidate).join("; ")}`,
    { httpStatus: 400 },
  );
}

async function requireProviderById(
  providerService: FridayProviderService,
  providerId: string,
  actionLabel: string,
): Promise<FridayProviderProfile> {
  const provider = await providerService.getProvider(providerId);
  if (!provider) {
    throw new FridayDomainError("NOT_FOUND", `Provider "${providerId}" not found for ${actionLabel}.`, { httpStatus: 404 });
  }
  return provider;
}

function assertOAuthReadyProvider(
  provider: FridayProviderProfile,
  actionLabel: string,
): void {
  if (provider.config.authMode !== "oauth") {
    throw new FridayDomainError("VALIDATION_ERROR",
      `Provider "${provider.id}" uses ${provider.config.authMode} auth, not oauth, so ${actionLabel} cannot use it.`,
      { httpStatus: 400 },
    );
  }
  if (provider.kind === "anthropic") {
    throw new FridayDomainError("UNSUPPORTED_OPERATION", FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE, { httpStatus: 400 });
  }
  if (!SUPPORTED_OAUTH_PROVIDER_KINDS.has(provider.kind)) {
    throw new FridayDomainError("UNSUPPORTED_OPERATION",
      `OAuth automation currently supports ${[...SUPPORTED_OAUTH_PROVIDER_KINDS].join(", ")} providers only. Provider "${provider.id}" is kind "${provider.kind}".`,
      { httpStatus: 400 },
    );
  }
}

function readOAuthProviderKind(kind: FridayProviderKind | undefined): FridayProviderKind {
  const resolved = kind ?? DEFAULT_OAUTH_PROVIDER_KIND;
  if (resolved === "anthropic") {
    throw new FridayDomainError("UNSUPPORTED_OPERATION", FRIDAY_ANTHROPIC_OAUTH_DISABLED_MESSAGE, { httpStatus: 400 });
  }
  if (!SUPPORTED_OAUTH_PROVIDER_KINDS.has(resolved)) {
    throw new FridayDomainError("UNSUPPORTED_OPERATION",
      `OAuth automation currently supports ${[...SUPPORTED_OAUTH_PROVIDER_KINDS].join(", ")} providers only.`,
      { httpStatus: 400 },
    );
  }
  return resolved;
}

async function safeGetRoutingConfig(
  providerService: FridayProviderService,
): Promise<{ defaultProviderId: string } | null> {
  try {
    return await providerService.getRoutingConfig();
  } catch (err) {
    console.warn("[friday][provider-oauth-selection] routing config fetch failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function formatProviderCandidate(provider: FridayProviderProfile): string {
  return `${provider.id} (${provider.name}${provider.defaultModel ? `, defaultModel=${provider.defaultModel}` : ""})`;
}

function getDefaultOAuthProviderName(kind: FridayProviderKind): string {
  switch (kind) {
    case "openai-codex":
      return "OpenAI Codex OAuth";
    case "anthropic":
      return "Claude OAuth";
    default:
      return `${kind} OAuth`;
  }
}

function getDefaultBaseUrl(kind: FridayProviderKind): string {
  switch (kind) {
    case "openai-codex":
      return "https://chatgpt.com/backend-api/codex";
    case "openai":
      return "https://api.openai.com";
    case "anthropic":
      return "https://api.anthropic.com";
    case "google":
      return "https://generativelanguage.googleapis.com";
    case "ollama":
      return "http://localhost:11434";
    default:
      return "";
  }
}

function getDefaultApi(kind: FridayProviderKind): FridayProviderApi {
  switch (kind) {
    case "openai-codex":
      return "openai-codex-responses";
    case "openai":
    case "openai-compatible":
      return "openai-completions";
    case "anthropic":
      return "anthropic-messages";
    case "google":
      return "google-generative-ai";
    case "ollama":
      return "ollama";
    default:
      return "openai-completions";
  }
}

function getDefaultModels(kind: FridayProviderKind): string[] {
  switch (kind) {
    case "openai-codex":
      return ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"];
    case "openai":
      return ["gpt-4o", "gpt-4o-mini", "gpt-4.1"];
    case "anthropic":
      return ["claude-sonnet-4-6", "claude-opus-4-8"];
    case "google":
      return ["gemini-2.0-flash", "gemini-1.5-pro"];
    case "ollama":
      return ["llama3.2:3b", "qwen2.5-coder:7b"];
    default:
      return [];
  }
}
