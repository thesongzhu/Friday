import type { FridayAuthPrincipal } from "#api";
import type { FridaySqliteLayer } from "#state";
import type {
  FridayMemoryItem,
  FridayMemorySearchResult,
  FridayMemoryStoreInput,
} from "../../model/friday-memory.types.js";
import type { FridayMemoryService } from "../../services/friday-memory-service.types.js";
import type Database from "better-sqlite3";

// ─── Access & action types ───

export type FridayMemoryGuardAccessLevel = "tenant" | "system";
export type FridayMemoryGuardAction = "write" | "search";
export type FridayMemoryGuardPiiMode = "block" | "redact" | "tag";
export type FridayMemoryGuardPiiType = "email" | "phone_us" | "ssn_us" | "credit_card";

// ─── Subject & context ───

export interface FridayMemoryGuardSubject {
  hubId: string;
  userId?: string;
  accessLevel: FridayMemoryGuardAccessLevel;
  /**
   * Channel kind for cross-channel namespace isolation (Initiative H.3).
   * When set, memory namespaces include a channel-level segment:
   * `tenant.{hubId}.channel.{channelKind}.user.{userId}.{namespace}`
   */
  channelKind?: string;
}

export interface FridayMemoryGuardContext {
  subject: FridayMemoryGuardSubject;
  principalId: string;
  requestId?: string;
}

// ─── Namespace resolution ───

export interface FridayMemoryGuardNamespaceResolution {
  requestedNamespace: string;
  effectiveNamespace: string;
  scopePrefix: string;
}

// ─── Rate limiting ───

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

// ─── Quota ───

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

// ─── PII ───

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

// ─── Sanitized input ───

export interface FridayMemoryGuardSanitizedStoreInput {
  namespace: string;
  content: string;
  metadata?: Omit<FridayMemoryStoreInput, "namespace" | "content">;
}

// ─── Component interfaces ───

export interface FridayMemoryGuardRateLimiter {
  consume(action: FridayMemoryGuardAction, namespace: string, nowMs: number): FridayMemoryGuardRateLimitDecision;
}

export interface FridayMemoryGuardQuotaRepository {
  getNamespaceUsage(db: Database.Database, namespace: string, nowIso: string): FridayMemoryGuardNamespaceUsage;
  listNamespacesByPrefix(db: Database.Database, prefix: string, limit: number): string[];
  pruneExpiredOldest(db: Database.Database, input: { namespace: string; nowIso: string; limit: number }): FridayMemoryGuardPruneExpiredResult;
}

export interface FridayMemoryGuardPiiGuard {
  scanAndTransform(content: string): FridayMemoryGuardPiiScanResult;
  /**
   * Recursively redact PII in the string leaves of an arbitrary structured value
   * (memory metadata objects, tag arrays). Returns the redacted value (or the original
   * when not in redact mode) plus the PII-type tags discovered, so callers can scan
   * metadata/tags the same way `scanAndTransform` scans content.
   */
  redactDeep(value: unknown): { value: unknown; tagsToAdd: string[] };
}

export interface FridayMemoryGuardOutputFilter {
  filterItem(item: FridayMemoryItem): FridayMemoryItem;
  filterSearchResults(results: FridayMemorySearchResult[]): FridayMemorySearchResult[];
  /**
   * Redact + truncate a single search result (item content/metadata/tags + snippet) WITHOUT
   * applying the result-count cap. Use at an egress boundary where results from multiple
   * sources are merged (e.g. stored items + appended learned facts) so every returned
   * result passes the same PII filter regardless of the total count.
   */
  filterSearchResult(result: FridayMemorySearchResult): FridayMemorySearchResult;
}

// ─── Guard service ───

export interface FridayMemoryGuardService extends FridayMemoryService {}

// ─── Guard service deps ───

export interface CreateFridayMemoryGuardServiceDeps {
  core: FridayMemoryService;
  db: FridaySqliteLayer;
  nowIso: () => string;
  nowMs: () => number;
  /**
   * Mirrors the core memory service retirement switch. When false, guarded
   * memory write legs fail before guard-local pre-write maintenance such as
   * quota auto-prune can mutate legacy `memory_items`.
   */
  tsMemoryWritesEnabled?: boolean;
  context: FridayMemoryGuardContext;
  rateLimiter: FridayMemoryGuardRateLimiter;
  quotaRepo: FridayMemoryGuardQuotaRepository;
  piiGuard: FridayMemoryGuardPiiGuard;
  outputFilter: FridayMemoryGuardOutputFilter;
}

// ─── Factory ───

export interface FridayMemoryGuardServiceFactory {
  forPrincipal(principal: FridayAuthPrincipal | null): FridayMemoryGuardService;
  forContext(context: FridayMemoryGuardContext): FridayMemoryGuardService;
}

export interface CreateFridayMemoryGuardServiceFactoryDeps {
  core: FridayMemoryService;
  db: FridaySqliteLayer;
  nowIso: () => string;
  nowMs: () => number;
  tsMemoryWritesEnabled?: boolean;
  resolveContextFromPrincipal?: (principal: FridayAuthPrincipal | null) => FridayMemoryGuardContext;
}
