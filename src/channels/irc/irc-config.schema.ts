/**
 * IRC channel configuration schema.
 */

import { z } from "zod";

export const FridayIrcChannelConfigSchema = z.object({
  kind: z.literal("irc"),
  enabled: z.boolean().default(true),
  /** IRC server hostname. */
  host: z.string().min(1),
  /** IRC server port. */
  port: z.number().int().positive().default(6667),
  /** Use TLS. */
  tls: z.boolean().default(false),
  /** Bot nickname. */
  nick: z.string().min(1),
  /** Username (ident). */
  username: z.string().optional(),
  /** Server password. */
  password: z.string().optional(),
  /** Channels to join (e.g. ["#general", "#dev"]). */
  channels: z.array(z.string()).default([]),
  /** If set, only respond to these nicks. */
  allowedUsers: z.array(z.string()).optional(),
});

export type FridayIrcChannelConfig = z.infer<typeof FridayIrcChannelConfigSchema>;
