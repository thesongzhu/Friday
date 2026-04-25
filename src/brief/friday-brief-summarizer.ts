/**
 * Brief summarizer — turns raw collected events into a spoken narrative.
 *
 * Two paths:
 *  - When an LLM `summarize` function is injected, we delegate (better quality).
 *  - Fallback: a deterministic template-based summarizer that groups by source
 *    and produces a compact narrative. Always runs if the LLM is missing.
 */

import {
  FRIDAY_BRIEF_LENGTH_TARGETS,
  type FridayBriefEvent,
  type FridayBriefLength,
  type FridayBriefSourceKind,
  type FridayBriefSummary,
  type FridayBriefSummaryBullet,
} from "./friday-brief.types.js";

export interface FridayBriefSummarizerDeps {
  /**
   * Optional LLM hook — called when an LLM-backed summarizer is available.
   * When it returns `null` or throws, the deterministic fallback is used.
   */
  llmSummarize?: (input: {
    events: readonly FridayBriefEvent[];
    language: string;
    length: FridayBriefLength;
  }, signal: AbortSignal) => Promise<FridayBriefSummary | null>;
}

export interface FridayBriefSummarizeInput {
  events: readonly FridayBriefEvent[];
  /** Language override — empty string means auto-detect. */
  languageOverride: string;
  length: FridayBriefLength;
  signal: AbortSignal;
}

export interface FridayBriefSummarizer {
  summarize(input: FridayBriefSummarizeInput): Promise<FridayBriefSummary>;
}

// ─── Language detection ───

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

function detectLanguage(events: readonly FridayBriefEvent[], override: string): string {
  if (override) return override;
  let cjk = 0;
  let latin = 0;
  for (const event of events) {
    const sample = `${event.summary} ${event.detail ?? ""}`;
    for (const ch of sample) {
      if (CJK_RE.test(ch)) cjk += 1;
      else if (/[a-zA-Z]/.test(ch)) latin += 1;
    }
  }
  if (cjk === 0 && latin === 0) return "en-US";
  return cjk >= latin ? "zh-CN" : "en-US";
}

// ─── Source label localization ───

const SOURCE_LABELS_ZH: Record<FridayBriefSourceKind, string> = {
  friday_history: "与 Friday 的互动",
  git_repos: "代码提交",
  slack: "Slack 消息",
  mail: "邮件",
  calendar: "日历",
  issues: "任务与工单",
};

const SOURCE_LABELS_EN: Record<FridayBriefSourceKind, string> = {
  friday_history: "Friday interactions",
  git_repos: "code commits",
  slack: "Slack messages",
  mail: "mail",
  calendar: "calendar",
  issues: "issues & tasks",
};

function labelFor(source: FridayBriefSourceKind, language: string): string {
  return language.startsWith("zh") ? SOURCE_LABELS_ZH[source] : SOURCE_LABELS_EN[source];
}

// ─── Grouping + bullet construction ───

function groupEventsBySource(
  events: readonly FridayBriefEvent[],
): Map<FridayBriefSourceKind, FridayBriefEvent[]> {
  const out = new Map<FridayBriefSourceKind, FridayBriefEvent[]>();
  for (const event of events) {
    const list = out.get(event.source) ?? [];
    list.push(event);
    out.set(event.source, list);
  }
  return out;
}

function buildBulletForSource(
  source: FridayBriefSourceKind,
  items: readonly FridayBriefEvent[],
  language: string,
  maxEventsToMention: number,
): FridayBriefSummaryBullet {
  const label = labelFor(source, language);
  const total = items.length;
  const sample = items.slice(0, maxEventsToMention).map((e) => e.summary);
  const countWord = language.startsWith("zh") ? `共 ${total} 条` : `${total} items`;
  const joiner = language.startsWith("zh") ? "，" : "; ";
  const text = `${label}（${countWord}）：${sample.join(joiner)}`;
  return { source, text };
}

function buildOpening(totalEvents: number, language: string): string {
  if (totalEvents === 0) {
    return language.startsWith("zh") ? "今天暂无活动记录。" : "No tracked activity today.";
  }
  return language.startsWith("zh")
    ? `今天你一共有 ${totalEvents} 条活动记录。`
    : `You had ${totalEvents} tracked activities today.`;
}

function buildClosing(language: string): string | undefined {
  return language.startsWith("zh")
    ? "以上就是今天的总结。"
    : "That wraps up today's brief.";
}

function bulletsToFullText(
  opening: string,
  bullets: readonly FridayBriefSummaryBullet[],
  closing: string | undefined,
): string {
  const body = bullets.map((b) => `• ${b.text}`).join("\n");
  return [opening, body, closing].filter(Boolean).join("\n\n").trim();
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  // CJK: roughly one character per word. Latin: count whitespace-separated tokens.
  const cjkChars = trimmed.match(CJK_RE);
  if (cjkChars && cjkChars.length > trimmed.length / 3) return trimmed.length;
  return trimmed.split(/\s+/).length;
}

function deterministicSummarize(
  events: readonly FridayBriefEvent[],
  language: string,
  length: FridayBriefLength,
): FridayBriefSummary {
  const target = FRIDAY_BRIEF_LENGTH_TARGETS[length];
  const maxEventsPerSource = length === "short" ? 2 : length === "normal" ? 4 : 8;
  const grouped = groupEventsBySource(events);
  const opening = buildOpening(events.length, language);
  const bullets: FridayBriefSummaryBullet[] = [];
  for (const [source, items] of grouped) {
    if (items.length === 0) continue;
    items.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
    bullets.push(buildBulletForSource(source, items, language, maxEventsPerSource));
  }
  const closing = events.length > 0 ? buildClosing(language) : undefined;
  let fullText = bulletsToFullText(opening, bullets, closing);
  const wc = wordCount(fullText);
  // If we are over target, truncate longest bullets.
  if (wc > target.words * 1.4 && bullets.length > 0) {
    bullets.sort((a, b) => b.text.length - a.text.length);
    while (bullets.length > 0 && wordCount(bulletsToFullText(opening, bullets, closing)) > target.words * 1.2) {
      const longest = bullets[0];
      if (longest.text.length <= 80) break;
      longest.text = `${longest.text.slice(0, Math.floor(longest.text.length * 0.7))}…`;
    }
    fullText = bulletsToFullText(opening, bullets, closing);
  }
  return {
    language,
    opening,
    bullets,
    closing,
    fullText,
    wordCount: wordCount(fullText),
  };
}

export function createFridayBriefSummarizer(
  deps: FridayBriefSummarizerDeps = {},
): FridayBriefSummarizer {
  return {
    async summarize(input) {
      const language = detectLanguage(input.events, input.languageOverride);
      if (deps.llmSummarize) {
        try {
          const llmOutput = await deps.llmSummarize(
            { events: input.events, language, length: input.length },
            input.signal,
          );
          if (llmOutput) return llmOutput;
        } catch {
          // Fall through to deterministic fallback.
        }
      }
      return deterministicSummarize(input.events, language, input.length);
    },
  };
}
