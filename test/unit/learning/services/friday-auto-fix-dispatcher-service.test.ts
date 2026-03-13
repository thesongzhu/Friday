import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAutoFixDispatcherService } from "#learning";
import { createFridayAutoFixExecutionService } from "#learning";
import { createFridayAutoFixRollbackService } from "#learning";
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

  beforeEach(() => {
    db = createTestDb();

    actionRepo = createFridayAutoFixActionRepository();
    approvalRepo = createFridayApprovalRequestRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
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
    });

    service = createFridayAutoFixDispatcherService({
      db,
      actionRepo,
      approvalRepo,
      executionService,
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

  it("returns empty when no planned actions exist", async () => {
    // Execute the only eligible one first
    await service.runReadyActions({ maxRiskTier: 0 });
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
