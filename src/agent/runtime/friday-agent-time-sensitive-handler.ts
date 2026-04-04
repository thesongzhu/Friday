import type {
  FridayAgentContentBlock,
  FridayAgentMessage,
  FridayAgentToolCallRecord,
  FridayAgentToolResult,
} from "../model/friday-agent.types.js";

// ─── Types ───

export interface RunTimeContext {
  nowIso: string;
  timezone: string;
  localDate: string;
}

export interface TimeSensitiveResponseDecision {
  responseText: string;
  retryPrompt?: string;
}

interface TimeSensitiveEvidenceSummary {
  latestnessVerified: boolean;
  warnings: string[];
}

interface TimeSensitiveResponseCoverage {
  satisfied: boolean;
  missingAbsoluteDate: boolean;
  missingDirectUrl: boolean;
  coverageWarning?: string;
}

// ─── Public API ───

export function buildRunTimeContext(
  now: string,
  requestedTimezone: string | undefined,
  preferredTimezone: string | undefined,
): RunTimeContext {
  const timezone = resolveAgentTimezone(requestedTimezone, preferredTimezone);
  return {
    nowIso: now,
    timezone,
    localDate: formatDateInTimezone(now, timezone),
  };
}

export function resolveAgentTimezone(
  requestedTimezone: string | undefined,
  preferredTimezone: string | undefined,
): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const candidates = [
    normalizeIanaTimezone(requestedTimezone),
    normalizeIanaTimezone(preferredTimezone),
    normalizeIanaTimezone(typeof fallback === "string" ? fallback : undefined),
    "UTC",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    return candidate;
  }
  return "UTC";
}

