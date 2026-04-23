import type { FridaySessionMessageRecord, FridaySessionRecord } from "@/lib/api/types";

export interface FridayChannelChatHandoffExcerpt {
  role: "user" | "assistant";
  text: string;
}

export interface FridayChannelChatHandoffPayload {
  id: string;
  sourceSessionKey: string;
  sourceChannel: string;
  sourceDisplayName: string;
  sourceChatId: string;
  sourceChatKind: string;
  sourceMessageCount: number;
  sourceLastActivityAt?: string;
  topicSummary?: string;
  latestUserMessage?: string;
  latestAssistantMessage?: string;
  excerpts: FridayChannelChatHandoffExcerpt[];
  createdAt: string;
}

const HANDOFF_STORAGE_PREFIX = "friday-chat-handoff:";
const HANDOFF_LATEST_KEY = "friday-chat-handoff-latest";
const MAX_EXCERPT_LENGTH = 220;
const MAX_EXCERPTS = 4;

function truncate(text: string, maxLength = MAX_EXCERPT_LENGTH): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function readTopicSummary(session: FridaySessionRecord): string | undefined {
  const metadata = session.metadata as Record<string, unknown> | undefined;
  const focus = metadata?.conversationFocus;
  if (!focus || typeof focus !== "object" || Array.isArray(focus)) {
    return undefined;
  }
  const candidate = (focus as Record<string, unknown>).currentTopicSummary;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? truncate(candidate, 140)
    : undefined;
}

function toRenderableExcerpt(record: FridaySessionMessageRecord): FridayChannelChatHandoffExcerpt | null {
  if (record.role !== "user" && record.role !== "assistant") {
    return null;
  }
  const rawText = typeof record.contentText === "string" && record.contentText.trim().length > 0
    ? record.contentText
    : typeof record.content === "string"
      ? record.content
      : "";
  const text = truncate(rawText);
  if (!text) {
    return null;
  }
  return {
    role: record.role,
    text,
  };
}

export function buildChannelChatHandoffPayload(input: {
  session: FridaySessionRecord;
  displayName: string;
  messages: FridaySessionMessageRecord[];
  nowIso?: () => string;
}): FridayChannelChatHandoffPayload {
  const topicSummary = readTopicSummary(input.session);
  const excerpts = input.messages
    .filter((record) => record.role === "user" || record.role === "assistant")
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-MAX_EXCERPTS)
    .map(toRenderableExcerpt)
    .filter((excerpt): excerpt is FridayChannelChatHandoffExcerpt => Boolean(excerpt));

  const latestUserMessage = [...input.messages]
    .reverse()
    .find((record) => record.role === "user");
  const latestAssistantMessage = [...input.messages]
    .reverse()
    .find((record) => record.role === "assistant");

  const createdAt = input.nowIso ? input.nowIso() : new Date().toISOString();
  const id = `handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    sourceSessionKey: input.session.key,
    sourceChannel: input.session.channel,
    sourceDisplayName: input.displayName,
    sourceChatId: input.session.chatId,
    sourceChatKind: input.session.chatKind,
    sourceMessageCount: input.session.messageCount,
    sourceLastActivityAt: input.session.lastActivityAt,
    topicSummary,
    latestUserMessage: latestUserMessage ? truncate(latestUserMessage.contentText || String(latestUserMessage.content ?? "")) : undefined,
    latestAssistantMessage: latestAssistantMessage ? truncate(latestAssistantMessage.contentText || String(latestAssistantMessage.content ?? "")) : undefined,
    excerpts,
    createdAt,
  };
}

export function buildChannelChatHandoffTaskPrompt(
  payload: FridayChannelChatHandoffPayload,
  userText: string,
  locale: "zh" | "en",
): string {
  const header = locale === "zh"
    ? [
        "你正在从一条外部渠道会话继续到 Friday 主聊天。",
        "这不是自动合并历史。",
        "只使用下面的摘要和锚点继续上下文，不要假装你看到了完整原始线程。",
      ]
    : [
        "You are continuing from an external channel conversation into Friday main chat.",
        "This is not an automatic history merge.",
        "Use only the summary and anchors below; do not pretend you can see the full original thread.",
      ];

  const sourceBlock = locale === "zh"
    ? [
        `来源渠道: ${payload.sourceChannel}`,
        `来源会话: ${payload.sourceDisplayName}`,
        `来源 chatId: ${payload.sourceChatId}`,
      ]
    : [
        `Source channel: ${payload.sourceChannel}`,
        `Source conversation: ${payload.sourceDisplayName}`,
        `Source chatId: ${payload.sourceChatId}`,
      ];

  const topicBlock = payload.topicSummary
    ? (locale === "zh"
      ? [`当前主题: ${payload.topicSummary}`]
      : [`Current topic: ${payload.topicSummary}`])
    : [];

  const anchorHeader = locale === "zh" ? "最近锚点:" : "Recent anchors:";
  const anchors = payload.excerpts.map((excerpt) => {
    const roleLabel = excerpt.role === "user"
      ? (locale === "zh" ? "用户" : "User")
      : "Friday";
    return `${roleLabel}: ${excerpt.text}`;
  });

  const latestUserBlock = payload.latestUserMessage && payload.excerpts.every((excerpt) => excerpt.text !== payload.latestUserMessage)
    ? [locale === "zh" ? `最近用户消息: ${payload.latestUserMessage}` : `Latest user message: ${payload.latestUserMessage}`]
    : [];
  const latestAssistantBlock = payload.latestAssistantMessage && payload.excerpts.every((excerpt) => excerpt.text !== payload.latestAssistantMessage)
    ? [locale === "zh" ? `最近 Friday 回复: ${payload.latestAssistantMessage}` : `Latest Friday reply: ${payload.latestAssistantMessage}`]
    : [];

  const questionLine = locale === "zh"
    ? `用户在主聊天里的当前请求: ${userText.trim()}`
    : `Current user request in main chat: ${userText.trim()}`;

  return [
    ...header,
    "",
    ...sourceBlock,
    ...topicBlock,
    ...latestUserBlock,
    ...latestAssistantBlock,
    anchors.length > 0 ? "" : undefined,
    anchors.length > 0 ? anchorHeader : undefined,
    ...anchors,
    "",
    questionLine,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n")
    .trim();
}

export function writePendingChannelChatHandoff(payload: FridayChannelChatHandoffPayload): string {
  sessionStorage.setItem(`${HANDOFF_STORAGE_PREFIX}${payload.id}`, JSON.stringify(payload));
  sessionStorage.setItem(HANDOFF_LATEST_KEY, payload.id);
  return payload.id;
}

export function readPendingChannelChatHandoff(handoffId?: string | null): FridayChannelChatHandoffPayload | null {
  const resolvedId = handoffId ?? sessionStorage.getItem(HANDOFF_LATEST_KEY);
  if (!resolvedId) {
    return null;
  }
  const raw = sessionStorage.getItem(`${HANDOFF_STORAGE_PREFIX}${resolvedId}`);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as FridayChannelChatHandoffPayload;
  } catch {
    return null;
  }
}

export function clearPendingChannelChatHandoff(handoffId?: string | null): void {
  const resolvedId = handoffId ?? sessionStorage.getItem(HANDOFF_LATEST_KEY);
  if (!resolvedId) {
    return;
  }
  sessionStorage.removeItem(`${HANDOFF_STORAGE_PREFIX}${resolvedId}`);
  const latest = sessionStorage.getItem(HANDOFF_LATEST_KEY);
  if (latest === resolvedId) {
    sessionStorage.removeItem(HANDOFF_LATEST_KEY);
  }
}
