// ─── Memory Core barrel exports ───

// Constants
export {
  FRIDAY_MEMORY_FTS_TABLE,
  FRIDAY_MEMORY_EMBEDDINGS_TABLE,
  FRIDAY_MEMORY_DEFAULT_LIMIT,
  FRIDAY_MEMORY_MAX_LIMIT,
  FRIDAY_MEMORY_DEFAULT_CANDIDATE_LIMIT,
  FRIDAY_MEMORY_DEFAULT_FTS_WEIGHT,
  FRIDAY_MEMORY_DEFAULT_SEMANTIC_WEIGHT,
  FRIDAY_MEMORY_DEFAULT_SOURCE,
  FRIDAY_MEMORY_DEFAULT_TTL_SECONDS,
  FRIDAY_MEMORY_DEFAULT_EMBEDDING_MODEL,
  FRIDAY_MEMORY_ERROR_CODES,
} from "./friday-memory.constants.js";

// Model types
export type {
  FridayMemoryNamespace,
  FridayMemoryItem,
  FridayMemoryEmbedding,
  FridayMemorySearchQuery,
  FridayMemorySearchResult,
  FridayMemoryStoreInput,
  FridayMemoryPruneOptions,
  FridayMemoryPruneResult,
  FridayMemoryFtsHit,
  FridayMemorySemanticHit,
} from "./model/friday-memory.types.js";

// Persistence
export type { FridayMemoryItemRepository } from "./persistence/friday-memory-item-repository.js";
export { createFridayMemoryItemRepository } from "./persistence/friday-memory-item-repository.js";
export type { FridayMemoryEmbeddingRepository } from "./persistence/friday-memory-embedding-repository.js";
export { createFridayMemoryEmbeddingRepository } from "./persistence/friday-memory-embedding-repository.js";

// Search
export { mergeHybridResults } from "./search/friday-memory-hybrid.js";
export type { MergeHybridResultsInput } from "./search/friday-memory-hybrid.js";

// Embedding client
export type { FridayMemoryByokEmbeddingClient, FridayMemoryEmbeddingResponse, CreateFridayMemoryByokEmbeddingClientDeps } from "./services/friday-memory-byok-embedding-client.js";
export { createFridayMemoryByokEmbeddingClient } from "./services/friday-memory-byok-embedding-client.js";

// Service
export type { FridayMemoryService, CreateFridayMemoryServiceDeps } from "./services/friday-memory-service.types.js";
export { createFridayMemoryService } from "./services/friday-memory-service.js";

// ─── Memory File Sync ───

export type {
  FridayMemorySyncEntityType,
  FridayMemoryFileSyncService,
  FridayMemoryFileSyncResult,
  FridayMemoryFileSyncReindexResult,
  FridayMemoryFileSyncStatus,
  FridayMemoryFileSyncDirtyRow,
  FridayMemoryFileSyncStateRow,
} from "./sync/friday-memory-file-sync.types.js";

export {
  FRIDAY_MEMORY_FILE_SYNC_DEBOUNCE_MS,
  FRIDAY_MEMORY_FILE_SYNC_POLL_INTERVAL_MS,
  FRIDAY_MEMORY_FILE_SYNC_BATCH_SIZE,
  FRIDAY_MEMORY_FILE_SYNC_SESSION_DELTA_BYTES,
  FRIDAY_MEMORY_FILE_SYNC_SESSION_DELTA_MESSAGES,
  FRIDAY_MEMORY_FILE_SYNC_EXPORT_DIR,
} from "./sync/friday-memory-file-sync.constants.js";

export { createFridayMemoryFileSyncRepository } from "./sync/friday-memory-file-sync-repository.js";
export type { FridayMemoryFileSyncRepository } from "./sync/friday-memory-file-sync-repository.js";

export { createFridayMemoryFileSyncService } from "./sync/friday-memory-file-sync-service.js";
export type { CreateFridayMemoryFileSyncServiceDeps } from "./sync/friday-memory-file-sync-service.js";

export {
  resolveExportRoot,
  memoryNamespaceExportPath,
  sessionKeyExportPath,
} from "./sync/friday-memory-file-sync-paths.js";

export { createFridayMemoryFileSyncWatcher } from "./sync/friday-memory-file-sync-watcher.js";
export type { FridayMemoryFileSyncWatcher, CreateFridayMemoryFileSyncWatcherDeps } from "./sync/friday-memory-file-sync-watcher.js";
export { FRIDAY_MEMORY_FILE_SYNC_WATCHER_DEBOUNCE_MS } from "./sync/friday-memory-file-sync-watcher.js";

