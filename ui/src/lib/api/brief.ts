import { apiClient } from "./client";

// ─── Brief types (mirror of src/brief/*) ───

export type FridayBriefSourceKind =
  | "friday_history"
  | "git_repos"
  | "slack"
  | "mail"
  | "calendar"
  | "issues";

export type FridayBriefChannelKind = "wecom" | "telegram" | "email";

export type FridayBriefLength = "short" | "normal" | "long";

export type FridayBriefTtsProviderKind = "azure" | "google" | "local";

export type FridayBriefRunStatus =
  | "pending"
  | "collecting"
  | "summarizing"
  | "synthesizing"
  | "delivering"
  | "delivered"
  | "skipped"
  | "failed";

export type FridayBriefRunTrigger =
  | "scheduled"
  | "manual_http"
  | "manual_cli"
  | "replay";

export interface FridayBriefGitRepoConfig {
  label: string;
  path: string;
  authors: string[];
  branches: string[];
}

export interface FridayBriefFridayHistorySourceConfig {
  enabled: boolean;
  includeKinds: string[];
}

export interface FridayBriefGitSourceConfig {
  enabled: boolean;
  repos: FridayBriefGitRepoConfig[];
}

export interface FridayBriefSlackSourceConfig {
  enabled: boolean;
  tokenRefKey?: string;
  userId?: string;
  channels: string[];
  includeDms: boolean;
}

export interface FridayBriefMailSourceConfig {
  enabled: boolean;
  provider?: "gmail" | "outlook";
  credentialRefKey?: string;
  account?: string;
  includeReceived: boolean;
  vipSenders: string[];
}

export interface FridayBriefCalendarSourceConfig {
  enabled: boolean;
  provider?: "google" | "outlook";
  credentialRefKey?: string;
  account?: string;
  calendarIds: string[];
  includeDeclined: boolean;
}

export interface FridayBriefIssuesLinearConfig {
  enabled: boolean;
  apiKeyRefKey?: string;
  userId?: string;
}

export interface FridayBriefIssuesJiraConfig {
  enabled: boolean;
  baseUrl?: string;
  credentialRefKey?: string;
  accountId?: string;
}

export interface FridayBriefIssuesGithubConfig {
  enabled: boolean;
  tokenRefKey?: string;
  username?: string;
  repos: string[];
}

export interface FridayBriefIssuesSourceConfig {
  enabled: boolean;
  linear: FridayBriefIssuesLinearConfig;
  jira: FridayBriefIssuesJiraConfig;
  github: FridayBriefIssuesGithubConfig;
}

export interface FridayBriefSourcesConfig {
  friday_history: FridayBriefFridayHistorySourceConfig;
  git_repos: FridayBriefGitSourceConfig;
  slack: FridayBriefSlackSourceConfig;
  mail: FridayBriefMailSourceConfig;
  calendar: FridayBriefCalendarSourceConfig;
  issues: FridayBriefIssuesSourceConfig;
}

export interface FridayBriefWeComChannelConfig {
  enabled: boolean;
  corpId?: string;
  agentId?: string;
  secretRefKey?: string;
  toUser: string;
}

export interface FridayBriefTelegramChannelConfig {
  enabled: boolean;
  botTokenRefKey?: string;
  chatId?: string;
}

export interface FridayBriefEmailChannelConfig {
  enabled: boolean;
  host?: string;
  port: number;
  secure: boolean;
  username?: string;
  passwordRefKey?: string;
  fromAddress?: string;
  fromName: string;
  toAddress?: string;
}

export interface FridayBriefChannelsConfig {
  wecom: FridayBriefWeComChannelConfig;
  telegram: FridayBriefTelegramChannelConfig;
  email: FridayBriefEmailChannelConfig;
}

export interface FridayBriefTtsConfig {
  provider: FridayBriefTtsProviderKind;
  azure: {
    region?: string;
    keyRefKey?: string;
    voice: string;
    voiceEn: string;
  };
  google: {
    apiKeyRefKey?: string;
    voice: string;
    voiceEn: string;
  };
  local: {
    voice: string;
    voiceEn: string;
  };
}

