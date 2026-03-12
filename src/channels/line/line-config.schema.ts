/**
 * LINE channel configuration schema.
 */

import { z } from "zod";

export const FridayLineChannelConfigSchema = z.object({
  kind: z.literal("line"),
  enabled: z.boolean().default(true),
  /** LINE Channel Access Token. */
  channelAccessToken: z.string().min(1),
  /** LINE Channel Secret (for webhook signature validation). */
  channelSecret: z.string().min(1),
  /** Webhook path to listen on. */
  webhookPath: z.string().default("/webhook/line"),
  /** If set, only accept messages from these user IDs. */
  allowedUsers: z.array(z.string()).optional(),
  /** If set, only accept messages from these group IDs. */
  allowedGroups: z.array(z.string()).optional(),
});

export type FridayLineChannelConfig = z.infer<typeof FridayLineChannelConfigSchema>;
