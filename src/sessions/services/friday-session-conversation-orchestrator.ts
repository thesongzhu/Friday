import { createHash } from "node:crypto";

import type { FridayAgentMessage } from "#agent";

import type {
  FridayConversationTurnKind,
  FridaySessionConversationFocusState,
  FridaySessionMessageRecord,
} from "../model/friday-session.types.js";

const MAX_TOPIC_SUMMARY_CHARS = 180;
const MAX_FOLLOW_UP_HISTORY = 12;
const MAX_STATUS_HISTORY = 6;
const FOLLOW_UP_HINTS =
  /\b(that|it|this|those|these|also|and|then|what about|more about|continue|same|again|summari[sz]e|summary|recap|recommendation|recommendations)\b/i;
const CHINESE_FOLLOW_UP_HINTS = /(这个|那个|继续|还有|然后|刚才|上一个|同一个|总结|概括|再说|细讲)/;
const ADVISORY_CONTINUATION_HINTS = /\b(prefer|preference|recommend|recommendation|recommendations|should i|best)\b/i;
const STATUS_CHECK_HINTS =
  /\b(status update|check status|current status|what(?:'s| is) (?:the )?status|progress|still working|still running|still executing|what are you doing|what's happening|how long|eta|done yet|finished yet)\b/i;
const CHINESE_STATUS_CHECK_HINTS = /(状态|进度|还在|多久|完成了吗|现在在做什么|刚才那个任务|还没好|ETA)/;
const CONTINUE_HINTS =
  /\b(continue|go ahead|proceed|keep going|do it|start it|carry on)\b/i;
const CHINESE_CONTINUE_HINTS = /(继续|开始吧|继续做|接着做|往下做|执行吧)/;
const CROSS_TOPIC_RECAP_HINTS =
  /\b(summari[sz]e|summary|recap|wrap up|pull together|combine|roll up|recommendations|all recommendations|overall recommendation)\b/i;
const CHINESE_CROSS_TOPIC_RECAP_HINTS = /(总结|概括|汇总|整体建议|全部建议|总的建议)/;
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "can", "for", "from", "how", "i", "in",
  "is", "it", "me", "my", "of", "on", "one", "or", "please", "should", "short", "single",
  "sentence", "answer", "brief", "that", "the", "this", "to", "what", "when", "where",
  "which", "who", "why", "you", "your",
]);

export interface FridayPreparedConversationTurn {
  turnKind: FridayConversationTurnKind;
  historyMessages: FridayAgentMessage[];
  taskPrompt: string;
  previousTopicSummary?: string;
  currentTopicSummary?: string;
}

export interface PrepareFridayConversationTurnInput {
  task: string;
  historyRecords: FridaySessionMessageRecord[];
  focusState?: FridaySessionConversationFocusState | null;
  currentUserSequence?: number;
}

