export type FridaySessionStatus = "active" | "idle" | "archived" | "pruned";
export type FridaySessionRole = "system" | "user" | "assistant" | "tool";
export type FridaySessionChatKind = "dm" | "group" | "channel" | "thread";
export type FridayConversationTurnKind =
  | "new_topic"
  | "follow_up"
  | "clarification"
  | "status_check"
  | "continue_active_task";

export type FridayConversationBlockSource =
  | "reply_anchor"
  | "assistant_anchor"
  | "recent_user"
  | "focus_topic"
  | "active_run"
  | "pending_plan"
  | "status_anchor";

export interface FridayConversationBlock {
  id: string;
  source: FridayConversationBlockSource;
  summary: string;
  score: number;
  reason: string;
  messageIds?: string[];
  sequenceStart?: number;
  sequenceEnd?: number;
}

export interface FridayContextSelectionResult {
  selectedBlocks: FridayConversationBlock[];
  selectionReasons: string[];
}

/**
 * Send policy controls whether outbound messages are allowed for a session.
 * - "allow"  — messages can be sent (default behavior)
 * - "block"  — messages are silently dropped
 * - "queue"  — messages are queued for later delivery
 */
export type FridaySessionSendPolicy = "allow" | "block" | "queue";

export interface FridaySessionKeyParts {
  kind: "conversation" | "subagent";
  channel?: string;
  accountId?: string;
  chatId?: string;
  parentKey?: string;
  taskId?: string;
  canonicalKey: string;
}

export interface FridaySessionRecord {
  id: string;
  key: string;
  channel: string;
  accountId: string;
  chatId: string;
  userId?: string;
  chatKind: FridaySessionChatKind;
  status: FridaySessionStatus;
  memoryNamespace?: string;
  parentSessionKey?: string;
  rootSessionKey?: string;
  forkedFromMessageId?: string;
  sendPolicy?: FridaySessionSendPolicy;
  metadata: Record<string, unknown>;
  contextInputTokens: number;
  contextOutputTokens: number;
  contextTotalTokens: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  statusChangedAt?: string;
  idleAt?: string;
  archivedAt?: string;
  prunedAt?: string;
}

export interface FridaySessionConversationFocusState {
  currentTopicFingerprint?: string;
  currentTopicSummary?: string;
  currentTopicStartSequence?: number;
  assistantAnchorSummary?: string;
  assistantAnchorFingerprint?: string;
  replyAnchorMessageId?: string;
  replyAnchorSequence?: number;
  lastAnsweredQuestion?: string;
  lastAssistantAskedQuestion?: boolean;
  lastRunId?: string;
  activeRunId?: string;
  activeSubagentIds?: string[];
  pendingPlanRunId?: string;
  lastTurnKind?: FridayConversationTurnKind;
  updatedAt: string;
}

export interface FridaySessionMessageRecord {
  id: string;
  sessionId: string;
  sessionKey: string;
  sequence: number;
  role: FridaySessionRole;
  content: unknown;
  contentText: string;
  toolCalls?: unknown[];
  tokenCount: number;
  idempotencyKey?: string;
  parentMessageId?: string;
  metadata: Record<string, unknown>;
  memoryExtractStatus: "pending" | "extracted" | "skipped" | "failed";
  memoryExtractedAt?: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  inherited?: boolean;
  inheritedFromSessionKey?: string;
  inheritedFromMessageId?: string;
}

export interface FridaySessionMessageInput {
  role: FridaySessionRole;
  content: unknown;
  contentText?: string;
  toolCalls?: unknown[];
  tokenCount?: number;
  idempotencyKey?: string;
  parentMessageId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export interface FridaySessionCreateInput {
  channel: string;
  chatId: string;
  userId?: string;
  accountId?: string;
  chatKind?: FridaySessionChatKind;
  sendPolicy?: FridaySessionSendPolicy;
  metadata?: Record<string, unknown>;
}

export interface FridaySessionListInput {
  channel?: string;
  accountId?: string;
  userId?: string;
  status?: FridaySessionStatus;
  limit?: number;
  cursor?: string;
}

export interface FridaySessionPruneResult {
  archivedToPrunedCount: number;
  hardDeletedCount: number;
  sessionKeys: string[];
}

// ─── Fork types ───

export interface FridaySessionForkCreateInput {
  taskId?: string;
  inheritMessageCount?: number;
  forkFromMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface FridaySessionForkCreateResult {
  forkSession: FridaySessionRecord;
  inheritedMessageCount: number;
  forkedFromMessageId?: string;
}

export interface FridaySessionForkListInput {
  status?: FridaySessionStatus;
  limit?: number;
}

export interface FridaySessionForkMergeInput {
  forkSessionKey: string;
  summary: string;
  archiveFork?: boolean;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface FridaySessionForkMergeResult {
  parentMessage: FridaySessionMessageRecord;
  forkSession: FridaySessionRecord;
}
