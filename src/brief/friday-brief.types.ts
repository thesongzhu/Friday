/**
 * Daily Brief — core types.
 *
 * The daily brief summarizes the user's activity across enabled sources,
 * synthesizes a spoken report via TTS, and delivers it through the user's
 * preferred communication channels with a text transcript retained long term.
 */

// ─── Source kinds ───

/**
 * Discrete data sources the brief can pull from.
 *
 * - `friday_history` — Friday's learning-event ledger (user/assistant messages, tool results).
 * - `git_repos` — User-configured local git repos, aggregated commit activity.
 * - `slack` — Slack messages the user sent/received.
 * - `mail` — Gmail/Outlook mail (sent + high-signal received).
 * - `calendar` — Google/Outlook Calendar events in today's window.
 * - `issues` — Linear / Jira / GitHub Issues activity assigned to or authored by the user.
 */
export type FridayBriefSourceKind =
  | "friday_history"
  | "git_repos"
  | "slack"
  | "mail"
  | "calendar"
  | "issues";

/** All known source kinds, in presentation order. */
export const FRIDAY_BRIEF_SOURCE_KINDS: readonly FridayBriefSourceKind[] = [
  "friday_history",
  "git_repos",
  "slack",
  "mail",
  "calendar",
  "issues",
] as const;

// ─── Channel kinds ───

/** Delivery channels the brief supports. */
export type FridayBriefChannelKind = "wecom" | "telegram" | "email";

/** All known channel kinds, in presentation order. */
export const FRIDAY_BRIEF_CHANNEL_KINDS: readonly FridayBriefChannelKind[] = [
  "wecom",
  "telegram",
  "email",
] as const;

// ─── Length presets ───

export type FridayBriefLength = "short" | "normal" | "long";

/** Target word counts by length preset — guide the summarizer prompt. */
export const FRIDAY_BRIEF_LENGTH_TARGETS: Record<FridayBriefLength, { words: number; seconds: number }> = {
  short: { words: 120, seconds: 60 },
  normal: { words: 260, seconds: 130 },
  long: { words: 520, seconds: 260 },
};

// ─── TTS provider kinds ───

export type FridayBriefTtsProviderKind = "azure" | "google" | "local";

export const FRIDAY_BRIEF_TTS_PROVIDER_KINDS: readonly FridayBriefTtsProviderKind[] = [
  "azure",
  "google",
  "local",
] as const;

// ─── Run status + phase ───

/** Lifecycle of a single brief run. */
export type FridayBriefRunStatus =
  | "pending"
  | "collecting"
  | "summarizing"
  | "synthesizing"
  | "delivering"
  | "delivered"
  | "skipped"
  | "failed";

export type FridayBriefRunTrigger = "scheduled" | "manual_http" | "manual_cli" | "replay";

export type FridayBriefSkipReason =
  | "no_events"
  | "all_sources_disabled"
  | "all_channels_disabled"
  | "all_channels_failed";

// ─── Events (collector → summarizer shape) ───

/**
 * Normalized event produced by a collector.
 *
 * Collectors translate heterogeneous raw data into this single shape so the
 * summarizer can treat all sources uniformly.
 */
export interface FridayBriefEvent {
  /** Which source produced this event. */
  source: FridayBriefSourceKind;
  /** Event occurrence time (ISO). */
  occurredAt: string;
  /** Short identifier within the source (commit sha, message ts, issue id, etc.). */
  externalId: string;
  /** One-line summary for the summarizer to chew on. */
  summary: string;
  /** Optional longer body (commit message, email subject+snippet, issue title). */
  detail?: string;
  /** Optional actor (author, sender, assignee). */
  actor?: string;
  /** Optional tags to help the summarizer group (e.g. repo name, channel name). */
  tags?: readonly string[];
  /** Optional link back to the source. */
  url?: string;
}

/** Source-level collection outcome. */
export interface FridayBriefCollectionResult {
  source: FridayBriefSourceKind;
  /** Normalized events, chronological. */
  events: FridayBriefEvent[];
  /** Duration of the collection call, ms. */
  durationMs: number;
  /** Whether the source was skipped due to config or missing credentials. */
  skipped: boolean;
  /** If skipped or failed, the reason. */
  skipReason?: string;
  /** Error object when collection threw. */
  error?: { code: string; message: string };
}

// ─── Summarization result ───

export interface FridayBriefSummaryBullet {
  source: FridayBriefSourceKind;
  text: string;
}

/** The summarizer produces a structured brief that both TTS and transcript consume. */
export interface FridayBriefSummary {
  /** BCP-47 language tag — auto-detected from source material. */
  language: string;
  /** Short opening paragraph ("你今天完成了..."). */
  opening: string;
  /** Per-source bullets — empty array if source was silent. */
  bullets: FridayBriefSummaryBullet[];
  /** Closing paragraph — optional wrap-up. */
  closing?: string;
  /** The full text used for TTS — ordered opening + bullets + closing. */
  fullText: string;
  /** Total estimated word count. */
  wordCount: number;
}

// ─── Synthesis + delivery results ───

export interface FridayBriefAudioArtifact {
  /** Absolute path — deleted after successful delivery per user preference. */
  filePath: string;
  mimeType: string;
  bytes: number;
  provider: FridayBriefTtsProviderKind;
  voice: string;
  durationSec?: number;
}

export interface FridayBriefDeliveryAttempt {
  channel: FridayBriefChannelKind;
  /** Order in the user's fallback list (0-based). */
  order: number;
  attemptedAt: string;
  /** Platform-assigned message id on success. */
  messageId?: string;
  /** True if audio was attached (false if audio failed and text fallback was sent). */
  audioAttached: boolean;
  ok: boolean;
  error?: { code: string; message: string };
  durationMs: number;
}

// ─── Persisted run record ───

export interface FridayBriefRunRecord {
  id: string;
  triggeredBy: FridayBriefRunTrigger;
  /** ISO — the logical "as-of" time the brief summarizes up to. */
  windowEndAt: string;
  /** ISO — start of the window (typically 00:00 local of the same day). */
  windowStartAt: string;
  status: FridayBriefRunStatus;
  skipReason?: FridayBriefSkipReason;
  /** Text transcript — always retained. */
  transcript?: string;
  /** Detected language of the transcript. */
  language?: string;
  /** Per-source collection results (counts + errors, not event bodies). */
  sourceResults: readonly FridayBriefRunSourceResult[];
  /** Per-channel delivery attempts (in order tried). */
  deliveryAttempts: readonly FridayBriefDeliveryAttempt[];
  /** Audio info if it was synthesized; null after on-disk deletion. */
  audio?: { provider: FridayBriefTtsProviderKind; voice: string; bytes: number; durationSec?: number };
  /** Top-level error for the run (if status is failed). */
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}

export interface FridayBriefRunSourceResult {
  source: FridayBriefSourceKind;
  eventCount: number;
  durationMs: number;
  skipped: boolean;
  skipReason?: string;
  error?: { code: string; message: string };
}
