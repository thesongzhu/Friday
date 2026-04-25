// ─── Core types ───
export type {
  FridayBriefChannelKind,
  FridayBriefCollectionResult,
  FridayBriefDeliveryAttempt,
  FridayBriefEvent,
  FridayBriefLength,
  FridayBriefRunRecord,
  FridayBriefRunSourceResult,
  FridayBriefRunStatus,
  FridayBriefRunTrigger,
  FridayBriefSkipReason,
  FridayBriefSourceKind,
  FridayBriefSummary,
  FridayBriefSummaryBullet,
  FridayBriefTtsProviderKind,
} from "./friday-brief.types.js";

export {
  FRIDAY_BRIEF_CHANNEL_KINDS,
  FRIDAY_BRIEF_LENGTH_TARGETS,
  FRIDAY_BRIEF_SOURCE_KINDS,
  FRIDAY_BRIEF_TTS_PROVIDER_KINDS,
} from "./friday-brief.types.js";

// ─── Config ───
export type {
  FridayBriefConfig,
  FridayBriefSourcesConfig,
  FridayBriefChannelsConfig,
  FridayBriefTtsConfig,
  FridayBriefWeComChannelConfig,
  FridayBriefEmailChannelConfig,
  FridayBriefGitRepoConfig,
  FridayBriefSlackSourceConfig,
  FridayBriefMailSourceConfig,
  FridayBriefCalendarSourceConfig,
  FridayBriefIssuesSourceConfig,
} from "./friday-brief-config.types.js";

export {
  FridayBriefConfigSchema,
  FridayBriefSourcesConfigSchema,
  FridayBriefChannelsConfigSchema,
  FridayBriefTtsConfigSchema,
  FridayBriefGitRepoConfigSchema,
  FridayBriefWeComChannelConfigSchema,
  FridayBriefTelegramChannelConfigSchema,
  FridayBriefEmailChannelConfigSchema,
  buildDefaultFridayBriefConfig,
  normalizeFridayBriefFallbackOrder,
} from "./friday-brief-config.types.js";

// ─── Repositories ───
export type { FridayBriefConfigRepository } from "./friday-brief-config-repository.js";
export { createFridayBriefConfigRepository } from "./friday-brief-config-repository.js";
export type { FridayBriefHistoryRepository } from "./friday-brief-history-repository.js";
export { createFridayBriefHistoryRepository } from "./friday-brief-history-repository.js";

// ─── Secret resolver ───
export {
  FRIDAY_BRIEF_SECRET_SCOPE,
  resolveBriefSecret,
} from "./friday-brief-secret-resolver.js";
export {
  FRIDAY_BRIEF_SECRET_SLOTS,
  isFridayBriefSecretSlot,
  readSlotRefKey,
  writeSlotRefKey,
} from "./friday-brief-secret-slots.js";
export type { FridayBriefSecretSlot } from "./friday-brief-secret-slots.js";

// ─── Collectors ───
export type {
  FridayBriefCollector,
  FridayBriefCollectorContext,
} from "./collectors/friday-brief-collector.types.js";
export { createFridayBriefFridayHistoryCollector } from "./collectors/friday-brief-friday-history-collector.js";
export {
  createFridayBriefGitCollector,
} from "./collectors/friday-brief-git-collector.js";
export type { FridayGitRunner } from "./collectors/friday-brief-git-collector.js";
export { createFridayBriefSlackCollector } from "./collectors/friday-brief-slack-collector.js";
export { createFridayBriefMailCollector } from "./collectors/friday-brief-mail-collector.js";
export { createFridayBriefCalendarCollector } from "./collectors/friday-brief-calendar-collector.js";
export { createFridayBriefIssuesCollector } from "./collectors/friday-brief-issues-collector.js";

// ─── TTS ───
export type {
  FridayBriefTtsInput,
  FridayBriefTtsOutput,
  FridayBriefTtsProvider,
  FridayBriefTtsRegistry,
} from "./tts/friday-brief-tts.types.js";
export { createFridayBriefTtsRegistry } from "./tts/friday-brief-tts-registry.js";
export { createFridayBriefAzureTtsProvider } from "./tts/friday-brief-azure-tts-provider.js";
export { createFridayBriefGoogleTtsProvider } from "./tts/friday-brief-google-tts-provider.js";
export { createFridayBriefLocalTtsProvider } from "./tts/friday-brief-local-tts-provider.js";

// ─── Delivery ───
export type {
  FridayBriefDeliveryClient,
  FridayBriefDeliveryPayload,
  FridayBriefDeliveryResult,
} from "./delivery/friday-brief-delivery.types.js";
export { createFridayBriefWeComDelivery } from "./delivery/friday-brief-wecom-delivery.js";
export { createFridayBriefTelegramDelivery } from "./delivery/friday-brief-telegram-delivery.js";
export { createFridayBriefEmailDelivery } from "./delivery/friday-brief-email-delivery.js";
export { sendFridayBriefEmail } from "./delivery/friday-brief-smtp-client.js";

// ─── Core ───
export type { FridayBriefSummarizer, FridayBriefSummarizerDeps } from "./friday-brief-summarizer.js";
export { createFridayBriefSummarizer } from "./friday-brief-summarizer.js";
export { createFridayBriefLlmSummarize } from "./friday-brief-llm-summarize.js";
export type { FridayBriefLlmSummarizeDeps } from "./friday-brief-llm-summarize.js";
export type { FridayBriefDeliverer } from "./friday-brief-deliverer.js";
export { createFridayBriefDeliverer } from "./friday-brief-deliverer.js";
export type { FridayBriefService, FridayBriefServiceDeps, FridayBriefRunRequest } from "./friday-brief-service.js";
export { createFridayBriefService } from "./friday-brief-service.js";
