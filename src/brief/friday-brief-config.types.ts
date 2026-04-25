/**
 * Daily Brief — configuration schema.
 *
 * The user controls:
 * - Which sources are enabled + per-source settings (paths, tokens, filters)
 * - Which channels are enabled + fallback order
 * - Which TTS provider + voice
 * - Schedule (cron expression)
 * - Length + timezone + optional transcript delivery
 */

import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

import {
  FRIDAY_BRIEF_CHANNEL_KINDS,
  FRIDAY_BRIEF_SOURCE_KINDS,
  FRIDAY_BRIEF_TTS_PROVIDER_KINDS,
} from "./friday-brief.types.js";

function isValidCron(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─── Source configs ───

export const FridayBriefFridayHistorySourceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Learning-event kinds to include. Empty → default curated set. */
  includeKinds: z.array(z.string()).default([]),
});

export const FridayBriefGitRepoConfigSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1),
  /** Optional author filter (email or name match). Empty → include all authors. */
  authors: z.array(z.string()).default([]),
  /** Branches to include. Empty → current HEAD only. */
  branches: z.array(z.string()).default([]),
});

export const FridayBriefGitSourceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  repos: z.array(FridayBriefGitRepoConfigSchema).default([]),
});

export const FridayBriefSlackSourceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Bot user OAuth token ref (secret scope+key). */
  tokenRefKey: z.string().min(1).optional(),
  /** User id — used to filter messages authored by the user. */
  userId: z.string().min(1).optional(),
  /** Channels to include (id prefixed). Empty → all accessible channels. */
  channels: z.array(z.string()).default([]),
  /** Include DMs alongside channels. */
  includeDms: z.boolean().default(true),
});

export const FridayBriefMailSourceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Mail provider. */
  provider: z.enum(["gmail", "outlook"]).optional(),
  /** OAuth credential ref key (resolves to access/refresh tokens). */
  credentialRefKey: z.string().min(1).optional(),
  /** Account email the user operates under. */
  account: z.string().email().optional(),
  /** Whether to include high-signal received mail (from VIP senders). */
  includeReceived: z.boolean().default(true),
  /** VIP sender emails — always include when received. */
  vipSenders: z.array(z.string()).default([]),
});

export const FridayBriefCalendarSourceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["google", "outlook"]).optional(),
  credentialRefKey: z.string().min(1).optional(),
  account: z.string().email().optional(),
  /** Calendar ids to include. Empty → primary calendar only. */
  calendarIds: z.array(z.string()).default([]),
  /** Whether to include declined events. */
  includeDeclined: z.boolean().default(false),
});

export const FridayBriefIssuesLinearConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apiKeyRefKey: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
});

export const FridayBriefIssuesJiraConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Jira site url (https://your-company.atlassian.net). */
  baseUrl: z.string().url().optional(),
  /** Email + API token tuple stored as JSON under this ref key. */
  credentialRefKey: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
});

export const FridayBriefIssuesGithubConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Personal access token ref key. */
  tokenRefKey: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  /** Repos to scope (owner/repo). Empty → all the token can see. */
  repos: z.array(z.string()).default([]),
});

export const FridayBriefIssuesSourceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  linear: FridayBriefIssuesLinearConfigSchema.default(() =>
    FridayBriefIssuesLinearConfigSchema.parse({}),
  ),
  jira: FridayBriefIssuesJiraConfigSchema.default(() =>
    FridayBriefIssuesJiraConfigSchema.parse({}),
  ),
  github: FridayBriefIssuesGithubConfigSchema.default(() =>
    FridayBriefIssuesGithubConfigSchema.parse({}),
  ),
});

export const FridayBriefSourcesConfigSchema = z.object({
  friday_history: FridayBriefFridayHistorySourceConfigSchema.default(() =>
    FridayBriefFridayHistorySourceConfigSchema.parse({}),
  ),
  git_repos: FridayBriefGitSourceConfigSchema.default(() =>
    FridayBriefGitSourceConfigSchema.parse({}),
  ),
  slack: FridayBriefSlackSourceConfigSchema.default(() =>
    FridayBriefSlackSourceConfigSchema.parse({}),
  ),
  mail: FridayBriefMailSourceConfigSchema.default(() =>
    FridayBriefMailSourceConfigSchema.parse({}),
  ),
  calendar: FridayBriefCalendarSourceConfigSchema.default(() =>
    FridayBriefCalendarSourceConfigSchema.parse({}),
  ),
  issues: FridayBriefIssuesSourceConfigSchema.default(() =>
    FridayBriefIssuesSourceConfigSchema.parse({}),
  ),
});

