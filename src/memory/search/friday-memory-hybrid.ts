import type {
  FridayMemoryFtsHit,
  FridayMemoryItem,
  FridayMemorySearchResult,
  FridayMemorySemanticHit,
} from "../model/friday-memory.types.js";

import {
  FRIDAY_MEMORY_DEFAULT_FTS_WEIGHT,
  FRIDAY_MEMORY_DEFAULT_SEMANTIC_WEIGHT,
} from "../friday-memory.constants.js";

export interface MergeHybridResultsInput {
  ftsHits: FridayMemoryFtsHit[];
  semanticHits: FridayMemorySemanticHit[];
  resolveItem: (itemId: string) => FridayMemoryItem | null;
  weights?: { fts: number; semantic: number };
  limit: number;
  minScore?: number;
  boostByConfidence?: boolean;
  boostByAccess?: boolean;
  applyRetentionDecay?: boolean;
  retentionHalfLifeDays?: number;
  nowIso?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_HALF_LIFE_DAYS = 180;
const MIN_RETENTION_CONFIDENCE = 0.05;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function latestIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return rightMs > leftMs ? right : left;
}

function effectiveConfidence(item: FridayMemoryItem, input: MergeHybridResultsInput): number | undefined {
  if (typeof item.confidence !== "number") return undefined;
  const confidence = clamp01(item.confidence);
  if (!input.applyRetentionDecay) return confidence;

  const nowMs = Date.parse(input.nowIso ?? new Date().toISOString());
  const anchor = latestIso(item.updatedAt, item.lastAccessedAt);
  const anchorMs = anchor ? Date.parse(anchor) : NaN;
  if (!Number.isFinite(nowMs) || !Number.isFinite(anchorMs) || nowMs <= anchorMs) {
    return confidence;
  }

  const halfLifeDays = typeof input.retentionHalfLifeDays === "number" && input.retentionHalfLifeDays > 0
    ? input.retentionHalfLifeDays
    : DEFAULT_RETENTION_HALF_LIFE_DAYS;
  const ageDays = (nowMs - anchorMs) / MS_PER_DAY;
  const decayed = confidence * Math.exp(-Math.LN2 * ageDays / halfLifeDays);
  return Math.max(MIN_RETENTION_CONFIDENCE, decayed);
}

/**
 * Merges FTS and semantic search results into a single ranked list.
 *
 * Items appearing in both result sets receive the weighted sum of both scores.
 * Items appearing in only one set receive only that weighted component.
 */
export function mergeHybridResults(input: MergeHybridResultsInput): FridayMemorySearchResult[] {
  const ftsWeight = input.weights?.fts ?? FRIDAY_MEMORY_DEFAULT_FTS_WEIGHT;
  const semanticWeight = input.weights?.semantic ?? FRIDAY_MEMORY_DEFAULT_SEMANTIC_WEIGHT;
  const minScore = input.minScore ?? 0;

  // Build a map of item id → accumulated scores
  const scoreMap = new Map<
    string,
    { ftsScore: number; semanticScore: number; snippet: string; matchedBy: Set<"fts" | "semantic"> }
  >();

  for (const hit of input.ftsHits) {
    const entry = scoreMap.get(hit.itemId);
    if (entry) {
      entry.ftsScore = Math.max(entry.ftsScore, hit.score);
      entry.matchedBy.add("fts");
      if (hit.snippet && !entry.snippet) {
        entry.snippet = hit.snippet;
      }
    } else {
      scoreMap.set(hit.itemId, {
        ftsScore: hit.score,
        semanticScore: 0,
        snippet: hit.snippet,
        matchedBy: new Set(["fts"]),
      });
    }
  }

  for (const hit of input.semanticHits) {
    const entry = scoreMap.get(hit.itemId);
    if (entry) {
      entry.semanticScore = Math.max(entry.semanticScore, hit.score);
      entry.matchedBy.add("semantic");
    } else {
      scoreMap.set(hit.itemId, {
        ftsScore: 0,
        semanticScore: hit.score,
        snippet: "",
        matchedBy: new Set(["semantic"]),
      });
    }
  }

  // Compute final scores and resolve items
  const results: FridayMemorySearchResult[] = [];

  for (const [itemId, entry] of scoreMap) {
    const score = entry.ftsScore * ftsWeight + entry.semanticScore * semanticWeight;
    if (score < minScore) continue;

    const item = input.resolveItem(itemId);
    if (!item) continue;

    const decayedConfidence = effectiveConfidence(item, input);
    const confidenceBoost = input.boostByConfidence && typeof decayedConfidence === "number"
      ? decayedConfidence * 0.05
      : 0;
    const accessBoost = input.boostByAccess && typeof item.accessCount === "number"
      ? Math.min(Math.max(item.accessCount, 0), 20) / 20 * 0.03
      : 0;

    results.push({
      item,
      score: score + confidenceBoost + accessBoost,
      ftsScore: entry.ftsScore,
      semanticScore: entry.semanticScore,
      matchedBy: [...entry.matchedBy],
      snippet: entry.snippet || item.content.slice(0, 200),
    });
  }

  // Sort descending by score
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, input.limit);
}
