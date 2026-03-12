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
}

export interface FridayMemoryGuardOutputFilter {
  filterItem(item: FridayMemoryItem): FridayMemoryItem;
  filterSearchResults(results: FridayMemorySearchResult[]): FridayMemorySearchResult[];
}

// ─── Guard service ───

export interface FridayMemoryGuardService extends FridayMemoryService {}

// ─── Guard service deps ───

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
  resolveContextFromPrincipal?: (principal: FridayAuthPrincipal | null) => FridayMemoryGuardContext;
}
