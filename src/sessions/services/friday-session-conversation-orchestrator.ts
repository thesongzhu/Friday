import { createHash } from "node:crypto";

import type { FridayAgentMessage } from "#agent";

import type {
  FridayContextSelectionResult,
  FridayConversationBlock,
  FridayConversationTurnKind,
  FridaySessionConversationFocusState,
  FridaySessionMessageRecord,
} from "../model/friday-session.types.js";

const MAX_TOPIC_SUMMARY_CHARS = 180;
const MAX_FOLLOW_UP_HISTORY = 12;
const MAX_STATUS_HISTORY = 6;
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
  const shortTask = task.length > 0 && task.length <= 120;
  const advisoryContinuation =
    ADVISORY_CONTINUATION_HINTS.test(taskLower)
    && ADVISORY_CONTINUATION_HINTS.test(focusSummary.toLowerCase());
  const followUpHint =
    FOLLOW_UP_HINTS.test(taskLower)
    || CHINESE_FOLLOW_UP_HINTS.test(task)
    || DEICTIC_FOLLOW_UP_HINTS.test(taskLower);

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
    (hasFocus || latestAssistantOverlap >= 1 || latestUserOverlap >= 2)
    && (
      overlap >= 2
      || latestAssistantOverlap >= 1
      || latestUserOverlap >= 2
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

function buildConversationBlockSelection(input: {
  task: string;
  historyRecords: FridaySessionMessageRecord[];
  focusState?: FridaySessionConversationFocusState | null;
  turnKind: FridayConversationTurnKind;
  replyToMessageId?: string;
}): FridayContextSelectionResult & { historyMessages: FridayAgentMessage[]; replyAnchorMessageId?: string; replyAnchorSequence?: number } {
  const taskTokens = tokenize(input.task);
  const taskLower = normalizeText(input.task).toLowerCase();
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
        FOLLOW_UP_HINTS.test(taskLower)
        || DEICTIC_FOLLOW_UP_HINTS.test(taskLower)
        || CHINESE_FOLLOW_UP_HINTS.test(input.task)
        ? 18
        : 0
      )
      + (input.turnKind === "follow_up" || input.turnKind === "clarification" ? 10 : 0);
    registerCandidate(createMessageBlockCandidate({
      id: `assistant:${latestAssistant.id}`,
      source: "assistant_anchor",
      summary: buildAnchorWindow(records, latestAssistant).map((record) => `${record.role}: ${record.contentText}`).join("\n"),
      score: assistantScore,
      reason: assistantOverlap > 0
        ? `Current turn overlaps the latest assistant answer (${String(assistantOverlap)} token match(es)).`
        : "Latest assistant answer is a plausible short-follow-up anchor.",
      records: buildAnchorWindow(records, latestAssistant),
    }));
  }

  const latestUser = findLatestRecord(records, "user");
  if (latestUser) {
    const userOverlap = countOverlap(taskTokens, tokenize(latestUser.contentText));
    const userScore = (userOverlap * 14) + (input.turnKind === "follow_up" ? 8 : 0);
    registerCandidate(createMessageBlockCandidate({
      id: `user:${latestUser.id}`,
      source: "recent_user",
      summary: latestUser.contentText,
      score: userScore,
      reason: userOverlap > 0
        ? `Current turn overlaps the most recent user turn (${String(userOverlap)} token match(es)).`
        : "Most recent user turn is a fallback short-context anchor.",
      records: [latestUser],
    }));
  }

  if (focusState?.currentTopicSummary) {
    const focusOverlap = countOverlap(taskTokens, tokenize(focusState.currentTopicSummary));
    const focusScore = (focusOverlap * 12)
      + (input.turnKind === "follow_up" || input.turnKind === "clarification" ? 8 : 0);
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
    });
  }

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
    const topicWindowScore = 36 + (countOverlap(taskTokens, tokenize(topicWindowSummary)) * 10);
    registerCandidate(createMessageBlockCandidate({
      id: `topic-window:${String(focusState?.currentTopicStartSequence)}`,
      source: "focus_topic",
      summary: topicWindowSummary,
      score: topicWindowScore,
      reason: "Current turn is still inside the persisted topic window.",
      records: topicWindowRecords,
    }));
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

  const useCrossTopicRecapWindow =
    input.turnKind === "follow_up"
    && (
      CROSS_TOPIC_RECAP_HINTS.test(input.task)
      || CHINESE_CROSS_TOPIC_RECAP_HINTS.test(input.task)
    );

  const scoreThreshold = input.turnKind === "new_topic" ? 60 : 1;
  const selectedCandidates = candidates
    .filter((candidate) => candidate.block.score >= scoreThreshold || candidate.block.source === "reply_anchor")
    .sort((left, right) => right.block.score - left.block.score || left.block.id.localeCompare(right.block.id))
    .slice(0, input.turnKind === "status_check" ? 3 : 4);
  const selectionReasons = selectedCandidates.map((candidate) =>
    `${candidate.block.source} → ${candidate.block.reason}`);

  const messageMap = new Map<string, { sequence: number; message: FridayAgentMessage }>();
  for (const candidate of selectedCandidates) {
    for (const messageRecord of candidate.block.messageIds ?? []) {
      const record = records.find((entry) => entry.id === messageRecord);
      const mapped = record ? mapSessionMessageToAgentMessage(record) : null;
      if (record && mapped) {
        messageMap.set(record.id, { sequence: record.sequence, message: mapped });
      }
    }
  }

  if (useCrossTopicRecapWindow && records.length > 0) {
    const maxCount = input.turnKind === "status_check" ? MAX_STATUS_HISTORY : MAX_FOLLOW_UP_HISTORY;
    for (const record of records.slice(Math.max(0, records.length - maxCount))) {
      const mapped = mapSessionMessageToAgentMessage(record);
      if (mapped) {
        messageMap.set(record.id, { sequence: record.sequence, message: mapped });
      }
    }
  }

  const historyMessages = [...messageMap.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-(input.turnKind === "status_check" ? MAX_STATUS_HISTORY : MAX_FOLLOW_UP_HISTORY))
    .map((entry) => entry.message);

  return {
    selectedBlocks: selectedCandidates.map((candidate) => candidate.block),
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
  const selectedBlockSummary = input.selectedBlocks.length > 0
    ? input.selectedBlocks
      .map((block) => `- [${block.source}] ${block.summary}`)
      .join("\n")
    : undefined;

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
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      `Latest user turn: ${task}`,
      "An explicit reply anchor was selected. Answer the referenced point directly from the anchored context.",
      "Do not reinterpret this as a generic troubleshooting or research request unless the user explicitly broadens the scope.",
      "Do not ask what 'this/that/here' refers to unless the reply anchor itself is ambiguous.",
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
