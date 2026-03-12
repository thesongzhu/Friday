// ─── Memory Guard barrel exports ───

// Constants
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
} from "./friday-memory-guard.constants.js";

// Guard types
export type * from "./model/friday-memory-guard.types.js";

// Persistence
export { createFridayMemoryGuardQuotaRepository } from "./persistence/friday-memory-guard-quota-repository.js";

// Services
export { createFridayMemoryRateLimiter } from "./services/friday-memory-rate-limiter.js";
export { createFridayMemoryPiiGuard } from "./services/friday-memory-pii-guard.js";
export { sanitizeFridayMemoryQuery } from "./services/friday-memory-query-sanitizer.js";
export { createFridayMemoryOutputFilter } from "./services/friday-memory-output-filter.js";
export { createFridayMemoryGuardService } from "./services/friday-memory-guard-service.js";
export { createFridayMemoryGuardServiceFactory } from "./services/friday-memory-guard-factory.js";