// ─── Channel configs ───

export const FridayBriefWeComChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** 企业微信 corp id. */
  corpId: z.string().min(1).optional(),
  /** 自建应用 agent id (number as string). */
  agentId: z.string().min(1).optional(),
  /** Secret ref key — resolves to the corp-secret. */
  secretRefKey: z.string().min(1).optional(),
  /** Recipient user ids (pipe-separated per WeCom convention) or @all. */
  toUser: z.string().default("@all"),
});

export const FridayBriefTelegramChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Reuses existing Telegram bot token. Required unless we share with general telegram channel. */
  botTokenRefKey: z.string().min(1).optional(),
  /** Target chat id — typically the user's DM chat id. */
  chatId: z.string().min(1).optional(),
});

export const FridayBriefEmailChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** SMTP host. */
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).default(465),
  secure: z.boolean().default(true),
  /** SMTP username. */
  username: z.string().min(1).optional(),
  /** SMTP password ref key. */
  passwordRefKey: z.string().min(1).optional(),
  fromAddress: z.string().email().optional(),
  fromName: z.string().default("Friday"),
  /** Recipient email address. */
  toAddress: z.string().email().optional(),
});

export const FridayBriefChannelsConfigSchema = z.object({
  wecom: FridayBriefWeComChannelConfigSchema.default(() =>
    FridayBriefWeComChannelConfigSchema.parse({}),
  ),
  telegram: FridayBriefTelegramChannelConfigSchema.default(() =>
    FridayBriefTelegramChannelConfigSchema.parse({}),
  ),
  email: FridayBriefEmailChannelConfigSchema.default(() =>
    FridayBriefEmailChannelConfigSchema.parse({}),
  ),
});

// ─── TTS config ───

export const FridayBriefAzureTtsConfigSchema = z.object({
  /** Azure region (e.g. "eastus"). */
  region: z.string().min(1).optional(),
  /** Subscription key ref key. */
  keyRefKey: z.string().min(1).optional(),
  /** Voice name (e.g. "zh-CN-XiaoxiaoNeural"). Language auto-switched at runtime. */
  voice: z.string().default("zh-CN-XiaoxiaoNeural"),
  /** Voice for English content. */
  voiceEn: z.string().default("en-US-AvaNeural"),
});

export const FridayBriefGoogleTtsConfigSchema = z.object({
  /** Google Cloud API key ref key (alternative: service-account JSON ref). */
  apiKeyRefKey: z.string().min(1).optional(),
  /** Default voice name (e.g. "cmn-CN-Wavenet-A"). */
  voice: z.string().default("cmn-CN-Wavenet-A"),
  voiceEn: z.string().default("en-US-Neural2-F"),
});

export const FridayBriefLocalTtsConfigSchema = z.object({
  /** macOS `say` voice for CJK content (e.g. "Tingting"). */
  voice: z.string().default("Tingting"),
  /** macOS `say` voice for English content. */
  voiceEn: z.string().default("Samantha"),
});

export const FridayBriefTtsConfigSchema = z.object({
  provider: z.enum(FRIDAY_BRIEF_TTS_PROVIDER_KINDS).default("azure"),
  azure: FridayBriefAzureTtsConfigSchema.default(() =>
    FridayBriefAzureTtsConfigSchema.parse({}),
  ),
  google: FridayBriefGoogleTtsConfigSchema.default(() =>
    FridayBriefGoogleTtsConfigSchema.parse({}),
  ),
  local: FridayBriefLocalTtsConfigSchema.default(() =>
    FridayBriefLocalTtsConfigSchema.parse({}),
  ),
});

// ─── Top-level config ───

