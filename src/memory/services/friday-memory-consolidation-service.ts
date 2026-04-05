/**
 * Memory Consolidation Service — promotes episodic memories into
 * higher-level procedural/preference memories by leveraging discovered
 * patterns, analogous to sleep consolidation in humans.
 *
 * Never deletes original episodes — marks them as consolidated to
 * prevent re-processing.
 */

import type { FridaySqliteLayer } from "#state";
import type { FridayPatternExtractor } from "./friday-pattern-extractor.js";
import type { FridayMemoryService } from "./friday-memory-service.types.js";
import type {
  FridayConsolidationConfig,
  FridayConsolidationResult,
} from "../model/friday-memory-consolidation.types.js";
import { FRIDAY_CONSOLIDATION_DEFAULTS } from "../model/friday-memory-consolidation.types.js";

// ─── Deps ───────────────────────────────────────────────────────

export interface CreateFridayMemoryConsolidationServiceDeps {
  db: FridaySqliteLayer;
  patternExtractor: FridayPatternExtractor;
  memoryService: FridayMemoryService;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Public interface ───────────────────────────────────────────

export interface FridayMemoryConsolidationService {
  consolidate(input: {
    userId: string;
    nowIso: string;
    config?: Partial<FridayConsolidationConfig>;
  }): Promise<FridayConsolidationResult>;
}

// ─── Internal types ─────────────────────────────────────────────

interface EpisodeRow {
  id: string;
  user_id: string;
  task_intent: string;
  outcome: string;
  created_at: string;
}

// ─── Factory ────────────────────────────────────────────────────

export function createFridayMemoryConsolidationService(
  deps: CreateFridayMemoryConsolidationServiceDeps,
): FridayMemoryConsolidationService {
  return {
    async consolidate(input) {
      const cfg: FridayConsolidationConfig = {
        ...FRIDAY_CONSOLIDATION_DEFAULTS,
        ...input.config,
      };

      // 1. Find unconsolidated episodes for this user
      const cutoffIso = new Date(
        new Date(input.nowIso).getTime() - cfg.maxAgeDays * 86_400_000,
      ).toISOString();

      const episodes = deps.db.withReadConnection((db) =>
        db
          .prepare(
            `SELECT e.id, e.user_id, e.task_intent, e.outcome, e.created_at
             FROM friday_episodes e
             LEFT JOIN friday_consolidated_episodes c ON e.id = c.episode_id
             WHERE e.user_id = ?
               AND c.episode_id IS NULL
               AND e.created_at <= ?
             ORDER BY e.created_at ASC
             LIMIT ?`,
          )
          .all(input.userId, cutoffIso, cfg.batchSize) as EpisodeRow[],
      );

      if (episodes.length < cfg.minEpisodes) {
        return {
          consolidatedCount: 0,
          promotedMemories: [],
          archivedEpisodeIds: [],
        };
      }

      // 2. Extract patterns from this user's episodes
      const patterns = await deps.patternExtractor.extractPatterns(
        input.userId,
        cfg.batchSize,
      );

      const promotable = patterns.filter(
        (p) => p.confidence >= cfg.minPromotionConfidence,
      );

      const result: FridayConsolidationResult = {
        consolidatedCount: 0,
        promotedMemories: [],
        archivedEpisodeIds: [],
      };

      // 3. Promote qualifying patterns into permanent memories
      for (const pattern of promotable) {
        const memoryType =
          pattern.kind === "tool_sequence" || pattern.kind === "failure_mode"
            ? ("procedure" as const)
            : ("preference" as const);

        const content = `[Consolidated] ${pattern.kind}: ${pattern.description}`;

        const item = await deps.memoryService.store(
          "learning:consolidated",
          content,
          {
            tags: ["consolidated", pattern.kind],
            memoryType,
            source: "memory-consolidation",
            metadata: {
              sourcePatternId: pattern.id,
              sourceEpisodeCount: pattern.sampleCount,
              consolidatedAt: input.nowIso,
            },
          },
        );

        result.promotedMemories.push({
          sourceEpisodeIds: episodes.map((e) => e.id),
          targetMemoryId: item.id,
          memoryType,
          content,
          confidence: pattern.confidence,
        });
      }

      // 4. Mark episodes as consolidated
      const episodeIds = episodes.map((e) => e.id);
      deps.db.withWriteTransaction((db) => {
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO friday_consolidated_episodes
           (episode_id, consolidated_at, target_memory_id)
           VALUES (?, ?, ?)`,
        );
        const targetId =
          result.promotedMemories[0]?.targetMemoryId ?? null;
        for (const eid of episodeIds) {
          stmt.run(eid, input.nowIso, targetId);
        }
      });

      result.consolidatedCount = episodeIds.length;
      result.archivedEpisodeIds = episodeIds;

      return result;
    },
  };
}