export interface FridayBriefConfig {
  enabled: boolean;
  cronExpression: string;
  timezone: string;
  length: FridayBriefLength;
  includeTranscript: boolean;
  languageOverride: string;
  fallbackOrder: FridayBriefChannelKind[];
  sources: FridayBriefSourcesConfig;
  channels: FridayBriefChannelsConfig;
  tts: FridayBriefTtsConfig;
  updatedAt?: string;
}

export interface FridayBriefRunSourceResult {
  source: FridayBriefSourceKind;
  eventCount: number;
  durationMs: number;
  skipped: boolean;
  skipReason?: string;
  error?: { code: string; message: string };
}

export interface FridayBriefDeliveryAttempt {
  channel: FridayBriefChannelKind;
  order: number;
  attemptedAt: string;
  messageId?: string;
  audioAttached: boolean;
  ok: boolean;
  error?: { code: string; message: string };
  durationMs: number;
}

export interface FridayBriefRunRecord {
  id: string;
  triggeredBy: FridayBriefRunTrigger;
  windowEndAt: string;
  windowStartAt: string;
  status: FridayBriefRunStatus;
  skipReason?: string;
  transcript?: string;
  language?: string;
  sourceResults: FridayBriefRunSourceResult[];
  deliveryAttempts: FridayBriefDeliveryAttempt[];
  audio?: { provider: FridayBriefTtsProviderKind; voice: string; bytes: number; durationSec?: number };
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}

// ─── Response envelopes ───

interface GetConfigResponse {
  config: FridayBriefConfig;
}

interface UpdateConfigResponse {
  config: FridayBriefConfig;
}

interface TriggerRunResponse {
  run: FridayBriefRunRecord;
}

interface ListHistoryResponse {
  items: FridayBriefRunRecord[];
  nextCursor?: string;
}

interface GetRunResponse {
  run: FridayBriefRunRecord;
}

// ─── Request shapes ───

export interface BriefTriggerRequest {
  windowStartIso?: string;
  windowEndIso?: string;
  triggeredBy?: "manual_http" | "manual_cli" | "replay";
}

// ─── Secret slots (mirror of src/brief/friday-brief-secret-slots.ts) ───

export const BRIEF_SECRET_SLOTS = [
  "channels.wecom.secret",
  "channels.telegram.botToken",
  "channels.email.password",
  "tts.azure.key",
  "tts.google.apiKey",
  "sources.slack.token",
  "sources.mail.credential",
  "sources.calendar.credential",
  "sources.issues.linear.apiKey",
  "sources.issues.jira.credential",
  "sources.issues.github.token",
] as const;

export type BriefSecretSlot = (typeof BRIEF_SECRET_SLOTS)[number];

export interface BriefSecretSlotState {
  slot: BriefSecretSlot;
  configured: boolean;
  refKey?: string;
}

export function readBriefSlotRefKey(
  config: FridayBriefConfig,
  slot: BriefSecretSlot,
): string | undefined {
  switch (slot) {
    case "channels.wecom.secret":
      return config.channels.wecom.secretRefKey;
    case "channels.telegram.botToken":
      return config.channels.telegram.botTokenRefKey;
    case "channels.email.password":
      return config.channels.email.passwordRefKey;
    case "tts.azure.key":
      return config.tts.azure.keyRefKey;
    case "tts.google.apiKey":
      return config.tts.google.apiKeyRefKey;
    case "sources.slack.token":
      return config.sources.slack.tokenRefKey;
    case "sources.mail.credential":
      return config.sources.mail.credentialRefKey;
    case "sources.calendar.credential":
      return config.sources.calendar.credentialRefKey;
    case "sources.issues.linear.apiKey":
      return config.sources.issues.linear.apiKeyRefKey;
    case "sources.issues.jira.credential":
      return config.sources.issues.jira.credentialRefKey;
    case "sources.issues.github.token":
      return config.sources.issues.github.tokenRefKey;
  }
}

