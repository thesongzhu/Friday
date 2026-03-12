/**
 * Discord channel configuration schema.
 */

import { z } from "zod";

export const FridayDiscordChannelConfigSchema = z.object({
  kind: z.literal("discord"),
  enabled: z.boolean().default(true),
  /** Discord bot token. */
  token: z.string().min(1),
  /** Gateway intents bitmask (default: GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT). */
  intents: z.number().int().default((1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)),
  /** If set, only accept messages from these user IDs. */
  allowedUsers: z.array(z.string()).optional(),
  /** If set, only accept messages from these channel IDs. */
  allowedChannels: z.array(z.string()).optional(),
  /** If true, only respond when the bot is mentioned. */
  requireMention: z.boolean().default(false),
  /** Bot user ID (used for requireMention filtering). */
  botUserId: z.string().optional(),
});

export type FridayDiscordChannelConfig = z.infer<typeof FridayDiscordChannelConfigSchema>;
