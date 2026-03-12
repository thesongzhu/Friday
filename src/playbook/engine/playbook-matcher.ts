/**
 * Playbook Matcher — Context-aware playbook selection engine.
 *
 * Implements the {@link FridayPlaybookSelectorEngine} interface.
 * Finds the best-matching playbook for an incoming task by combining
 * Jaccard similarity on node sequences with composite score weighting.
 *
 * @module playbook/engine
 */

import type {
  FridayPlaybook,
  FridayPlaybookEngineConfig,
  FridayPlaybookMatch,
  FridayPlaybookMatchReason,
  FridayPlaybookSelectionConfig,
  FridayPlaybookSelector,
  FridayPlaybookSelectorEngine,
  FridayPlaybookTieBreakCriterion,
  FridayPlaybookVersion,
  JsonObject,
  UUID,
} from "../model/friday-playbook.types.js";

import type { PlaybookStore } from "./playbook-store.js";

// ─── Similarity Functions ───

/**
 * Compute Jaccard similarity between two sets.
 * Returns a value in [0, 1] where 1 means identical sets.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

/**
 * Serialize a node sequence element for set comparison.
 */
function nodeKey(node: { nodeType: string; adapterType?: string }): string {
  return node.adapterType ? `${node.nodeType}:${node.adapterType}` : node.nodeType;
}

/**
 * Compute node sequence similarity between a selector context and
 * a playbook version's pattern.
 */
export function computeNodeSequenceSimilarity(
  selectorNodes: Array<{ nodeType: string; adapterType?: string }>,
  patternNodes: Array<{ nodeType: string; adapterType?: string }>,
): number {
  const selectorSet = new Set(selectorNodes.map(nodeKey));
  const patternSet = new Set(patternNodes.map(nodeKey));
  return jaccardSimilarity(selectorSet, patternSet);
}

/**
 * Compute tag overlap percentage between two tag sets.
 * Returns the fraction of selector tags present in the pattern tags.
 */
export function computeTagOverlap(selectorTags: string[], playbookTags: string[]): number {
  if (selectorTags.length === 0) return 1.0;
  const playbookSet = new Set(playbookTags);
  let overlap = 0;
  for (const tag of selectorTags) {
    if (playbookSet.has(tag)) overlap++;
  }
  return overlap / selectorTags.length;
}

// ─── Ranked Candidate ───

interface RankedCandidate {
  playbook: FridayPlaybook;
  version: FridayPlaybookVersion;
  similarity: number;
  finalRank: number;
}

// ─── Matcher ───

/** Dependencies for creating a playbook matcher. */
export interface PlaybookMatcherDeps {
  store: PlaybookStore;
  config: FridayPlaybookEngineConfig;
}