export const FridayBriefConfigSchema = z.object({
  /** Feature kill switch. */
  enabled: z.boolean().default(false),
  /** Cron expression (supports 5-field standard). */
  cronExpression: z
    .string()
    .default("0 20 * * *")
    .refine(isValidCron, { message: "invalid cron expression" }),
  /** IANA timezone for the cron expression. */
  timezone: z
    .string()
    .default("Asia/Shanghai")
    .refine(isValidTimezone, { message: "invalid IANA timezone" }),
  /** Length preset. */
  length: z.enum(["short", "normal", "long"]).default("normal"),
  /** Whether to attach the text transcript alongside audio. */
  includeTranscript: z.boolean().default(false),
  /** Language override — empty = auto-detect from sources. */
  languageOverride: z.string().default(""),
  /** Fallback channel order — first enabled channel attempted first. */
  fallbackOrder: z
    .array(z.enum(FRIDAY_BRIEF_CHANNEL_KINDS))
    .default(["wecom", "telegram", "email"]),
  sources: FridayBriefSourcesConfigSchema.default(() =>
    FridayBriefSourcesConfigSchema.parse({}),
  ),
  channels: FridayBriefChannelsConfigSchema.default(() =>
    FridayBriefChannelsConfigSchema.parse({}),
  ),
  tts: FridayBriefTtsConfigSchema.default(() =>
    FridayBriefTtsConfigSchema.parse({}),
  ),
  updatedAt: z.string().optional(),
});

export type FridayBriefConfig = z.infer<typeof FridayBriefConfigSchema>;
export type FridayBriefSourcesConfig = z.infer<typeof FridayBriefSourcesConfigSchema>;
export type FridayBriefChannelsConfig = z.infer<typeof FridayBriefChannelsConfigSchema>;
export type FridayBriefTtsConfig = z.infer<typeof FridayBriefTtsConfigSchema>;
export type FridayBriefWeComChannelConfig = z.infer<typeof FridayBriefWeComChannelConfigSchema>;
export type FridayBriefEmailChannelConfig = z.infer<typeof FridayBriefEmailChannelConfigSchema>;
export type FridayBriefGitRepoConfig = z.infer<typeof FridayBriefGitRepoConfigSchema>;
export type FridayBriefSlackSourceConfig = z.infer<typeof FridayBriefSlackSourceConfigSchema>;
export type FridayBriefMailSourceConfig = z.infer<typeof FridayBriefMailSourceConfigSchema>;
export type FridayBriefCalendarSourceConfig = z.infer<typeof FridayBriefCalendarSourceConfigSchema>;
export type FridayBriefIssuesSourceConfig = z.infer<typeof FridayBriefIssuesSourceConfigSchema>;

/** Build a blank config with defaults applied — used at first boot. */
export function buildDefaultFridayBriefConfig(): FridayBriefConfig {
  return FridayBriefConfigSchema.parse({});
}

/**
 * Sanitizer — ensures the canonical fallbackOrder contains every channel kind
 * exactly once. User drag-reordering cannot accidentally drop or duplicate entries.
 */
export function normalizeFridayBriefFallbackOrder(
  input: readonly string[] | undefined,
): Array<"wecom" | "telegram" | "email"> {
  const valid = new Set(FRIDAY_BRIEF_CHANNEL_KINDS);
  const out: Array<"wecom" | "telegram" | "email"> = [];
  const seen = new Set<string>();
  for (const kind of input ?? []) {
    if (valid.has(kind as "wecom" | "telegram" | "email") && !seen.has(kind)) {
      out.push(kind as "wecom" | "telegram" | "email");
      seen.add(kind);
    }
  }
  for (const kind of FRIDAY_BRIEF_CHANNEL_KINDS) {
    if (!seen.has(kind)) {
      out.push(kind);
      seen.add(kind);
    }
  }
  return out;
}

/** Re-exports for external consumers. */
export {
  FRIDAY_BRIEF_CHANNEL_KINDS,
  FRIDAY_BRIEF_SOURCE_KINDS,
  FRIDAY_BRIEF_TTS_PROVIDER_KINDS,
};
