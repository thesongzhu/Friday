import { describe, it, expect, beforeEach } from "vitest";
import { createPlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import {
  createLearningEngine,
  extractPattern,
  canonicalizePattern,
  computeStableFingerprint,
} from "../../../../src/playbook/engine/learning-engine.js";
import type { PlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import type {
  FridayPlaybookRunCompletionEvent,
  FridayPlaybookEngineConfig,
  FridayPlaybookCandidateGenerator,
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

function makeEvent(overrides: Partial<FridayPlaybookRunCompletionEvent> = {}): FridayPlaybookRunCompletionEvent {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    workflowType: "data-pipeline",
    tags: ["etl"],
    nodeSequence: [
      { nodeType: "extract", adapterType: "sql" },
      { nodeType: "transform" },
      { nodeType: "load", adapterType: "s3" },
    ],
    toolsUsed: ["sql-query", "s3-upload"],
    parameterKeys: ["source", "destination", "format"],
    durationMs: 5000,
    cost: { tokenCost: 100, apiCallCost: 5, latencyMs: 3000 },
    success: true,
    completedAt: NOW,
    ...overrides,
  };
}

// ─── Tests ───

describe("Learning Engine", () => {
  let store: PlaybookStore;
  let config: FridayPlaybookEngineConfig;
  let engine: FridayPlaybookCandidateGenerator;

  beforeEach(() => {
    store = createPlaybookStore();
    config = makeConfig();
    engine = createLearningEngine({ store, config });
  });

  describe("extractPattern", () => {
    it("extracts normalized pattern from event", () => {
      const event = makeEvent();
      const pattern = extractPattern(event);

      expect(pattern.nodeSequence).toEqual([
        { nodeType: "extract", adapterType: "sql" },
        { nodeType: "transform" },
        { nodeType: "load", adapterType: "s3" },
      ]);
      expect(pattern.toolsUsed).toEqual(["s3-upload", "sql-query"]); // sorted
      expect(pattern.parameterKeys).toEqual(["destination", "format", "source"]); // sorted
    });

    it("excludes inputSchemas when not present", () => {
      const event = makeEvent({ inputSchemas: undefined });
      const pattern = extractPattern(event);
      expect(pattern.inputSchemas).toBeUndefined();
    });

    it("includes inputSchemas when present", () => {
      const event = makeEvent({ inputSchemas: [{ type: "object" }] });
      const pattern = extractPattern(event);
      expect(pattern.inputSchemas).toEqual([{ type: "object" }]);
    });
  });

  describe("computeStableFingerprint", () => {
    it("produces deterministic fingerprints", () => {
      const event = makeEvent();
      const p1 = extractPattern(event);
      const p2 = extractPattern(event);

      expect(computeStableFingerprint(p1)).toBe(computeStableFingerprint(p2));
    });

    it("produces 64-char hex strings", () => {
      const pattern = extractPattern(makeEvent());
      const fp = computeStableFingerprint(pattern);

      expect(fp).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(fp)).toBe(true);
    });

    it("produces different fingerprints for different patterns", () => {
      const fp1 = computeStableFingerprint(extractPattern(makeEvent()));
      const fp2 = computeStableFingerprint(
        extractPattern(makeEvent({ nodeSequence: [{ nodeType: "different" }] })),
      );

      expect(fp1).not.toBe(fp2);
    });

    it("B4 truth-labeling: NOT a SHA-256 hash (output diverges from real SHA-256 of same canonical input)", async () => {
      // The function's 64-hex-char output shape resembles SHA-256 purely
      // for downstream type/string compatibility. This regression guard
      // proves it is NOT a cryptographic SHA-256: comparing the output
      // against `crypto.subtle.digest('SHA-256', ...)` of the same
      // canonical input must NOT match. If a future slice swaps the
      // implementation to real SHA-256, this test will fail loudly and
      // the docstring + function name must be updated to match.
      const pattern = extractPattern(makeEvent());
      const canonical = canonicalizePattern(pattern);
      const stableFp = computeStableFingerprint(pattern);

      const sha256Buf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
      );
      const sha256Hex = Array.from(new Uint8Array(sha256Buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      expect(stableFp).toHaveLength(64);
      expect(sha256Hex).toHaveLength(64);
      // Both are 64 hex chars. They must NOT match — proves the stable
      // fingerprint is not a real SHA-256.
      expect(stableFp).not.toBe(sha256Hex);
    });
  });

  describe("canonicalizePattern", () => {
    it("produces deterministic JSON", () => {
      const p1 = extractPattern(makeEvent());
      const p2 = extractPattern(makeEvent());
      expect(canonicalizePattern(p1)).toBe(canonicalizePattern(p2));
    });

    it("includes nested keys so structurally different node entries do not collide", () => {
      const patternA = extractPattern(
        makeEvent({
          nodeSequence: [{ nodeType: "extract", adapterType: "sql" }],
        }),
      );
      const patternB = extractPattern(
        makeEvent({
          nodeSequence: [{ nodeType: "load", adapterType: "s3" }],
        }),
      );

      expect(canonicalizePattern(patternA)).not.toBe(canonicalizePattern(patternB));
      expect(computeStableFingerprint(patternA)).not.toBe(computeStableFingerprint(patternB));
    });
  });

  describe("processCompletedRun", () => {
    it("creates a new candidate from a successful run", async () => {
      const event = makeEvent();
      const candidate = await engine.processCompletedRun(event);

      expect(candidate).not.toBeNull();
      expect(candidate!.status).toBe("observed");
      expect(candidate!.evidenceCount).toBe(1);
      expect(candidate!.successCount).toBe(1);
      expect(candidate!.failureCount).toBe(0);
      expect(candidate!.workflowType).toBe("data-pipeline");
      expect(candidate!.sourceRunIds).toEqual(["run-1"]);
    });

    it("increments evidence on existing candidate for duplicate pattern", async () => {
      const event1 = makeEvent({ runId: "run-1" });
      const event2 = makeEvent({ runId: "run-2" });

      await engine.processCompletedRun(event1);
      const updated = await engine.processCompletedRun(event2);

      expect(updated!.evidenceCount).toBe(2);
      expect(updated!.successCount).toBe(2);
      expect(updated!.sourceRunIds).toEqual(["run-1", "run-2"]);
      expect(updated!.totalDurationMs).toBe(10_000);
    });

    it("does not dedupe across different workflow types for the same fingerprint", async () => {
      const first = await engine.processCompletedRun(
        makeEvent({ runId: "run-1", workflowType: "workflow-a" }),
      );
      const second = await engine.processCompletedRun(
        makeEvent({ runId: "run-2", workflowType: "workflow-b" }),
      );

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.id).not.toBe(second!.id);
      expect(first!.evidenceCount).toBe(1);
      expect(second!.evidenceCount).toBe(1);
      expect(store.getCandidatesByWorkflowType("workflow-a")).toHaveLength(1);
      expect(store.getCandidatesByWorkflowType("workflow-b")).toHaveLength(1);
    });

    it("transitions to pending after reaching evidence threshold", async () => {
      for (let i = 1; i <= 3; i++) {
        const result = await engine.processCompletedRun(makeEvent({ runId: `run-${i}` }));
        if (i < 3) {
          expect(result!.status).toBe("observed");
        } else {
          expect(result!.status).toBe("pending");
        }
      }
    });

    it("increments failure count on failed run matching existing candidate", async () => {
      await engine.processCompletedRun(makeEvent({ runId: "run-1", success: true }));
      const failed = await engine.processCompletedRun(
        makeEvent({ runId: "run-2", success: false }),
      );

      expect(failed!.failureCount).toBe(1);
      expect(failed!.evidenceCount).toBe(1); // evidence not incremented on failure
    });

    it("returns null for failed run with no matching candidate", async () => {
      const result = await engine.processCompletedRun(
        makeEvent({ success: false }),
      );
      expect(result).toBeNull();
    });

    it("merges tags from multiple runs", async () => {
      await engine.processCompletedRun(makeEvent({ runId: "run-1", tags: ["etl", "daily"] }));
      const result = await engine.processCompletedRun(
        makeEvent({ runId: "run-2", tags: ["etl", "hourly"] }),
      );

      expect(result!.tags).toEqual(["daily", "etl", "hourly"]); // sorted, unique
    });

    it("accumulates cost dimensions", async () => {
      await engine.processCompletedRun(
        makeEvent({
          runId: "run-1",
          cost: { tokenCost: 100, apiCallCost: 5, latencyMs: 3000 },
        }),
      );
      const result = await engine.processCompletedRun(
        makeEvent({
          runId: "run-2",
          cost: { tokenCost: 200, apiCallCost: 10, latencyMs: 2000 },
        }),
      );

      expect(result!.totalCost).toEqual({
        tokenCost: 300,
        apiCallCost: 15,
        latencyMs: 5000,
      });
    });
  });
});