/** Create a playbook selector engine instance. */
export function createPlaybookMatcher(deps: PlaybookMatcherDeps): FridayPlaybookSelectorEngine {
  const { store, config } = deps;
  const selConfig = config.selection;

  return {
    async select(selector: FridayPlaybookSelector): Promise<FridayPlaybookMatch> {
      // 1. Filter active playbooks by workflow type
      const candidates = store.getPlaybooksByWorkflowType(selector.workflowType, "active");

      if (candidates.length === 0) {
        return buildMatch(selector, null, null, null, null, "no_match");
      }

      // 2. Filter by tag overlap, rank by similarity, limit to maxCandidates
      const ranked = rankCandidates(candidates, selector, selConfig);

      if (ranked.length === 0) {
        return buildMatch(selector, null, null, null, null, "below_threshold");
      }

      // 3. Apply tie-breaking
      const winner = applyTieBreak(ranked, selConfig.tieBreakOrder);

      if (winner.finalRank < selConfig.matchThreshold) {
        return buildMatch(selector, null, null, winner.finalRank, winner.similarity, "below_threshold");
      }

      // 4. Build match result
      return buildMatch(
        selector,
        winner.playbook.id,
        winner.version.versionNumber,
        winner.finalRank,
        winner.similarity,
        "matched",
      );
    },
  };

  function rankCandidates(
    playbooks: FridayPlaybook[],
    selector: FridayPlaybookSelector,
    cfg: FridayPlaybookSelectionConfig,
  ): RankedCandidate[] {
    const ranked: RankedCandidate[] = [];

    for (const pb of playbooks) {
      // Tag overlap filter
      const tagOverlap = computeTagOverlap(selector.tags, pb.tags);
      if (tagOverlap < cfg.minTagOverlap) continue;

      // Get active version
      const version = store.getVersionByNumber(pb.id, pb.activeVersionNumber);
      if (!version) continue;

      // Extract node sequence from pattern
      const patternNodes = extractNodeSequenceFromPattern(version.pattern);

      // Compute similarity
      const nodeSimilarity = computeNodeSequenceSimilarity(selector.nodeSequence, patternNodes);
      const similarity = nodeSimilarity * 0.7 + tagOverlap * 0.3;

      // Compute final rank: similarity × weight + compositeScore × weight
      const finalRank = similarity * cfg.similarityWeight + pb.compositeScore * cfg.scoreWeight;

      ranked.push({ playbook: pb, version, similarity, finalRank });
    }

    // Sort descending by finalRank
    ranked.sort((a, b) => b.finalRank - a.finalRank);

    // Limit to maxCandidates
    return ranked.slice(0, cfg.maxCandidates);
  }

  function applyTieBreak(
    ranked: RankedCandidate[],
    tieBreakOrder: FridayPlaybookTieBreakCriterion[],
  ): RankedCandidate {
    if (ranked.length <= 1) return ranked[0];

    // Find all candidates tied with the top score (within epsilon)
    const epsilon = 1e-10;
    const topScore = ranked[0].finalRank;
    const tied = ranked.filter((r) => Math.abs(r.finalRank - topScore) < epsilon);

    if (tied.length <= 1) return tied[0];

    // Apply tie-break criteria in order
    for (const criterion of tieBreakOrder) {
      switch (criterion) {
        case "highest_composite_score":
          tied.sort((a, b) => b.playbook.compositeScore - a.playbook.compositeScore);
          if (tied[0].playbook.compositeScore !== tied[1].playbook.compositeScore) return tied[0];
          break;
        case "most_recent_success":
          tied.sort((a, b) =>
            (b.playbook.lastSuccessfulAt ?? "").localeCompare(a.playbook.lastSuccessfulAt ?? ""),
          );
          if ((tied[0].playbook.lastSuccessfulAt ?? "") !== (tied[1].playbook.lastSuccessfulAt ?? "")) {
            return tied[0];
          }
          break;
        case "lowest_candidate_id":
          tied.sort((a, b) => a.playbook.sourceCandidateId.localeCompare(b.playbook.sourceCandidateId));
          return tied[0];
      }
    }

    return tied[0];
  }

  function buildMatch(
    selector: FridayPlaybookSelector,
    playbookId: UUID | null,
    versionNumber: number | null,
    matchScore: number | null,
    similarity: number | null,
    reason: FridayPlaybookMatchReason,
  ): FridayPlaybookMatch {
    const match: FridayPlaybookMatch = {
      id: config.generateId(),
      runId: selector.runId,
      workflowId: selector.workflowId,
      playbookId,
      versionNumber,
      matchScore,
      similarity,
      reason,
      context: selector,
      selectedAt: config.nowIso(),
    };
    store.saveMatch(match);
    return match;
  }
}

/**
 * Extract node sequence from a playbook version's pattern.
 * The pattern may store nodeSequence directly or under a nested key.
 */
export function extractNodeSequenceFromPattern(
  pattern: JsonObject,
): Array<{ nodeType: string; adapterType?: string }> {
  const seq = pattern["nodeSequence"];
  if (!Array.isArray(seq)) return [];
  return seq.map((node) => {
    const obj = node as JsonObject;
    return {
      nodeType: String(obj["nodeType"] ?? ""),
      ...(obj["adapterType"] !== undefined ? { adapterType: String(obj["adapterType"]) } : {}),
    };
  });
}
