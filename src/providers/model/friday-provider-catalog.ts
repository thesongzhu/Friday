import type {
  FridayProviderApi,
  FridayProviderAuthMode,
  FridayProviderBackendKind,
  FridayProviderDeploymentKind,
  FridayProviderKind,
  FridayProviderRegionTag,
} from "./friday-provider.types.js";
import { FRIDAY_PROVIDER_KINDS } from "./friday-provider.types.js";

export interface FridayProviderPreset {
  kind: FridayProviderKind;
  api: FridayProviderApi;
  authMode: FridayProviderAuthMode;
  backendKind: FridayProviderBackendKind;
  deploymentKind: FridayProviderDeploymentKind;
  regionTag: FridayProviderRegionTag;
  /**
   * Optional base URL default. Empty means caller must provide one.
   */
  baseUrl: string;
}

function hostedPreset(
  kind: FridayProviderKind,
  api: FridayProviderApi,
  authMode: FridayProviderAuthMode,
  baseUrl: string,
  regionTag: FridayProviderRegionTag = "global",
): FridayProviderPreset {
  return {
    kind,
    api,
    authMode,
    backendKind: "http",
    deploymentKind: "hosted",
    regionTag,
    baseUrl,
  };
}

function selfHostedPreset(
  kind: FridayProviderKind,
  api: FridayProviderApi,
  authMode: FridayProviderAuthMode,
  baseUrl: string,
  regionTag: FridayProviderRegionTag = "custom",
): FridayProviderPreset {
  return {
    kind,
    api,
    authMode,
    backendKind: "http",
    deploymentKind: "self-hosted",
    regionTag,
    baseUrl,
  };
}

function localPreset(
  kind: FridayProviderKind,
  api: FridayProviderApi,
  authMode: FridayProviderAuthMode,
  baseUrl: string,
): FridayProviderPreset {
  return {
    kind,
    api,
    authMode,
    backendKind: "http",
    deploymentKind: "local",
    regionTag: "local",
    baseUrl,
  };
}

export const FRIDAY_PROVIDER_PRESETS: Record<FridayProviderKind, FridayProviderPreset> = {
  openai: hostedPreset("openai", "openai-responses", "bearer-token", "https://api.openai.com"),
  "openai-codex": hostedPreset("openai-codex", "openai-responses", "bearer-token", "https://api.openai.com"),
  anthropic: hostedPreset("anthropic", "anthropic-messages", "api-key", "https://api.anthropic.com"),
  google: hostedPreset("google", "google-generative-ai", "api-key", "https://generativelanguage.googleapis.com"),
  "google-vertex": hostedPreset("google-vertex", "google-generative-ai", "api-key", ""),
  "google-antigravity": hostedPreset("google-antigravity", "google-generative-ai", "api-key", ""),
  openrouter: hostedPreset("openrouter", "openai-responses", "bearer-token", "https://openrouter.ai/api"),
  xai: hostedPreset("xai", "openai-responses", "bearer-token", "https://api.x.ai", "us"),
  mistral: hostedPreset("mistral", "openai-responses", "bearer-token", "https://api.mistral.ai"),
  groq: hostedPreset("groq", "openai-responses", "bearer-token", "https://api.groq.com/openai", "us"),
  cerebras: hostedPreset("cerebras", "openai-responses", "bearer-token", "https://api.cerebras.ai", "us"),
  "github-copilot": hostedPreset("github-copilot", "openai-responses", "bearer-token", ""),
  huggingface: hostedPreset("huggingface", "openai-responses", "bearer-token", "https://router.huggingface.co"),
  opencode: hostedPreset("opencode", "openai-responses", "bearer-token", ""),
  "vercel-ai-gateway": hostedPreset("vercel-ai-gateway", "openai-responses", "bearer-token", "https://ai-gateway.vercel.sh"),
  kilocode: hostedPreset("kilocode", "openai-responses", "bearer-token", "https://api.kilo.ai/api/gateway"),
  moonshot: hostedPreset("moonshot", "openai-responses", "bearer-token", "https://api.moonshot.ai", "china"),
  "kimi-coding": hostedPreset("kimi-coding", "anthropic-messages", "api-key", "https://api.moonshot.ai/anthropic", "china"),
  qwen: hostedPreset("qwen", "openai-responses", "bearer-token", "https://dashscope.aliyuncs.com/compatible-mode", "china"),
  "qwen-portal": hostedPreset("qwen-portal", "openai-responses", "bearer-token", "", "china"),
  volcengine: hostedPreset("volcengine", "openai-responses", "bearer-token", "", "china"),
  byteplus: hostedPreset("byteplus", "openai-responses", "bearer-token", "", "china"),
  synthetic: hostedPreset("synthetic", "anthropic-messages", "api-key", "https://api.synthetic.new/anthropic"),
  minimax: hostedPreset("minimax", "openai-responses", "bearer-token", "https://api.minimaxi.com", "china"),
  ollama: localPreset("ollama", "ollama", "none", "http://localhost:11434"),
  vllm: selfHostedPreset("vllm", "openai-responses", "bearer-token", "http://127.0.0.1:8000", "local"),
  litellm: selfHostedPreset("litellm", "openai-responses", "bearer-token", "http://127.0.0.1:4000", "local"),
  together: hostedPreset("together", "openai-responses", "bearer-token", "https://api.together.xyz"),
  nvidia: hostedPreset("nvidia", "openai-responses", "bearer-token", "https://integrate.api.nvidia.com"),
  qianfan: hostedPreset("qianfan", "openai-responses", "bearer-token", "", "china"),
  venice: hostedPreset("venice", "openai-responses", "bearer-token", "https://api.venice.ai"),
  xiaomi: hostedPreset("xiaomi", "openai-responses", "bearer-token", "", "china"),
  zai: hostedPreset("zai", "openai-responses", "bearer-token", "https://api.z.ai", "china"),
  glm: hostedPreset("glm", "openai-responses", "bearer-token", "https://open.bigmodel.cn/api/paas/v4", "china"),
  deepseek: hostedPreset("deepseek", "openai-responses", "bearer-token", "https://api.deepseek.com", "china"),
  bedrock: hostedPreset("bedrock", "openai-responses", "bearer-token", ""),
  "cloudflare-ai-gateway": hostedPreset("cloudflare-ai-gateway", "openai-responses", "bearer-token", ""),
  "openai-compatible": selfHostedPreset("openai-compatible", "openai-responses", "bearer-token", "", "custom"),
};

