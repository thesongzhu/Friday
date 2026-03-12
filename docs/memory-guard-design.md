# Memory Guard Layer Design (Wrapper Around `FridayMemoryService`)

## 1) Architecture
1. `FridayMemoryGuard` is a request-scoped wrapper that implements `FridayMemoryService` and delegates to core `FridayMemoryService` only after guard checks.
2. Guard pipeline order for writes: validate/sanitize -> namespace isolation -> rate limit -> quota preflight + auto-prune expired -> PII policy -> core store -> output filter.
3. Guard pipeline order for reads/search: validate/sanitize -> namespace isolation -> rate limit -> core query -> output filter.
4. No core-memory behavior is modified; all protections are additive wrappers.

---

## 2) Constants File Spec
File: `src/memory/guard/friday-memory-guard.constants.ts`

```ts
// Validation limits
export const FRIDAY_MEMORY_GUARD_MAX_CONTENT_BYTES = 64 * 1024; // 64KB
export const FRIDAY_MEMORY_GUARD_MAX_METADATA_BYTES = 16 * 1024; // 16KB
export const FRIDAY_MEMORY_GUARD_MAX_TAG_COUNT = 32;
export const FRIDAY_MEMORY_GUARD_MAX_TAG_LENGTH = 64;
export const FRIDAY_MEMORY_GUARD_MAX_NAMESPACE_LENGTH = 128;
export const FRIDAY_MEMORY_GUARD_MAX_KEY_LENGTH = 128;
export const FRIDAY_MEMORY_GUARD_MAX_QUERY_CHARS = 512;
export const FRIDAY_MEMORY_GUARD_MAX_QUERY_TOKENS = 24;
export const FRIDAY_MEMORY_GUARD_MAX_QUERY_TOKEN_LENGTH = 64;

// Namespace/key format
export const FRIDAY_MEMORY_GUARD_NAMESPACE_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,31})(?:\.[a-z0-9](?:[a-z0-9-]{0,31}))*$/;
export const FRIDAY_MEMORY_GUARD_KEY_REGEX =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const FRIDAY_MEMORY_GUARD_TAG_REGEX =
  /^[a-z0-9][a-z0-9._:-]{0,63}$/;

// Namespace isolation
export const FRIDAY_MEMORY_GUARD_TENANT_PREFIX = "tenant";
export const FRIDAY_MEMORY_GUARD_USER_SEGMENT = "user";
export const FRIDAY_MEMORY_GUARD_RESERVED_NAMESPACE_PREFIXES = ["system"] as const;

// Rate limits (token bucket, compile-time constants)
export const FRIDAY_MEMORY_GUARD_WRITE_RATE_PER_MINUTE = 100;
export const FRIDAY_MEMORY_GUARD_SEARCH_RATE_PER_MINUTE = 200;
export const FRIDAY_MEMORY_GUARD_GLOBAL_WRITE_RATE_PER_MINUTE = 2_000;
export const FRIDAY_MEMORY_GUARD_GLOBAL_SEARCH_RATE_PER_MINUTE = 4_000;

// Quotas
export const FRIDAY_MEMORY_GUARD_QUOTA_MAX_ITEMS_PER_NAMESPACE = 10_000;
export const FRIDAY_MEMORY_GUARD_QUOTA_MAX_BYTES_PER_NAMESPACE = 100 * 1024 * 1024; // 100MB
export const FRIDAY_MEMORY_GUARD_QUOTA_APPROACHING_RATIO = 0.90;
export const FRIDAY_MEMORY_GUARD_AUTO_PRUNE_BATCH_SIZE = 250;

// PII policy (compile-time configurable)
export const FRIDAY_MEMORY_GUARD_PII_MODE = "tag" as const; // "block" | "redact" | "tag"
export const FRIDAY_MEMORY_GUARD_PII_TAG_PREFIX = "pii";
export const FRIDAY_MEMORY_GUARD_EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
export const FRIDAY_MEMORY_GUARD_US_PHONE_REGEX = /\b(?:\+1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s]?)?[2-9]\d{2}[-.\s]?\d{4}\b/g;
export const FRIDAY_MEMORY_GUARD_US_SSN_REGEX = /\b(?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g;
export const FRIDAY_MEMORY_GUARD_CREDIT_CARD_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

// Output filtering
export const FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS = 50;
export const FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS = 8_192;
export const FRIDAY_MEMORY_GUARD_MAX_RESULT_SNIPPET_CHARS = 512;

// Error codes
export const FRIDAY_MEMORY_GUARD_ERROR_CODES = {
  CONTENT_TOO_LARGE: "MEMORY_GUARD_CONTENT_TOO_LARGE",
  METADATA_TOO_LARGE: "MEMORY_GUARD_METADATA_TOO_LARGE",
  TAGS_TOO_MANY: "MEMORY_GUARD_TAGS_TOO_MANY",
  TAG_TOO_LONG: "MEMORY_GUARD_TAG_TOO_LONG",
  NAMESPACE_INVALID: "MEMORY_GUARD_NAMESPACE_INVALID",
  NAMESPACE_RESERVED: "MEMORY_GUARD_NAMESPACE_RESERVED",
  KEY_INVALID: "MEMORY_GUARD_KEY_INVALID",
  QUERY_INVALID: "MEMORY_GUARD_QUERY_INVALID",
  QUERY_EMPTY: "MEMORY_GUARD_QUERY_EMPTY",
  SCOPE_VIOLATION: "MEMORY_GUARD_SCOPE_VIOLATION",
  ITEM_ACCESS_DENIED: "MEMORY_GUARD_ITEM_ACCESS_DENIED",
  RATE_LIMIT_NAMESPACE_WRITE: "MEMORY_GUARD_RATE_LIMIT_NAMESPACE_WRITE",
  RATE_LIMIT_NAMESPACE_SEARCH: "MEMORY_GUARD_RATE_LIMIT_NAMESPACE_SEARCH",
  RATE_LIMIT_GLOBAL_WRITE: "MEMORY_GUARD_RATE_LIMIT_GLOBAL_WRITE",
  RATE_LIMIT_GLOBAL_SEARCH: "MEMORY_GUARD_RATE_LIMIT_GLOBAL_SEARCH",
  QUOTA_ITEMS_EXCEEDED: "MEMORY_GUARD_QUOTA_ITEMS_EXCEEDED",
  QUOTA_BYTES_EXCEEDED: "MEMORY_GUARD_QUOTA_BYTES_EXCEEDED",
  PII_BLOCKED: "MEMORY_GUARD_PII_BLOCKED",
  INTERNAL: "MEMORY_GUARD_INTERNAL",
} as const;
```

