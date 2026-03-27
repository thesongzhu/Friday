/**
 * QQ channel configuration schema.
 * P1-CH-001: Runtime config validation via Zod.
 */

import { z } from "zod";

export const FridayQqChannelConfigSchema = z.object({
  kind: z.literal("qq"),
  enabled: z.boolean().default(true),
  /** QQ Bot application ID. */
  appId: z.string().min(1),
  /** QQ Bot application secret. */
  appSecret: z.string().min(1),
  /** Use QQ sandbox environment. */
  sandbox: z.boolean().default(false),
  /** If set, only accept messages from these user IDs. */
  allowedUsers: z.array(z.string()).optional(),
  /** If set, only accept messages from these group IDs. */
  allowedGroups: z.array(z.string()).optional(),
});

export type FridayQqChannelConfig = z.infer<typeof FridayQqChannelConfigSchema>;