export function normalizeIanaTimezone(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const timezone = value.trim();
  if (timezone.length === 0) return undefined;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch (err) {
    console.warn("[friday][agent-runtime] validate-timezone:", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

export function readPreferredTimezone(preferences: Record<string, unknown>): string | undefined {
  const preferredTimezone = preferences["pref:timezone"];
  return typeof preferredTimezone === "string"
    ? normalizeIanaTimezone(preferredTimezone)
    : undefined;
}

export function formatDateInTimezone(nowIso: string, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(nowIso));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

export function hasTimeSensitiveNewsIntent(
  task: string,
  historyMessages: FridayAgentMessage[],
): boolean {
  if (textHasTimeSensitiveNewsIntent(task)) {
    return true;
  }

  const recentUserMessages = historyMessages
    .filter((message) => message.role === "user")
    .slice(-3);
  return recentUserMessages.some((message) => textHasTimeSensitiveNewsIntent(extractMessageText(message)));
}

export function textHasTimeSensitiveNewsIntent(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  const newsTopicWords =
    /\b(news|headline|headlines|article|articles|report|reports|story|stories)\b/i;
  const timelinessWords =
    /\b(latest|current|today'?s|recent|newest|breaking)\b/i;
  const capabilityWords =
    /\b(capabilities?|what can\b|can (?:friday|you)\b.*\bdo\b|runtime facts?|deployment|enabled|disabled|connected|read[- ]?only|desktop companion|provider mutations?|mcp)\b/i;
  const chineseNewsTopicWords =
    /(新闻|头条|报道|文章|快讯|消息)/;
  const chineseTimelinessWords =
    /(最新|当前|目前|今天|最近|快讯)/;
  const chineseCapabilityWords =
    /(能力|能做什么|运行时|部署|启用|禁用|连接|只读|桌面伴侣|提供者修改|MCP)/;
  if (!newsTopicWords.test(normalized) && !chineseNewsTopicWords.test(normalized)) {
    if (capabilityWords.test(normalized) || chineseCapabilityWords.test(normalized)) {
      return false;
    }
  }
  return (
    (timelinessWords.test(normalized) && newsTopicWords.test(normalized))
    || (chineseTimelinessWords.test(normalized) && chineseNewsTopicWords.test(normalized))
  );
}

export function evaluateTimeSensitiveResponse(params: {
  required: boolean;
  responseText: string;
  toolCalls: FridayAgentToolCallRecord[];
  localDate: string;
  timezone: string;
}): TimeSensitiveResponseDecision {
  if (!params.required) {
    return { responseText: params.responseText };
  }

  const normalized = params.responseText.trim();
  const explicitCaveat = responseAcknowledgesTimelinessUnverified(
    normalized,
    params.localDate,
    params.timezone,
  );
  const coverage = evaluateTimeSensitiveResponseCoverage(normalized);
  const evidence = summarizeTimeSensitiveEvidence(params.toolCalls);

  if (evidence.latestnessVerified && coverage.satisfied) {
    return { responseText: params.responseText };
  }

  if (explicitCaveat) {
    return { responseText: params.responseText };
  }

  const caveatedResponse = appendTimelinessCaveat({
    responseText: params.responseText,
    localDate: params.localDate,
    timezone: params.timezone,
    evidence,
    missingAbsoluteDate: coverage.missingAbsoluteDate,
    missingDirectUrl: coverage.missingDirectUrl,
    coverageWarning: coverage.coverageWarning,
  });

  return {
    responseText: caveatedResponse,
    retryPrompt: buildTimelinessRetryPrompt({
      localDate: params.localDate,
      timezone: params.timezone,
      evidence,
      missingAbsoluteDate: coverage.missingAbsoluteDate,
      missingDirectUrl: coverage.missingDirectUrl,
      coverageWarning: coverage.coverageWarning,
    }),
  };
}

// ─── Internal Helpers ───

function summarizeTimeSensitiveEvidence(
  toolCalls: FridayAgentToolCallRecord[],
): TimeSensitiveEvidenceSummary {
  let latestnessVerified = false;
  const warnings = new Set<string>();

  for (const call of toolCalls) {
    if (call.result.isError) continue;

    if (call.toolName === "web_search") {
      const metadata = readWebSearchMetadata(call.result);
      if (metadata?.warning) {
        warnings.add(metadata.warning);
      }
      if (metadata?.freshnessApplied && metadata?.hasDates) {
        latestnessVerified = true;
      }
      continue;
    }
  }

  return {
    latestnessVerified,
    warnings: [...warnings],
  };
}

function readWebSearchMetadata(
  result: FridayAgentToolResult,
): {
  provider?: string;
  freshnessApplied?: boolean;
  hasDates?: boolean;
  warning?: string | null;
} | null {
  const raw = result.metadata;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as {
    provider?: string;
    freshnessApplied?: boolean;
    hasDates?: boolean;
    warning?: string | null;
  };
}

function appendTimelinessCaveat(params: {
  responseText: string;
  localDate: string;
  timezone: string;
  evidence: TimeSensitiveEvidenceSummary;
  missingAbsoluteDate: boolean;
  missingDirectUrl: boolean;
  coverageWarning?: string;
}): string {
  const reasons: string[] = [];
  if (!params.evidence.latestnessVerified) {
    reasons.push("the available tool evidence did not verify both recency filtering and publication dates");
  }
  if (params.missingAbsoluteDate) {
    reasons.push("the response omits absolute publication dates");
  }
  if (params.missingDirectUrl) {
    reasons.push("the response omits direct source URLs");
  }
  if (params.coverageWarning) {
    reasons.push(params.coverageWarning);
  }
  for (const warning of params.evidence.warnings) {
    reasons.push(warning);
  }
  const reasonText = reasons.length > 0
    ? reasons.join("; ")
    : "the available evidence is insufficient";
  const caveat =
    `Caveat: I could not verify that these are the latest results as of ${params.localDate} (${params.timezone}) because ${reasonText}. ` +
    "Treat the items above as unverified search results, not confirmed latest news.";
  return params.responseText.trim().length > 0
    ? `${params.responseText.trim()}\n\n${caveat}`
    : caveat;
}

function buildTimelinessRetryPrompt(params: {
  localDate: string;
  timezone: string;
  evidence: TimeSensitiveEvidenceSummary;
  missingAbsoluteDate: boolean;
  missingDirectUrl: boolean;
  coverageWarning?: string;
}): string {
  const gaps: string[] = [];
  if (!params.evidence.latestnessVerified) {
    gaps.push("your tool evidence did not verify recency plus publication dates");
  }
  if (params.missingAbsoluteDate) {
    gaps.push("your answer is missing absolute publication dates");
  }
  if (params.missingDirectUrl) {
    gaps.push("your answer is missing direct source URLs");
  }
  if (params.coverageWarning) {
    gaps.push(params.coverageWarning);
  }
  const warningText = params.evidence.warnings.length > 0
    ? ` Tool warnings: ${params.evidence.warnings.join(" ")}`
    : "";
  return (
    `System verification: this is a time-sensitive latest/news request. ${gaps.join("; ")}.` +
    ` Use tool evidence to either (1) provide the answer with absolute publication dates and direct source URLs for each item,` +
    ` or (2) explicitly say you cannot verify the latestness as of ${params.localDate} (${params.timezone}).${warningText}`
  );
}

function responseContainsAbsoluteDate(text: string): boolean {
  if (text.trim().length === 0) return false;
  return (
    /\b\d{4}-\d{2}-\d{2}\b/.test(text)
    || /\b\d{4}\/\d{1,2}\/\d{1,2}\b/.test(text)
    || /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i.test(text)
    || /\b\d{4}年\d{1,2}月\d{1,2}日\b/.test(text)
  );
}

function responseContainsDirectUrl(text: string): boolean {
  return /https?:\/\/\S+/i.test(text);
}

function evaluateTimeSensitiveResponseCoverage(text: string): TimeSensitiveResponseCoverage {
  const hasAbsoluteDate = responseContainsAbsoluteDate(text);
  const hasDirectUrl = responseContainsDirectUrl(text);
  const items = extractStructuredListItems(text);

  if (items.length >= 2) {
    const missingItemDate = items.some((item) => !responseContainsAbsoluteDate(item));
    const missingItemUrl = items.some((item) => !responseContainsDirectUrl(item));
    return {
      satisfied: !missingItemDate && !missingItemUrl,
      missingAbsoluteDate: missingItemDate,
      missingDirectUrl: missingItemUrl,
      coverageWarning: missingItemDate || missingItemUrl
        ? "not every listed item includes its own absolute publication date and direct source URL"
        : undefined,
    };
  }

  if (responseClaimsMultipleItems(text)) {
    return {
      satisfied: false,
      missingAbsoluteDate: !hasAbsoluteDate,
      missingDirectUrl: !hasDirectUrl,
      coverageWarning: "the response claims multiple items but does not structure them item-by-item",
    };
  }

  return {
    satisfied: hasAbsoluteDate && hasDirectUrl,
    missingAbsoluteDate: !hasAbsoluteDate,
    missingDirectUrl: !hasDirectUrl,
  };
}

function extractStructuredListItems(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const items: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const markerLine = line.replace(/\*\*/g, "").trim();
    if (/^(?:\d+[\.\)\u3001]|[-*•])\s+/.test(markerLine)) {
      if (current.length > 0) {
        items.push(current.join("\n"));
      }
      current = [line];
      continue;
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    items.push(current.join("\n"));
  }

  return items.length >= 2 ? items : [];
}

function responseClaimsMultipleItems(text: string): boolean {
  return (
    /\b(?:2|3|4|5|two|three|four|five|several)\b.{0,20}\b(?:items?|results?|articles?|stories|news|headlines)\b/i.test(text)
    || /(两条|两则|二条|二则|三条|三则|四条|四则|五条|五则).{0,12}(新闻|结果|报道|消息)/.test(text)
  );
}

function responseAcknowledgesTimelinessUnverified(
  text: string,
  localDate: string,
  timezone: string,
): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) return false;
  const acknowledgesLatestness = (
    /\b(cannot|could not|can't|unable to)\b.{0,40}\b(verify|confirm)\b.{0,40}\b(latest|latestness|current|today)\b/i.test(normalized)
    || /\b(latest|latestness)\b.{0,40}\b(unverified|not verified|could not be verified)\b/i.test(normalized)
    || /(无法|不能|未能).{0,20}(验证|确认).{0,20}(最新|截至|今天)/.test(normalized)
    || /(最新|截至今天).{0,20}(未验证|无法确认|不能确认)/.test(normalized)
  );
  return acknowledgesLatestness
    && normalized.includes(localDate)
    && normalized.includes(timezone);
}

export function extractMessageText(message: FridayAgentMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((block): block is Extract<FridayAgentContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
