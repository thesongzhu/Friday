import type { FridayProviderInferenceClient } from "#skills/generator";

import {
  FRIDAY_BRIEF_LENGTH_TARGETS,
  FRIDAY_BRIEF_SOURCE_KINDS,
  type FridayBriefEvent,
  type FridayBriefLength,
  type FridayBriefSourceKind,
  type FridayBriefSummary,
  type FridayBriefSummaryBullet,
} from "./friday-brief.types.js";

export interface FridayBriefLlmSummarizeDeps {
  inferenceClient: FridayProviderInferenceClient;
}

interface RawBriefSummary {
  opening: string;
  paragraphs: string[];
  closing?: string;
}

function buildSystemPrompt(language: string, length: FridayBriefLength): string {
  const target = FRIDAY_BRIEF_LENGTH_TARGETS[length];
  const zh = language.startsWith("zh");
  const langName = zh ? "Simplified Chinese" : "English";
  const openingSample = zh
    ? '欢迎回来，这里是 Friday 每日播报。今天是 …'
    : "Welcome back. I'm Friday, and here's your day.";
  const closingSample = zh
    ? '就到这里，我们明天见。'
    : "That's your day. I'll be back tomorrow.";
  const transitionSample = zh
    ? '午后…、紧接着…、一天快结束时…'
    : "Around midday…, Not long after…, As the day wound down…";

  return [
    "You are the host of the user's personal daily podcast, \"Friday Daily.\"",
    "You are both a narrator and a companion: first-person in the opening and closing, second-person (\"you\") in the body.",
    `Deliver a spoken brief of roughly ${target.words} words (~${Math.round(target.seconds / 60)} minutes). This is audio-first — TTS reads it aloud.`,
    `Language: write everything in ${langName}.`,
    "",
    "Tone:",
    "- Warm, curious, unhurried. Think The Daily / Ezra Klein Show intros plus an NPR sign-off.",
    "- Conversational. Full sentences, natural rhythm, room to breathe.",
    "- No bullet points, no headers, no lists, no emoji, no markdown.",
    "- Never read raw timestamps or IDs aloud. Translate \"2026-04-24T14:32:00Z\" into phrases like \"mid-afternoon\" or \"just after lunch.\"",
    "",
    "What the brief MUST cover (this is the whole point — skip the vibes, tell the actual story):",
    "- What the user asked Friday to do today, and what threads kept coming up.",
    "- What workflows and agent tasks ran, how many, which completed, which failed and why (quote the failure_message when you have it).",
    "- What went wrong: incidents, errors, unhealthy signals (e.g. a heartbeat flagging an unhealthy gateway).",
    "- How Friday responded or self-fixed: diagnoses, auto-fix actions and their outcome, lessons learned.",
    "- Progress markers: how much of the recurring work completed, what's still outstanding.",
    "- End with a short, grounded recommendation or next-step tied to what actually happened — not generic advice.",
    "",
    "Hard rules on content:",
    "- Every paragraph must reference at least one concrete fact from the input (a task name, workflow name, incident category, counts, failure reason, learned-lesson title, user question).",
    "- No vague feelings, no \"busy day,\" no \"lots of activity,\" no \"many events\" without naming what they were.",
    "- If the input is thin or noisy (e.g. only heartbeats and eval runs), say so plainly and keep it short — do not pad.",
    "- Do not invent data. If a number, name, or cause is not in the input, do not mention it.",
    "",
    "Structure (narrative, not per-source):",
    `- opening: a host-style welcome in first person. E.g. "${openingSample}"`,
    "- paragraphs: 3 to 5 flowing paragraphs in second person, walking the user through their day as a single story of what was done, what broke, what Friday figured out, and what's next.",
    "  * Weave events by theme or timeline, not by data source. Never say \"in your Slack messages\" or \"from git.\"",
    `  * Use natural transitions between paragraphs (e.g. "${transitionSample}").`,
    "  * Name 2 to 3 specific items by their real text — workflow names, task prompts, incident categories, lesson titles. Give each one a beat of context (what happened, why it mattered, how it resolved).",
    "  * Summarize the repetitive stuff at a higher level (e.g. \"the usual rhythm of heartbeat checks\") instead of reading every duplicate.",
    `- closing: a host-style sign-off in first person. E.g. "${closingSample}" End on a concrete next-step or recommendation grounded in today's events.`,
    "",
    "Return a single JSON object matching this TypeScript type (no prose, no markdown fences):",
    "{",
    '  "opening": string,',
    '  "paragraphs": string[],',
    '  "closing"?: string',
    "}",
  ].join("\n");
}

