import { apiClient } from "./client";
import type {
  SetupStatusResponse,
  DetectProviderResponse,
  SetupNetworkResponse,
  SetupCompleteResponse,
  ProviderKind,
  AuthMode,
  SetupStepId,
  NetworkMode,
  ChannelKind,
} from "@/lib/setup/types";

// ─── Request types ───

export interface DetectProviderInput {
  apiKey?: string;
  kind?: ProviderKind;
  baseUrl?: string;
  authMode?: AuthMode;
}

export interface SaveNetworkInput {
  mode: NetworkMode;
  host?: string;
  port: number;
}

export interface SaveChannelsInput {
  controlConfirmed?: boolean;
  channels: Array<{
    kind: ChannelKind;
    enabled: boolean;
    config: Record<string, string>;
  }>;
}

export interface SaveChannelsResponse {
  savedKinds: string[];
  activation?: {
    startedKinds: string[];
    failed: Array<{ kind: string; message: string }>;
    restartRequired: boolean;
    warnings: string[];
  };
}

export interface TestChannelInput {
  kind: ChannelKind;
  config: Record<string, string>;
}

export interface TestChannelResponse {
  kind: ChannelKind;
  validated: boolean;
  useFeishu?: boolean;
  receiveMode?: "websocket" | "webhook";
  tokenExpiresInSeconds?: number;
  warnings: string[];
}

export interface BeginFeishuRegistrationResponse {
  registrationId: string;
  kind: "feishu";
  domain: "feishu";
  qrUrl: string;
  userCode: string;
  intervalSeconds: number;
  expireInSeconds: number;
  expiresAt: string;
  warnings: string[];
}

export interface PollFeishuRegistrationInput {
  registrationId: string;
}

export interface PollFeishuRegistrationResponse {
  registrationId: string;
  kind: "feishu";
  status: "pending" | "slow_down" | "success" | "dm_failed" | "access_denied" | "expired" | "error";
  appId?: string;
  ownerOpenId?: string;
  suggestedAllowedUsers?: string[];
  dmVerified?: boolean;
  welcomeMessageId?: string;
  intervalSeconds?: number;
  expiresAt?: string;
  message?: string;
  warnings: string[];
}

export interface BeginTelegramVerificationInput {
  botToken: string;
}

export interface BeginTelegramVerificationResponse {
  verificationId: string;
  kind: "telegram";
  status: "pending";
  botUserId: string;
  botUsername?: string;
  botName: string;
  startCode: string;
  startUrl?: string;
  expiresAt: string;
  warnings: string[];
}

export interface PollTelegramVerificationInput {
  verificationId: string;
}

export interface PollTelegramVerificationResponse {
  verificationId: string;
  kind: "telegram";
  status: "pending" | "success" | "expired" | "error";
  botUserId?: string;
  botUsername?: string;
  chatId?: string;
  userId?: string;
  welcomeMessageId?: string;
  expiresAt?: string;
  message?: string;
  warnings: string[];
}

export interface BeginDiscordVerificationInput {
  token: string;
  guildId?: string;
}

export interface BeginDiscordVerificationResponse {
  verificationId: string;
  kind: "discord";
  status: "ready";
  applicationId: string;
  botUserId: string;
  botUsername: string;
  inviteUrl: string;
  guildId?: string;
  guildVerified?: boolean;
  expiresAt: string;
  warnings: string[];
}

export interface CompleteDiscordVerificationInput {
  verificationId: string;
  userId: string;
  guildId?: string;
}

export interface CompleteDiscordVerificationResponse {
  verificationId: string;
  kind: "discord";
  status: "success" | "dm_failed" | "expired" | "error";
  applicationId?: string;
  botUserId?: string;
  botUsername?: string;
  guildId?: string;
  guildVerified?: boolean;
  userId?: string;
  dmVerified?: boolean;
  welcomeMessageId?: string;
  message?: string;
  warnings: string[];
}

export interface CompleteSetupInput {
  completedSteps: SetupStepId[];
  skippedSteps: SetupStepId[];
}

// ─── API ───

export const setupApi = {
  async getStatus(): Promise<SetupStatusResponse> {
    return apiClient.get<SetupStatusResponse>("/v1/setup/status");
  },

  async detectProvider(input: DetectProviderInput): Promise<DetectProviderResponse> {
    return apiClient.post<DetectProviderInput, DetectProviderResponse>(
      "/v1/providers/detect",
      input,
    );
  },

  async getNetwork(): Promise<SetupNetworkResponse> {
    return apiClient.get<SetupNetworkResponse>("/v1/setup/network");
  },

  async saveNetwork(input: SaveNetworkInput): Promise<SetupNetworkResponse> {
    return apiClient.post<SaveNetworkInput, SetupNetworkResponse>(
      "/v1/setup/network",
      input,
    );
  },

  async saveChannels(input: SaveChannelsInput): Promise<SaveChannelsResponse> {
    return apiClient.post<SaveChannelsInput, SaveChannelsResponse>(
      "/v1/setup/channels",
      input,
    );
  },

  async testChannel(input: TestChannelInput): Promise<TestChannelResponse> {
    return apiClient.post<TestChannelInput, TestChannelResponse>(
      "/v1/setup/channels/test",
      input,
    );
  },

  async beginFeishuRegistration(): Promise<BeginFeishuRegistrationResponse> {
    return apiClient.post<Record<string, never>, BeginFeishuRegistrationResponse>(
      "/v1/setup/channels/feishu/registration/begin",
      {},
    );
  },

  async pollFeishuRegistration(input: PollFeishuRegistrationInput): Promise<PollFeishuRegistrationResponse> {
    return apiClient.post<PollFeishuRegistrationInput, PollFeishuRegistrationResponse>(
      "/v1/setup/channels/feishu/registration/poll",
      input,
    );
  },

  async beginTelegramVerification(input: BeginTelegramVerificationInput): Promise<BeginTelegramVerificationResponse> {
    return apiClient.post<BeginTelegramVerificationInput, BeginTelegramVerificationResponse>(
      "/v1/setup/channels/telegram/verification/begin",
      input,
    );
  },

  async pollTelegramVerification(input: PollTelegramVerificationInput): Promise<PollTelegramVerificationResponse> {
    return apiClient.post<PollTelegramVerificationInput, PollTelegramVerificationResponse>(
      "/v1/setup/channels/telegram/verification/poll",
      input,
    );
  },

  async beginDiscordVerification(input: BeginDiscordVerificationInput): Promise<BeginDiscordVerificationResponse> {
    return apiClient.post<BeginDiscordVerificationInput, BeginDiscordVerificationResponse>(
      "/v1/setup/channels/discord/verification/begin",
      input,
    );
  },

  async completeDiscordVerification(input: CompleteDiscordVerificationInput): Promise<CompleteDiscordVerificationResponse> {
    return apiClient.post<CompleteDiscordVerificationInput, CompleteDiscordVerificationResponse>(
      "/v1/setup/channels/discord/verification/complete",
      input,
    );
  },

  async completeSetup(input: CompleteSetupInput): Promise<SetupCompleteResponse> {
    return apiClient.post<CompleteSetupInput, SetupCompleteResponse>(
      "/v1/setup/complete",
      input,
    );
  },
};
