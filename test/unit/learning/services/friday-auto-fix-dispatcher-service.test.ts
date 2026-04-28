import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAutoFixDispatcherService } from "#learning";
import { createFridayAutoFixExecutionService } from "#learning";
import { createFridayAutoFixRollbackService } from "#learning";
import { createFridayAutoFixRiskAssessmentService } from "#learning";
import { createFridayAutoFixActionRepository } from "#learning";
import { createFridayApprovalRequestRepository } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import { createFridayDiagnosisRecordRepository } from "#learning";
import type { FridayAutoFixDispatcherService } from "#learning";
import type { FridayAutoFixPlan } from "#learning";

describe("FridayAutoFixDispatcherService", () => {
  let db: FridaySqliteLayer;
  let service: FridayAutoFixDispatcherService;
  const NOW = "2025-06-15T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
    title: "Auto-fix: retry",
    summary: "Retry",
    steps: [
      {
        stepId: "step-001",
        kind: "retry_node",
        target: "tool",
        payload: {},
        verify: { method: "error_absent", timeoutMs: 5000 },
      },
    ],
    evidence: {
      fingerprint: "sig-abc",
      matchedLessonIds: [],
      diagnosisId: "diag-001",
      recurrenceCount: 1,
    },
  };

  let actionRepo: ReturnType<typeof createFridayAutoFixActionRepository>;
  let approvalRepo: ReturnType<typeof createFridayApprovalRequestRepository>;
  let incidentRepo: ReturnType<typeof createFridayErrorIncidentRepository>;

  beforeEach(() => {
    db = createTestDb();

    actionRepo = createFridayAutoFixActionRepository();
    approvalRepo = createFridayApprovalRequestRepository();
    incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();

    // Setup FK deps
    incidentRepo.insert(db.writer, {
      incidentId: "inc-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "medium",
      signature: "sig-abc",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    diagnosisRepo.insert(db.writer, {
      id: "diag-001",
      incidentId: "inc-001",
      errorFingerprint: "sig-abc",
      confidence: 0.8,
      diagnosis: { summary: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    // Insert two planned actions at different tiers
    incidentRepo.insert(db.writer, {
      incidentId: "inc-002",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "high",
      signature: "sig-def",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    actionRepo.insert(db.writer, {
      actionId: "action-001",
      incidentId: "inc-001",
      userId: "test-user",
      riskTier: 0,
      plan: basePlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    actionRepo.insert(db.writer, {
      actionId: "action-002",
      incidentId: "inc-002",
      userId: "test-user",
      riskTier: 2,
      plan: {
        ...basePlan,
        steps: [
          { stepId: "step-002", kind: "disable_skill", target: "skill-x", payload: {} },
        ],
        evidence: { ...basePlan.evidence, diagnosisId: "diag-001" },
      },
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const executionService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo,
        nowIso: () => NOW,
      }),
      nowIso: () => NOW,
      stepExecutors: {
        retry_node: (step) => {
          const payload = step.payload as Record<string, unknown> | null;
          if (payload && typeof payload === "object") {
            payload._retryRequested = true;
          }
          return true;
        },
      },
    });
    const riskService = createFridayAutoFixRiskAssessmentService({
      db,
      actionRepo,
    });

    service = createFridayAutoFixDispatcherService({
      db,
      actionRepo,
      approvalRepo,
      incidentRepo,
      riskService,
      executionService,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("runs ready actions up to maxRiskTier", async () => {
    const results = await service.runReadyActions({ maxRiskTier: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]!.action.actionId).toBe("action-001");
    expect(results[0]!.success).toBe(true);
  });

  it("respects maxRiskTier cap", async () => {
    const results = await service.runReadyActions({ maxRiskTier: 1 });
    // Only action-001 (tier 0) qualifies, action-002 (tier 2) does not
    expect(results).toHaveLength(1);
  });

  it("filters by incidentIds", async () => {
    const results = await service.runReadyActions({
      incidentIds: ["inc-001"],
      maxRiskTier: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.action.incidentId).toBe("inc-001");
  });

  it("filters ready actions by userId for homepage self-repair", async () => {
    db.writer.prepare(
      `INSERT INTO users (id, display_name, role, is_local_only, created_at, updated_at)
       VALUES ('other-user', 'Other User', 'admin', 1, ?, ?)`,
    ).run(NOW, NOW);
    incidentRepo.insert(db.writer, {
      incidentId: "inc-other",
      userId: "other-user",
      ts: NOW,
      category: "tool",
      severity: "medium",
      signature: "sig-other",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });
    actionRepo.insert(db.writer, {
      actionId: "action-other",
      incidentId: "inc-other",
      userId: "other-user",
      riskTier: 0,
      plan: {
        ...basePlan,
        evidence: { ...basePlan.evidence, fingerprint: "sig-other" },
      },
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const results = await service.runReadyActions({ userId: "other-user", maxRiskTier: 0 });

    expect(results).toHaveLength(1);
    expect(results[0]!.action.actionId).toBe("action-other");
  });

  it("skips mutating data-preserving actions when rollback evidence is missing", async () => {
    incidentRepo.insert(db.writer, {
      incidentId: "inc-no-rollback",
      userId: "test-user",
      ts: NOW,
      category: "config",
      severity: "medium",
      signature: "sig-no-rollback",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });
    actionRepo.insert(db.writer, {
      actionId: "action-no-rollback",
      incidentId: "inc-no-rollback",
      userId: "test-user",
      riskTier: 1,
      plan: {
        ...basePlan,
        steps: [
          { stepId: "step-no-rollback", kind: "apply_config_patch", target: "config", payload: {} },
        ],
        evidence: { ...basePlan.evidence, fingerprint: "sig-no-rollback" },
      },
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const results = await service.runReadyActions({
      incidentIds: ["inc-no-rollback"],
      maxRiskTier: 1,
    });

    expect(results).toHaveLength(0);
  });

  it("returns empty when no planned actions exist", async () => {
    // Execute the only eligible one first
    await service.runReadyActions({ maxRiskTier: 0 });
    const results = await service.runReadyActions({ maxRiskTier: 0 });
    expect(results).toHaveLength(0);
  });

  it("skips planned actions when adaptive risk reassessment caps auto-apply", async () => {
    for (let i = 3; i <= 10; i++) {
      incidentRepo.insert(db.writer, {
        incidentId: `inc-rj-${i}`,
        userId: "test-user",
        ts: NOW,
        category: "tool",
        severity: "medium",
        signature: "sig-abc",
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });
      actionRepo.insert(db.writer, {
        actionId: `action-rj-${i}`,
        incidentId: `inc-rj-${i}`,
        userId: "test-user",
        riskTier: 0,
        plan: basePlan,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      actionRepo.markRejected(db.writer, `action-rj-${i}`, NOW);
    }

    const results = await service.runReadyActions({ maxRiskTier: 0 });
    expect(results).toHaveLength(0);
  });

  it("runApprovedAction executes a specific action with valid approval", async () => {
    // Create an approved approval request for action-001
    approvalRepo.insert(db.writer, {
      requestId: "req-001",
      actionId: "action-001",
      userId: "test-user",
      description: "Approved",
      riskTier: 2,
      plan: basePlan,
      requestedAt: NOW,
      expiresAt: "2025-06-16T10:00:00.000Z",
      status: "approved",
      respondedAt: NOW,
      respondedBy: "test-user",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await service.runApprovedAction("action-001");
    expect(result.success).toBe(true);
    expect(result.action.status).toBe("applied");
  });

  it("runApprovedAction throws for nonexistent action", async () => {
    await expect(service.runApprovedAction("nonexistent")).rejects.toThrow(
      "not found",
    );
  });

  it("runApprovedAction throws when no approved approval exists", async () => {
    // action-001 exists but has no approval request
    await expect(service.runApprovedAction("action-001")).rejects.toThrow(
      "no approved approval request",
    );
  });

  it("runApprovedAction throws when approval is pending (not approved)", async () => {
    // Create a pending (not approved) approval request
    approvalRepo.insert(db.writer, {
      requestId: "req-001",
      actionId: "action-001",
      userId: "test-user",
      description: "Pending",
      riskTier: 2,
      plan: basePlan,
      requestedAt: NOW,
      expiresAt: "2025-06-16T10:00:00.000Z",
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(service.runApprovedAction("action-001")).rejects.toThrow(
      "no approved approval request",
    );
  });

  it("runApprovedAction throws for non-planned action", async () => {
    // Mark action as applied first
    actionRepo.markApplied(db.writer, "action-001", "success", NOW);

    await expect(service.runApprovedAction("action-001")).rejects.toThrow(
      "expected 'planned'",
    );
  });
});