export interface FinalizeFridayConversationFocusInput {
  task: string;
  responseText: string;
  runId: string;
  turnKind: FridayConversationTurnKind;
  focusState?: FridaySessionConversationFocusState | null;
  currentUserSequence?: number;
  pendingPlanRunId?: string | null;
  nowIso: string;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function summarizeTopic(text: string): string {
  const normalized = normalizeText(text);
  if (normalized.length <= MAX_TOPIC_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TOPIC_SUMMARY_CHARS - 1)}…`;
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function countOverlap(left: Iterable<string>, right: Iterable<string>): number {
  const rightSet = new Set(right);
  let matches = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      matches++;
    }
  }
  return matches;
}

function fingerprintTopic(text: string): string {
  const normalized = summarizeTopic(text).toLowerCase();
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

function mapSessionMessageToAgentMessage(
  message: FridaySessionMessageRecord,
): FridayAgentMessage | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }
  if (typeof message.content === "string") {
    const content = message.content.trim();
    if (content.length > 0) {
      return { role: message.role, content };
    }
  }
  const fallbackText = message.contentText.trim();
  if (fallbackText.length > 0) {
    return { role: message.role, content: fallbackText };
  }
  return null;
}

export function classifyFridayConversationTurn(input: {
  task: string;
  focusState?: FridaySessionConversationFocusState | null;
}): FridayConversationTurnKind {
  const task = normalizeText(input.task);
  const focusState = input.focusState ?? null;
  const taskLower = task.toLowerCase();
  const focusSummary = focusState?.currentTopicSummary ?? "";
  const hasFocus = Boolean(focusState?.currentTopicSummary);
  const taskTokens = tokenize(task);
  const focusTokens = tokenize(focusSummary);
  const overlap = countOverlap(taskTokens, focusTokens);
  const shortTask = task.length > 0 && task.length <= 120;
  const advisoryContinuation =
    ADVISORY_CONTINUATION_HINTS.test(taskLower)
    && ADVISORY_CONTINUATION_HINTS.test(focusSummary.toLowerCase());

  if (STATUS_CHECK_HINTS.test(taskLower) || CHINESE_STATUS_CHECK_HINTS.test(task)) {
    return "status_check";
  }
  if (CONTINUE_HINTS.test(taskLower) || CHINESE_CONTINUE_HINTS.test(task)) {
    return "continue_active_task";
  }
  if (
    Boolean(focusState?.lastAssistantAskedQuestion)
    && shortTask
  ) {
    return "clarification";
  }
  if (
    hasFocus
    && (
      overlap >= 2
      || advisoryContinuation
      || FOLLOW_UP_HINTS.test(taskLower)
      || CHINESE_FOLLOW_UP_HINTS.test(task)
    )
  ) {
    return "follow_up";
  }
  return "new_topic";
}

function selectConversationRecords(input: {
  historyRecords: FridaySessionMessageRecord[];
  focusState?: FridaySessionConversationFocusState | null;
  turnKind: FridayConversationTurnKind;
  currentUserSequence?: number;
  task: string;
}): FridaySessionMessageRecord[] {
  const focusState = input.focusState ?? null;
  let records = [...input.historyRecords];

  if (typeof input.currentUserSequence === "number") {
    records = records.filter((record) => record.sequence < input.currentUserSequence!);
  }

  if (input.turnKind === "new_topic") {
    return [];
  }

  const topicStartSequence = focusState?.currentTopicStartSequence;
  const useCrossTopicRecapWindow =
    input.turnKind === "follow_up"
    && (
      CROSS_TOPIC_RECAP_HINTS.test(input.task)
      || CHINESE_CROSS_TOPIC_RECAP_HINTS.test(input.task)
    );
  if (
    (input.turnKind === "follow_up" || input.turnKind === "clarification" || input.turnKind === "continue_active_task")
    && !useCrossTopicRecapWindow
    && typeof topicStartSequence === "number"
  ) {
    records = records.filter((record) => record.sequence >= topicStartSequence);
  }

  const maxCount = input.turnKind === "status_check" ? MAX_STATUS_HISTORY : MAX_FOLLOW_UP_HISTORY;
  if (records.length <= maxCount) {
    return records;
  }
  return records.slice(records.length - maxCount);
}

function buildTaskPrompt(input: {
  task: string;
  turnKind: FridayConversationTurnKind;
  focusState?: FridaySessionConversationFocusState | null;
}): string {
  const task = normalizeText(input.task);
  const previousTopicSummary = input.focusState?.currentTopicSummary?.trim();

  if (input.turnKind === "new_topic" && previousTopicSummary) {
    return [
      "This user started a new question.",
      `Current question: ${task}`,
      `Previous topic (do not answer this unless the user explicitly asked for it): ${previousTopicSummary}`,
      "Answer only the current question. If context from the previous topic is not needed, ignore it.",
    ].join("\n");
  }

  if (input.turnKind === "status_check") {
    return [
      `The user is asking for a status update: ${task}`,
      previousTopicSummary
        ? `Active topic reference: ${previousTopicSummary}`
        : "No active topic summary is available.",
      "Use the task_status tool before answering.",
      "Do not retry, resume, or reconstruct the original task in this turn unless the user explicitly asked for a new action.",
      "Do not answer the content of the previous task unless the user explicitly asked for that content.",
      "If you do not have deterministic status evidence in this turn, say that clearly instead of assuming.",
    ].join("\n");
  }

  if (input.turnKind === "clarification" && previousTopicSummary) {
    return [
      `The user is replying to your clarification request: ${task}`,
      `Current topic: ${previousTopicSummary}`,
      "Use this answer to continue the current topic.",
    ].join("\n");
  }

  if ((input.turnKind === "follow_up" || input.turnKind === "continue_active_task") && previousTopicSummary) {
    return [
      `Continue the current topic: ${previousTopicSummary}`,
      `Latest user turn: ${task}`,
    ].join("\n");
  }

  return task;
}

export function prepareFridayConversationTurn(
  input: PrepareFridayConversationTurnInput,
): FridayPreparedConversationTurn {
  const focusState = input.focusState ?? null;
  const turnKind = classifyFridayConversationTurn({
    task: input.task,
    focusState,
  });
  const selectedRecords = selectConversationRecords({
    historyRecords: input.historyRecords,
    focusState,
    turnKind,
    currentUserSequence: input.currentUserSequence,
    task: input.task,
  });
  const historyMessages = selectedRecords
    .map(mapSessionMessageToAgentMessage)
    .filter((message): message is FridayAgentMessage => message !== null);
  const currentTopicSummary = turnKind === "new_topic"
    ? summarizeTopic(input.task)
    : focusState?.currentTopicSummary ?? summarizeTopic(input.task);

  return {
    turnKind,
    historyMessages,
    taskPrompt: buildTaskPrompt({
      task: input.task,
      turnKind,
      focusState,
    }),
    previousTopicSummary: focusState?.currentTopicSummary,
    currentTopicSummary,
  };
}

export function finalizeFridayConversationFocus(
  input: FinalizeFridayConversationFocusInput,
): FridaySessionConversationFocusState {
  const previous = input.focusState ?? null;
  const currentTopicSummary = input.turnKind === "new_topic"
    ? summarizeTopic(input.task)
    : previous?.currentTopicSummary ?? summarizeTopic(input.task);
  const currentTopicFingerprint = input.turnKind === "new_topic"
    ? fingerprintTopic(input.task)
    : previous?.currentTopicFingerprint ?? fingerprintTopic(input.task);
  const currentTopicStartSequence = input.turnKind === "new_topic"
    ? input.currentUserSequence
    : previous?.currentTopicStartSequence ?? input.currentUserSequence;
  const activeSubagentIds = previous?.activeSubagentIds;
  const assistantAskedQuestion = /(?:\?|？)\s*$/.test(input.responseText.trim());

  return {
    currentTopicFingerprint,
    currentTopicSummary,
    currentTopicStartSequence,
    lastAnsweredQuestion: summarizeTopic(input.task),
    lastAssistantAskedQuestion: assistantAskedQuestion,
    lastRunId: input.runId,
    activeRunId: previous?.activeRunId && previous.activeRunId !== input.runId
      ? previous.activeRunId
      : undefined,
    activeSubagentIds: activeSubagentIds && activeSubagentIds.length > 0 ? activeSubagentIds : undefined,
    pendingPlanRunId: input.pendingPlanRunId === null
      ? undefined
      : input.pendingPlanRunId ?? previous?.pendingPlanRunId,
    lastTurnKind: input.turnKind,
    updatedAt: input.nowIso,
  };
}
