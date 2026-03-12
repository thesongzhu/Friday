/**
 * Integration tests for the Playbook Learning Loop — verifying the full
 * production learning cycle: selection → ingestion → scoring → promotion.
 *
 * Tests verify:
 * - Matcher selects playbooks and persists selection records
 * - Learning engine creates candidates from completed runs
 * - Score trajectory is recorded per playbook
 * - Success/failure telemetry updates candidate counters
 * - Promoter job evaluates pending candidates
 * - Full lifecycle: candidate → pending → promoted → playbook
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPlaybookLearningLoop,
  createPlaybookStore,
} from "#playbook";
import type {
  UUID,
  ISODateTime,
  FridayPlaybookRunCompletionEvent,
  FridayPlaybookSelector,
  FridayPlaybook,
} from "#playbook";

// ─── Test Helpers ───

let idCounter = 0;
function generateId(): UUID {
  return `test-${++idCounter}` as UUID;
}

function nowIso(): ISODateTime {
  return "2026-02-25T12:00:00.000Z" as ISODateTime;
}

function makeCompletionEvent(overrides: Partial<FridayPlaybookRunCompletionEvent> = {}): FridayPlaybookRunCompletionEvent {
  return {
    runId: generateId(),
    workflowId: "wf-1" as UUID,
    workflowType: "data-pipeline",
    tags: ["etl", "batch"],
    nodeSequence: [
      { nodeType: "trigger" },
      { nodeType: "data" },
      { nodeType: "action", adapterType: "http" },
    ],
    toolsUsed: ["http-client"],
    parameterKeys: ["url", "method"],
    durationMs: 5000,
    cost: { tokenCost: 100, apiCallCost: 5, latencyMs: 5000 },
    success: true,
    completedAt: nowIso(),
    ...overrides,
  };
}

function makeSelector(overrides: Partial<FridayPlaybookSelector> = {}): FridayPlaybookSelector {
  return {
    workflowType: "data-pipeline",
    workflowId: "wf-1" as UUID,
    runId: generateId(),
    nodeSequence: [
      { nodeType: "trigger" },
      { nodeType: "data" },
      { nodeType: "action", adapterType: "http" },
    ],
    tags: ["etl", "batch"],
    ...overrides,
  };
}

function createLoop(overrides: Record<string, unknown> = {}) {
  const store = createPlaybookStore();
  return createPlaybookLearningLoop({
    store,
    generateId,
    nowIso,
    getKpis: () => ({
      reuseHitRate: 0.50,
      successLift: 0.30,
      badPromotionRollbackRate: 0.00,
    }),
    ...overrides,
  });
}

// ─── Tests ───

describe("Playbook Learning Loop", () => {
  beforeEach(() => {
    idCounter = 0;
  });

  describe("Selection", () => {
    it("returns no_match when no playbooks exist", async () => {
      const loop = createLoop();
      const match = await loop.selectPlaybook(makeSelector());

      expect(match.reason).toBe("no_match");
      expect(match.playbookId).toBeNull();
    });

    it("persists selection records for analytics", async () => {
      const loop = createLoop();
      const selector = makeSelector();
      await loop.selectPlaybook(selector);

      // Selection should be saved in the store
      const matches = loop.store.getMatchesByRunId(selector.runId);
      expect(matches).toHaveLength(1);
      expect(matches[0].reason).toBe("no_match");
    });
  });

  describe("Run ingestion", () => {
    it("creates a candidate from a successful run", async () => {
      const loop = createLoop();
      const event = makeCompletionEvent();

      const candidate = await loop.ingestRunCompletion(event);

      expect(candidate).toBeDefined();
      expect(candidate!.status).toBe("observed");
      expect(candidate!.evidenceCount).toBe(1);
      expect(candidate!.successCount).toBe(1);
      expect(candidate!.failureCount).toBe(0);
    });

    it("increments evidence on duplicate pattern", async () => {
      const loop = createLoop();

      await loop.ingestRunCompletion(makeCompletionEvent({ runId: "run-a" as UUID }));
      const second = await loop.ingestRunCompletion(makeCompletionEvent({ runId: "run-b" as UUID }));

      expect(second).toBeDefined();
      expect(second!.evidenceCount).toBe(2);
    });

    it("transitions candidate to pending at 3 evidence", async () => {
      const loop = createLoop();

      await loop.ingestRunCompletion(makeCompletionEvent({ runId: "r1" as UUID }));
      await loop.ingestRunCompletion(makeCompletionEvent({ runId: "r2" as UUID }));
      const third = await loop.ingestRunCompletion(makeCompletionEvent({ runId: "r3" as UUID }));

      expect(third).toBeDefined();
      expect(third!.status).toBe("pending");
    });

    it("increments failure counter on failed runs", async () => {
      const loop = createLoop();

      // First, create a candidate with a successful run
      await loop.ingestRunCompletion(makeCompletionEvent({ runId: "ok-1" as UUID }));

      // Then send a failed run with the same pattern
      const failed = await loop.ingestRunCompletion(
        makeCompletionEvent({ runId: "fail-1" as UUID, success: false }),
      );

      expect(failed).toBeDefined();
      expect(failed!.failureCount).toBe(1);
      expect(failed!.successCount).toBe(1);
    });

    it("does not create candidate from failed run with no existing match", async () => {
      const loop = createLoop();

      const result = await loop.ingestRunCompletion(
        makeCompletionEvent({ success: false }),
      );

      expect(result).toBeNull();
    });
  });

  describe("Score tracking", () => {
    it("recalculates score for a playbook", async () => {
      const loop = createLoop();

      // Manually create a playbook in the store
      const playbookId = generateId();
      const playbook: FridayPlaybook = {
        id: playbookId,
        name: "Test Playbook",
        workflowType: "data-pipeline",
        tags: ["etl"],
        status: "active",
        activeVersionNumber: 1,
        sourceCandidateId: generateId(),
        compositeScore: 0,
        totalUses: 10,
        totalSuccesses: 8,
        etag: "etag-1",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      loop.store.savePlaybook(playbook);

      const score = await loop.recalculateScore(playbookId);

      expect(score).toBeDefined();
      expect(score.compositeScore).toBeGreaterThan(0);
      expect(score.successRate).toBeCloseTo(0.8);
      // sampleSize comes from evidence (candidate runs count), not totalUses directly
      expect(score.sampleSize).toBeGreaterThanOrEqual(1);
    });

    it("persists score snapshots for trend analysis", async () => {
      const loop = createLoop();

      const playbookId = generateId();
      loop.store.savePlaybook({
        id: playbookId,
        name: "Score Track Playbook",
        workflowType: "data-pipeline",
        tags: [],
        status: "active",
        activeVersionNumber: 1,
        sourceCandidateId: generateId(),
        compositeScore: 0,
        totalUses: 5,
        totalSuccesses: 5,
        etag: "etag-2",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });

      await loop.recalculateScore(playbookId);
      await loop.recalculateScore(playbookId);

      const scores = loop.store.getScoresByPlaybookId(playbookId);
      expect(scores.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Promoter job", () => {
    it("runs a tick and evaluates pending candidates", async () => {
      const loop = createLoop();

      // Create enough evidence for a pending candidate
      for (let i = 0; i < 5; i++) {
        await loop.ingestRunCompletion(
          makeCompletionEvent({ runId: `promo-run-${i}` as UUID }),
        );
      }

      // Verify candidate is pending
      const pending = loop.store.getCandidatesByStatus("pending");
      expect(pending.length).toBeGreaterThanOrEqual(1);

      // Run promoter tick
      const result = await loop.tickPromoter("test-tick-1");
      expect(result.status).toBeDefined();
    });

    it("promotes candidate that meets all criteria", async () => {
      const loop = createLoop({
        promotionConfig: {
          rules: [
            {
              id: "min-evidence",
              name: "Min evidence",
              description: "At least 3 evidence runs",
              metric: "evidence_count" as const,
              operator: "gte" as const,
              threshold: 3,
            },
            {
              id: "min-success",
              name: "Min success rate",
              description: "At least 50% success",
              metric: "success_rate" as const,
              operator: "gte" as const,
              threshold: 0.50,
            },
          ],
          evaluationIntervalHours: 6,
          rollbackConsecutiveWindows: 3,
          rollbackSuccessRateThreshold: 0.50,
        },
      });

      // Ingest 5 successful runs (evidence threshold = 3)
      for (let i = 0; i < 5; i++) {
        await loop.ingestRunCompletion(
          makeCompletionEvent({ runId: `promote-${i}` as UUID }),
        );
      }

      // Run promoter
      const tickResult = await loop.tickPromoter("promote-tick");
      expect(tickResult.status).toBe("completed");

      // Check that a playbook was created
      const playbooks = loop.store.getAllPlaybooks("active");
      expect(playbooks.length).toBeGreaterThanOrEqual(1);
    });

    it("returns idempotent result for duplicate tick key", async () => {
      const loop = createLoop();

      for (let i = 0; i < 5; i++) {
        await loop.ingestRunCompletion(
          makeCompletionEvent({ runId: `idem-${i}` as UUID }),
        );
      }

      const first = await loop.tickPromoter("idem-key");
      const second = await loop.tickPromoter("idem-key");

      expect(second.replayed).toBe(true);
      expect(second.status).toBe(first.status);
    });
  });

  describe("Full lifecycle", () => {
    it("completes candidate → pending → promoted → playbook → selection cycle", async () => {
      const loop = createLoop({
        promotionConfig: {
          rules: [
            {
              id: "min-evidence",
              name: "Min evidence",
              description: "At least 3",
              metric: "evidence_count" as const,
              operator: "gte" as const,
              threshold: 3,
            },
          ],
          evaluationIntervalHours: 6,
          rollbackConsecutiveWindows: 3,
          rollbackSuccessRateThreshold: 0.50,
        },
      });

      // Phase 1: Ingest runs to create and transition candidate
      for (let i = 0; i < 5; i++) {
        await loop.ingestRunCompletion(
          makeCompletionEvent({ runId: `lc-${i}` as UUID }),
        );
      }

      // Phase 2: Promote via promoter tick
      const tickResult = await loop.tickPromoter("lifecycle-tick");
      expect(tickResult.status).toBe("completed");

      // Phase 3: Verify playbook exists
      const playbooks = loop.store.getAllPlaybooks("active");
      expect(playbooks.length).toBeGreaterThanOrEqual(1);
      const createdPlaybook = playbooks[0];

      // Phase 4: Select — should now match
      const match = await loop.selectPlaybook(makeSelector());
      expect(match.reason).toBe("matched");
      expect(match.playbookId).toBe(createdPlaybook.id);

      // Phase 5: Ingest another success for the selected run
      await loop.ingestRunCompletion(
        makeCompletionEvent({ runId: match.context.runId }),
      );

      // Verify playbook usage stats updated
      const updated = loop.store.getPlaybook(createdPlaybook.id);
      expect(updated).toBeDefined();
      expect(updated!.totalUses).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Component access", () => {
    it("exposes all engine components", () => {
      const loop = createLoop();

      expect(loop.store).toBeDefined();
      expect(loop.learningEngine).toBeDefined();
      expect(loop.matcher).toBeDefined();
      expect(loop.scoreCalculator).toBeDefined();
      expect(loop.promotionEngine).toBeDefined();
      expect(loop.versionManager).toBeDefined();
      expect(loop.promoterJob).toBeDefined();
    });
  });
});
