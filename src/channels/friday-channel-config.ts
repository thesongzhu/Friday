/**
 * Channel configuration schema and types.
 *
 * Integrates with Friday's existing config system to define
 * per-channel-instance configuration.
 */

import { z } from "zod";

import { FridayQqChannelConfigSchema } from "./qq/qq-config.schema.js";
import { FridayLarkChannelConfigSchema } from "./lark/lark-config.schema.js";
import { FridayDiscordChannelConfigSchema } from "./discord/discord-config.schema.js";
import { FridayTelegramChannelConfigSchema } from "./telegram/telegram-config.schema.js";
import { FridayWhatsappChannelConfigSchema } from "./whatsapp/whatsapp-config.schema.js";
import { FridaySignalChannelConfigSchema } from "./signal/signal-config.schema.js";
import { FridaySlackChannelConfigSchema } from "./slack/slack-config.schema.js";
import { FridayWebchatChannelConfigSchema } from "./webchat/webchat-config.schema.js";
import { FridayIrcChannelConfigSchema } from "./irc/irc-config.schema.js";
import { FridayLineChannelConfigSchema } from "./line/line-config.schema.js";

// Re-export so existing consumers still work
export { FridayQqChannelConfigSchema, FridayLarkChannelConfigSchema };

// ─── Config Schemas ───

export const FRIDAY_SUPPORTED_CHANNEL_KINDS = [
  "qq",
  "lark",
  "feishu",
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "slack",
  "webchat",
  "irc",
  "line",
] as const;

export type FridaySupportedChannelKind = (typeof FRIDAY_SUPPORTED_CHANNEL_KINDS)[number];

/**
 * Channel kinds that are recognized by the type system (still appear in
 * `FRIDAY_SUPPORTED_CHANNEL_KINDS` for backward-compat schema validation) but
 * MUST NOT be activated at runtime.
 *
 * B1 / GLOBAL_DECISIONS_LOCKED.md: "QQ is unsupported/proof_pending unless
 * fixed and proven." QQ inbound is currently silently dropped by the channel
 * registry's lifecycle/start arbitration (see `friday-channel-registry.ts`
 * `buildStartPromise`). Until that root cause is fixed and end-to-end inbound
 * delivery is proved, QQ must be labeled `unsupported` at every user-facing
 * boundary: setup config validation, channel-registry activation, agent
 * routing, UI.
 *
 * Adding a kind here does NOT delete its schema or types — the underlying
 * source files remain so a future "support QQ" slice can re-enable cleanly
 * once the lifecycle bug is fixed and live proof exists.
 */
export const FRIDAY_UNSUPPORTED_CHANNEL_KINDS: readonly FridaySupportedChannelKind[] = ["qq"] as const;

const UNSUPPORTED_CHANNEL_KIND_SET = new Set<string>(FRIDAY_UNSUPPORTED_CHANNEL_KINDS);

/**
 * Returns `true` if the channel kind is recognized AND not labeled unsupported.
 */
export function isFridayChannelKindSupported(kind: string): boolean {
  return (FRIDAY_SUPPORTED_CHANNEL_KINDS as readonly string[]).includes(kind)
    && !UNSUPPORTED_CHANNEL_KIND_SET.has(kind);
}

export const FridayChannelInstanceConfigSchema = z.discriminatedUnion("kind", [
  FridayQqChannelConfigSchema,
  FridayLarkChannelConfigSchema,
  FridayDiscordChannelConfigSchema,
  FridayTelegramChannelConfigSchema,
  FridayWhatsappChannelConfigSchema,
  FridaySignalChannelConfigSchema,
  FridaySlackChannelConfigSchema,
  FridayWebchatChannelConfigSchema,
  FridayIrcChannelConfigSchema,
  FridayLineChannelConfigSchema,
]);

export const FridayChannelsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  instances: z.array(FridayChannelInstanceConfigSchema).default([]),
});

// ─── Types ───

export type FridayQqChannelConfig = z.infer<typeof FridayQqChannelConfigSchema>;
export type FridayLarkChannelConfig = z.infer<typeof FridayLarkChannelConfigSchema>;
export type FridayChannelInstanceConfig = z.infer<typeof FridayChannelInstanceConfigSchema>;
export type FridayChannelsConfig = z.infer<typeof FridayChannelsConfigSchema>;

// ─── Helpers ───

/** Parse and validate a channels config block. Returns fully defaulted config. */
export function parseFridayChannelsConfig(input: unknown): FridayChannelsConfig {
  return FridayChannelsConfigSchema.parse(input ?? {});
}

/** Returns a default (disabled) channels config. */
export function buildDefaultChannelsConfig(): FridayChannelsConfig {
  return FridayChannelsConfigSchema.parse({});
}
