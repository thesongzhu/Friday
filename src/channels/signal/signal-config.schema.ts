/**
 * Signal channel configuration schema.
 */

import { z } from "zod";

export const FridaySignalChannelConfigSchema = z.object({
  kind: z.literal("signal"),
  enabled: z.boolean().default(true),
  /** signal-cli REST API base URL. */
  baseUrl: z.string().min(1).default("http://localhost:8080"),
  /** Signal account phone number (e.g. "+1234567890"). */
  account: z.string().min(1),
  /** Path to signal-cli binary (optional, for direct CLI mode). */
  cliPath: z.string().optional(),
  /** If set, only accept messages from these sender numbers. */
  allowedUsers: z.array(z.string()).optional(),
});

export type FridaySignalChannelConfig = z.infer<typeof FridaySignalChannelConfigSchema>;