// Guard
export {
  FRIDAY_MEMORY_GUARD_MAX_CONTENT_BYTES,
  FRIDAY_MEMORY_GUARD_MAX_METADATA_BYTES,
  FRIDAY_MEMORY_GUARD_MAX_TAG_COUNT,
  FRIDAY_MEMORY_GUARD_MAX_TAG_LENGTH,
  FRIDAY_MEMORY_GUARD_MAX_NAMESPACE_LENGTH,
  FRIDAY_MEMORY_GUARD_MAX_KEY_LENGTH,
  FRIDAY_MEMORY_GUARD_MAX_QUERY_CHARS,
  FRIDAY_MEMORY_GUARD_MAX_QUERY_TOKENS,
  FRIDAY_MEMORY_GUARD_MAX_QUERY_TOKEN_LENGTH,
  FRIDAY_MEMORY_GUARD_NAMESPACE_REGEX,
  FRIDAY_MEMORY_GUARD_KEY_REGEX,
  FRIDAY_MEMORY_GUARD_TAG_REGEX,
  FRIDAY_MEMORY_GUARD_TENANT_PREFIX,
  FRIDAY_MEMORY_GUARD_USER_SEGMENT,
  FRIDAY_MEMORY_GUARD_RESERVED_NAMESPACE_PREFIXES,
  FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE,
  FRIDAY_MEMORY_GUARD_SEARCH_RATE_PER_MINUTE,
  FRIDAY_MEMORY_GUARD_GLOBAL_WRITE_RATE_PER_MINUTE,
  FRIDAY_MEMORY_GUARD_GLOBAL_SEARCH_RATE_PER_MINUTE,
  FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE,
  FRIDAY_MEMORY_GUARD_QUOTA_MAX_BYTES_PER_NAMESPACE,
  FRIDAY_MEMORY_GUARD_QUOTA_APPROACHING_RATIO,
  FRIDAY_MEMORY_GUARD_AUTO_PRUNE_BATCH_SIZE,
  FRIDAY_MEMORY_GUARD_PII_MODE,
  FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX,
  FRIDAY_MEMORY_GUARD_EMAIL_REGEX,
  FRIDAY_MEMORY_GUARD_US_PHONE_REGEX,
  FRIDAY_MEMORY_GUARD_US_SSN_REGEX,
  FRIDAY_MEMORY_GUARD_CREDIT_CARD_REGEX,
  FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS,
  FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS,
  FRIDAY_MEMORY_GUARD_MAX_RESULT_SNIPPET_CHARS,
  FRIDAY_MEMORY_GUARD_ERROR_CODES,
  createFridayMemoryGuardQuotaRepository,
  createFridayMemoryRateLimiter,
  createFridayMemoryPiiGuard,
  sanitizeFridayMemoryQuery,
  createFridayMemoryOutputFilter,
  createFridayMemoryGuardService,
  createFridayMemoryGuardServiceFactory,
} from "./guard/index.js";
export type {
  FridayMemoryGuardAccessLevel,
  FridayMemoryGuardAction,
  FridayMemoryGuardPiiMode,
  FridayMemoryGuardPiiType,
  FridayMemoryGuardSubject,
  FridayMemoryGuardContext,
  FridayMemoryGuardNamespaceResolution,
  FridayMemoryGuardRateLimitDecision,
  FridayMemoryGuardTokenBucketState,
  FridayMemoryGuardNamespaceUsage,
  FridayMemoryGuardPruneExpiredResult,
  FridayMemoryGuardQuotaDecision,
  FridayMemoryGuardPiiMatch,
  FridayMemoryGuardPiiScanResult,
  FridayMemoryGuardSanitizedStoreInput,
  FridayMemoryGuardRateLimiter,
  FridayMemoryGuardQuotaRepository,
  FridayMemoryGuardPiiGuard,
  FridayMemoryGuardOutputFilter,
  FridayMemoryGuardService,
  CreateFridayMemoryGuardServiceDeps,
  FridayMemoryGuardServiceFactory,
  CreateFridayMemoryGuardServiceFactoryDeps,
} from "./guard/index.js";

// ─── Episode & Pattern Extractors ───

export type { FridayEpisodeExtractor, CreateFridayEpisodeExtractorDeps } from "./services/friday-episode-extractor.js";
export { createFridayEpisodeExtractor } from "./services/friday-episode-extractor.js";

export type { FridayPatternExtractor, CreateFridayPatternExtractorDeps } from "./services/friday-pattern-extractor.js";
export { createFridayPatternExtractor } from "./services/friday-pattern-extractor.js";