---

## 3) Types File Spec (All Interfaces)
File: `src/memory/guard/model/friday-memory-guard.types.ts`

```ts
import type { FridayAuthPrincipal } from "#api";
import type { FridaySqliteLayer } from "#state";
import type {
  FridayMemoryItem,
  FridayMemoryPruneOptions,
  FridayMemoryPruneResult,
  FridayMemorySearchQuery,
  FridayMemorySearchResult,
  FridayMemoryService,
  FridayMemoryStoreInput,
} from "#memory";

export type FridayMemoryGuardAccessLevel = "tenant" | "system";
export type FridayMemoryGuardAction = "write" | "search";
export type FridayMemoryGuardPiiMode = "block" | "redact" | "tag";
export type FridayMemoryGuardPiiType = "email" | "phone_us" | "ssn_us" | "credit_card";

export interface FridayMemoryGuardSubject {
  hubId: string;
  userId?: string;
  accessLevel: FridayMemoryGuardAccessLevel;
}

export interface FridayMemoryGuardContext {
  subject: FridayMemoryGuardSubject;
  principalId: string;
  requestId?: string;
}

export interface FridayMemoryGuardNamespaceResolution {
  requestedNamespace: string;
  effectiveNamespace: string;
  scopePrefix: string;
}

export interface FridayMemoryGuardRateLimitDecision {
  allowed: boolean;
  action: FridayMemoryGuardAction;
  key: string;
  remaining: number;
  resetAt: string;
  retryAfterMs: number;
}

export interface FridayMemoryGuardTokenBucketState {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  lastRefillMs: number;
}

export interface FridayMemoryGuardNamespaceUsage {
  namespace: string;
  itemCount: number;
  totalBytes: number;
  expiredItemCount: number;
  expiredBytes: number;
}

export interface FridayMemoryGuardPruneExpiredResult {
  deletedCount: number;
  deletedBytes: number;
  deletedIds: string[];
}

export interface FridayMemoryGuardQuotaDecision {
  allowed: boolean;
  usageBefore: FridayMemoryGuardNamespaceUsage;
  usageAfter?: FridayMemoryGuardNamespaceUsage;
  projectedItemCount: number;
  projectedTotalBytes: number;
  prunedExpired?: FridayMemoryGuardPruneExpiredResult;
}

export interface FridayMemoryGuardPiiMatch {
  type: FridayMemoryGuardPiiType;
  value: string;
  start: number;
  end: number;
}

export interface FridayMemoryGuardPiiScanResult {
  matches: FridayMemoryGuardPiiMatch[];
  distinctTypes: FridayMemoryGuardPiiType[];
  transformedContent: string;
  tagsToAdd: string[];
}

export interface FridayMemoryGuardSanitizedStoreInput {
  namespace: string;
  content: string;
  metadata?: Omit<FridayMemoryStoreInput, "namespace" | "content">;
}

export interface FridayMemoryGuardRateLimiter {
  consume(action: FridayMemoryGuardAction, namespace: string, nowMs: number): FridayMemoryGuardRateLimitDecision;
}

export interface FridayMemoryGuardQuotaRepository {
  getNamespaceUsage(db: import("better-sqlite3").Database, namespace: string, nowIso: string): FridayMemoryGuardNamespaceUsage;
  listNamespacesByPrefix(db: import("better-sqlite3").Database, prefix: string, limit: number): string[];
  pruneExpiredOldest(db: import("better-sqlite3").Database, input: { namespace: string; nowIso: string; limit: number }): FridayMemoryGuardPruneExpiredResult;
}

export interface FridayMemoryGuardPiiGuard {
  scanAndTransform(content: string): FridayMemoryGuardPiiScanResult;
}

export interface FridayMemoryGuardOutputFilter {
  filterItem(item: FridayMemoryItem): FridayMemoryItem;
  filterSearchResults(results: FridayMemorySearchResult[]): FridayMemorySearchResult[];
}

export interface FridayMemoryGuardService extends FridayMemoryService {}

export interface CreateFridayMemoryGuardServiceDeps {
  core: FridayMemoryService;
  db: FridaySqliteLayer;
  nowIso: () => string;
  nowMs: () => number;
  context: FridayMemoryGuardContext;
  rateLimiter: FridayMemoryGuardRateLimiter;
  quotaRepo: FridayMemoryGuardQuotaRepository;
  piiGuard: FridayMemoryGuardPiiGuard;
  outputFilter: FridayMemoryGuardOutputFilter;
}

export interface FridayMemoryGuardServiceFactory {
  forPrincipal(principal: FridayAuthPrincipal | null): FridayMemoryGuardService;
  forContext(context: FridayMemoryGuardContext): FridayMemoryGuardService;
}

export interface CreateFridayMemoryGuardServiceFactoryDeps {
  core: FridayMemoryService;
  db: FridaySqliteLayer;
  nowIso: () => string;
  nowMs: () => number;
  resolveContextFromPrincipal?: (principal: FridayAuthPrincipal | null) => FridayMemoryGuardContext;
}
```

