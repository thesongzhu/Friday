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
  /** Event subscription verification token used by webhook callbacks. */
  verificationToken: z.string().min(1).optional(),
  /** Event subscription encrypt key used for webhook signature verification and decryption. */
  encryptKey: z.string().min(1).optional(),
  /** Use Feishu (China) API endpoints instead of Lark (international). */
  useFeishu: z.boolean().default(false),
  /** If set, only accept messages from these user IDs. */
  allowedUsers: z.array(z.string()).optional(),
  /** If set, only accept messages from these chat IDs. */
  allowedChats: z.array(z.string()).optional(),
  /** Receive mode: websocket (default) or webhook relay. */
  receiveMode: z.enum(["websocket", "webhook"]).default("websocket"),
  /** Setup activation timestamp used to distinguish current chats from stale historical sessions. */
  setupActivatedAt: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.receiveMode === "webhook" && !value.verificationToken) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verificationToken"],
      message: "verificationToken is required when receiveMode=webhook",
    });
  }
});

export type FridayLarkChannelConfig = z.infer<typeof FridayLarkChannelConfigSchema>;
