import type {
  FridayProviderAuthMode,
  FridayProviderKind,
  FridayProviderTemplate,
  FridayProviderTemplateModelDefaults,
  FridayProviderTemplateSecretRequirement,
  FridayProviderTemplateStatus,
  FridayProviderTemplateTier,
} from "./friday-provider.types.js";
import { FRIDAY_PROVIDER_KINDS } from "./friday-provider.types.js";
import { getFridayProviderAuthModesForBackend, getFridayProviderCapability } from "./friday-provider-capabilities.js";
import { getFridayProviderPreset } from "./friday-provider-catalog.js";

interface FridayProviderTemplateMeta {
  displayName?: string;
  description?: string;
  tier?: FridayProviderTemplateTier;
  status?: FridayProviderTemplateStatus;
  baseUrlHints?: string[];
  modelDefaults?: Partial<FridayProviderTemplateModelDefaults>;
  reasoningHints?: string[];
}

const TEMPLATE_META: Partial<Record<FridayProviderKind, FridayProviderTemplateMeta>> = {
  openai: {
    displayName: "OpenAI API",
    description: "Friday's default hosted path for native-tool runs, explainable routing, and broad model coverage.",
    tier: "official",
    status: "ready",
    modelDefaults: {
      recommended: "gpt-4o-mini",
      fallback: "gpt-4o",
      examples: ["gpt-4o-mini", "gpt-4o", "o4-mini"],
    },
    reasoningHints: [
      "Use the recommended fallback model when latency or budget matters.",
      "Keep HTTP routing as the canonical setup path even if Codex CLI is attached later.",
    ],
  },
  anthropic: {
    displayName: "Anthropic API",
    description: "Claude HTTP path with support for API keys, OAuth, and setup tokens inside Friday's supervised runtime.",
    tier: "official",
    status: "ready",
    modelDefaults: {
      recommended: "claude-sonnet-4-20250514",
      fallback: "claude-haiku-3.5",
      examples: ["claude-sonnet-4-20250514", "claude-opus-4"],
    },
    reasoningHints: [
      "Prefer HTTP for tool-capable runs; attach Claude CLI later only for text-only workflows.",
    ],
  },
  google: {
    displayName: "Google AI Studio",
    description: "Gemini API path for tool-capable runs without assuming Gemini CLI is present.",
    tier: "official",
    status: "ready",
    modelDefaults: {
      recommended: "gemini-2.5-pro",
      fallback: "gemini-2.5-flash",
      examples: ["gemini-2.5-pro", "gemini-2.5-flash"],
    },
    reasoningHints: [
      "Use API key auth first; add CLI-backed workflows later only if the local environment really has Gemini CLI.",
    ],
  },
  ollama: {
    displayName: "Ollama Local",
    description: "Local-only runtime path for no-egress and self-hosted workflows.",
    tier: "official",
    status: "ready",
    baseUrlHints: ["http://localhost:11434"],
    modelDefaults: {
      recommended: "llama3.2",
      fallback: "qwen2.5-coder",
      examples: ["llama3.2", "qwen2.5-coder", "mistral"],
    },
    reasoningHints: [
      "Use local-only routing policies when privacy outweighs absolute model capability.",
    ],
  },
  "openai-compatible": {
    displayName: "OpenAI-compatible Gateway",
    description: "Gateway or self-hosted proxy that follows Friday's canonical OpenAI-compatible HTTP contract.",
    tier: "official",
    status: "requires_configuration",
    modelDefaults: {
      examples: ["gpt-4o", "qwen2.5-coder", "llama3.1"],
    },
    reasoningHints: [
      "Only configure gateways that genuinely follow the OpenAI-compatible contract; Friday does not infer hidden OAuth flows.",
    ],
  },
  openrouter: {
    displayName: "OpenRouter",
    description: "OpenAI-compatible hosted router with broad model coverage and straightforward bearer auth.",
    tier: "verified",
    status: "ready",
    modelDefaults: {
      recommended: "openai/gpt-4o-mini",
      fallback: "anthropic/claude-3.5-haiku",
      examples: ["openai/gpt-4o-mini", "anthropic/claude-3.7-sonnet"],
    },
  },
  groq: {
    displayName: "Groq",
    description: "High-speed OpenAI-compatible route for latency-sensitive tasks.",
    tier: "verified",
    status: "ready",
    modelDefaults: {
      recommended: "llama-3.3-70b-versatile",
      fallback: "llama-3.1-8b-instant",
      examples: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    },
  },
  mistral: {
    displayName: "Mistral",
    description: "Hosted OpenAI-compatible route with solid European-region coverage.",
    tier: "verified",
    status: "ready",
    modelDefaults: {
      recommended: "mistral-large-latest",
      fallback: "ministral-8b-latest",
      examples: ["mistral-large-latest", "ministral-8b-latest"],
    },
  },
  vllm: {
    displayName: "vLLM",
    description: "Self-hosted OpenAI-compatible runtime for dedicated deployments.",
    tier: "verified",
    status: "ready",
    baseUrlHints: ["http://127.0.0.1:8000"],
  },
  litellm: {
    displayName: "LiteLLM",
    description: "OpenAI-compatible router that can front multiple upstream model providers.",
    tier: "verified",
    status: "ready",
    baseUrlHints: ["http://127.0.0.1:4000"],
  },
  bedrock: {
    displayName: "AWS Bedrock (compat)",
    description: "Bring your own compatibility bridge or gateway for Bedrock-backed routing.",
    tier: "verified",
    status: "requires_configuration",
  },
  "github-copilot": {
    displayName: "GitHub Copilot Gateway",
    description: "Compatibility-only path. Friday does not ship a Copilot reverse proxy or consumer OAuth bridge.",
    tier: "experimental",
    status: "experimental",
  },
  synthetic: {
    displayName: "Synthetic",
    description: "Experimental Anthropic-compatible provider preset.",
    tier: "experimental",
    status: "experimental",
  },
  deepseek: {
    displayName: "DeepSeek",
    description: "DeepSeek reasoning and coding models with OpenAI-compatible API.",
    tier: "verified",
    status: "ready",
    baseUrlHints: ["https://api.deepseek.com"],
    modelDefaults: {
      recommended: "deepseek-v4-pro",
      fallback: "deepseek-v4-flash",
      examples: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    },
    reasoningHints: ["DeepSeek V4 supports thinking and non-thinking modes via the API."],
  },
  moonshot: {
    displayName: "\u6708\u4E4B\u6697\u9762 (Moonshot)",
    description: "Kimi \u5927\u6A21\u578B\uFF0C\u652F\u6301\u8D85\u957F\u4E0A\u4E0B\u6587\u5BF9\u8BDD\u3002",
    tier: "verified",
    status: "ready",
    baseUrlHints: ["https://api.moonshot.ai"],
    modelDefaults: {
      recommended: "moonshot-v1-128k",
      fallback: "moonshot-v1-32k",
      examples: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    },
    reasoningHints: [],
  },
  qwen: {
    displayName: "\u901A\u4E49\u5343\u95EE (Qwen)",
    description: "\u963F\u91CC\u4E91\u901A\u4E49\u5343\u95EE\uFF0C\u652F\u6301\u591A\u6A21\u6001\u548C\u4EE3\u7801\u751F\u6210\u3002",
    tier: "verified",
    status: "ready",
    baseUrlHints: ["https://dashscope.aliyuncs.com/compatible-mode"],
    modelDefaults: {
      recommended: "qwen-max",
      fallback: "qwen-plus",
      examples: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen2.5-coder-32b"],
    },
    reasoningHints: [],
  },
  glm: {
    displayName: "\u667A\u8C31\u6E05\u8A00 (GLM)",
    description: "\u667A\u8C31 AI \u7684 GLM \u7CFB\u5217\u5927\u6A21\u578B\u3002",
    tier: "verified",
    status: "ready",
    baseUrlHints: ["https://open.bigmodel.cn/api/paas/v4"],
    modelDefaults: {
      recommended: "glm-4",
      fallback: "glm-4-flash",
      examples: ["glm-4", "glm-4-flash", "glm-4v"],
    },
    reasoningHints: [],
  },
  minimax: {
    displayName: "MiniMax",
    description: "MiniMax \u5927\u6A21\u578B\uFF0C\u652F\u6301\u8BED\u97F3\u548C\u591A\u6A21\u6001\u3002",
    tier: "verified",
    status: "ready",
    baseUrlHints: ["https://api.minimaxi.com"],
    modelDefaults: {
      recommended: "abab6.5s-chat",
      examples: ["abab6.5s-chat", "abab5.5-chat"],
    },
    reasoningHints: [],
  },
  volcengine: {
    displayName: "\u706B\u5C71\u5F15\u64CE (\u8C46\u5305)",
    description: "\u5B57\u8282\u8DF3\u52A8\u706B\u5C71\u5F15\u64CE\uFF0C\u8C46\u5305\u5927\u6A21\u578B\u3002",
    tier: "community",
    status: "requires_configuration",
    baseUrlHints: [],
    modelDefaults: {
      examples: ["doubao-pro-32k", "doubao-lite-32k"],
    },
    reasoningHints: ["\u9700\u8981\u5728\u706B\u5C71\u5F15\u64CE\u63A7\u5236\u53F0\u521B\u5EFA\u63A5\u5165\u70B9\u5E76\u83B7\u53D6 API Key\u3002"],
  },
  qianfan: {
    displayName: "\u767E\u5EA6\u5343\u5E06 (\u6587\u5FC3)",
    description: "\u767E\u5EA6\u6587\u5FC3\u4E00\u8A00\u5343\u5E06\u5E73\u53F0\u3002",
    tier: "community",
    status: "requires_configuration",
    baseUrlHints: [],
    modelDefaults: {
      examples: ["ernie-4.0", "ernie-3.5-turbo"],
    },
    reasoningHints: ["\u9700\u8981\u5728\u767E\u5EA6\u667A\u80FD\u4E91\u521B\u5EFA\u5E94\u7528\u5E76\u83B7\u53D6 API Key\u3002"],
  },
  "kimi-coding": {
    displayName: "Kimi Coding",
    description: "Kimi \u7F16\u7A0B\u6A21\u578B\uFF0C\u652F\u6301 Anthropic \u517C\u5BB9 API\u3002",
    tier: "verified",
    status: "ready",
    baseUrlHints: ["https://api.moonshot.ai/anthropic"],
    modelDefaults: {
      recommended: "kimi-coder",
      examples: ["kimi-coder"],
    },
    reasoningHints: [],
  },
  xiaomi: {
    displayName: "\u5C0F\u7C73 AI (MiLM)",
    description: "\u5C0F\u7C73\u5927\u6A21\u578B\u670D\u52A1\u3002",
    tier: "community",
    status: "requires_configuration",
    baseUrlHints: [],
    modelDefaults: {
      examples: [],
    },
    reasoningHints: [],
  },
  byteplus: {
    displayName: "BytePlus ModelArk",
    description: "BytePlus \u6D77\u5916\u7248\u706B\u5C71\u5F15\u64CE\u6A21\u578B\u670D\u52A1\u3002",
    tier: "community",
    status: "requires_configuration",
    baseUrlHints: [],
    modelDefaults: {
      examples: [],
    },
    reasoningHints: [],
  },
  "qwen-portal": {
    displayName: "\u901A\u4E49\u5343\u95EE Portal",
    description: "\u901A\u4E49\u5343\u95EE\u95E8\u6237\u7248 API\u3002",
    tier: "community",
    status: "requires_configuration",
    baseUrlHints: [],
    modelDefaults: {
      examples: ["qwen-max", "qwen-plus"],
    },
    reasoningHints: [],
  },
  zai: {
    displayName: "Z.AI",
    description: "Z.AI \u667A\u80FD\u5BF9\u8BDD\u5E73\u53F0\u3002",
    tier: "community",
    status: "ready",
    baseUrlHints: ["https://api.z.ai"],
    modelDefaults: {
      examples: [],
    },
    reasoningHints: [],
  },
};

