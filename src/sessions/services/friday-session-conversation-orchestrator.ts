import { createHash } from "node:crypto";

import type { FridayAgentMessage } from "#agent";

import type {
  FridayContextSelectionResult,
  FridayConversationBlock,
  FridayConversationHistoryBlockKind,
  FridayConversationHistoryBlockSummary,
  FridayConversationTurnKind,
  FridaySessionConversationFocusState,
  FridaySessionMessageRecord,
} from "../model/friday-session.types.js";

const MAX_TOPIC_SUMMARY_CHARS = 180;
const MAX_FOLLOW_UP_HISTORY = 12;
const MAX_STATUS_HISTORY = 6;
const MAX_SELECTED_BLOCKS = 6;
const MAX_RELEVANT_HISTORY_BLOCKS = 3;
const MAX_BLOCK_SUMMARY_CHARS = 240;
const FOLLOW_UP_HINTS =
  /\b(that|it|this|those|these|also|and|then|what about|more about|continue|same|again|summari[sz]e|summary|recap|recommendation|recommendations)\b/i;
const CHINESE_FOLLOW_UP_HINTS = /(这个|那个|这里|这儿|继续|还有|然后|刚才|上一个|同一个|总结|概括|再说|细讲)/;
const DEICTIC_FOLLOW_UP_HINTS = /\b(this one|that one|same one|same issue|that issue|this issue|that part|this part|here|there)\b/i;
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
const GENERIC_FOLLOW_UP_TOKENS = new Set([
  "again",
  "connect",
  "continue",
  "didnt",
  "failed",
  "fail",
  "here",
  "issue",
  "open",
  "part",
  "recap",
  "same",
  "summary",
  "there",
  "thing",
  "wrong",
  "为什么",
  "这里",
  "这个",
  "那个",
  "同一个",
  "连接",
  "打开",
  "失败",
  "原因",
]);

function hasSpecificFollowUpTokens(task: string): boolean {
  return tokenize(task).some((token) => !GENERIC_FOLLOW_UP_TOKENS.has(token));
}

function isShortContextualFollowUpTask(task: string): boolean {
  const normalized = normalizeText(task);
  return normalized.length <= 48
    || /\b(why|what|that|this|here|it|connect|open)\b/i.test(normalized)
    || /(为什么|什么|这里|这个|那个|连接|打不开|打开)/.test(normalized);
}

