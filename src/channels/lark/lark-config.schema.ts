/**
 * Lark/Feishu channel configuration schema.
 * P1-CH-001: Runtime config validation via Zod.
 */

import { z } from "zod";

export const FridayLarkChannelConfigSchema = z.object({
  kind: z.enum(["lark", "feishu"]),
  enabled: z.boolean().default(true),
  /** Lark/Feishu application ID. */
  appId: z.string().min(1),
  /** Lark/Feishu application secret. */
  appSecret: z.string().min(1),
  /** Use Feishu (China) API endpoints instead of Lark (international). */
  useFeishu: z.boolean().default(false),
  /** If set, only accept messages from these user IDs. */
  allowedUsers: z.array(z.string()).optional(),
  /** If set, only accept messages from these chat IDs. */
  allowedChats: z.array(z.string()).optional(),
  /** Receive mode: websocket (default) or webhook relay. */
  receiveMode: z.enum(["websocket", "webhook"]).default("websocket"),
});

export type FridayLarkChannelConfig = z.infer<typeof FridayLarkChannelConfigSchema>;
