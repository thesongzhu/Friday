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

    results.push({
      item,
      score,
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
