import type {
  CreateFridayMemoryServiceDeps,
  FridayMemoryDedupAdvisoryEvent,
  FridayMemoryService,
} from "./friday-memory-service.types.js";

import type {
  FridayMemoryItem,
  FridayMemoryPruneResult,
  FridayMemorySearchResult,
} from "../model/friday-memory.types.js";

import { FridayDomainError } from "#errors";

import {
  FRIDAY_MEMORY_DEFAULT_CANDIDATE_LIMIT,
  FRIDAY_MEMORY_DEFAULT_EMBEDDING_MODEL,
  FRIDAY_MEMORY_DEFAULT_LIMIT,
  FRIDAY_MEMORY_DEFAULT_SOURCE,
  FRIDAY_MEMORY_ERROR_CODES,
  FRIDAY_MEMORY_MAX_LIMIT,
} from "../friday-memory.constants.js";

import { createFridayMemoryItemRepository } from "../persistence/friday-memory-item-repository.js";
import { createFridayMemoryEmbeddingRepository } from "../persistence/friday-memory-embedding-repository.js";
import { createFridayMemoryByokEmbeddingClient } from "./friday-memory-byok-embedding-client.js";
import { assertFridayDurableMemoryBoundaryAllowed } from "./friday-memory-boundary-policy.js";
import { mergeHybridResults } from "../search/friday-memory-hybrid.js";
import { checkMemoryDuplicate } from "./friday-memory-dedup.js";

/**
 * B4 / FRI-AUD-006 dedup-advisory default threshold. Placeholder until
 * product policy decides the production value. Operator can override per
 * service via `CreateFridayMemoryServiceDeps.dedupThreshold`.
 */
const FRIDAY_MEMORY_DEDUP_ADVISORY_DEFAULT_THRESHOLD = 0.92;

// P2-06: Module-level Set avoids WeakMap edge cases with replaced warn sinks.
type FridayWarnSink = (message: string) => void;
const warnedKeys = new Set<string>();

function warnOnce(warn: FridayWarnSink, key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  warn(message);
}

function normalizeWarningKey(
  kind: "embedding" | "semantic" | "access-counter" | "dedup-advisory",
  message: string,
): string {
  return `${kind}:${message}`;
}

function warnMemoryFallback(
  kind: "embedding" | "semantic" | "access-counter" | "dedup-advisory",
  message: string,
): void {
  if (message.startsWith("No enabled providers available for routing")) {
    return;
  }
  const label =
    kind === "embedding"
      ? "embedding failed"
      : kind === "semantic"
        ? "semantic search unavailable"
        : kind === "access-counter"
          ? "access-counter update failed (counter may lag)"
          : "dedup advisory failed (no policy effect; store still succeeded)";
  warnOnce(
    console.warn as FridayWarnSink,
    normalizeWarningKey(kind, message),
    `[friday][memory-service] ${label}: ${message}`,
  );
}

