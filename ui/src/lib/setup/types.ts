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
  | "anthropic"
  | "google"
  | "ollama"
  | "openai-compatible";

export type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "ollama";

export type AuthMode = "api-key" | "bearer-token" | "oauth" | "none";

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
