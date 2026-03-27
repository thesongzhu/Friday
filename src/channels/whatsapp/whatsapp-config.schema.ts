/**
 * WhatsApp channel configuration schema.
 */

import { z } from "zod";

export const FridayWhatsappChannelConfigSchema = z.object({
  kind: z.literal("whatsapp"),
  enabled: z.boolean().default(true),
  /** Provider type: official Cloud API or third-party bridge. */
  provider: z.enum(["cloud-api", "bridge"]).default("cloud-api"),
  /** Cloud API access token (required for cloud-api provider). */
  accessToken: z.string().optional(),
  /** Cloud API phone number ID (required for cloud-api provider). */
  phoneNumberId: z.string().optional(),
  /** Bridge URL (required for bridge provider). */
  bridgeUrl: z.string().optional(),
  /** Webhook verify token for incoming messages. */
  webhookVerifyToken: z.string().optional(),
  /** If set, only accept messages from these sender phone numbers. */
  allowedUsers: z.array(z.string()).optional(),
  /** If set, only accept messages from these chat IDs. */
  allowedChats: z.array(z.string()).optional(),
  /** Meta App Secret for webhook HMAC-SHA256 signature validation. Recommended for secure webhook verification. */
  appSecret: z.string().optional(),
});

export type FridayWhatsappChannelConfig = z.infer<typeof FridayWhatsappChannelConfigSchema>;
