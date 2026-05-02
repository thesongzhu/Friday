import type {
  FridayProviderApi,
  FridayProviderAuthMode,
  FridayProviderBackendKind,
  FridayProviderCliBackendId,
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
  supportedBackendKinds: readonly FridayProviderBackendKind[];
  supportedAuthModesByBackend: Readonly<Record<FridayProviderBackendKind, readonly FridayProviderAuthMode[]>>;
  defaultCliBackendId?: FridayProviderCliBackendId;
  /**
   * True when operator must provide an explicit baseUrl (no stable default).
   */
  requiresBaseUrl: boolean;
}

const OPENAI_APIS: readonly FridayProviderApi[] = ["openai-completions", "openai-responses"];
const OPENAI_CODEX_APIS: readonly FridayProviderApi[] = ["openai-codex-responses"];
const ANTHROPIC_APIS: readonly FridayProviderApi[] = ["anthropic-messages"];
const GOOGLE_APIS: readonly FridayProviderApi[] = ["google-generative-ai"];
const OLLAMA_APIS: readonly FridayProviderApi[] = ["ollama"];

const OPENAI_CLOUD_AUTH: readonly FridayProviderAuthMode[] = ["api-key", "bearer-token"];
const OPENAI_CODEX_HTTP_AUTH: readonly FridayProviderAuthMode[] = ["oauth", "bearer-token"];
const OPENAI_PROXY_AUTH: readonly FridayProviderAuthMode[] = ["api-key", "bearer-token", "none"];
const ANTHROPIC_AUTH: readonly FridayProviderAuthMode[] = ["api-key", "oauth", "token"];
const GOOGLE_AUTH: readonly FridayProviderAuthMode[] = ["api-key"];
const LOCAL_AUTH: readonly FridayProviderAuthMode[] = ["none", "api-key", "bearer-token"];
const CLI_EXTERNAL_SESSION_AUTH: readonly FridayProviderAuthMode[] = ["external-session"];
const SDK_EXTERNAL_SESSION_AUTH: readonly FridayProviderAuthMode[] = ["external-session"];