export function writeBriefSlotRefKey(
  config: FridayBriefConfig,
  slot: BriefSecretSlot,
  refKey: string | undefined,
): FridayBriefConfig {
  switch (slot) {
    case "channels.wecom.secret":
      return {
        ...config,
        channels: { ...config.channels, wecom: { ...config.channels.wecom, secretRefKey: refKey } },
      };
    case "channels.telegram.botToken":
      return {
        ...config,
        channels: {
          ...config.channels,
          telegram: { ...config.channels.telegram, botTokenRefKey: refKey },
        },
      };
    case "channels.email.password":
      return {
        ...config,
        channels: {
          ...config.channels,
          email: { ...config.channels.email, passwordRefKey: refKey },
        },
      };
    case "tts.azure.key":
      return {
        ...config,
        tts: { ...config.tts, azure: { ...config.tts.azure, keyRefKey: refKey } },
      };
    case "tts.google.apiKey":
      return {
        ...config,
        tts: { ...config.tts, google: { ...config.tts.google, apiKeyRefKey: refKey } },
      };
    case "sources.slack.token":
      return {
        ...config,
        sources: {
          ...config.sources,
          slack: { ...config.sources.slack, tokenRefKey: refKey },
        },
      };
    case "sources.mail.credential":
      return {
        ...config,
        sources: {
          ...config.sources,
          mail: { ...config.sources.mail, credentialRefKey: refKey },
        },
      };
    case "sources.calendar.credential":
      return {
        ...config,
        sources: {
          ...config.sources,
          calendar: { ...config.sources.calendar, credentialRefKey: refKey },
        },
      };
    case "sources.issues.linear.apiKey":
      return {
        ...config,
        sources: {
          ...config.sources,
          issues: {
            ...config.sources.issues,
            linear: { ...config.sources.issues.linear, apiKeyRefKey: refKey },
          },
        },
      };
    case "sources.issues.jira.credential":
      return {
        ...config,
        sources: {
          ...config.sources,
          issues: {
            ...config.sources.issues,
            jira: { ...config.sources.issues.jira, credentialRefKey: refKey },
          },
        },
      };
    case "sources.issues.github.token":
      return {
        ...config,
        sources: {
          ...config.sources,
          issues: {
            ...config.sources.issues,
            github: { ...config.sources.issues.github, tokenRefKey: refKey },
          },
        },
      };
  }
}

interface ListSecretsResponse {
  slots: BriefSecretSlotState[];
}

interface SetSecretResponse {
  config: FridayBriefConfig;
}

interface ClearSecretResponse {
  config: FridayBriefConfig;
}

// ─── API ───

export const briefApi = {
  async getConfig(): Promise<FridayBriefConfig> {
    const data = await apiClient.get<GetConfigResponse>("/v1/brief/config");
    return data.config;
  },

  async updateConfig(config: FridayBriefConfig): Promise<FridayBriefConfig> {
    const data = await apiClient.put<FridayBriefConfig, UpdateConfigResponse>(
      "/v1/brief/config",
      config,
    );
    return data.config;
  },

  async triggerNow(input: BriefTriggerRequest = {}): Promise<FridayBriefRunRecord> {
    const data = await apiClient.post<BriefTriggerRequest, TriggerRunResponse>(
      "/v1/brief/runs",
      input,
    );
    return data.run;
  },

  async listHistory(input?: {
    limit?: number;
    beforeId?: string;
  }): Promise<ListHistoryResponse> {
    const params = new URLSearchParams();
    if (input?.limit !== undefined) params.set("limit", String(input.limit));
    if (input?.beforeId) params.set("beforeId", input.beforeId);
    const qs = params.toString();
    const path = qs ? `/v1/brief/runs?${qs}` : "/v1/brief/runs";
    return apiClient.get<ListHistoryResponse>(path);
  },

  async getRun(runId: string): Promise<FridayBriefRunRecord> {
    const data = await apiClient.get<GetRunResponse>(
      `/v1/brief/runs/${encodeURIComponent(runId)}`,
    );
    return data.run;
  },

  async listSecrets(): Promise<BriefSecretSlotState[]> {
    const data = await apiClient.get<ListSecretsResponse>("/v1/brief/secrets");
    return data.slots;
  },

  async setSecret(slot: BriefSecretSlot, value: string): Promise<FridayBriefConfig> {
    const data = await apiClient.post<
      { slot: BriefSecretSlot; value: string },
      SetSecretResponse
    >("/v1/brief/secrets", { slot, value });
    return data.config;
  },

  async clearSecret(slot: BriefSecretSlot): Promise<FridayBriefConfig> {
    const data = await apiClient.del<ClearSecretResponse>(
      `/v1/brief/secrets/${encodeURIComponent(slot)}`,
    );
    return data.config;
  },
};