function isShortAssistantAnchorFollowUpTask(task: string): boolean {
  const normalized = normalizeText(task);
  if (normalized.length === 0 || normalized.length > 48) {
    return false;
  }
  return (
    /\b(why|what|that|this|here|it|same|again|connect|didn't|did not|failed)\b/i.test(normalized)
    || /(为什么|什么|这里|这个|那个|同一个|还是|连接|打不开|失败|没连上)/.test(normalized)
  );
}

export interface FridayPreparedConversationTurn {
  turnKind: FridayConversationTurnKind;
  historyMessages: FridayAgentMessage[];
  taskPrompt: string;
  previousTopicSummary?: string;
  currentTopicSummary?: string;
  selectedBlocks: FridayConversationBlock[];
  selectionReasons: string[];
  replyAnchorMessageId?: string;
  replyAnchorSequence?: number;
}

export interface PrepareFridayConversationTurnInput {
  task: string;
  historyRecords: FridaySessionMessageRecord[];
  focusState?: FridaySessionConversationFocusState | null;
  currentUserSequence?: number;
  replyToMessageId?: string;
}

export interface FinalizeFridayConversationFocusInput {
  task: string;
  responseText: string;
  runId: string;
  turnKind: FridayConversationTurnKind;
  focusState?: FridaySessionConversationFocusState | null;
  currentUserSequence?: number;
  replyAnchorMessageId?: string;
  replyAnchorSequence?: number;
  pendingPlanRunId?: string | null;
  nowIso: string;
}

interface FridayConversationBlockCandidate {
  block: FridayConversationBlock;
  messages: FridayAgentMessage[];
  taskOverlap?: number;
  fallbackOnly?: boolean;
}

interface FridayConversationHistoryBlockCandidate {
  summary: FridayConversationHistoryBlockSummary;
  score: number;
  reason: string;
  messages: FridayAgentMessage[];
  taskOverlap: number;
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
  const expandToken = (token: string): string[] => {
    if (/^[\u4e00-\u9fff]+$/u.test(token)) {
      const expanded = new Set<string>([token]);
      if (token.length >= 2) {
        for (let index = 0; index < token.length - 1; index++) {
          expanded.add(token.slice(index, index + 2));
        }
      }
      return [...expanded];
    }
    return [token];
  };

  const normalizeToken = (token: string): string => {
    if (!/^[a-z0-9]+$/i.test(token)) {
      return token;
    }
    if (token.length > 5 && token.endsWith("ing")) {
      return token.slice(0, -3);
    }
    if (token.length > 4 && token.endsWith("ed")) {
      return token.slice(0, -2);
    }
    if (token.length > 4 && token.endsWith("es")) {
      return token.slice(0, -2);
    }
    if (token.length > 3 && token.endsWith("s")) {
      return token.slice(0, -1);
    }
    return token;
  };

  return normalizeText(text)
    .replace(/([\u4e00-\u9fff])([a-z0-9])/gi, "$1 $2")
    .replace(/([a-z0-9])([\u4e00-\u9fff])/gi, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .map(normalizeToken)
    .flatMap(expandToken)
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
  historyRecords?: FridaySessionMessageRecord[];
  currentUserSequence?: number;
  replyToMessageId?: string;
}): FridayConversationTurnKind {
  const task = normalizeText(input.task);
  const focusState = input.focusState ?? null;
  const taskLower = task.toLowerCase();
  const focusSummary = focusState?.currentTopicSummary ?? "";
  const hasFocus = Boolean(focusState?.currentTopicSummary);
  const taskTokens = tokenize(task);
  const focusTokens = tokenize(focusSummary);
  const overlap = countOverlap(taskTokens, focusTokens);
  const records = filterConversationRecords(input.historyRecords ?? [], input.currentUserSequence);
  const latestAssistant = findLatestRecord(records, "assistant");
  const latestUser = findLatestRecord(records, "user");
  const latestAssistantOverlap = countOverlap(taskTokens, tokenize(latestAssistant?.contentText ?? focusState?.assistantAnchorSummary ?? ""));
  const latestUserOverlap = countOverlap(taskTokens, tokenize(latestUser?.contentText ?? ""));
  const hasReplyAnchor = Boolean(resolveReplyAnchorRecord(records, input.replyToMessageId));
  const hasAssistantAnchor = Boolean(latestAssistant?.contentText || focusState?.assistantAnchorSummary);
  const shortTask = task.length > 0 && task.length <= 120;
  const advisoryContinuation =
    ADVISORY_CONTINUATION_HINTS.test(taskLower)
    && ADVISORY_CONTINUATION_HINTS.test(focusSummary.toLowerCase());
  const followUpHint =
    FOLLOW_UP_HINTS.test(taskLower)
    || CHINESE_FOLLOW_UP_HINTS.test(task)
    || DEICTIC_FOLLOW_UP_HINTS.test(taskLower);
  const assistantOverlapSignal = latestAssistantOverlap >= 2
    || (
      latestAssistantOverlap >= 1
      && hasFocus
      && hasAssistantAnchor
      && isShortAssistantAnchorFollowUpTask(task)
    );
  const userOverlapSignal = latestUserOverlap >= 2;

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
  if (hasReplyAnchor) {
    return "follow_up";
  }
  if (
    hasFocus
    && hasAssistantAnchor
    && isShortAssistantAnchorFollowUpTask(task)
  ) {
    return "follow_up";
  }
  if (
    (hasFocus || assistantOverlapSignal || userOverlapSignal)
    && (
      overlap >= 2
      || assistantOverlapSignal
      || userOverlapSignal
      || advisoryContinuation
      || followUpHint
    )
  ) {
    return "follow_up";
  }
  return "new_topic";
}

function filterConversationRecords(
  historyRecords: FridaySessionMessageRecord[],
  currentUserSequence?: number,
): FridaySessionMessageRecord[] {
  if (typeof currentUserSequence !== "number") {
    return [...historyRecords];
  }
  return historyRecords.filter((record) => record.sequence < currentUserSequence);
}

function findLatestRecord(
  records: FridaySessionMessageRecord[],
  role: "user" | "assistant",
): FridaySessionMessageRecord | undefined {
  return [...records].reverse().find((record) => record.role === role);
}

function findRecordIndex(
  records: FridaySessionMessageRecord[],
  messageId: string,
): number {
  return records.findIndex((record) => record.id === messageId);
}

function resolveSourceMessageId(record: FridaySessionMessageRecord): string | undefined {
  const sourceMessageId = record.metadata?.sourceMessageId;
  return typeof sourceMessageId === "string" && sourceMessageId.trim().length > 0
    ? sourceMessageId.trim()
    : undefined;
}

function resolveReplyAnchorRecord(
  records: FridaySessionMessageRecord[],
  replyToMessageId?: string,
): FridaySessionMessageRecord | undefined {
  if (!replyToMessageId || replyToMessageId.trim().length === 0) {
    return undefined;
  }
  const normalizedReplyId = replyToMessageId.trim();
  return records.find((record) =>
    record.id === normalizedReplyId || resolveSourceMessageId(record) === normalizedReplyId);
}

function clampSummary(text: string, limit = MAX_BLOCK_SUMMARY_CHARS): string {
  const normalized = normalizeText(text);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function extractFileOperations(text: string): string[] {
  const matches = text.match(/(?:^|\s)(?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9._-]+)?/g) ?? [];
  return [...new Set(matches.map((match) => match.trim()).filter((match) => match.length > 0))].slice(0, 4);
}

function classifyConversationHistoryBlockKind(
  records: readonly FridaySessionMessageRecord[],
): FridayConversationHistoryBlockKind {
  const combined = records.map((record) => record.contentText).join("\n").toLowerCase();
  if (
    /\b(plan|approval|approve|approved|reject|rejected|clarif(?:y|ication)|awaiting plan|awaiting clarification|review required)\b/i.test(combined)
    || /(计划|批准|审批|驳回|澄清|需要更多信息|等待批准)/.test(combined)
  ) {
    return "plan_block";
  }
  if (
    STATUS_CHECK_HINTS.test(combined)
    || CHINESE_STATUS_CHECK_HINTS.test(combined)
  ) {
    return "task_status_block";
  }
  if (
    /\b(subagent|delegat(?:e|ed|ion)|worker|child run|spawned|spawn_subagent|hand[- ]?off)\b/i.test(combined)
    || /(子任务|子代理|委派|工作线程|分配给)/.test(combined)
  ) {
    return "delegated_task_block";
  }
  if (
    /\b(failed|failure|error|unable|cannot|could not|couldn't|blocked|timed out|not connected|invalid|denied)\b/i.test(combined)
    || /(失败|错误|无法|不能|未连接|阻止|超时|无效|拒绝)/.test(combined)
  ) {
    return "tool_failure_block";
  }
  const hasUser = records.some((record) => record.role === "user");
  const hasAssistant = records.some((record) => record.role === "assistant");
  return hasUser && hasAssistant ? "topic_block" : "conversation_block";
}

function summarizeConversationHistoryBlock(
  records: readonly FridaySessionMessageRecord[],
): FridayConversationHistoryBlockSummary {
  const kind = classifyConversationHistoryBlockKind(records);
  const userSummaries = records
    .filter((record) => record.role === "user")
    .map((record) => clampSummary(record.contentText, 140));
  const assistantSummaries = records
    .filter((record) => record.role === "assistant")
    .map((record) => clampSummary(record.contentText, 160));
  const summaryText = clampSummary(
    [
      userSummaries.length > 0 ? `User: ${userSummaries.join(" | ")}` : undefined,
      assistantSummaries.length > 0 ? `Assistant: ${assistantSummaries.join(" | ")}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );
  const combined = records.map((record) => record.contentText).join("\n");
  const toolFailures = kind === "tool_failure_block"
    ? records.map((record) => clampSummary(record.contentText, 120)).slice(-2)
    : [];
  const openQuestions = records
    .filter((record) => record.role === "user" && /(?:\?|？)\s*$/.test(record.contentText.trim()))
    .map((record) => clampSummary(record.contentText, 120))
    .slice(-2);
  const decisions = records
    .filter((record) => record.role === "assistant" && /\b(recommend|decide|should|best|prefer|plan)\b/i.test(record.contentText))
    .map((record) => clampSummary(record.contentText, 120))
    .slice(0, 3);
  const todos = records
    .filter((record) => /\b(todo|next|follow up|need to|should)\b/i.test(record.contentText) || /(下一步|待办|需要)/.test(record.contentText))
    .map((record) => clampSummary(record.contentText, 120))
    .slice(0, 3);

  return {
    id: `history-block:${records[0]?.id ?? "unknown"}:${records[records.length - 1]?.id ?? "unknown"}`,
    kind,
    summaryText,
    decisions,
    todos,
    openQuestions,
    toolFailures,
    fileOperations: extractFileOperations(combined),
    messageIds: records.map((record) => record.id),
    sequenceStart: records[0]?.sequence,
    sequenceEnd: records[records.length - 1]?.sequence,
  };
}

function buildConversationHistoryBlocks(
  records: readonly FridaySessionMessageRecord[],
): FridayConversationHistoryBlockSummary[] {
  if (records.length === 0) {
    return [];
  }

  const blocks: FridayConversationHistoryBlockSummary[] = [];
  let current: FridaySessionMessageRecord[] = [];

  const flushCurrent = () => {
    if (current.length === 0) {
      return;
    }
    blocks.push(summarizeConversationHistoryBlock(current));
    current = [];
  };

  for (const record of records) {
    if (record.role === "user" && current.some((entry) => entry.role === "user")) {
      flushCurrent();
    }
    current.push(record);
  }
  flushCurrent();
  return blocks;
}

function formatConversationHistoryBlockSummary(
  block: FridayConversationHistoryBlockSummary,
): string {
  const parts = [`${block.kind}: ${block.summaryText}`];
  if (block.decisions.length > 0) {
    parts.push(`decisions=${block.decisions.join(" | ")}`);
  }
  if (block.todos.length > 0) {
    parts.push(`todos=${block.todos.join(" | ")}`);
  }
  if (block.openQuestions.length > 0) {
    parts.push(`openQuestions=${block.openQuestions.join(" | ")}`);
  }
  if (block.toolFailures.length > 0) {
    parts.push(`toolFailures=${block.toolFailures.join(" | ")}`);
  }
  if (block.fileOperations.length > 0) {
    parts.push(`fileOperations=${block.fileOperations.join(" | ")}`);
  }
  return parts.join(" | ");
}

function rehydrateConversationHistoryBlockMessages(
  block: FridayConversationHistoryBlockSummary,
  records: readonly FridaySessionMessageRecord[],
): FridayAgentMessage[] {
  return block.messageIds
    .map((messageId) => records.find((record) => record.id === messageId))
    .filter((record): record is FridaySessionMessageRecord => Boolean(record))
    .map(mapSessionMessageToAgentMessage)
    .filter((message): message is FridayAgentMessage => message !== null);
}

function createMessageBlockCandidate(input: {
  id: string;
  source: FridayConversationBlock["source"];
  summary: string;
  score: number;
  reason: string;
  records: FridaySessionMessageRecord[];
}): FridayConversationBlockCandidate {
  const historyMessages = input.records
    .map(mapSessionMessageToAgentMessage)
    .filter((message): message is FridayAgentMessage => message !== null);
  return {
    block: {
      id: input.id,
      source: input.source,
      summary: summarizeTopic(input.summary),
      score: input.score,
      reason: input.reason,
      messageIds: input.records.map((record) => record.id),
      sequenceStart: input.records[0]?.sequence,
      sequenceEnd: input.records[input.records.length - 1]?.sequence,
    },
    messages: historyMessages,
  };
}

function createHistoryBlockCandidate(input: {
  summary: FridayConversationHistoryBlockSummary;
  score: number;
  reason: string;
  records: readonly FridaySessionMessageRecord[];
  taskOverlap: number;
}): FridayConversationHistoryBlockCandidate {
  return {
    summary: input.summary,
    score: input.score,
    reason: input.reason,
    messages: rehydrateConversationHistoryBlockMessages(input.summary, input.records),
    taskOverlap: input.taskOverlap,
  };
}

function buildAnchorWindow(
  records: FridaySessionMessageRecord[],
  anchorRecord: FridaySessionMessageRecord,
): FridaySessionMessageRecord[] {
  const anchorIndex = findRecordIndex(records, anchorRecord.id);
  if (anchorIndex < 0) {
    return [anchorRecord];
  }

  if (anchorRecord.role === "assistant") {
    const previousUser = [...records.slice(0, anchorIndex)]
      .reverse()
      .find((record) => record.role === "user");
    return previousUser ? [previousUser, anchorRecord] : [anchorRecord];
  }

  const nextAssistant = records
    .slice(anchorIndex + 1)
    .find((record) => record.role === "assistant");
  return nextAssistant ? [anchorRecord, nextAssistant] : [anchorRecord];
}

function deriveSelectedAssistantFact(input: {
  selectedBlocks: FridayConversationBlock[];
  focusState?: FridaySessionConversationFocusState | null;
}): string | undefined {
  const replyAnchorSummary = input.selectedBlocks
    .find((block) => block.source === "reply_anchor")
    ?.summary
    ?.trim();
  if (replyAnchorSummary) {
    const assistantMatch = replyAnchorSummary.match(/assistant:\s*([\s\S]+)$/i);
    const replyAssistantFact = assistantMatch?.[1]?.trim() ?? replyAnchorSummary;
    if (replyAssistantFact.length > 0) {
      return replyAssistantFact;
    }
  }

  const assistantAnchorSummary = input.selectedBlocks
    .find((block) => block.source === "assistant_anchor")
    ?.summary
    ?.trim();
  if (assistantAnchorSummary && assistantAnchorSummary.length > 0) {
    return assistantAnchorSummary;
  }

  const persistedAssistantAnchor = input.focusState?.assistantAnchorSummary?.trim();
  if (persistedAssistantAnchor && persistedAssistantAnchor.length > 0) {
    return persistedAssistantAnchor;
  }

  return undefined;
}

function buildConversationBlockSelection(input: {
  task: string;
  historyRecords: FridaySessionMessageRecord[];
  focusState?: FridaySessionConversationFocusState | null;
  turnKind: FridayConversationTurnKind;
  replyToMessageId?: string;
}): FridayContextSelectionResult & { historyMessages: FridayAgentMessage[]; replyAnchorMessageId?: string; replyAnchorSequence?: number } {
  const taskTokens = tokenize(input.task);
  const taskLower = normalizeText(input.task).toLowerCase();
  const taskHasSpecificFollowUpTokens = hasSpecificFollowUpTokens(input.task);
  const shortContextualFollowUp = isShortContextualFollowUpTask(input.task) && !taskHasSpecificFollowUpTokens;
  const shortAssistantAnchorFollowUp = isShortAssistantAnchorFollowUpTask(input.task) && !taskHasSpecificFollowUpTokens;
  const focusState = input.focusState ?? null;
  const records = input.historyRecords;
  const candidates: FridayConversationBlockCandidate[] = [];
  const seenCandidateIds = new Set<string>();

  const registerCandidate = (candidate: FridayConversationBlockCandidate | null) => {
    if (!candidate || seenCandidateIds.has(candidate.block.id) || candidate.block.score <= 0) {
      return;
    }
    seenCandidateIds.add(candidate.block.id);
    candidates.push(candidate);
  };

  const replyAnchor = resolveReplyAnchorRecord(records, input.replyToMessageId);
  const replyAnchorInCurrentTopicWindow = Boolean(
    replyAnchor
    && typeof focusState?.currentTopicStartSequence === "number"
    && replyAnchor.sequence >= focusState.currentTopicStartSequence,
  );
  if (replyAnchor) {
    registerCandidate(createMessageBlockCandidate({
      id: `reply:${replyAnchor.id}`,
      source: "reply_anchor",
      summary: buildAnchorWindow(records, replyAnchor).map((record) => `${record.role}: ${record.contentText}`).join("\n"),
      score: 100,
      reason: "Explicit reply target matched a prior session message.",
      records: buildAnchorWindow(records, replyAnchor),
    }));
  }

  const latestAssistant = findLatestRecord(records, "assistant");
  if (latestAssistant) {
    const assistantOverlap = countOverlap(taskTokens, tokenize(latestAssistant.contentText));
    const assistantScore = (assistantOverlap * 20)
      + (
        !replyAnchor
        && (
          FOLLOW_UP_HINTS.test(taskLower)
          || DEICTIC_FOLLOW_UP_HINTS.test(taskLower)
          || CHINESE_FOLLOW_UP_HINTS.test(input.task)
        )
        ? 18
        : 0
      )
      + (
        (input.turnKind === "follow_up" || input.turnKind === "clarification")
        && (assistantOverlap > 0 || (!replyAnchor && shortAssistantAnchorFollowUp) || replyAnchorInCurrentTopicWindow)
        ? 10
        : 0
      );
    registerCandidate({
      ...createMessageBlockCandidate({
        id: `assistant:${latestAssistant.id}`,
        source: "assistant_anchor",
        summary: latestAssistant.contentText,
        score: assistantScore,
        reason: assistantOverlap > 0
          ? `Current turn overlaps the latest assistant answer (${String(assistantOverlap)} token match(es)).`
          : "Latest assistant answer is a plausible short-follow-up anchor.",
        records: buildAnchorWindow(records, latestAssistant),
      }),
      taskOverlap: assistantOverlap,
      fallbackOnly: assistantOverlap === 0,
    });
  }

  const latestUser = findLatestRecord(records, "user");
  if (latestUser) {
    const userOverlap = countOverlap(taskTokens, tokenize(latestUser.contentText));
    const userScore = (userOverlap * 14)
      + (
        input.turnKind === "follow_up"
        && (!replyAnchor || replyAnchorInCurrentTopicWindow || userOverlap > 0)
        ? 8
        : 0
      );
    registerCandidate({
      ...createMessageBlockCandidate({
        id: `user:${latestUser.id}`,
        source: "recent_user",
        summary: latestUser.contentText,
        score: userScore,
        reason: userOverlap > 0
          ? `Current turn overlaps the most recent user turn (${String(userOverlap)} token match(es)).`
          : "Most recent user turn is a fallback short-context anchor.",
        records: [latestUser],
      }),
      taskOverlap: userOverlap,
      fallbackOnly: userOverlap === 0,
    });
  }

  if (focusState?.currentTopicSummary) {
    const focusOverlap = countOverlap(taskTokens, tokenize(focusState.currentTopicSummary));
    const focusScore = (focusOverlap * 12)
      + (
        !replyAnchor
        && (input.turnKind === "follow_up" || input.turnKind === "clarification")
        ? 8
        : replyAnchorInCurrentTopicWindow
        ? 8
        : 0
      );
    registerCandidate({
      block: {
        id: "focus:current-topic",
        source: "focus_topic",
        summary: focusState.currentTopicSummary,
        score: focusScore,
        reason: focusOverlap > 0
          ? `Current topic summary matches this turn (${String(focusOverlap)} token match(es)).`
          : "Persisted focus topic kept as a low-weight context block.",
      },
      messages: [],
      taskOverlap: focusOverlap,
      fallbackOnly: focusOverlap === 0,
    });
  }

  const useCrossTopicRecapWindow =
    input.turnKind === "follow_up"
    && (
      CROSS_TOPIC_RECAP_HINTS.test(input.task)
      || CHINESE_CROSS_TOPIC_RECAP_HINTS.test(input.task)
    );

  const topicWindowRecords = (
    (input.turnKind === "follow_up" || input.turnKind === "clarification" || input.turnKind === "continue_active_task")
    && typeof focusState?.currentTopicStartSequence === "number"
  )
    ? records.filter((record) => record.sequence >= focusState.currentTopicStartSequence!)
    : [];
  if (topicWindowRecords.length > 1) {
    const topicWindowSummary = topicWindowRecords
      .map((record) => `${record.role}: ${record.contentText}`)
      .join("\n");
    const topicWindowOverlap = countOverlap(taskTokens, tokenize(topicWindowSummary));
    const topicWindowBaseScore = replyAnchor
      ? (replyAnchorInCurrentTopicWindow ? 24 : 0)
      : 36;
    const topicWindowScore = topicWindowBaseScore + (topicWindowOverlap * 10);
    if (topicWindowRecords.length > MAX_FOLLOW_UP_HISTORY) {
      registerCandidate({
        block: {
          id: `topic-window:${String(focusState?.currentTopicStartSequence)}`,
          source: "focus_topic",
          summary: summarizeTopic(topicWindowSummary),
          score: topicWindowScore,
          reason: "Current turn is still inside the persisted topic window; the long topic window is now represented as a compacted summary block.",
          sequenceStart: topicWindowRecords[0]?.sequence,
          sequenceEnd: topicWindowRecords[topicWindowRecords.length - 1]?.sequence,
        },
        messages: [],
        taskOverlap: topicWindowOverlap,
        fallbackOnly: topicWindowOverlap === 0,
      });
    } else {
      registerCandidate({
        ...createMessageBlockCandidate({
          id: `topic-window:${String(focusState?.currentTopicStartSequence)}`,
          source: "focus_topic",
          summary: topicWindowSummary,
          score: topicWindowScore,
          reason: "Current turn is still inside the persisted topic window.",
          records: topicWindowRecords,
        }),
        taskOverlap: topicWindowOverlap,
        fallbackOnly: topicWindowOverlap === 0,
      });
    }
  }

  if (input.turnKind === "status_check" && (focusState?.activeRunId || focusState?.pendingPlanRunId || focusState?.activeSubagentIds?.length)) {
    const activeSummary = [
      focusState.activeRunId ? `Active run: ${focusState.activeRunId}` : undefined,
      focusState.pendingPlanRunId ? `Pending plan run: ${focusState.pendingPlanRunId}` : undefined,
      focusState.activeSubagentIds?.length ? `Active subagents: ${focusState.activeSubagentIds.join(", ")}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n");
    registerCandidate({
      block: {
        id: "focus:active-run",
        source: "active_run",
        summary: activeSummary,
        score: 95,
        reason: "Status questions should anchor to the active run snapshot before answering.",
      },
      messages: [],
    });
  }

  const historyBlockCandidates: FridayConversationHistoryBlockCandidate[] = [];
  const seenHistoryBlockIds = new Set<string>();
  const registerHistoryBlock = (candidate: FridayConversationHistoryBlockCandidate | null) => {
    if (!candidate || seenHistoryBlockIds.has(candidate.summary.id) || candidate.score <= 0) {
      return;
    }
    seenHistoryBlockIds.add(candidate.summary.id);
    historyBlockCandidates.push(candidate);
  };

  const candidateHistoryRecords = replyAnchor
    ? []
    : useCrossTopicRecapWindow
    ? records
    : topicWindowRecords.length > MAX_FOLLOW_UP_HISTORY
      ? topicWindowRecords
      : records;
  if (
    candidateHistoryRecords.length > MAX_FOLLOW_UP_HISTORY
    && input.turnKind !== "new_topic"
  ) {
    const alreadyAnchoredMessageIds = new Set(
      candidates.flatMap((candidate) => candidate.block.messageIds ?? []),
    );
    const historyBlocks = buildConversationHistoryBlocks(candidateHistoryRecords);
    const totalBlockCount = historyBlocks.length;
    const focusTokens = tokenize(focusState?.currentTopicSummary ?? "");

    historyBlocks.forEach((block, index) => {
      const unanchoredMessageIds = block.messageIds.filter((messageId) => !alreadyAnchoredMessageIds.has(messageId));
      if (unanchoredMessageIds.length === 0) {
        return;
      }

      const formattedSummary = formatConversationHistoryBlockSummary(block);
      const blockTokens = tokenize(formattedSummary);
      const taskOverlap = countOverlap(taskTokens, blockTokens);
      const focusOverlap = focusTokens.length > 0 ? countOverlap(focusTokens, blockTokens) : 0;
      const recencyBonus = Math.max(1, totalBlockCount - index);
      const kindBonus = block.kind === "tool_failure_block"
        ? 14
        : block.kind === "task_status_block"
          ? 12
          : block.kind === "delegated_task_block"
            ? 10
            : block.kind === "plan_block"
              ? 8
              : block.kind === "topic_block"
                ? 6
                : 4;
      const score = (taskOverlap * 14) + (focusOverlap * 8) + recencyBonus + kindBonus;

      registerHistoryBlock(createHistoryBlockCandidate({
        summary: {
          ...block,
          messageIds: unanchoredMessageIds,
        },
        score,
        reason: taskOverlap > 0 || focusOverlap > 0
          ? `Compacted ${block.kind} matched the current turn (${String(taskOverlap)} task token match(es), ${String(focusOverlap)} focus token match(es)).`
          : `Compacted ${block.kind} kept as a recency-weighted history block.`,
        records: candidateHistoryRecords,
        taskOverlap,
      }));
    });
  }

  const scoreThreshold = input.turnKind === "new_topic" ? 60 : 1;
  const hasMatchedHistoryBlock = !replyAnchor && historyBlockCandidates.some((candidate) => candidate.taskOverlap > 0);
  const selectedCandidates = candidates
    .filter((candidate) => !hasMatchedHistoryBlock || !candidate.fallbackOnly || candidate.block.source === "reply_anchor")
    .filter((candidate) => candidate.block.score >= scoreThreshold || candidate.block.source === "reply_anchor")
    .sort((left, right) => right.block.score - left.block.score || left.block.id.localeCompare(right.block.id))
    .slice(0, input.turnKind === "status_check" ? 3 : 4);
  const selectedHistoryCandidates = historyBlockCandidates
    .filter((candidate) => candidate.score >= scoreThreshold)
    .sort((left, right) => right.score - left.score || left.summary.id.localeCompare(right.summary.id))
    .slice(0, input.turnKind === "status_check" ? 1 : MAX_RELEVANT_HISTORY_BLOCKS);
  const selectionReasons = [
    ...selectedCandidates.map((candidate) => `${candidate.block.source} → ${candidate.block.reason}`),
    ...selectedHistoryCandidates.map((candidate) => `${candidate.summary.kind} → ${candidate.reason}`),
  ];

  const historyMessageLimit = input.turnKind === "status_check"
    ? MAX_STATUS_HISTORY
    : MAX_FOLLOW_UP_HISTORY + 6;
  const prioritizedHistoryEntries: Array<{ id: string; sequence: number; message: FridayAgentMessage }> = [];
  const seenHistoryMessageIds = new Set<string>();

  const appendHistoryMessages = (messageIds: readonly string[], messages: readonly FridayAgentMessage[]) => {
    messageIds.forEach((messageId, index) => {
      if (seenHistoryMessageIds.has(messageId) || prioritizedHistoryEntries.length >= historyMessageLimit) {
        return;
      }
      const record = records.find((entry) => entry.id === messageId);
      const mapped = messages[index]
        ?? (record ? mapSessionMessageToAgentMessage(record) : null);
      if (record && mapped) {
        seenHistoryMessageIds.add(messageId);
        prioritizedHistoryEntries.push({
          id: record.id,
          sequence: record.sequence,
          message: mapped,
        });
      }
    });
  };

  for (const candidate of selectedCandidates) {
    appendHistoryMessages(candidate.block.messageIds ?? [], candidate.messages);
  }
  for (const candidate of selectedHistoryCandidates) {
    appendHistoryMessages(candidate.summary.messageIds, candidate.messages);
  }

  if (useCrossTopicRecapWindow && records.length > 0) {
    const maxCount = input.turnKind === "status_check" ? MAX_STATUS_HISTORY : MAX_FOLLOW_UP_HISTORY;
    for (const record of records.slice(Math.max(0, records.length - maxCount))) {
      if (seenHistoryMessageIds.has(record.id) || prioritizedHistoryEntries.length >= historyMessageLimit) {
        continue;
      }
      const mapped = mapSessionMessageToAgentMessage(record);
      if (mapped) {
        seenHistoryMessageIds.add(record.id);
        prioritizedHistoryEntries.push({ id: record.id, sequence: record.sequence, message: mapped });
      }
    }
  }

  const historyMessages = prioritizedHistoryEntries
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry) => entry.message);

  const selectedBlocks = [
    ...selectedCandidates.map((candidate) => candidate.block),
    ...selectedHistoryCandidates.map((candidate): FridayConversationBlock => ({
      id: candidate.summary.id,
      source: candidate.summary.kind,
      summary: formatConversationHistoryBlockSummary(candidate.summary),
      score: candidate.score,
      reason: candidate.reason,
      messageIds: candidate.summary.messageIds,
      sequenceStart: candidate.summary.sequenceStart,
      sequenceEnd: candidate.summary.sequenceEnd,
    })),
  ]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, MAX_SELECTED_BLOCKS);

  return {
    selectedBlocks,
    selectionReasons,
    historyMessages,
    replyAnchorMessageId: replyAnchor?.id,
    replyAnchorSequence: replyAnchor?.sequence,
  };
}

