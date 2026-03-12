/**
 * Slack channel configuration schema.
 */

import { z } from "zod";

export const FridaySlackChannelConfigSchema = z.object({
  kind: z.literal("slack"),
  enabled: z.boolean().default(true),
  /** Slack Bot User OAuth Token (xoxb-...). */
  botToken: z.string().min(1),
  /** Slack App-Level Token for Socket Mode (xapp-...). */
  appToken: z.string().optional(),
  /** Connection mode: Socket Mode or HTTP events. */
  mode: z.enum(["socket", "http"]).default("socket"),
  /** Slack Signing Secret (required for HTTP mode). */
  signingSecret: z.string().optional(),
  /** If set, only accept messages from these user IDs. */
  allowedUsers: z.array(z.string()).optional(),
  /** If set, only accept messages from these channel IDs. */
  allowedChannels: z.array(z.string()).optional(),
});

export type FridaySlackChannelConfig = z.infer<typeof FridaySlackChannelConfigSchema>;
