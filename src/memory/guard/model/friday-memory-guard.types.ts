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
   * Redact a bare STRUCTURED-KEY / identifier string with the SAME identifier-aware policy
   * `redactDeep` applies to an object KEY — NOT the free-form value transform. A key composed
   * ENTIRELY of decimal digits (any script) is an ambiguous business identifier and is preserved
   * BYTE-IDENTICAL (never folded to `[CREDIT_CARD]`); a credential-shaped key (`hf_…` / `sk-…` /
   * `ghp_…` / `AKIA…`, raw or Unicode-obfuscated) and a formatted-PII key (SSN-/email-shaped) are
   * redacted to their canonical markers. Mode-honoring: `tag`/`block` return the key unchanged.
   * Used by the memory read-back output filter for `FridayMemoryItem.key`.
   */
  redactStructuredKey(key: string): string;
  /**
   * Recursively redact PII in an arbitrary structured value (memory metadata objects, tag
   * arrays, learned-fact values). Coverage:
   *  - STRING leaves and STRING key content: existing shape-based patterns (email / phone /
   *    SSN / Luhn-gated card), unchanged by this contract.
   *  - Typed `number` / `bigint` values: redacted CONTEXT-AWARELY under TWO gates — the value's
   *    object KEY names a known sensitive field (ssn / phone / card and variants) AND the value's
   *    string form actually matches that type's detector (SSN / phone / Luhn card). A bare number
   *    is never redacted by digit shape or Luhn ALONE, so business ids, order numbers, epoch
   *    timestamps, benign numerics under sensitive-sounding keys (`gift_card: 3`), and
   *    pure-numeric object keys are preserved. Array elements inherit a sensitive parent key;
   *    nested objects do not.
   *  - `Date` values: their original type is preserved (never corrupted into `{}`).
   * Returns the (possibly) redacted value plus the PII-type tags discovered. This closes the
   * typed-value, Date-corruption, and object-KEY coverage gaps; it is NOT a guarantee that every
   * possible PII representation is caught.
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
  /**
   * Redact PII from a learned-fact `value` (which is free-form `unknown` — a string or a
   * nested object/array), returning the value with the SAME structure/type, PII redacted in
   * place via the production deep redactor. Unlike `filterItem`, it does NOT stringify or
   * truncate — sibling egress paths (uix / asset-inventory) return the raw `value` field, so
   * only redaction is applied. Idempotent on an already-redacted value.
   */
  redactLearnedFactValue(value: unknown): unknown;
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
