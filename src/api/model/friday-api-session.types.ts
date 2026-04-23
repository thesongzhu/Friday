import type {
  FridaySessionChatKind,
  FridaySessionForkCreateResult,
  FridaySessionForkMergeResult,
  FridaySessionMemoryExtractionRunResult,
  FridaySessionMemoryExtractionStatus,
  FridaySessionMemoryRetryResult,
  FridaySessionMessageInput,
  FridaySessionMessageRecord,
  FridaySessionPruneResult,
  FridaySessionRecord,
  FridaySessionSweepResult,
} from "#sessions";

// ─── Session CRUD ───

export interface FridaySessionCreateRequest {
  channel: string;
  chatId: string;
  userId?: string;
  accountId?: string;
  chatKind?: FridaySessionChatKind;
  metadata?: Record<string, unknown>;
}

export interface FridaySessionCreateResponse {
  session: FridaySessionRecord;
}

export interface FridaySessionGetResponse {
  session: FridaySessionRecord;
}

export interface FridaySessionListResponse {
  items: FridaySessionRecord[];
}

export interface FridaySessionArchiveResponse {
  session: FridaySessionRecord;
}

// ─── Session prune ───

export interface FridaySessionPruneRequest {
  olderThan: string;
}

export interface FridaySessionPruneResponse {
  result: FridaySessionPruneResult;
}

// ─── Session sweep ───

export interface FridaySessionSweepResponse {
  result: FridaySessionSweepResult;
}

// ─── Messages ───

export interface FridaySessionMessageCreateRequest extends FridaySessionMessageInput {}

export interface FridaySessionMessageCreateResponse {
  message: FridaySessionMessageRecord;
  hint?: string;
}

export interface FridaySessionMessageListResponse {
  items: FridaySessionMessageRecord[];
}

export interface FridaySessionOutboundRequest {
  text: string;
  images?: string[];
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface FridaySessionOutboundResponse {
  delivery: {
    channel: string;
    chatId: string;
    messageId: string;
  };
  message: FridaySessionMessageRecord;
}

import type { FridayAgentRunStatus } from "#agent";

// ─── Memory namespace ───

export interface FridaySessionMemoryNamespaceResponse {
  namespace: string;
}

// ─── Session run (legacy compatibility) ───

export interface FridaySessionRunRequest {
  task?: string;
  providerId?: string;
  model?: string;
  replyToMessageId?: string;
  timezone?: string;
  timeoutMs?: number;
}

export interface FridaySessionRunResponse {
  run: {
    runId: string;
    status: FridayAgentRunStatus;
    response: string;
    toolCallCount: number;
    durationMs: number;
    usageInput: number;
    usageOutput: number;
  };
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
  }>;
}

// ─── Fork ───

export interface FridaySessionForkRequest {
  taskId?: string;
  inheritMessageCount?: number;
  forkFromMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface FridaySessionForkResponse {
  result: FridaySessionForkCreateResult;
}

export interface FridaySessionForkListResponse {
  items: FridaySessionRecord[];
}

export interface FridaySessionMergeRequest {
  forkSessionKey: string;
  summary: string;
  archiveFork?: boolean;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface FridaySessionMergeResponse {
  result: FridaySessionForkMergeResult;
}

// ─── Memory extraction ───

export interface FridaySessionMemoryExtractRequest {
  trigger?: "auto" | "manual" | "retry";
  mode?: "queue" | "inline";
  batchSize?: number;
  maxBatches?: number;
}

export interface FridaySessionMemoryExtractResponse {
  result: FridaySessionMemoryExtractionRunResult;
}

export interface FridaySessionMemoryRememberRequest {
  messageIds: string[];
  mode?: "queue" | "inline";
}

export interface FridaySessionMemoryRememberResponse {
  result: FridaySessionMemoryExtractionRunResult;
}

export interface FridaySessionMemoryExtractionStatusResponse {
  status: FridaySessionMemoryExtractionStatus;
}

export interface FridaySessionMemoryExtractionRetryResponse {
  result: FridaySessionMemoryRetryResult;
}
