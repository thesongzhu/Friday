// ─── Core Types ───

export type {
  FridayChannelCapabilityContract,
  FridayChannelCoreAuthority,
  FridayChannelMessage,
  FridayChannelSendOptions,
  FridayChannelPluginResponsibilities,
  FridayChannelPlugin,
  FridayChannelSupportProfile,
} from "./friday-channel.types.js";

// ─── Adapter Types ───

export type {
  FridayChannelAdapters,
  FridayChannelConfigAdapter,
  FridayChannelInboundAdapter,
  FridayChannelOutboundAdapter,
  FridayChannelStatusAdapter,
  FridayChannelLifecycleAdapter,
  FridayChannelStatus,
} from "./friday-channel-adapters.types.js";

// ─── Registry ───

export type {
  FridayChannelRegistry,
  FridayChannelRegistryEntry,
  FridayChannelRegistryView,
  FridayChannelAllowlistConfig,
  FridayChannelStartFailure,
  FridayChannelStartSummary,
  FridayChannelMessageHandler,
} from "./friday-channel-registry.js";

export { createFridayChannelRegistry } from "./friday-channel-registry.js";

// ─── Loader ───

export type {
  FridayChannelLoader,
  FridayChannelFactory,
  FridayChannelLoaderOptions,
} from "./friday-channel-loader.js";

export { createFridayChannelLoader } from "./friday-channel-loader.js";

// ─── Config ───

export type {
  FridaySupportedChannelKind,
  FridayQqChannelConfig,
  FridayLarkChannelConfig,
  FridayChannelInstanceConfig,
  FridayChannelsConfig,
} from "./friday-channel-config.js";

export {
  FRIDAY_SUPPORTED_CHANNEL_KINDS,
  FRIDAY_UNSUPPORTED_CHANNEL_KINDS,
  FRIDAY_UNSUPPORTED_CHANNEL_MODES,
  FRIDAY_CONTROL_CAPABLE_CHANNEL_KINDS,
  FridayQqChannelConfigSchema,
  FridayLarkChannelConfigSchema,
  FridayChannelInstanceConfigSchema,
  FridayChannelsConfigSchema,
  parseFridayChannelsConfig,
  buildDefaultChannelsConfig,
  isFridayChannelKindSupported,
  isFridayChannelModeSupported,
  isControlCapableChannelKind,
} from "./friday-channel-config.js";

// ─── Security / Capability Matrix ───

export type {
  FridayChannelCapabilityEntry,
  FridayChannelSecretFieldDescriptor,
  FridayChannelSecretPolicy,
} from "./friday-channel-security.js";

export {
  FRIDAY_CHANNEL_SECRET_SCOPE,
  FRIDAY_CHANNEL_SECRET_REF_PREFIX,
  FRIDAY_CHANNEL_CAPABILITY_MATRIX,
  getFridayChannelCapabilityEntry,
  getFridayChannelSecretFieldDescriptors,
  buildFridayChannelSecretRef,
  parseFridayChannelSecretRef,
  buildFridayChannelSecretRefKey,
  isFridayEnvSecretRef,
  parseFridayEnvSecretRef,
  resolveFridayChannelSecretPolicy,
} from "./friday-channel-security.js";

// ─── Input Sanitization ───

export { sanitizeChannelInput, FRIDAY_MAX_CHANNEL_INPUT_LENGTH } from "./friday-channel-input-sanitizer.js";
export {
  formatFridayChannelOutboundSendOptions,
  formatFridayChannelOutboundText,
} from "./friday-channel-outbound-formatting.js";

// ─── Typing Controller (OC-005) ───

export type { FridayChannelTypingController, CreateTypingControllerOptions } from "./friday-channel-typing-controller.js";
export { createFridayChannelTypingController } from "./friday-channel-typing-controller.js";

// ─── Inbound Debouncer (OC-004) ───

export type { FridayChannelInboundDebouncer, CreateInboundDebouncerOptions } from "./friday-channel-inbound-debouncer.js";
export { createFridayChannelInboundDebouncer } from "./friday-channel-inbound-debouncer.js";

// ─── Slow Task Notifier ───

export type {
  FridayChannelSlowTaskNotifier,
  FridayChannelSlowTaskNotifierOptions,
} from "./friday-channel-slow-task-notifier.js";
export { createFridayChannelSlowTaskNotifier } from "./friday-channel-slow-task-notifier.js";

// ─── Channel Implementations ───

export { createFridayQqChannel } from "./qq/friday-qq-channel.js";
export { createFridayLarkChannel } from "./lark/friday-lark-channel.js";
export type { LarkChannelDeps } from "./lark/friday-lark-channel.js";
export { createLarkWebhookRelayService, validateLarkWebhookSignature } from "./lark/lark-webhook-relay.js";
export type { LarkWebhookRelayService, LarkWebhookRelayResult } from "./lark/lark-webhook-relay.js";

