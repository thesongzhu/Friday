export type SetupStepId =
  | "welcome"
  | "security"
  | "communication"
  | "provider"
  | "network"
  | "channels"
  | "skills"
  | "done";

export type ProviderKind =
  | "openai"
  | "openai-codex"
  | "anthropic"
  | "google"
  | "google-antigravity"
  | "google-vertex"
  | "google-gemini-cli"
  | "ollama"
  | "openrouter"
  | "groq"
  | "mistral"
  | "together"
  | "xai"
  | "cerebras"
  | "github-copilot"
  | "huggingface"
  | "opencode"
  | "vercel-ai-gateway"
  | "kilocode"
  | "qwen"
  | "qwen-portal"
  | "moonshot"
  | "kimi-coding"
  | "glm"
  | "deepseek"
  | "minimax"
  | "qianfan"
  | "volcengine"
  | "byteplus"
  | "synthetic"
  | "venice"
  | "zai"
  | "xiaomi"
  | "bedrock"
  | "cloudflare-ai-gateway"
  | "litellm"
  | "vllm"
  | "nvidia"
  | "openai-compatible";

export type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "ollama";

export type ProviderBackendKind = "http" | "cli" | "sdk";

export type AuthMode =
  | "api-key"
  | "bearer-token"
  | "oauth"
  | "token"
  | "external-session"
  | "none";

export type ChannelKind =
  | "qq"
  | "lark"
  | "feishu"
  | "discord"
  | "telegram"
  | "whatsapp"
  | "signal"
  | "slack"
  | "webchat"
  | "irc"
  | "line";

export type NetworkMode = "local" | "network" | "custom";

export interface SetupStatusResponse {
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

export interface DetectProviderResponse {
  kind: ProviderKind;
  confidence: "high" | "medium" | "low";
  baseUrl: string;
  api: ProviderApi;
  authMode: AuthMode;
  availableModels: string[];
  defaultModel?: string;
  validated: boolean;
  latencyMs?: number;
  warnings: string[];
}

export interface SetupNetworkResponse {
  host: string;
  port: number;
  mode: NetworkMode;
  previewUrls: string[];
  restartRequired: boolean;
}

export interface SetupCompleteResponse {
  setupCompletedAt: string;
}
