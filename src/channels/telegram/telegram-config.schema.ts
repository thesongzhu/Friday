/**
 * Telegram channel configuration schema.
 */

import { z } from "zod";

export const FridayTelegramChannelConfigSchema = z.object({
  kind: z.literal("telegram"),
  enabled: z.boolean().default(true),
  /** Telegram Bot API token. */
  botToken: z.string().min(1),
  /** Receive mode: long polling or webhook. */
  mode: z.enum(["polling", "webhook"]).default("polling"),
  /** Webhook URL (required if mode is "webhook"). */
  webhookUrl: z.string().optional(),
  /** If set, only accept messages from these user IDs. */
  allowedUsers: z.array(z.string()).optional(),
  /** If set, only accept messages from these chat IDs. */
  allowedChats: z.array(z.string()).optional(),
});

export type FridayTelegramChannelConfig = z.infer<typeof FridayTelegramChannelConfigSchema>;