---

## 4) Guard Service Interface + Implementation Plan
Files: `src/memory/guard/services/friday-memory-guard-service.types.ts`, `src/memory/guard/services/friday-memory-guard-service.ts`

```ts
export interface FridayMemoryGuardService extends FridayMemoryService {}

export function createFridayMemoryGuardService(
  deps: CreateFridayMemoryGuardServiceDeps,
): FridayMemoryGuardService;
```

Implementation plan:
1. `store`:
   - Validate content/tags/metadata/key/namespace formats and sizes.
   - Resolve effective namespace prefix from context.
   - Enforce reserved namespace policy (`system.*` tenant-denied).
   - Consume write rate tokens (namespace + global).
   - Compute projected quota; auto-prune oldest expired in same namespace if near/exceeded.
   - Apply PII mode on content (`block` throws, `redact` transforms, `tag` appends tags).
   - Delegate to `core.store(effectiveNamespace, transformedContent, sanitizedMetadata)`.
   - Filter output before return.
2. `search`:
   - Validate non-empty query and max length.
   - Sanitize query to safe FTS token-only expression.
   - Resolve namespace filter to scoped namespaces only.
   - Consume search rate tokens.
   - Clamp requested limit to `FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS`.
   - Delegate to `core.search(sanitizedQuery, scopedOptions)`.
   - Filter/truncate outputs.
3. `get`:
   - Delegate `core.get(itemId)`.
   - If found, verify item namespace is inside context scope; otherwise throw `ITEM_ACCESS_DENIED`.
   - Filter output.
4. `list`:
   - Resolve scoped namespace set (default: all namespaces under scope prefix).
   - Delegate to `core.list`.
   - Enforce item-level scope check on all returned rows.
   - Filter output.
5. `delete`:
   - Consume write rate tokens.
   - Read item via `core.get` then scope check.
   - Delegate `core.delete`.
6. `prune`:
   - Consume write rate tokens.
   - Scope all namespace filters.
   - Delegate `core.prune`.
7. Error discipline:
   - All guard validation/rejection paths throw `FridayDomainError` with unique `FRIDAY_MEMORY_GUARD_ERROR_CODES`.
   - No raw error throws; unexpected errors are wrapped as `MEMORY_GUARD_INTERNAL`.
   - No `as any`; use typed narrowing helpers (`isRecord`, `isStringArray`, etc).

---