export function createFridayMemoryService(
  deps: CreateFridayMemoryServiceDeps,
): FridayMemoryService {
  const itemRepo = createFridayMemoryItemRepository();
  const embeddingRepo = createFridayMemoryEmbeddingRepository();
  const resolvedEmbeddingModel = deps.embeddingModel ?? FRIDAY_MEMORY_DEFAULT_EMBEDDING_MODEL;
  const embeddingClient = createFridayMemoryByokEmbeddingClient({
    providerService: deps.providerService,
    embeddingModel: resolvedEmbeddingModel,
  });

  // Key format: alphanumeric, hyphens, underscores, dots, colons
  const KEY_FORMAT_RE = /^[a-zA-Z0-9._:@\-]+$/;

  // B4 / FRI-AUD-006: resolve advisory dedup threshold once per service
  // instance. Placeholder default; operator-tunable via deps.dedupThreshold.
  const resolvedDedupThreshold =
    typeof deps.dedupThreshold === "number" && deps.dedupThreshold > 0 && deps.dedupThreshold <= 1
      ? deps.dedupThreshold
      : FRIDAY_MEMORY_DEDUP_ADVISORY_DEFAULT_THRESHOLD;

  // B4 / FRI-AUD-006: forward-ref so `store()` can call `service.search()`
  // for advisory-only dedup checks AFTER successful persist. The advisory
  // is purely additive — it never deletes, overwrites, merges, or blocks
  // any user memory (per POST_RELEASE_DEFAULT_DECISIONS.md B4 + the
  // 2026-05-26 operator directive). Destructive merge/block semantics
  // remain `policy_pending`.
  const service: FridayMemoryService = {
    async store(namespace, content, metadata) {
      // Service-level validation (Fix #5)
      if (!namespace || typeof namespace !== "string" || !namespace.trim()) {
        throw new FridayDomainError(
          FRIDAY_MEMORY_ERROR_CODES.VALIDATION_ERROR,
          "namespace is required and must be a non-empty string",
          { httpStatus: 400 },
        );
      }
      if (!content || typeof content !== "string" || !content.trim()) {
        throw new FridayDomainError(
          FRIDAY_MEMORY_ERROR_CODES.VALIDATION_ERROR,
          "content is required and must be a non-empty string",
          { httpStatus: 400 },
        );
      }
      if (metadata?.key !== undefined && (typeof metadata.key !== "string" || !KEY_FORMAT_RE.test(metadata.key))) {
        throw new FridayDomainError(
          FRIDAY_MEMORY_ERROR_CODES.VALIDATION_ERROR,
          "key must be alphanumeric with hyphens, underscores, dots, colons, or @ signs",
          { httpStatus: 400 },
        );
      }
      const now = deps.nowIso();
      const id = deps.idGenerator();
      const source = metadata?.source ?? FRIDAY_MEMORY_DEFAULT_SOURCE;
      const key = metadata?.key ?? id;
      const tags = metadata?.tags ?? [];
      const meta = metadata?.metadata ?? {};
      const ttlSeconds = metadata?.ttlSeconds;
      assertFridayDurableMemoryBoundaryAllowed({
        source,
        key,
        tags,
        metadata: meta,
      });

      let expiresAt = metadata?.expiresAt;
      if (!expiresAt && ttlSeconds) {
        const expiresMs = new Date(now).getTime() + ttlSeconds * 1000;
        expiresAt = new Date(expiresMs).toISOString();
      }

      const item: FridayMemoryItem = {
        id,
        namespace,
        key,
        content,
        source,
        tags,
        metadata: meta,
        ttlSeconds,
        expiresAt,
        createdAt: now,
        updatedAt: now,
        memoryType: metadata?.memoryType,
        confidence: metadata?.confidence,
      };

      // Persist the item
      deps.db.withWriteTransaction((db) => {
        itemRepo.insert(db, item);
      });

      // Attempt embedding (graceful fallback)
      try {
        const embeddingResponse = await embeddingClient.embed(content);
        const embeddingId = deps.idGenerator();
        const embeddingNow = deps.nowIso();

        deps.db.withWriteTransaction((db) => {
          embeddingRepo.upsert(db, {
            id: embeddingId,
            itemId: item.id,
            providerId: embeddingResponse.providerId,
            model: embeddingResponse.model,
            dimensions: embeddingResponse.dimensions,
            vector: embeddingResponse.vector,
            createdAt: embeddingNow,
            updatedAt: embeddingNow,
          });
        });
      } catch (err) {
        // Embedding failed — item was stored successfully, just no vector
        warnMemoryFallback("embedding", err instanceof Error ? err.message : String(err));
      }

      // B4 / FRI-AUD-006 advisory-only dedup (non-destructive).
      // The candidate is already persisted at this point. If the new item
      // matches a pre-existing memory in the same namespace above the
      // configured threshold, we emit an informational advisory event
      // (console.info + optional deps.dedupAdvisorySink). We NEVER delete,
      // overwrite, merge, or block any user memory. Destructive merge/block
      // semantics remain `policy_pending` per the operator directive.
      try {
        const dedupResult = await checkMemoryDuplicate(
          { namespace, content, metadata },
          { search: (q, opts) => service.search(q, opts) },
          { threshold: resolvedDedupThreshold },
        );
        if (
          dedupResult.deduplicated
          && dedupResult.existingItem
          && dedupResult.existingItem.id !== item.id
        ) {
          const advisory: FridayMemoryDedupAdvisoryEvent = {
            kind: "memory.dedup.advisory",
            candidateItemId: item.id,
            existingItemId: dedupResult.existingItem.id,
            namespace,
            bestScore: dedupResult.bestScore ?? 1.0,
            threshold: resolvedDedupThreshold,
            timestamp: now,
          };
          console.info(
            `[friday][memory-service] dedup advisory: candidate ${advisory.candidateItemId} `
              + `(namespace=${namespace}) similar to existing ${advisory.existingItemId} `
              + `(score=${advisory.bestScore.toFixed(3)} >= threshold=${advisory.threshold.toFixed(3)}); `
              + "candidate stored as-is; no merge/block (policy_pending).",
          );
          if (deps.dedupAdvisorySink) {
            try {
              deps.dedupAdvisorySink(advisory);
            } catch (sinkErr) {
              warnMemoryFallback(
                "dedup-advisory",
                `sink threw: ${sinkErr instanceof Error ? sinkErr.message : String(sinkErr)}`,
              );
            }
          }
        }
      } catch (err) {
        warnMemoryFallback(
          "dedup-advisory",
          err instanceof Error ? err.message : String(err),
        );
      }

      return item;
    },

    async search(query, options) {
      if (!query.trim()) {
        throw new FridayDomainError(
          FRIDAY_MEMORY_ERROR_CODES.SEARCH_EMPTY_QUERY,
          "Search query must not be empty",
          { httpStatus: 400 },
        );
      }

      const now = deps.nowIso();
      const limit = Math.min(options?.limit ?? FRIDAY_MEMORY_DEFAULT_LIMIT, FRIDAY_MEMORY_MAX_LIMIT);

      // FTS search (always runs)
      const ftsHits = deps.db.withReadConnection((db) =>
        itemRepo.searchFts(db, {
          text: query,
          namespace: options?.namespace,
          source: options?.source,
          tagsAny: options?.tagsAny,
          tagsAll: options?.tagsAll,
          includeExpired: options?.includeExpired,
          nowIso: now,
          limit: FRIDAY_MEMORY_DEFAULT_CANDIDATE_LIMIT,
        }),
      );

      // Semantic search (attempt, fallback to FTS-only)
      let semanticHits: Array<{ itemId: string; score: number }> = [];

      try {
        const embeddingResponse = await embeddingClient.embed(query);
        const model = embeddingResponse.model;

        semanticHits = deps.db.withReadConnection((db) =>
          embeddingRepo.querySimilar(db, {
            queryVector: embeddingResponse.vector,
            model,
            nowIso: now,
            namespace: options?.namespace,
            source: options?.source,
            tagsAny: options?.tagsAny,
            includeExpired: options?.includeExpired,
            limit: FRIDAY_MEMORY_DEFAULT_CANDIDATE_LIMIT,
            candidateLimit: FRIDAY_MEMORY_DEFAULT_CANDIDATE_LIMIT,
            minScore: options?.minScore,
          }),
        );
      } catch (err) {
        // Semantic search unavailable — fallback to FTS-only
        warnMemoryFallback("semantic", err instanceof Error ? err.message : String(err));
      }

      // Enforce tagsAll on semantic-only hits before merge (Fix #1)
      // FTS path already handles tagsAll filtering, but semantic hits need post-filtering
      let filteredSemanticHits = semanticHits;
      if (options?.tagsAll && options.tagsAll.length > 0) {
        const requiredTags = options.tagsAll;
        filteredSemanticHits = semanticHits.filter((hit) => {
          const item = deps.db.withReadConnection((db) => itemRepo.getById(db, hit.itemId));
          if (!item) return false;
          return requiredTags.every((tag) => item.tags.includes(tag));
        });
      }

      // Merge results
      const results: FridayMemorySearchResult[] = mergeHybridResults({
        ftsHits,
        semanticHits: filteredSemanticHits,
        resolveItem: (itemId) =>
          deps.db.withReadConnection((db) => itemRepo.getById(db, itemId)),
        weights: options?.weights,
        limit,
        minScore: options?.minScore,
      });

      // Fallback: if FTS and semantic both returned nothing, try a namespace-filtered
      // substring scan so that exact-word queries still find matches when FTS tokenization
      // misses (e.g. short or unusual tokens).
      // Skip the fallback entirely when the caller demands a higher score than substring
      // matches can provide (0.1), to avoid scanning all items for results that would
      // all be filtered out anyway.
      if (results.length === 0 && options?.namespace && !(options?.minScore != null && 0.1 < options.minScore)) {
        const allItems = deps.db.withReadConnection((db) =>
          itemRepo.list(db, {
            namespace: options.namespace,
            source: options.source,
            tagsAny: options.tagsAny,
            includeExpired: options.includeExpired,
            limit: FRIDAY_MEMORY_DEFAULT_CANDIDATE_LIMIT,
            nowIso: now,
          }),
        );

        const queryLower = query.toLowerCase();
        const queryTokens = queryLower.split(/\s+/).filter((t) => t.length > 0);

        for (const item of allItems) {
          if (results.length >= limit) break;
          const contentLower = item.content.toLowerCase();
          // Match if any query token appears as substring
          const matched = queryTokens.some((token) => contentLower.includes(token));
          if (matched) {
            // Apply tagsAll filter if present
            if (options.tagsAll && options.tagsAll.length > 0) {
              if (!options.tagsAll.every((tag) => item.tags.includes(tag))) continue;
            }
            // Skip fallback results that don't meet the caller's minimum score threshold
            if (options?.minScore != null && 0.1 < options.minScore) continue;
            results.push({
              item,
              score: 0.1, // low confidence substring match
              ftsScore: 0,
              semanticScore: 0,
              matchedBy: ["substring"],
              snippet: item.content.slice(0, 200),
            });
          }
        }
      }

      // B3 cognition policy (conservative): record access ONLY for items that
      // were actually returned through this intentional search path. We do not
      // increment on raw `get()` / `list()` reads — the counter is meant to
      // mean "served to the agent as part of recall," not "row was fetched by
      // some internal lookup."
      if (results.length > 0) {
        try {
          deps.db.withWriteTransaction((db) =>
            itemRepo.recordAccess(db, {
              itemIds: results.map((r) => r.item.id),
              nowIso: now,
            }),
          );
        } catch (err) {
          // Best-effort telemetry — a failed access-counter write must NOT
          // break the search. Log and continue with the already-merged
          // results.
          warnMemoryFallback("access-counter", err instanceof Error ? err.message : String(err));
        }
      }

      return results;
    },

    async get(itemId) {
      // B3 cognition policy: raw `get()` does NOT increment access_count.
      // Only intentional recall via `search()` is a counted access.
      return deps.db.withReadConnection((db) => itemRepo.getById(db, itemId));
    },

    async list(input) {
      const now = deps.nowIso();
      return deps.db.withReadConnection((db) =>
        itemRepo.list(db, {
          namespace: input?.namespace,
          source: input?.source,
          tagsAny: input?.tagsAny,
          includeExpired: input?.includeExpired,
          limit: input?.limit,
          nowIso: now,
        }),
      );
    },

    async delete(itemId) {
      // FK cascade deletes embeddings
      return deps.db.withWriteTransaction((db) => itemRepo.deleteById(db, itemId));
    },

    async prune(options) {
      const now = deps.nowIso();
      const dryRun = options?.dryRun ?? false;

      const deletedIds = deps.db.withWriteTransaction((db) =>
        itemRepo.prune(db, {
          namespace: options?.namespace,
          source: options?.source,
          tagsAny: options?.tagsAny,
          expiredOnly: options?.expiredOnly,
          olderThan: options?.olderThan,
          limit: options?.limit,
          dryRun,
          nowIso: now,
        }),
      );

      const result: FridayMemoryPruneResult = {
        deletedCount: deletedIds.length,
        deletedIds,
        dryRun,
      };

      return result;
    },
  };

  return service;
}
