export type FridaySessionMemoryExtractionTrigger = "auto" | "manual" | "retry";
export type FridaySessionMemoryExtractionJobStatus = "queued" | "running" | "completed" | "failed";
export type FridaySessionMemoryExtractionItemKind = "fact" | "decision" | "preference" | "action_item";

export interface FridaySessionMemoryExtractionJobRecord {
  id: string;
  sessionKey: string;
  trigger: FridaySessionMemoryExtractionTrigger;
  status: FridaySessionMemoryExtractionJobStatus;
  requestedMessageIds?: string[];
  batchSize: number;
  maxBatches: number;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FridaySessionMemoryExtractionRunResult {
  jobId?: string;
  sessionKey: string;
  trigger: FridaySessionMemoryExtractionTrigger;
  mode: "queued" | "inline";
  queued: boolean;
  processedMessageCount: number;
  extractedMessageCount: number;
  skippedMessageCount: number;
  failedMessageCount: number;
  memoryItemsCreated: number;
}

export interface FridaySessionMemoryExtractionStatus {
  sessionKey: string;
  pendingMessages: number;
  extractedMessages: number;
  skippedMessages: number;
  failedMessages: number;
  queuedJobs: number;
  runningJobs: number;
  lastCompletedAt?: string;
  lastFailedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface FridaySessionMemoryRetryResult {
  sessionsQueued: string[];
  resetMessageCount: number;
}

export interface FridaySessionMemoryExtractionLlmItem {
  kind: FridaySessionMemoryExtractionItemKind;
  content: string;
  sourceMessageIds: string[];
  tags?: string[];
}

export interface FridaySessionMemoryExtractionLlmResponse {
  items: FridaySessionMemoryExtractionLlmItem[];
}