function titleCaseProviderKind(kind: FridayProviderKind): string {
  return kind
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildRequiredSecrets(authModes: readonly FridayProviderAuthMode[]): FridayProviderTemplateSecretRequirement[] {
  const requirements: FridayProviderTemplateSecretRequirement[] = [];
  if (authModes.includes("api-key")) {
    requirements.push({
      key: "apiKey",
      label: "API key",
      required: true,
      acceptedRefs: ["inline", "env-ref", "file-ref", "secret-ref"],
      helpText: "Use a raw key, env: or $ENV, file:, or a managed secret reference.",
    });
  }
  if (authModes.includes("bearer-token")) {
    requirements.push({
      key: "bearerToken",
      label: "Bearer token",
      required: true,
      acceptedRefs: ["inline", "env-ref", "file-ref", "secret-ref"],
      helpText: "For OpenAI-compatible bearer auth paths. Supports env:, file:, and managed refs.",
    });
  }
  if (authModes.includes("token")) {
    requirements.push({
      key: "setupToken",
      label: "Setup token",
      required: true,
      acceptedRefs: ["inline", "env-ref", "file-ref", "secret-ref"],
      helpText: "Compatibility path for pasted or setup-phase provider tokens, including env: and file: refs.",
    });
  }
  return requirements;
}

function defaultReasoningHints(kind: FridayProviderKind): string[] {
  if (kind === "ollama" || kind === "vllm" || kind === "litellm") {
    return ["Prefer local-only or no-egress policies when these runtimes handle sensitive tasks."];
  }
  if (kind === "openai-compatible") {
    return ["Verify the base URL and model naming contract before making it the default route."];
  }
  return ["Start with the stable HTTP path first, then add advanced routing or CLI sidecars later if needed."];
}

function defaultModelDefaults(): FridayProviderTemplateModelDefaults {
  return { examples: [] };
}

export function listFridayProviderTemplates(): FridayProviderTemplate[] {
  return FRIDAY_PROVIDER_KINDS.map((kind) => {
    const preset = getFridayProviderPreset(kind);
    const capability = getFridayProviderCapability(kind);
    const meta = TEMPLATE_META[kind] ?? {};
    const authModes = [...getFridayProviderAuthModesForBackend(kind, preset.backendKind)];
    const baseUrlHints = meta.baseUrlHints ?? (preset.baseUrl.trim().length > 0 ? [preset.baseUrl] : []);
    const modelDefaults: FridayProviderTemplateModelDefaults = {
      ...defaultModelDefaults(),
      ...(meta.modelDefaults ?? {}),
      examples: meta.modelDefaults?.examples ?? [],
    };
    return {
      id: kind,
      providerKind: kind,
      displayName: meta.displayName ?? titleCaseProviderKind(kind),
      description: meta.description ?? `Bootstrap ${titleCaseProviderKind(kind)} through Friday's ${capability.family} provider path.`,
      tier: meta.tier ?? (preset.baseUrl.trim().length > 0 ? "verified" : "community"),
      status: meta.status ?? (capability.requiresBaseUrl ? "requires_configuration" : "ready"),
      api: preset.api,
      backendKind: preset.backendKind,
      deploymentKind: preset.deploymentKind,
      regionTag: preset.regionTag,
      authModes,
      baseUrlHints,
      modelDefaults,
      reasoningHints: meta.reasoningHints?.length ? meta.reasoningHints : defaultReasoningHints(kind),
      requiredSecrets: buildRequiredSecrets(authModes),
    };
  });
}

export function getFridayProviderTemplate(
  templateId: string,
): FridayProviderTemplate | null {
  return listFridayProviderTemplates().find((template) => template.id === templateId) ?? null;
}
