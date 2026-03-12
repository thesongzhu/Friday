import type {
  FridayProviderApi,
  FridayProviderAuthMode,
  FridayProviderKind,
} from "./friday-provider.types.js";
import { FRIDAY_PROVIDER_KINDS } from "./friday-provider.types.js";

export interface FridayProviderPreset {
  kind: FridayProviderKind;
  api: FridayProviderApi;
  authMode: FridayProviderAuthMode;
  /**
   * Optional base URL default. Empty means caller must provide one.
   */
  baseUrl: string;
}

export const FRIDAY_PROVIDER_PRESETS: Record<FridayProviderKind, FridayProviderPreset> = {
  openai: {
    kind: "openai",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.openai.com",
  },
  "openai-codex": {
    kind: "openai-codex",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.openai.com",
  },
  anthropic: {
    kind: "anthropic",
    api: "anthropic-messages",
    authMode: "api-key",
    baseUrl: "https://api.anthropic.com",
  },
  google: {
    kind: "google",
    api: "google-generative-ai",
    authMode: "api-key",
    baseUrl: "https://generativelanguage.googleapis.com",
  },
  "google-vertex": {
    kind: "google-vertex",
    api: "google-generative-ai",
    authMode: "api-key",
    baseUrl: "",
  },
  "google-antigravity": {
    kind: "google-antigravity",
    api: "google-generative-ai",
    authMode: "api-key",
    baseUrl: "",
  },
  "google-gemini-cli": {
    kind: "google-gemini-cli",
    api: "google-generative-ai",
    authMode: "api-key",
    baseUrl: "",
  },
  openrouter: {
    kind: "openrouter",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://openrouter.ai/api",
  },
  xai: {
    kind: "xai",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.x.ai",
  },
  mistral: {
    kind: "mistral",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.mistral.ai",
  },
  groq: {
    kind: "groq",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.groq.com/openai",
  },
  cerebras: {
    kind: "cerebras",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.cerebras.ai",
  },
  "github-copilot": {
    kind: "github-copilot",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "",
  },
  huggingface: {
    kind: "huggingface",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://router.huggingface.co",
  },
  opencode: {
    kind: "opencode",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "",
  },
  "vercel-ai-gateway": {
    kind: "vercel-ai-gateway",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://ai-gateway.vercel.sh",
  },
  kilocode: {
    kind: "kilocode",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.kilo.ai/api/gateway",
  },
  moonshot: {
    kind: "moonshot",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.moonshot.ai",
  },
  "kimi-coding": {
    kind: "kimi-coding",
    api: "anthropic-messages",
    authMode: "api-key",
    baseUrl: "https://api.moonshot.ai/anthropic",
  },
  qwen: {
    kind: "qwen",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
  },
  "qwen-portal": {
    kind: "qwen-portal",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "",
  },
  volcengine: {
    kind: "volcengine",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "",
  },
  byteplus: {
    kind: "byteplus",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "",
  },
  synthetic: {
    kind: "synthetic",
    api: "anthropic-messages",
    authMode: "api-key",
    baseUrl: "https://api.synthetic.new/anthropic",
  },
  minimax: {
    kind: "minimax",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.minimaxi.com",
  },
  ollama: {
    kind: "ollama",
    api: "ollama",
    authMode: "none",
    baseUrl: "http://localhost:11434",
  },
  vllm: {
    kind: "vllm",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "http://127.0.0.1:8000",
  },
  litellm: {
    kind: "litellm",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "http://127.0.0.1:4000",
  },
  together: {
    kind: "together",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.together.xyz",
  },
  nvidia: {
    kind: "nvidia",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://integrate.api.nvidia.com",
  },
  qianfan: {
    kind: "qianfan",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "",
  },
  venice: {
    kind: "venice",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.venice.ai",
  },
  xiaomi: {
    kind: "xiaomi",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "",
  },
  zai: {
    kind: "zai",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://api.z.ai",
  },
  glm: {
    kind: "glm",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  bedrock: {
    kind: "bedrock",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "",
  },
  "cloudflare-ai-gateway": {
    kind: "cloudflare-ai-gateway",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "",
  },
  "openai-compatible": {
    kind: "openai-compatible",
    api: "openai-responses",
    authMode: "bearer-token",
    baseUrl: "",
  },
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
} {
  const preset = FRIDAY_PROVIDER_PRESETS[kind];
  if (kind === "ollama") {
    return {
      baseUrl: baseUrlOverride ?? preset.baseUrl,
      api: preset.api,
      authMode: preset.authMode,
    };
  }
  return {
    baseUrl: baseUrlOverride ?? preset.baseUrl,
    api: preset.api,
    authMode: preset.authMode,
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
  return { kind: "openai-compatible", confidence: "medium" };
}