function buildUserPrompt(events: readonly FridayBriefEvent[]): string {
  const grouped = new Map<FridayBriefSourceKind, FridayBriefEvent[]>();
  for (const event of events) {
    const bucket = grouped.get(event.source) ?? [];
    bucket.push(event);
    grouped.set(event.source, bucket);
  }
  const lines: string[] = [];
  lines.push(`Today's raw material — ${events.length} events across ${grouped.size} sources.`);
  lines.push("Each event has a timestamp, an optional actor, tags, a summary line, and sometimes a detail body.");
  lines.push("Use these to craft the narrative. Do not expose source labels or timestamps verbatim in your output.");
  for (const source of FRIDAY_BRIEF_SOURCE_KINDS) {
    const items = grouped.get(source);
    if (!items || items.length === 0) continue;
    lines.push("");
    lines.push(`## ${source} (${items.length})`);
    items.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
    for (const event of items.slice(0, 40)) {
      const actor = event.actor ? ` @${event.actor}` : "";
      const tags = event.tags && event.tags.length > 0 ? ` [${event.tags.join(", ")}]` : "";
      const detail = event.detail ? ` — ${event.detail.slice(0, 260)}` : "";
      lines.push(`- ${event.occurredAt}${actor}${tags}: ${event.summary}${detail}`);
    }
    if (items.length > 40) {
      lines.push(`- …and ${items.length - 40} more`);
    }
  }
  return lines.join("\n");
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const cjk = trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  if (cjk && cjk.length > trimmed.length / 3) return trimmed.length;
  return trimmed.split(/\s+/).length;
}

function assembleFullText(
  opening: string,
  paragraphs: readonly string[],
  closing: string | undefined,
): string {
  return [opening, ...paragraphs, closing]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n")
    .trim();
}

function dominantSource(events: readonly FridayBriefEvent[]): FridayBriefSourceKind {
  const counts = new Map<FridayBriefSourceKind, number>();
  for (const event of events) {
    counts.set(event.source, (counts.get(event.source) ?? 0) + 1);
  }
  let best: FridayBriefSourceKind = "friday_history";
  let bestCount = -1;
  for (const source of FRIDAY_BRIEF_SOURCE_KINDS) {
    const c = counts.get(source) ?? 0;
    if (c > bestCount) {
      best = source;
      bestCount = c;
    }
  }
  return best;
}

function normalizeRaw(
  raw: RawBriefSummary,
  language: string,
  events: readonly FridayBriefEvent[],
): FridayBriefSummary | null {
  if (!raw || typeof raw.opening !== "string" || !Array.isArray(raw.paragraphs)) return null;
  const opening = raw.opening.trim();
  if (opening.length === 0) return null;
  const paragraphs: string[] = [];
  for (const item of raw.paragraphs) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text.length === 0) continue;
    paragraphs.push(text);
  }
  if (paragraphs.length === 0) return null;
  const closing = typeof raw.closing === "string" && raw.closing.trim().length > 0
    ? raw.closing.trim()
    : undefined;
  const anchorSource = dominantSource(events);
  const bullets: FridayBriefSummaryBullet[] = paragraphs.map((text) => ({
    source: anchorSource,
    text,
  }));
  const fullText = assembleFullText(opening, paragraphs, closing);
  return {
    language,
    opening,
    bullets,
    closing,
    fullText,
    wordCount: wordCount(fullText),
  };
}

/**
 * Build an `llmSummarize` function suitable for `createFridayBriefSummarizer`.
 *
 * Uses the shared Friday provider inference client, which routes through the
 * user's configured chat providers. Returns `null` on any failure so the
 * deterministic fallback kicks in.
 */
export function createFridayBriefLlmSummarize(
  deps: FridayBriefLlmSummarizeDeps,
): (
  input: { events: readonly FridayBriefEvent[]; language: string; length: FridayBriefLength },
  signal: AbortSignal,
) => Promise<FridayBriefSummary | null> {
  return async (input, signal) => {
    if (input.events.length === 0) return null;
    if (signal.aborted) return null;
    try {
      const result = await deps.inferenceClient.infer<RawBriefSummary>({
        prompt: {
          system: buildSystemPrompt(input.language, input.length),
          user: buildUserPrompt(input.events),
        },
        taskProfile: "planning",
      });
      return normalizeRaw(result.parsed, input.language, input.events);
    } catch {
      return null;
    }
  };
}
