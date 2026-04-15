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
