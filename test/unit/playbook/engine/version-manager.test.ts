import { describe, it, expect, beforeEach } from "vitest";
import { createPlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import { createVersionManager } from "../../../../src/playbook/engine/version-manager.js";
import type { PlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import type { VersionManager } from "../../../../src/playbook/engine/version-manager.js";
import type {
  FridayPlaybookCandidate,
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

function makeCandidate(overrides: Partial<FridayPlaybookCandidate> = {}): FridayPlaybookCandidate {
  return {
    id: "cand-1",
    fingerprint: "abc123",
    workflowType: "data-pipeline",
    tags: ["etl"],
    pattern: {
      nodeSequence: [
        { nodeType: "extract", adapterType: "sql" },
        { nodeType: "transform" },
        { nodeType: "load", adapterType: "s3" },
      ],
      toolsUsed: ["sql-query", "s3-upload"],
      parameterKeys: ["source", "destination"],
    },
    status: "promoted",
    evidenceCount: 10,
    successCount: 9,
    failureCount: 1,
    totalDurationMs: 50_000,
    totalCost: { tokenCost: 1000, apiCallCost: 50, latencyMs: 30_000 },
    sourceRunIds: ["run-1"],
    firstObservedAt: "2026-02-20T10:00:00.000Z",
    lastObservedAt: NOW,
    createdAt: "2026-02-20T10:00:00.000Z",
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── Tests ───

describe("Version Manager", () => {
  let store: PlaybookStore;
  let config: FridayPlaybookEngineConfig;
  let manager: VersionManager;

  beforeEach(() => {
    store = createPlaybookStore();
    config = makeConfig();
    manager = createVersionManager({ store, config });
  });

  describe("createFromCandidate", () => {
    it("creates a playbook and initial version", () => {
      const candidate = makeCandidate();
      store.saveCandidate(candidate);

      const { playbook, version } = manager.createFromCandidate(candidate);

      expect(playbook.status).toBe("active");
      expect(playbook.activeVersionNumber).toBe(1);
      expect(playbook.workflowType).toBe("data-pipeline");
      expect(playbook.tags).toEqual(["etl"]);
      expect(playbook.sourceCandidateId).toBe("cand-1");

      expect(version.versionNumber).toBe(1);
      expect(version.playbookId).toBe(playbook.id);
      expect(version.fingerprint).toBe("abc123");
      expect(version.candidateId).toBe("cand-1");
    });

    it("persists playbook and version in store", () => {
      store.saveCandidate(makeCandidate());
      const { playbook, version } = manager.createFromCandidate(makeCandidate());

      expect(store.getPlaybook(playbook.id)).toEqual(playbook);
      expect(store.getVersion(version.id)).toEqual(version);
    });

    it("links candidate back to playbook", () => {
      store.saveCandidate(makeCandidate());
      const { playbook } = manager.createFromCandidate(makeCandidate());

      const updatedCandidate = store.getCandidate("cand-1");
      expect(updatedCandidate!.promotedPlaybookId).toBe(playbook.id);
      expect(updatedCandidate!.status).toBe("promoted");
    });

    it("generates a meaningful playbook name", () => {
      store.saveCandidate(makeCandidate());
      const { playbook } = manager.createFromCandidate(makeCandidate());

      // Name should contain workflow type and node info
      expect(playbook.name).toContain("data-pipeline");
      expect(playbook.name).toContain("extract");
      expect(playbook.name).toContain("load");
    });

    it("generates name for single-node pattern", () => {
      const candidate = makeCandidate({
        pattern: {
          nodeSequence: [{ nodeType: "process" }],
          toolsUsed: [],
          parameterKeys: [],
        },
      });
      store.saveCandidate(candidate);
      const { playbook } = manager.createFromCandidate(candidate);

      expect(playbook.name).toBe("data-pipeline/process");
    });
  });

  describe("evolve", () => {
    it("creates a new version when pattern is similar enough", () => {
      const candidate1 = makeCandidate();
      store.saveCandidate(candidate1);
      const { playbook } = manager.createFromCandidate(candidate1);

      // New candidate with slightly different pattern (same node types, one adapter changed)
      // Jaccard similarity: 3 shared keys (extract:sql, transform, load:s3) + 1 new (validate)
      // = 3/4 = 0.75 ... but we need >= 0.85, so keep it very similar
      const candidate2 = makeCandidate({
        id: "cand-2",
        fingerprint: "def456",
        pattern: {
          nodeSequence: [
            { nodeType: "extract", adapterType: "sql" },
            { nodeType: "transform" },
            { nodeType: "load", adapterType: "s3" },
          ],
          toolsUsed: ["sql-query", "s3-upload", "validator"],
          parameterKeys: ["source", "destination", "schema"],
        },
      });
      store.saveCandidate(candidate2);

      const newVersion = manager.evolve(playbook.id, candidate2, "Added validation.");

      expect(newVersion).not.toBeNull();
      expect(newVersion!.versionNumber).toBe(2);
      expect(newVersion!.fingerprint).toBe("def456");

      const updated = store.getPlaybook(playbook.id);
      expect(updated!.activeVersionNumber).toBe(2);

      const linkedCandidate = store.getCandidate("cand-2");
      expect(linkedCandidate!.promotedPlaybookId).toBe(playbook.id);
      expect(linkedCandidate!.status).toBe("promoted");
    });

    it("rejects evolution when pattern is too different", () => {
      const candidate1 = makeCandidate();
      store.saveCandidate(candidate1);
      const { playbook } = manager.createFromCandidate(candidate1);

      const candidate2 = makeCandidate({
        id: "cand-2",
        fingerprint: "def456",
        pattern: {
          nodeSequence: [
            { nodeType: "completely_different" },
            { nodeType: "unrelated" },
          ],
          toolsUsed: [],
          parameterKeys: [],
        },
      });
      store.saveCandidate(candidate2);

      const result = manager.evolve(playbook.id, candidate2);
      expect(result).toBeNull();
    });

    it("reactivates existing version when fingerprint matches history", () => {
      const candidate1 = makeCandidate();
      store.saveCandidate(candidate1);
      const { playbook, version: v1 } = manager.createFromCandidate(candidate1);

      // Evolve to v2 (same node sequence for Jaccard = 1.0)
      const candidate2 = makeCandidate({
        id: "cand-2",
        fingerprint: "def456",
        pattern: {
          nodeSequence: [
            { nodeType: "extract", adapterType: "sql" },
            { nodeType: "transform" },
            { nodeType: "load", adapterType: "s3" },
          ],
          toolsUsed: ["sql-query", "s3-upload", "new-tool"],
          parameterKeys: ["source", "destination"],
        },
      });
      store.saveCandidate(candidate2);
      manager.evolve(playbook.id, candidate2);

      // Now try to evolve back to v1's fingerprint (circular evolution)
      const candidate3 = makeCandidate({
        id: "cand-3",
        fingerprint: "abc123", // same as v1
      });
      store.saveCandidate(candidate3);

      const result = manager.evolve(playbook.id, candidate3);

      // Should reactivate v1 instead of creating v3
      expect(result).not.toBeNull();
      expect(result!.versionNumber).toBe(1);

      const updated = store.getPlaybook(playbook.id);
      expect(updated!.activeVersionNumber).toBe(1);

      const linkedCandidate = store.getCandidate("cand-3");
      expect(linkedCandidate!.promotedPlaybookId).toBe(playbook.id);
      expect(linkedCandidate!.status).toBe("promoted");
    });

    it("returns null for non-existent playbook", () => {
      expect(manager.evolve("nonexistent", makeCandidate())).toBeNull();
    });
  });

  describe("rollback", () => {
    it("rolls back to a previous version", () => {
      const candidate = makeCandidate();
      store.saveCandidate(candidate);
      const { playbook } = manager.createFromCandidate(candidate);

      // Evolve to v2 (identical node sequence for Jaccard = 1.0)
      const candidate2 = makeCandidate({
        id: "cand-2",
        fingerprint: "def456",
        pattern: {
          nodeSequence: [
            { nodeType: "extract", adapterType: "sql" },
            { nodeType: "transform" },
            { nodeType: "load", adapterType: "s3" },
          ],
          toolsUsed: ["sql-query", "s3-upload", "validator"],
          parameterKeys: ["source", "destination"],
        },
      });
      store.saveCandidate(candidate2);
      manager.evolve(playbook.id, candidate2);

      const rolledBack = manager.rollback(playbook.id, 1, "Performance regression.");
      expect(rolledBack).not.toBeNull();
      expect(rolledBack!.activeVersionNumber).toBe(1);
      expect(rolledBack!.status).toBe("active");
    });

    it("returns null for non-existent version", () => {
      const candidate = makeCandidate();
      store.saveCandidate(candidate);
      const { playbook } = manager.createFromCandidate(candidate);

      expect(manager.rollback(playbook.id, 99, "Bad version.")).toBeNull();
    });

    it("returns null when target is already active", () => {
      const candidate = makeCandidate();
      store.saveCandidate(candidate);
      const { playbook } = manager.createFromCandidate(candidate);

      expect(manager.rollback(playbook.id, 1, "Already active.")).toBeNull();
    });

    it("persists rollback lifecycle audit event with reason and version transition", () => {
      const candidate = makeCandidate();
      store.saveCandidate(candidate);
      const { playbook } = manager.createFromCandidate(candidate);

      const candidate2 = makeCandidate({
        id: "cand-2",
        fingerprint: "def456",
        pattern: {
          nodeSequence: [
            { nodeType: "extract", adapterType: "sql" },
            { nodeType: "transform" },
            { nodeType: "load", adapterType: "s3" },
          ],
          toolsUsed: ["sql-query", "s3-upload", "validator"],
          parameterKeys: ["source", "destination"],
        },
      });
      store.saveCandidate(candidate2);
      manager.evolve(playbook.id, candidate2);

      manager.rollback(playbook.id, 1, "Regression in v2.");

      const events = store.getLifecycleEventsByPlaybookId(playbook.id);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("rollback");
      expect(events[0].reason).toBe("Regression in v2.");
      expect(events[0].fromVersionNumber).toBe(2);
      expect(events[0].toVersionNumber).toBe(1);
    });
  });

  describe("deactivate", () => {
    it("sets playbook status to rolled_back", () => {
      const candidate = makeCandidate();
      store.saveCandidate(candidate);
      const { playbook } = manager.createFromCandidate(candidate);

      const deactivated = manager.deactivate(playbook.id, "Performance issue.");
      expect(deactivated).not.toBeNull();
      expect(deactivated!.status).toBe("rolled_back");
      expect(deactivated!.archivedAt).toBe(NOW);
    });

    it("updates source candidate status to rolled_back", () => {
      const candidate = makeCandidate();
      store.saveCandidate(candidate);
      const { playbook } = manager.createFromCandidate(candidate);

      manager.deactivate(playbook.id, "Deactivating.");
      const updatedCandidate = store.getCandidate("cand-1");
      expect(updatedCandidate!.status).toBe("rolled_back");
    });

    it("returns null for non-existent playbook", () => {
      expect(manager.deactivate("nonexistent", "No reason.")).toBeNull();
    });

    it("persists deactivation lifecycle audit event with reason", () => {
      const candidate = makeCandidate();
      store.saveCandidate(candidate);
      const { playbook } = manager.createFromCandidate(candidate);

      manager.deactivate(playbook.id, "Sustained failure rate.");

      const events = store.getLifecycleEventsByPlaybookId(playbook.id);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("deactivate");
      expect(events[0].reason).toBe("Sustained failure rate.");
      expect(events[0].fromVersionNumber).toBe(1);
      expect(events[0].toVersionNumber).toBeNull();
    });
  });

  describe("diff", () => {
    it("computes diff between two versions", () => {
      const candidate1 = makeCandidate({
        pattern: {
          nodeSequence: [{ nodeType: "extract" }],
          toolsUsed: ["sql-query"],
          format: "csv",
        },
      });
      store.saveCandidate(candidate1);
      const { playbook } = manager.createFromCandidate(candidate1);

      // Evolve: same nodeSequence (Jaccard = 1.0) but changed format and toolsUsed
      const candidate2 = makeCandidate({
        id: "cand-2",
        fingerprint: "def456",
        pattern: {
          nodeSequence: [{ nodeType: "extract" }],
          toolsUsed: ["sql-query", "s3-upload"],
          format: "parquet",
        },
      });
      store.saveCandidate(candidate2);
      manager.evolve(playbook.id, candidate2);

      const result = manager.diff(playbook.id, 1, 2);
      expect(result).not.toBeNull();
      expect(result!.identical).toBe(false);
      expect(result!.entries.length).toBeGreaterThan(0);

      // Should detect changes in format
      const formatChange = result!.entries.find((e) => e.path === "format");
      expect(formatChange).toBeDefined();
      expect(formatChange!.kind).toBe("changed");
      expect(formatChange!.oldValue).toBe("csv");
      expect(formatChange!.newValue).toBe("parquet");
    });

    it("reports identical versions", () => {
      const candidate = makeCandidate();
      store.saveCandidate(candidate);
      const { playbook } = manager.createFromCandidate(candidate);

      const result = manager.diff(playbook.id, 1, 1);
      expect(result).not.toBeNull();
      expect(result!.identical).toBe(true);
      expect(result!.entries).toHaveLength(0);
    });

    it("returns null for non-existent versions", () => {
      expect(manager.diff("pb-1", 1, 2)).toBeNull();
    });
  });

  describe("getHistory", () => {
    it("returns all versions sorted by version number", () => {
      const candidate = makeCandidate();
      store.saveCandidate(candidate);
      const { playbook } = manager.createFromCandidate(candidate);

      // Evolve: identical node sequence for Jaccard = 1.0
      const candidate2 = makeCandidate({
        id: "cand-2",
        fingerprint: "def456",
        pattern: {
          nodeSequence: [
            { nodeType: "extract", adapterType: "sql" },
            { nodeType: "transform" },
            { nodeType: "load", adapterType: "s3" },
          ],
          toolsUsed: ["sql-query", "s3-upload", "new-tool"],
          parameterKeys: ["source", "destination"],
        },
      });
      store.saveCandidate(candidate2);
      manager.evolve(playbook.id, candidate2);

      const history = manager.getHistory(playbook.id);
      expect(history).toHaveLength(2);
      expect(history[0].versionNumber).toBe(1);
      expect(history[1].versionNumber).toBe(2);
    });
  });
});
