// ─── Constants ───

export {
  FRIDAY_SESSION_DEFAULT_ACCOUNT_ID,
  FRIDAY_SESSION_SUBAGENT_PREFIX,
  FRIDAY_SESSION_STATUS_ACTIVE,
  FRIDAY_SESSION_STATUS_IDLE,
  FRIDAY_SESSION_STATUS_ARCHIVED,
  FRIDAY_SESSION_STATUS_PRUNED,
  FRIDAY_SESSION_DEFAULT_MESSAGE_LIMIT,
  FRIDAY_SESSION_MAX_MESSAGE_LIMIT,
  FRIDAY_SESSION_IDLE_TIMEOUT_MS,
  FRIDAY_SESSION_ARCHIVE_TIMEOUT_MS,
  FRIDAY_SESSION_PRUNE_TIMEOUT_MS,
  FRIDAY_SESSION_HARD_DELETE_TIMEOUT_MS,
  FRIDAY_SESSION_KEY_SEGMENT_MAX_LENGTH,
  FRIDAY_SESSION_KEY_SEGMENT_REGEX,
  FRIDAY_SESSION_MEMORY_NAMESPACE_TENANT_SEGMENT,
  FRIDAY_SESSION_MEMORY_NAMESPACE_CHANNEL_SEGMENT,
  FRIDAY_SESSION_MEMORY_NAMESPACE_USER_SEGMENT,
  FRIDAY_SESSION_MEMORY_NAMESPACE_SHARED_SEGMENT,
  FRIDAY_SESSION_MEMORY_SOURCE_PREFIX,
  FRIDAY_SESSION_ERROR_CODES,
  FRIDAY_SESSION_FORK_DEFAULT_CONTEXT_MESSAGE_COUNT,
  FRIDAY_SESSION_FORK_MAX_CONTEXT_MESSAGE_COUNT,
  FRIDAY_SESSION_FORK_TIMEOUT_MS,
  FRIDAY_SESSION_FORK_DEFAULT_ARCHIVE_ON_MERGE,
} from "./friday-session.constants.js";

// ─── Model types ───

export type {
  FridaySessionStatus,
  FridaySessionRole,
  FridaySessionChatKind,
  FridayConversationTurnKind,
  FridayConversationBlockSource,
  FridayConversationBlock,
  FridayEvidenceBlock,
  FridayConversationHistoryBlockKind,
  FridayConversationHistoryBlockSummary,
  FridayContextSelectionResult,
  FridaySessionKeyParts,
  FridaySessionSendPolicy,
  FridaySessionConversationFocusState,
  FridaySessionRecord,
  FridaySessionMessageRecord,
  FridaySessionMessageInput,
  FridaySessionCreateInput,
  FridaySessionListInput,
  FridaySessionPruneResult,
  FridaySessionForkCreateInput,
  FridaySessionForkCreateResult,
  FridaySessionForkListInput,
  FridaySessionForkMergeInput,
  FridaySessionForkMergeResult,
} from "./model/friday-session.types.js";

// ─── Persistence ───

export { createFridaySessionRepository } from "./persistence/friday-session-repository.js";
export type { FridaySessionRepository } from "./persistence/friday-session-repository.js";

export { createFridaySessionMessageRepository } from "./persistence/friday-session-message-repository.js";
export type { FridaySessionMessageRepository, FridaySessionMessageAppendResult } from "./persistence/friday-session-message-repository.js";

// ─── Session key utilities ───

export {
  buildFridaySessionKey,
  buildFridayDmSessionKey,
  buildFridaySubagentSessionKey,
  parseFridaySessionKey,
  validateFridaySessionKey,
  normalizeFridaySessionKey,
  canonicalizeFridaySessionKey,
} from "./services/friday-session-key.js";

// ─── Send policy ───

export {
  FRIDAY_SESSION_DEFAULT_SEND_POLICY,
  FRIDAY_SESSION_VALID_SEND_POLICIES,
  normalizeFridaySessionSendPolicy,
  resolveFridaySessionSendPolicy,
  isFridaySessionSendAllowed,
} from "./services/friday-session-send-policy.js";
export type { FridaySessionSendPolicyResolveInput } from "./services/friday-session-send-policy.js";

// ─── Memory namespace ───

export {
  resolveFridaySessionMemoryNamespace,
  buildFridaySessionMemorySource,
  buildFridaySessionMemoryMetadata,
} from "./services/friday-session-memory-namespace.js";

// ─── Service ───

export type { FridaySessionService, FridaySessionSweepResult, CreateFridaySessionServiceDeps } from "./services/friday-session-service.types.js";
export { createFridaySessionService } from "./services/friday-session-service.js";
export type {
  FridayPreparedConversationTurn,
  PrepareFridayConversationTurnInput,
  FinalizeFridayConversationFocusInput,
} from "./services/friday-session-conversation-orchestrator.js";
export {
  classifyFridayConversationTurn,
  prepareFridayConversationTurn,
  finalizeFridayConversationFocus,
} from "./services/friday-session-conversation-orchestrator.js";

// ─── Memory extraction constants ───

export {
  FRIDAY_SESSION_MEMORY_EXTRACTION_MIN_BATCH_SIZE,
  FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_BATCH_SIZE,
  FRIDAY_SESSION_MEMORY_EXTRACTION_MAX_BATCH_SIZE,
  FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_MAX_BATCHES,
  FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_MAX_ITEMS_PER_BATCH,
  FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_JOB_MAX_ATTEMPTS,
  FRIDAY_SESSION_MEMORY_EXTRACTION_RETRY_BASE_DELAY_MS,
  FRIDAY_SESSION_MEMORY_EXTRACTION_WORKER_CLAIM_LIMIT,
  FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_AUTO,
  FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_MANUAL,
  FRIDAY_SESSION_MEMORY_EXTRACTION_TAG_PREFIX_KIND,
  FRIDAY_SESSION_MEMORY_EXTRACTION_ERROR_CODES,
} from "./friday-session-memory-extraction.constants.js";

// ─── Memory extraction types ───

export type {
  FridaySessionMemoryExtractionTrigger,
  FridaySessionMemoryExtractionJobStatus,
  FridaySessionMemoryExtractionItemKind,
  FridaySessionMemoryExtractionJobRecord,
  FridaySessionMemoryExtractionRunResult,
  FridaySessionMemoryExtractionStatus,
  FridaySessionMemoryRetryResult,
  FridaySessionMemoryExtractionLlmItem,
  FridaySessionMemoryExtractionLlmResponse,
} from "./model/friday-session-memory-extraction.types.js";

// ─── Memory extraction persistence ───

export { createFridaySessionMemoryExtractionRepository } from "./persistence/friday-session-memory-extraction-repository.js";
export type { FridaySessionMemoryExtractionRepository } from "./persistence/friday-session-memory-extraction-repository.js";

// ─── Memory extraction LLM client ───

export { createFridaySessionMemoryExtractionLlmClient } from "./services/friday-session-memory-extraction-llm-client.js";
export type { FridaySessionMemoryExtractionLlmClient, CreateFridaySessionMemoryExtractionLlmClientDeps } from "./services/friday-session-memory-extraction-llm-client.js";

// ─── Memory extraction service ───

export type { FridaySessionMemoryExtractionService, CreateFridaySessionMemoryExtractionServiceDeps } from "./services/friday-session-memory-extraction-service.types.js";
export { createFridaySessionMemoryExtractionService } from "./services/friday-session-memory-extraction-service.js";
