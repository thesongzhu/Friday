import { describe, it, expect, beforeEach } from "vitest";
import { createPlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import {
  createPlaybookMatcher,
  jaccardSimilarity,
  computeNodeSequenceSimilarity,
  computeTagOverlap,
  extractNodeSequenceFromPattern,
} from "../../../../src/playbook/engine/playbook-matcher.js";
import type { PlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import type {
  FridayPlaybook,
  FridayPlaybookVersion,
  FridayPlaybookSelector,
  FridayPlaybookSelectorEngine,
  FridayPlaybookEngineConfig,
} from "../../../../src/playbook/model/friday-playbook.types.js";
import {
  FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS,
  FRIDAY_DEFAULT_PROMOTION_RULES,
  FRIDAY_PLAYBOOK_TIE_BREAK_ORDER,
} from "../../../../src/playbook/model/friday-playbook.types.js";

// ─── Helpers ───

const NOW = "2026-02-24T10:00:00.000Z";
let idCounter = 0;

function makeConfig(): FridayPlaybookEngineConfig {
  idCounter = 0;
  return {
    scoring: {
      weights: { ...FRIDAY_PLAYBOOK_SCORE_DIMENSION_WEIGHTS },
      decayRate: 0.02,
      autoArchiveDays: 90,
      minSampleSize: 5,
    },
    selection: {
      matchThreshold: 0.6,
      similarityWeight: 0.6,
      scoreWeight: 0.4,
      minTagOverlap: 0.5,
      maxCandidates: 50,
      tieBreakOrder: [...FRIDAY_PLAYBOOK_TIE_BREAK_ORDER],
    },
    promotion: {
      rules: [...FRIDAY_DEFAULT_PROMOTION_RULES],
      evaluationIntervalHours: 6,
      rollbackConsecutiveWindows: 3,
      rollbackSuccessRateThreshold: 0.5,
    },
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
  };
}

function makePlaybook(overrides: Partial<FridayPlaybook> = {}): FridayPlaybook {
  return {
    id: "pb-1",
    name: "test-playbook",
    workflowType: "data-pipeline",
    tags: ["etl", "daily"],
    status: "active",
    activeVersionNumber: 1,
    sourceCandidateId: "cand-1",
    compositeScore: 0.85,
    totalUses: 10,
    totalSuccesses: 9,
    etag: "etag-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeVersion(overrides: Partial<FridayPlaybookVersion> = {}): FridayPlaybookVersion {
  return {
    id: "ver-1",
    playbookId: "pb-1",
    versionNumber: 1,
    fingerprint: "abc123",
    pattern: {
      nodeSequence: [
        { nodeType: "extract", adapterType: "sql" },
        { nodeType: "transform" },
        { nodeType: "load", adapterType: "s3" },
      ],
      toolsUsed: ["sql-query", "s3-upload"],
      parameterKeys: ["source", "destination"],
    },
    candidateId: "cand-1",
    createdAt: NOW,
    ...overrides,
  };
}

function makeSelector(overrides: Partial<FridayPlaybookSelector> = {}): FridayPlaybookSelector {
  return {
    workflowType: "data-pipeline",
    workflowId: "wf-1",
    runId: "run-1",
    nodeSequence: [
      { nodeType: "extract", adapterType: "sql" },
      { nodeType: "transform" },
      { nodeType: "load", adapterType: "s3" },
    ],
    tags: ["etl", "daily"],
    ...overrides,
  };
}

// ─── Tests ───

describe("Playbook Matcher", () => {
  let store: PlaybookStore;
  let config: FridayPlaybookEngineConfig;
  let matcher: FridayPlaybookSelectorEngine;

  beforeEach(() => {
    store = createPlaybookStore();
    config = makeConfig();
    matcher = createPlaybookMatcher({ store, config });
  });

  describe("jaccardSimilarity", () => {
    it("returns 1.0 for identical sets", () => {
      const a = new Set(["a", "b", "c"]);
      expect(jaccardSimilarity(a, a)).toBe(1.0);
    });

    it("returns 0.0 for disjoint sets", () => {
      expect(jaccardSimilarity(new Set(["a"]), new Set(["b"]))).toBe(0.0);
    });

    it("returns correct value for partial overlap", () => {
      const sim = jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]));
      expect(sim).toBeCloseTo(0.5, 5); // 2/4
    });

    it("returns 1.0 for two empty sets", () => {
      expect(jaccardSimilarity(new Set(), new Set())).toBe(1.0);
    });
  });

  describe("computeNodeSequenceSimilarity", () => {
    it("returns 1.0 for identical sequences", () => {
      const nodes = [
        { nodeType: "extract", adapterType: "sql" },
        { nodeType: "transform" },
      ];
      expect(computeNodeSequenceSimilarity(nodes, nodes)).toBe(1.0);
    });

    it("returns 0.0 for completely different sequences", () => {
      const a = [{ nodeType: "extract" }];
      const b = [{ nodeType: "load" }];
      expect(computeNodeSequenceSimilarity(a, b)).toBe(0.0);
    });
  });

  describe("computeTagOverlap", () => {
    it("returns 1.0 when all selector tags match", () => {
      expect(computeTagOverlap(["etl"], ["etl", "daily"])).toBe(1.0);
    });

    it("returns 0.5 when half of selector tags match", () => {
      expect(computeTagOverlap(["etl", "hourly"], ["etl", "daily"])).toBe(0.5);
    });

    it("returns 1.0 for empty selector tags", () => {
      expect(computeTagOverlap([], ["etl"])).toBe(1.0);
    });

    it("returns 0.0 for no overlap", () => {
      expect(computeTagOverlap(["hourly"], ["etl"])).toBe(0.0);
    });
  });

  describe("extractNodeSequenceFromPattern", () => {
    it("extracts node sequence from pattern", () => {
      const pattern = {
        nodeSequence: [
          { nodeType: "extract", adapterType: "sql" },
          { nodeType: "transform" },
        ],
      };
      const nodes = extractNodeSequenceFromPattern(pattern);
      expect(nodes).toEqual([
        { nodeType: "extract", adapterType: "sql" },
        { nodeType: "transform" },
      ]);
    });

    it("returns empty array when no nodeSequence", () => {
      expect(extractNodeSequenceFromPattern({})).toEqual([]);
    });
  });

  describe("select", () => {
    it("returns no_match when no playbooks exist", async () => {
      const result = await matcher.select(makeSelector());
      expect(result.reason).toBe("no_match");
      expect(result.playbookId).toBeNull();
    });

    it("matches a playbook with identical context", async () => {
      store.savePlaybook(makePlaybook());
      store.saveVersion(makeVersion());

      const result = await matcher.select(makeSelector());
      expect(result.reason).toBe("matched");
      expect(result.playbookId).toBe("pb-1");
      expect(result.versionNumber).toBe(1);
      expect(result.matchScore).toBeGreaterThan(0);
      expect(result.similarity).toBeGreaterThan(0);
    });

    it("returns below_threshold when tag overlap is too low", async () => {
      store.savePlaybook(makePlaybook({ tags: ["ml", "training"] }));
      store.saveVersion(makeVersion());

      const result = await matcher.select(makeSelector({ tags: ["etl"] }));
      expect(result.reason).toBe("below_threshold");
    });

    it("selects the highest-ranked playbook among multiple", async () => {
      store.savePlaybook(makePlaybook({ id: "pb-1", compositeScore: 0.5 }));
      store.savePlaybook(makePlaybook({ id: "pb-2", compositeScore: 0.9 }));
      store.saveVersion(makeVersion({ id: "v1", playbookId: "pb-1" }));
      store.saveVersion(makeVersion({ id: "v2", playbookId: "pb-2" }));

      const result = await matcher.select(makeSelector());
      expect(result.playbookId).toBe("pb-2");
    });

    it("uses lastSuccessfulAt for most_recent_success tie-break", async () => {
      store.savePlaybook(
        makePlaybook({
          id: "pb-1",
          sourceCandidateId: "cand-a",
          compositeScore: 0.8,
          lastSuccessfulAt: "2026-02-24T11:00:00.000Z",
          updatedAt: "2026-02-24T09:00:00.000Z",
        }),
      );
      store.savePlaybook(
        makePlaybook({
          id: "pb-2",
          sourceCandidateId: "cand-b",
          compositeScore: 0.8,
          lastSuccessfulAt: "2026-02-24T08:00:00.000Z",
          updatedAt: "2026-02-24T12:00:00.000Z",
        }),
      );
      store.saveVersion(makeVersion({ id: "v1", playbookId: "pb-1" }));
      store.saveVersion(makeVersion({ id: "v2", playbookId: "pb-2" }));

      const result = await matcher.select(makeSelector());
      expect(result.playbookId).toBe("pb-1");
    });

    it("persists match result in the store", async () => {
      store.savePlaybook(makePlaybook());
      store.saveVersion(makeVersion());

      const result = await matcher.select(makeSelector());
      expect(store.getMatch(result.id)).toEqual(result);
    });

    it("ignores archived and rolled_back playbooks", async () => {
      store.savePlaybook(makePlaybook({ id: "pb-1", status: "archived" }));
      store.savePlaybook(makePlaybook({ id: "pb-2", status: "rolled_back" }));
      store.saveVersion(makeVersion({ id: "v1", playbookId: "pb-1" }));
      store.saveVersion(makeVersion({ id: "v2", playbookId: "pb-2" }));

      const result = await matcher.select(makeSelector());
      expect(result.reason).toBe("no_match");
    });

    it("records context in the match result", async () => {
      const selector = makeSelector();
      const result = await matcher.select(selector);
      expect(result.context).toEqual(selector);
    });
  });
});
