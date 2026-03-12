import type {
  FridayProviderApi,
  FridayProviderAuthMode,
  FridayProviderKind,
} from "./friday-provider.types.js";
import { FRIDAY_PROVIDER_KINDS } from "./friday-provider.types.js";
import { FRIDAY_PROVIDER_PRESETS } from "./friday-provider-catalog.js";

export type FridayProviderFamily =
  | "openai-compatible"
  | "anthropic-compatible"
  | "google-compatible"
  | "local-runtime";

export interface FridayProviderCapability {
  kind: FridayProviderKind;
  family: FridayProviderFamily;
  supportedApis: readonly FridayProviderApi[];
  supportedAuthModes: readonly FridayProviderAuthMode[];
  /**
   * True when operator must provide an explicit baseUrl (no stable default).
   */
  requiresBaseUrl: boolean;
}

const OPENAI_APIS: readonly FridayProviderApi[] = ["openai-completions", "openai-responses"];
const ANTHROPIC_APIS: readonly FridayProviderApi[] = ["anthropic-messages"];
const GOOGLE_APIS: readonly FridayProviderApi[] = ["google-generative-ai"];
const OLLAMA_APIS: readonly FridayProviderApi[] = ["ollama"];

const OPENAI_CLOUD_AUTH: readonly FridayProviderAuthMode[] = ["api-key", "bearer-token"];
const OPENAI_PROXY_AUTH: readonly FridayProviderAuthMode[] = ["api-key", "bearer-token", "none"];
const ANTHROPIC_AUTH: readonly FridayProviderAuthMode[] = ["api-key", "oauth"];
const GOOGLE_AUTH: readonly FridayProviderAuthMode[] = ["api-key"];
const LOCAL_AUTH: readonly FridayProviderAuthMode[] = ["none", "api-key", "bearer-token"];

export const FRIDAY_PROVIDER_CAPABILITIES: Record<FridayProviderKind, FridayProviderCapability> = {
  openai: capability("openai", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  "openai-codex": capability("openai-codex", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  anthropic: capability("anthropic", "anthropic-compatible", ANTHROPIC_APIS, ANTHROPIC_AUTH),
  google: capability("google", "google-compatible", GOOGLE_APIS, ["api-key"]),
  "google-vertex": capability("google-vertex", "google-compatible", GOOGLE_APIS, GOOGLE_AUTH),
  "google-antigravity": capability("google-antigravity", "google-compatible", GOOGLE_APIS, GOOGLE_AUTH),
  "google-gemini-cli": capability("google-gemini-cli", "google-compatible", GOOGLE_APIS, GOOGLE_AUTH),
  openrouter: capability("openrouter", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  xai: capability("xai", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  mistral: capability("mistral", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  groq: capability("groq", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  cerebras: capability("cerebras", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  "github-copilot": capability("github-copilot", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  huggingface: capability("huggingface", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  opencode: capability("opencode", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  "vercel-ai-gateway": capability("vercel-ai-gateway", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  kilocode: capability("kilocode", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  moonshot: capability("moonshot", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  "kimi-coding": capability("kimi-coding", "anthropic-compatible", ANTHROPIC_APIS, ["api-key"]),
  qwen: capability("qwen", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  "qwen-portal": capability("qwen-portal", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  volcengine: capability("volcengine", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  byteplus: capability("byteplus", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  synthetic: capability("synthetic", "anthropic-compatible", ANTHROPIC_APIS, ["api-key"]),
  minimax: capability("minimax", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  ollama: capability("ollama", "local-runtime", OLLAMA_APIS, LOCAL_AUTH),
  vllm: capability("vllm", "openai-compatible", OPENAI_APIS, LOCAL_AUTH),
  litellm: capability("litellm", "openai-compatible", OPENAI_APIS, LOCAL_AUTH),
  together: capability("together", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  nvidia: capability("nvidia", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  qianfan: capability("qianfan", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  venice: capability("venice", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  xiaomi: capability("xiaomi", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  zai: capability("zai", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  glm: capability("glm", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  bedrock: capability("bedrock", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  "cloudflare-ai-gateway": capability("cloudflare-ai-gateway", "openai-compatible", OPENAI_APIS, OPENAI_CLOUD_AUTH),
  "openai-compatible": capability("openai-compatible", "openai-compatible", OPENAI_APIS, OPENAI_PROXY_AUTH),
};

export const FRIDAY_PROVIDER_FAMILIES: readonly FridayProviderFamily[] = [
  "openai-compatible",
  "anthropic-compatible",
  "google-compatible",
  "local-runtime",
] as const;

export function getFridayProviderCapability(kind: FridayProviderKind): FridayProviderCapability {
  return FRIDAY_PROVIDER_CAPABILITIES[kind];
}

export function isFridayProviderApiSupportedForKind(
  kind: FridayProviderKind,
  api: FridayProviderApi,
): boolean {
  return FRIDAY_PROVIDER_CAPABILITIES[kind].supportedApis.includes(api);
}

export function isFridayProviderAuthModeSupportedForKind(
  kind: FridayProviderKind,
  authMode: FridayProviderAuthMode,
): boolean {
  return FRIDAY_PROVIDER_CAPABILITIES[kind].supportedAuthModes.includes(authMode);
}

function capability(
  kind: FridayProviderKind,
  family: FridayProviderFamily,
  supportedApis: readonly FridayProviderApi[],
  supportedAuthModes: readonly FridayProviderAuthMode[],
): FridayProviderCapability {
  const preset = FRIDAY_PROVIDER_PRESETS[kind];
  return {
    kind,
    family,
    supportedApis,
    supportedAuthModes,
    requiresBaseUrl: preset.baseUrl.trim() === "",
  };
}

// Compile-time exhaustiveness guard for capabilities map.
const _providerKindCoverage: readonly FridayProviderKind[] = FRIDAY_PROVIDER_KINDS;
void _providerKindCoverage;
