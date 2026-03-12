/**
 * Web Chat channel configuration schema.
 */

import { z } from "zod";

export const FridayWebchatChannelConfigSchema = z.object({
  kind: z.literal("webchat"),
  enabled: z.boolean().default(true),
  /** WebSocket path for client connections. */
  wsPath: z.string().default("/ws/chat"),
  /** Allowed origins for CORS (empty = all). */
  allowedOrigins: z.array(z.string()).default([]),
  /** Authentication mode. */
  authMode: z.enum(["none", "token", "session"]).default("none"),
  /** Maximum number of concurrent client connections. */
  maxClients: z.number().int().positive().default(100),
});

export type FridayWebchatChannelConfig = z.infer<typeof FridayWebchatChannelConfigSchema>;
