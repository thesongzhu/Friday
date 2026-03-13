import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAutoFixExecutionService } from "#learning";
import { createFridayAutoFixRollbackService } from "#learning";
import { createFridayAutoFixActionRepository } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import { createFridayDiagnosisRecordRepository } from "#learning";
import type { FridayAutoFixExecutionService } from "#learning";
import type { FridayAutoFixActionEntity, FridayAutoFixPlan } from "#learning";
import type { FridayAutoFixActionRepository } from "#learning";

describe("FridayAutoFixExecutionService", () => {
  let db: FridaySqliteLayer;
  let service: FridayAutoFixExecutionService;
  const NOW = "2025-06-15T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
    title: "Auto-fix: retry node",
    summary: "Retry the failed operation",
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

  function setupDeps() {
    const incidentRepo = createFridayErrorIncidentRepository();
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

    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    diagnosisRepo.insert(db.writer, {
      id: "diag-001",
      incidentId: "inc-001",
      errorFingerprint: "sig-abc",
      confidence: 0.8,
      diagnosis: { summary: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const actionRepo = createFridayAutoFixActionRepository();
    return { incidentRepo, diagnosisRepo, actionRepo };
  }

  beforeEach(() => {
    db = createTestDb();
    const { incidentRepo, diagnosisRepo, actionRepo } = setupDeps();
    const rollbackService = createFridayAutoFixRollbackService({
      db,
      actionRepo,
      nowIso: () => NOW,
    });
    service = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      rollbackService,
      nowIso: () => NOW,
    });

    // Insert a planned action
    const action: FridayAutoFixActionEntity = {
      actionId: "action-001",
      incidentId: "inc-001",
      userId: "test-user",
      riskTier: 0,
      plan: basePlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    actionRepo.insert(db.writer, action);
  });

  afterEach(() => {
    db.close();
  });

  it("executes a Tier 0 action successfully", async () => {
    const result = await service.execute("action-001");
    expect(result.success).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.action.status).toBe("applied");
    expect(result.action.outcome).toBe("success");
    expect(result.rollbackAttempted).toBe(false);
  });

  it("honors injected executors and verifiers for supported kinds", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    actionRepo.insert(db.writer, {
      actionId: "action-disable-001",
      incidentId: "inc-001",
      userId: "test-user",
      riskTier: 0,
      plan: {
        title: "Disable skill",
        summary: "Disable skill-x",
        steps: [
          {
            stepId: "step-disable-001",
            kind: "disable_skill",
            target: "skill-x",
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
      },
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const executed: string[] = [];
    const verified: string[] = [];
    const overrideService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo: createFridayErrorIncidentRepository(),
      diagnosisRepo: createFridayDiagnosisRecordRepository(),
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo,
        nowIso: () => NOW,
      }),
      nowIso: () => NOW,
      stepExecutors: {
        disable_skill: async (step) => {
          executed.push(step.stepId);
          return true;
        },
      },
      stepVerifiers: {
        disable_skill: async (step) => {
          verified.push(step.stepId);
          return true;
        },
      },
    });

    const result = await overrideService.execute("action-disable-001");

    expect(result.success).toBe(true);
    expect(executed).toEqual(["step-disable-001"]);
    expect(verified).toEqual(["step-disable-001"]);
  });

  it("fails closed when an injected executor rejects a step kind", async () => {
    const failClosedService = createFridayAutoFixExecutionService({
      db,
      actionRepo: createFridayAutoFixActionRepository(),
      incidentRepo: createFridayErrorIncidentRepository(),
      diagnosisRepo: createFridayDiagnosisRecordRepository(),
      rollbackService: createFridayAutoFixRollbackService({
        db,
        actionRepo: createFridayAutoFixActionRepository(),
        nowIso: () => NOW,
      }),
      nowIso: () => NOW,
      stepExecutors: {
        retry_node: async () => false,
      },
    });

    const result = await failClosedService.execute("action-001");

    expect(result.success).toBe(false);
    expect(result.rollbackAttempted).toBe(false);
    expect(result.action.status).toBe("applied");
    expect(result.action.outcome).toBe("failed");
    expect(result.errorMessage).toContain("failed during execution");
  });

  it("marks incident as mitigated on success", async () => {
    await service.execute("action-001");

    const incidentRepo = createFridayErrorIncidentRepository();
    const incidents = incidentRepo.listByUser(db.writer, {
      userId: "test-user",
      status: "mitigated",
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.incidentId).toBe("inc-001");
  });

  it("marks diagnosis as resolved on success", async () => {
    await service.execute("action-001");

    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const records = diagnosisRepo.listByFingerprint(db.writer, "sig-abc");
    expect(records[0]!.resolvedAt).toBe(NOW);
  });

  it("throws for nonexistent action", async () => {
    await expect(service.execute("nonexistent")).rejects.toThrow(
      "Action nonexistent not found",
    );
  });

  it("throws for non-planned action", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    actionRepo.markApplied(db.writer, "action-001", "success", NOW);

    await expect(service.execute("action-001")).rejects.toThrow(
      "expected 'planned'",
    );
  });

  it("rejects Tier 1 action without rollback plan", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-002",
      userId: "test-user",
      ts: NOW,
      category: "config",
      severity: "medium",
      signature: "sig-cfg",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const tier1Plan: FridayAutoFixPlan = {
      ...basePlan,
      steps: [
        {
          stepId: "step-002",
          kind: "apply_config_patch",
          target: "config",
          payload: {},
        },
      ],
    };

    actionRepo.insert(db.writer, {
      actionId: "action-002",
      incidentId: "inc-002",
      userId: "test-user",
      riskTier: 1,
      plan: tier1Plan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await service.execute("action-002");
    expect(result.success).toBe(false);
    expect(result.action.status).toBe("rejected");
    expect(result.errorMessage).toContain("rollback plan");
  });

  describe("verification-fail → rollback path", () => {
    it("triggers rollback when verification fails and rollback plan exists", async () => {
      const actionRepo = createFridayAutoFixActionRepository();
      const incidentRepo = createFridayErrorIncidentRepository();
      const diagnosisRepo = createFridayDiagnosisRecordRepository();

      incidentRepo.insert(db.writer, {
        incidentId: "inc-vfail",
        userId: "test-user",
        ts: NOW,
        category: "tool",
        severity: "medium",
        signature: "sig-vfail",
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });

      diagnosisRepo.insert(db.writer, {
        id: "diag-vfail",
        incidentId: "inc-vfail",
        errorFingerprint: "sig-vfail",
        confidence: 0.8,
        diagnosis: { summary: "test" },
        createdAt: NOW,
        updatedAt: NOW,
      });

      const planWithRollback: FridayAutoFixPlan = {
        title: "Auto-fix: config patch",
        summary: "Apply patch",
        steps: [
          {
            stepId: "step-vfail",
            kind: "apply_config_patch",
            target: "config",
            payload: {},
            verify: { method: "config_reload_valid", timeoutMs: 5000 },
          },
        ],
        rollbackPlan: {
          summary: "Revert config patch",
          steps: [
            {
              stepId: "rb-step-001",
              kind: "apply_config_patch",
              target: "config",
              payload: { revert: true },
            },
          ],
        },
        evidence: {
          fingerprint: "sig-vfail",
          matchedLessonIds: [],
          diagnosisId: "diag-vfail",
          recurrenceCount: 1,
        },
      };

      actionRepo.insert(db.writer, {
        actionId: "action-vfail",
        incidentId: "inc-vfail",
        userId: "test-user",
        riskTier: 1,
        plan: planWithRollback,
        rollbackPlan: planWithRollback.rollbackPlan,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Create service with a verifier that FAILS for apply_config_patch
      const failService = createFridayAutoFixExecutionService({
        db,
        actionRepo,
        incidentRepo,
        diagnosisRepo,
        rollbackService: createFridayAutoFixRollbackService({
          db,
          actionRepo,
          nowIso: () => NOW,
          stepExecutors: {
            apply_config_patch: async () => true,
          },
        }),
        nowIso: () => NOW,
        stepVerifiers: {
          apply_config_patch: () => false, // Verification fails
        },
      });

      const result = await failService.execute("action-vfail");

      expect(result.success).toBe(false);
      expect(result.verificationPassed).toBe(false);
      expect(result.rollbackAttempted).toBe(true);
      expect(result.rollbackSucceeded).toBe(true);
      expect(result.action.status).toBe("rolled_back");
    });

    it("marks failed when verification fails and no rollback plan", async () => {
      const actionRepo = createFridayAutoFixActionRepository();
      const incidentRepo = createFridayErrorIncidentRepository();
      const diagnosisRepo = createFridayDiagnosisRecordRepository();

      incidentRepo.insert(db.writer, {
        incidentId: "inc-vfail2",
        userId: "test-user",
        ts: NOW,
        category: "tool",
        severity: "medium",
        signature: "sig-vfail2",
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });

      diagnosisRepo.insert(db.writer, {
        id: "diag-vfail2",
        incidentId: "inc-vfail2",
        errorFingerprint: "sig-vfail2",
        confidence: 0.8,
        diagnosis: { summary: "test" },
        createdAt: NOW,
        updatedAt: NOW,
      });

      const planNoRollback: FridayAutoFixPlan = {
        title: "Auto-fix: retry",
        summary: "Retry",
        steps: [
          {
            stepId: "step-vfail2",
            kind: "retry_node",
            target: "tool",
            payload: {},
            verify: { method: "error_absent", timeoutMs: 5000 },
          },
        ],
        evidence: {
          fingerprint: "sig-vfail2",
          matchedLessonIds: [],
          diagnosisId: "diag-vfail2",
          recurrenceCount: 1,
        },
      };

      actionRepo.insert(db.writer, {
        actionId: "action-vfail2",
        incidentId: "inc-vfail2",
        userId: "test-user",
        riskTier: 0,
        plan: planNoRollback,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      // Create service with a verifier that FAILS for retry_node
      const failService = createFridayAutoFixExecutionService({
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
        stepVerifiers: {
          retry_node: () => false, // Verification fails
        },
      });

      const result = await failService.execute("action-vfail2");

      expect(result.success).toBe(false);
      expect(result.verificationPassed).toBe(false);
      expect(result.rollbackAttempted).toBe(false);
      expect(result.rollbackSucceeded).toBe(false);
      expect(result.action.status).toBe("applied");
      expect(result.action.outcome).toBe("failed");
      expect(result.errorMessage).toContain("failed verification");
    });
  });
});