// Discord
export { createFridayDiscordChannel, normalizeDiscordMessageCreate, stripDiscordBotMention } from "./discord/friday-discord-channel.js";
export type { DiscordChannelDeps } from "./discord/friday-discord-channel.js";
export { FridayDiscordChannelConfigSchema } from "./discord/discord-config.schema.js";
export type { FridayDiscordChannelConfig } from "./discord/discord-config.schema.js";
export { createDiscordGatewayService, createDiscordRestService } from "./discord/discord-service.js";

// Telegram
export { createFridayTelegramChannel, normalizeTelegramUpdate } from "./telegram/friday-telegram-channel.js";
export type { TelegramChannelDeps } from "./telegram/friday-telegram-channel.js";
export { FridayTelegramChannelConfigSchema } from "./telegram/telegram-config.schema.js";
export type { FridayTelegramChannelConfig } from "./telegram/telegram-config.schema.js";
export { createTelegramPollingService, createTelegramWebhookService, createTelegramApiService, TELEGRAM_INBOX_PRUNE_INTERVAL_MS } from "./telegram/telegram-service.js";
export type { TelegramWebhookRelayResult, TelegramWebhookService } from "./telegram/telegram-service.js";
export {
  createInMemoryTelegramInboxStore,
  FridaySqliteTelegramInboxStore,
  TELEGRAM_INBOX_RETENTION_MS,
} from "./telegram/telegram-inbox-store.js";
export type {
  TelegramInboxStore,
  TelegramInboxStatus,
  TelegramInboxRow,
  TelegramInboxCommitResult,
} from "./telegram/telegram-inbox-store.js";

// WhatsApp
export { createFridayWhatsappChannel, normalizeWhatsappWebhook } from "./whatsapp/friday-whatsapp-channel.js";
export type { WhatsappChannelDeps } from "./whatsapp/friday-whatsapp-channel.js";
export { FridayWhatsappChannelConfigSchema } from "./whatsapp/whatsapp-config.schema.js";
export type { FridayWhatsappChannelConfig } from "./whatsapp/whatsapp-config.schema.js";
export type { WhatsappWebhookService } from "./whatsapp/whatsapp-service.js";
export { createWhatsappApiService, createWhatsappWebhookService } from "./whatsapp/whatsapp-service.js";

// Signal
export { createFridaySignalChannel, normalizeSignalMessage } from "./signal/friday-signal-channel.js";
export type { SignalChannelDeps } from "./signal/friday-signal-channel.js";
export { FridaySignalChannelConfigSchema } from "./signal/signal-config.schema.js";
export type { FridaySignalChannelConfig } from "./signal/signal-config.schema.js";
export { createSignalSseService, createSignalRpcService } from "./signal/signal-service.js";

// Slack
export { createFridaySlackChannel, normalizeSlackMessage } from "./slack/friday-slack-channel.js";
export type { SlackChannelDeps } from "./slack/friday-slack-channel.js";
export { FridaySlackChannelConfigSchema } from "./slack/slack-config.schema.js";
export type { FridaySlackChannelConfig } from "./slack/slack-config.schema.js";
export { createSlackSocketService, createSlackHttpEventService, createSlackWebApiService } from "./slack/slack-service.js";

// Webchat
export { createFridayWebchatChannel, normalizeWebchatMessage } from "./webchat/friday-webchat-channel.js";
export type { WebchatChannelDeps } from "./webchat/friday-webchat-channel.js";
export { FridayWebchatChannelConfigSchema } from "./webchat/webchat-config.schema.js";
export type { FridayWebchatChannelConfig } from "./webchat/webchat-config.schema.js";
export type { WebchatWsService } from "./webchat/webchat-service.js";
export { createWebchatWsService } from "./webchat/webchat-service.js";

// IRC
export { createFridayIrcChannel, normalizeIrcPrivmsg } from "./irc/friday-irc-channel.js";
export type { IrcChannelDeps } from "./irc/friday-irc-channel.js";
export { FridayIrcChannelConfigSchema } from "./irc/irc-config.schema.js";
export type { FridayIrcChannelConfig } from "./irc/irc-config.schema.js";
export { createIrcConnectionService } from "./irc/irc-service.js";

// LINE
export { createFridayLineChannel, normalizeLineWebhookEvent, normalizeLineWebhookPayload } from "./line/friday-line-channel.js";
export type { LineChannelDeps } from "./line/friday-line-channel.js";
export { FridayLineChannelConfigSchema } from "./line/line-config.schema.js";
export type { FridayLineChannelConfig } from "./line/line-config.schema.js";
export type { LineWebhookListenerService } from "./line/line-service.js";
export { createLineApiService, createLineWebhookListenerService } from "./line/line-service.js";