export const FRIDAY_PROVIDER_KIND_SET = new Set<string>(FRIDAY_PROVIDER_KINDS);

export function isFridayProviderKind(value: string): value is FridayProviderKind {
  return FRIDAY_PROVIDER_KIND_SET.has(value);
}

export function getFridayProviderPreset(
  kind: FridayProviderKind,
  baseUrlOverride?: string,
): {
  baseUrl: string;
  api: FridayProviderApi;
  authMode: FridayProviderAuthMode;
  backendKind: FridayProviderBackendKind;
  deploymentKind: FridayProviderDeploymentKind;
  regionTag: FridayProviderRegionTag;
} {
  const preset = FRIDAY_PROVIDER_PRESETS[kind];
  return {
    baseUrl: baseUrlOverride ?? preset.baseUrl,
    api: preset.api,
    authMode: preset.authMode,
    backendKind: preset.backendKind,
    deploymentKind: preset.deploymentKind,
    regionTag: preset.regionTag,
  };
}

export function detectFridayProviderKindFromApiKey(apiKey: string): {
  kind: FridayProviderKind;
  confidence: "high" | "medium";
} {
  const key = apiKey.trim();
  const lower = key.toLowerCase();

  if (key.startsWith("sk-ant-")) {
    return { kind: "anthropic", confidence: "high" };
  }
  if (key.startsWith("sk-or-")) {
    return { kind: "openrouter", confidence: "high" };
  }
  if (lower.startsWith("gsk_")) {
    return { kind: "groq", confidence: "high" };
  }
  if (lower.startsWith("xai-")) {
    return { kind: "xai", confidence: "high" };
  }
  if (lower.startsWith("hf_")) {
    return { kind: "huggingface", confidence: "high" };
  }
  if (lower.startsWith("mistral-")) {
    return { kind: "mistral", confidence: "high" };
  }
  if (key.startsWith("sk-")) {
    return { kind: "openai", confidence: "high" };
  }
  if (/^AI[a-zA-Z]/.test(key)) {
    return { kind: "google", confidence: "medium" };
  }

  // ── Chinese providers ──
  if (lower.startsWith("sk-") && key.length >= 40 && key.length <= 50) {
    // DeepSeek keys are sk-xxx with 48 chars; OpenAI sk-proj-xxx is longer
    // If not caught by OpenAI above, likely DeepSeek or Moonshot
    return { kind: "deepseek", confidence: "medium" };
  }
  if (/^[a-f0-9]{32}$/.test(key)) {
    // 32-char hex — common for Zhipu GLM API keys
    return { kind: "glm", confidence: "medium" };
  }
  if (key.includes(".") && key.split(".").length === 3) {
    // JWT-like format (xxx.xxx.xxx) — common for Zhipu and some Chinese providers
    return { kind: "glm", confidence: "medium" };
  }

  return { kind: "openai-compatible", confidence: "medium" };
}