export const FRIDAY_PROVIDER_CAPABILITIES: Record<FridayProviderKind, FridayProviderCapability> = {
  openai: capability("openai", "openai-compatible", OPENAI_APIS, {
    http: OPENAI_CLOUD_AUTH,
    cli: CLI_EXTERNAL_SESSION_AUTH,
    sdk: [],
  }, { defaultCliBackendId: "codex-cli" }),
  "openai-codex": capability("openai-codex", "openai-compatible", OPENAI_CODEX_APIS, {
    http: OPENAI_CODEX_HTTP_AUTH,
    cli: CLI_EXTERNAL_SESSION_AUTH,
    sdk: SDK_EXTERNAL_SESSION_AUTH,
  }, { defaultCliBackendId: "codex-cli" }),
  anthropic: capability("anthropic", "anthropic-compatible", ANTHROPIC_APIS, {
    http: ANTHROPIC_AUTH,
    cli: CLI_EXTERNAL_SESSION_AUTH,
    sdk: [],
  }, { defaultCliBackendId: "claude-cli" }),
  google: capability("google", "google-compatible", GOOGLE_APIS, {
    http: ["api-key"],
    cli: [],
    sdk: [],
  }),
  "google-vertex": capability("google-vertex", "google-compatible", GOOGLE_APIS, { http: GOOGLE_AUTH, cli: [], sdk: [] }),
  "google-antigravity": capability("google-antigravity", "google-compatible", GOOGLE_APIS, { http: GOOGLE_AUTH, cli: [], sdk: [] }),
  openrouter: capability("openrouter", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  xai: capability("xai", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  mistral: capability("mistral", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  groq: capability("groq", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  cerebras: capability("cerebras", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  "github-copilot": capability("github-copilot", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  huggingface: capability("huggingface", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  opencode: capability("opencode", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  "vercel-ai-gateway": capability("vercel-ai-gateway", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  kilocode: capability("kilocode", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  moonshot: capability("moonshot", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  "kimi-coding": capability("kimi-coding", "anthropic-compatible", ANTHROPIC_APIS, { http: ["api-key"], cli: [], sdk: [] }),
  qwen: capability("qwen", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  "qwen-portal": capability("qwen-portal", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  volcengine: capability("volcengine", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  byteplus: capability("byteplus", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  synthetic: capability("synthetic", "anthropic-compatible", ANTHROPIC_APIS, { http: ["api-key"], cli: [], sdk: [] }),
  minimax: capability("minimax", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  ollama: capability("ollama", "local-runtime", OLLAMA_APIS, { http: LOCAL_AUTH, cli: [], sdk: [] }),
  vllm: capability("vllm", "openai-compatible", OPENAI_APIS, { http: LOCAL_AUTH, cli: [], sdk: [] }),
  litellm: capability("litellm", "openai-compatible", OPENAI_APIS, { http: LOCAL_AUTH, cli: [], sdk: [] }),
  together: capability("together", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  nvidia: capability("nvidia", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  qianfan: capability("qianfan", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  venice: capability("venice", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  xiaomi: capability("xiaomi", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  zai: capability("zai", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  glm: capability("glm", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  deepseek: capability("deepseek", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  bedrock: capability("bedrock", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  "cloudflare-ai-gateway": capability("cloudflare-ai-gateway", "openai-compatible", OPENAI_APIS, { http: OPENAI_CLOUD_AUTH, cli: [], sdk: [] }),
  "openai-compatible": capability("openai-compatible", "openai-compatible", OPENAI_APIS, { http: OPENAI_PROXY_AUTH, cli: [], sdk: [] }),
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

export function isFridayProviderBackendKindSupportedForKind(
  kind: FridayProviderKind,
  backendKind: FridayProviderBackendKind,
): boolean {
  return FRIDAY_PROVIDER_CAPABILITIES[kind].supportedBackendKinds.includes(backendKind);
}

export function isFridayProviderAuthModeSupportedForKind(
  kind: FridayProviderKind,
  authMode: FridayProviderAuthMode,
): boolean {
  const capability = FRIDAY_PROVIDER_CAPABILITIES[kind];
  return capability.supportedBackendKinds.some((backendKind) =>
    capability.supportedAuthModesByBackend[backendKind]?.includes(authMode),
  );
}

export function isFridayProviderAuthModeSupportedForKindAndBackend(
  kind: FridayProviderKind,
  backendKind: FridayProviderBackendKind,
  authMode: FridayProviderAuthMode,
): boolean {
  const modes = FRIDAY_PROVIDER_CAPABILITIES[kind].supportedAuthModesByBackend[backendKind] ?? [];
  return modes.includes(authMode);
}

export function getFridayProviderAuthModesForBackend(
  kind: FridayProviderKind,
  backendKind: FridayProviderBackendKind,
): readonly FridayProviderAuthMode[] {
  return FRIDAY_PROVIDER_CAPABILITIES[kind].supportedAuthModesByBackend[backendKind] ?? [];
}

function capability(
  kind: FridayProviderKind,
  family: FridayProviderFamily,
  supportedApis: readonly FridayProviderApi[],
  supportedAuthModesByBackend: Partial<Record<FridayProviderBackendKind, readonly FridayProviderAuthMode[]>>,
  options?: {
    defaultCliBackendId?: FridayProviderCliBackendId;
  },
): FridayProviderCapability {
  const preset = FRIDAY_PROVIDER_PRESETS[kind];
  const normalizedByBackend: Readonly<Record<FridayProviderBackendKind, readonly FridayProviderAuthMode[]>> = {
    http: supportedAuthModesByBackend.http ?? [],
    cli: supportedAuthModesByBackend.cli ?? [],
    sdk: supportedAuthModesByBackend.sdk ?? [],
  };
  const supportedBackendKinds = (Object.entries(normalizedByBackend) as Array<[FridayProviderBackendKind, readonly FridayProviderAuthMode[]]>)
    .filter(([, modes]) => modes.length > 0)
    .map(([backendKind]) => backendKind);
  return {
    kind,
    family,
    supportedApis,
    supportedBackendKinds,
    supportedAuthModesByBackend: normalizedByBackend,
    defaultCliBackendId: options?.defaultCliBackendId,
    requiresBaseUrl: preset.baseUrl.trim() === "",
  };
}

// Compile-time exhaustiveness guard for capabilities map.
const _providerKindCoverage: readonly FridayProviderKind[] = FRIDAY_PROVIDER_KINDS;
void _providerKindCoverage;