function buildTaskPrompt(input: {
  task: string;
  turnKind: FridayConversationTurnKind;
  focusState?: FridaySessionConversationFocusState | null;
  selectedBlocks: FridayConversationBlock[];
}): string {
  const task = normalizeText(input.task);
  const previousTopicSummary = input.focusState?.currentTopicSummary?.trim();
  const hasExplicitReplyAnchor = input.selectedBlocks.some((block) => block.source === "reply_anchor");
  const assistantFactSummary = deriveSelectedAssistantFact({
    selectedBlocks: input.selectedBlocks,
    focusState: input.focusState,
  });
  const isShortAssistantFactFollowUp = Boolean(
    assistantFactSummary
    && (input.turnKind === "follow_up" || input.turnKind === "clarification" || input.turnKind === "continue_active_task")
    && isShortContextualFollowUpTask(task),
  );
  const selectedBlockSummary = input.selectedBlocks.length > 0
    ? input.selectedBlocks
      .map((block) => `- [${block.source}] ${block.summary}`)
      .join("\n")
    : undefined;
  const hasHistoryOnlySelection = input.selectedBlocks.length > 0
    && input.selectedBlocks.every((block) => block.source.endsWith("_block"));

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
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : "No anchored status blocks were selected.",
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
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      hasExplicitReplyAnchor
        ? "An explicit reply anchor was selected. Treat that anchor as the user's intended referent even if the latest turn is short or deictic."
        : undefined,
      "Use this answer to continue the current topic.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if (input.turnKind === "clarification" && hasExplicitReplyAnchor) {
    return [
      `The user is clarifying a point about this referenced context: ${task}`,
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      "An explicit reply anchor was selected. Treat that anchor as the user's intended referent even if the latest turn is short or deictic.",
      "Answer the referenced point directly from the anchored context before asking for more detail.",
      "Do not switch to generic advice or external research unless the user explicitly asked for that broader scope.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if ((input.turnKind === "follow_up" || input.turnKind === "continue_active_task") && hasExplicitReplyAnchor) {
    return [
      "The user is following up on a specifically referenced earlier exchange.",
      assistantFactSummary ? `Referenced assistant fact: ${assistantFactSummary}` : undefined,
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      `Latest user turn: ${task}`,
      "An explicit reply anchor was selected. Answer the referenced point directly from the anchored context.",
      "Do not reinterpret this as a generic troubleshooting or research request unless the user explicitly broadens the scope.",
      "Do not ask what 'this/that/here' refers to unless the reply anchor itself is ambiguous.",
      "Explain the referenced assistant fact directly before adding any broader caveat.",
      "Do not claim a new action, a new success state, or a new result unless this turn produced new deterministic evidence.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if ((input.turnKind === "follow_up" || input.turnKind === "continue_active_task") && hasHistoryOnlySelection) {
    return [
      "The user is following up on an earlier referenced session context, not necessarily the most recent topic.",
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      `Latest user turn: ${task}`,
      "Answer from the relevant anchors directly.",
      "Do not prepend or restate the most recent topic unless one of the selected anchors actually references it.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if (isShortAssistantFactFollowUp && assistantFactSummary) {
    return [
      previousTopicSummary
        ? `Continue the current topic: ${previousTopicSummary}`
        : "The user is following up on the latest assistant-stated fact.",
      `Referenced assistant fact: ${assistantFactSummary}`,
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      hasExplicitReplyAnchor
        ? "An explicit reply anchor was selected. Treat that anchor as the user's intended referent even if the latest turn is short or deictic."
        : "Treat this short follow-up as referring to the referenced assistant fact even if the user uses deictic wording like “这里/这个/that one/why didn’t it connect”.",
      `Latest user turn: ${task}`,
      "Explain the referenced assistant fact directly before adding any broader caveat.",
      "Do not claim a new action, a new success state, or a new result unless this turn produced new deterministic evidence.",
      "If the deeper cause is unknown, say that explicitly instead of speculating.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if ((input.turnKind === "follow_up" || input.turnKind === "continue_active_task") && previousTopicSummary) {
    return [
      `Continue the current topic: ${previousTopicSummary}`,
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      hasExplicitReplyAnchor
        ? "An explicit reply anchor was selected. Do not ask what 'this/that/here' refers to unless the reply anchor itself is ambiguous."
        : undefined,
      `Latest user turn: ${task}`,
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if ((input.turnKind === "follow_up" || input.turnKind === "continue_active_task") && hasExplicitReplyAnchor) {
    return [
      "The user is following up on a specifically referenced earlier exchange.",
      assistantFactSummary ? `Referenced assistant fact: ${assistantFactSummary}` : undefined,
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      `Latest user turn: ${task}`,
      "An explicit reply anchor was selected. Answer the referenced point directly from the anchored context.",
      "Do not reinterpret this as a generic troubleshooting or research request unless the user explicitly broadens the scope.",
      "Do not ask what 'this/that/here' refers to unless the reply anchor itself is ambiguous.",
      "Explain the referenced assistant fact directly before adding any broader caveat.",
      "Do not claim a new action, a new success state, or a new result unless this turn produced new deterministic evidence.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  return task;
}

export function prepareFridayConversationTurn(
  input: PrepareFridayConversationTurnInput,
): FridayPreparedConversationTurn {
  const focusState = input.focusState ?? null;
  const filteredRecords = filterConversationRecords(input.historyRecords, input.currentUserSequence);
  const turnKind = classifyFridayConversationTurn({
    task: input.task,
    focusState,
    historyRecords: filteredRecords,
    currentUserSequence: input.currentUserSequence,
    replyToMessageId: input.replyToMessageId,
  });
  const selection = buildConversationBlockSelection({
    task: input.task,
    historyRecords: filteredRecords,
    focusState,
    turnKind,
    replyToMessageId: input.replyToMessageId,
  });
  const currentTopicSummary = turnKind === "new_topic"
    ? summarizeTopic(input.task)
    : focusState?.currentTopicSummary ?? summarizeTopic(input.task);

  return {
    turnKind,
    historyMessages: selection.historyMessages,
    taskPrompt: buildTaskPrompt({
      task: input.task,
      turnKind,
      focusState,
      selectedBlocks: selection.selectedBlocks,
    }),
    previousTopicSummary: focusState?.currentTopicSummary,
    currentTopicSummary,
    selectedBlocks: selection.selectedBlocks,
    selectionReasons: selection.selectionReasons,
    replyAnchorMessageId: selection.replyAnchorMessageId,
    replyAnchorSequence: selection.replyAnchorSequence,
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
  const assistantAnchorSummary = summarizeTopic(input.responseText);
  const assistantAnchorFingerprint = fingerprintTopic(input.responseText);

  return {
    currentTopicFingerprint,
    currentTopicSummary,
    currentTopicStartSequence,
    assistantAnchorSummary,
    assistantAnchorFingerprint,
    replyAnchorMessageId: input.replyAnchorMessageId,
    replyAnchorSequence: input.replyAnchorSequence,
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