## 5) Middleware/Wrapper Approach
1. Add `FridayMemoryGuardServiceFactory` and inject it into memory routes.
2. In each memory route handler, build request-scoped guarded service from `ctx.principal`.
3. Use guarded service only; never expose core service directly to HTTP.

Example handler pattern for `src/api/http/routes/friday-memory-routes.ts`:
```ts
const memory = deps.memoryGuardFactory.forPrincipal(ctx.principal);
const item = await memory.store(body.namespace, body.content, metadata);
return { item };
```

Flow:
`HTTP -> auth middleware -> memory route -> guard factory (principal->context) -> guarded service -> core service -> output filter -> response`.

Consistent error responses:
1. Guard only throws `FridayDomainError`.
2. Existing `buildErrorResponse` remains the only serializer, so no stack/internal details leak.

---

## 6) File Plan

New files:
1. `src/memory/guard/friday-memory-guard.constants.ts`
2. `src/memory/guard/model/friday-memory-guard.types.ts`
3. `src/memory/guard/persistence/friday-memory-guard-quota-repository.ts`
4. `src/memory/guard/services/friday-memory-rate-limiter.ts`
5. `src/memory/guard/services/friday-memory-pii-guard.ts`
6. `src/memory/guard/services/friday-memory-query-sanitizer.ts`
7. `src/memory/guard/services/friday-memory-output-filter.ts`
8. `src/memory/guard/services/friday-memory-guard-service.types.ts`
9. `src/memory/guard/services/friday-memory-guard-service.ts`
10. `src/memory/guard/services/friday-memory-guard-factory.ts`
11. `src/memory/guard/index.ts`

Files to modify:
1. `src/memory/index.ts` (export guard APIs)
2. `src/api/http/routes/friday-memory-routes.ts` (use guard factory)
3. `src/api/runtime/friday-api-runtime.types.ts` (add memory guard factory/runtime deps)
4. `src/api/runtime/friday-api-runtime.ts` (compose core + guard)
5. `src/api/model/friday-api-memory.types.ts` (public response shapes aligned with output filtering)
6. `src/api/index.ts` (memory API exports)
7. `package.json` (`#memory` import mapping if not already added by core phase)

---

## 7) Test Plan (All Test Files)

1. `test/unit/memory/guard/services/friday-memory-query-sanitizer.test.ts`
2. `test/unit/memory/guard/services/friday-memory-pii-guard.test.ts`
3. `test/unit/memory/guard/services/friday-memory-rate-limiter.test.ts`
4. `test/unit/memory/guard/persistence/friday-memory-guard-quota-repository.test.ts`
5. `test/unit/memory/guard/services/friday-memory-guard-service-validation.test.ts`
6. `test/unit/memory/guard/services/friday-memory-guard-service-namespace-isolation.test.ts`
7. `test/unit/memory/guard/services/friday-memory-guard-service-rate-limit.test.ts`
8. `test/unit/memory/guard/services/friday-memory-guard-service-quota.test.ts`
9. `test/unit/memory/guard/services/friday-memory-guard-service-pii-policy.test.ts`
10. `test/unit/memory/guard/services/friday-memory-guard-service-output-filter.test.ts`
11. `test/unit/api/http/routes/friday-memory-routes.test.ts` (guard factory wiring + scoped behavior)
12. `test/unit/api/runtime/friday-api-runtime-memory-guard-registration.test.ts` (runtime composition + route registration)

Key assertions:
1. Every rejection path throws `FridayDomainError` with the expected unique guard code.
2. No cross-namespace read/write is possible via list/search/get/delete/prune.
3. PII mode behavior is deterministic for `block`, `redact`, and `tag`.
4. Quota pre-check + auto-prune expired works before write.
5. Search query sanitization strips operators/injection syntax and remains valid FTS input.
6. Returned payloads are truncated/filtered per constants.

---

## 8) Integration Points With `docs/memory-core-design.md`
1. Guard wraps `createFridayMemoryService(...)` output; core interfaces and repositories remain unchanged.
2. Guard depends on core `FridayMemoryService` methods exactly as defined in memory-core design (`store/search/get/list/delete/prune`).
3. Guard uses core namespace semantics but enforces scoped-prefix transformation before delegation.
4. Guard can use core prune behavior and memory tables introduced by v004 for quota/autoprune operations.
5. Memory API routes from memory-core design switch dependency from direct `memoryService` to `memoryGuardFactory`.
6. API runtime from memory-core design composes in this order: core memory service -> guard factory -> routes.
7. Error handling remains centralized via existing HTTP error mapper; guard guarantees safe domain errors.
8. This layer introduces no behavioral changes inside core search/store logic; it is strictly pre/post enforcement around core calls.
