import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayAutoFixActionRepository,
  createFridayAutoFixRollbackService,
  createFridayDiagnosisRecordRepository,
  createFridayErrorIncidentRepository,
  type FridayAutoFixActionEntity,
  type FridayAutoFixPlan,
} from "#learning";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("FridayAutoFixRollbackService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";

  const planWithRollback: FridayAutoFixPlan = {
    title: "Disable broken skill",
    summary: "Disable skill-x",
    steps: [
      {
        stepId: "step-001",
        kind: "disable_skill",
        target: "skill-x",
        payload: {},
        verify: { method: "error_absent", timeoutMs: 5000 },
      },
    ],
    rollbackPlan: {
      summary: "Re-enable skill-x",
      steps: [
        {
          stepId: "rb-step-001",
          kind: "disable_skill",
          target: "skill-x",
          payload: { revert: true },
          verify: { method: "error_absent", timeoutMs: 5000 },
        },
      ],
    },
    evidence: {
      fingerprint: "sig-rb",
      matchedLessonIds: [],
      diagnosisId: "diag-rb-001",
      recurrenceCount: 1,
    },
  };

  function seedAppliedAction(
    overrides: Partial<FridayAutoFixActionEntity> = {},
  ): ReturnType<typeof createFridayAutoFixActionRepository> {
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const actionRepo = createFridayAutoFixActionRepository();

    incidentRepo.insert(db.writer, {
      incidentId: "inc-rb-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "high",
      signature: "sig-rb",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    diagnosisRepo.insert(db.writer, {
      id: "diag-rb-001",
      incidentId: "inc-rb-001",
      errorFingerprint: "sig-rb",
      confidence: 0.9,
      diagnosis: { summary: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    actionRepo.insert(db.writer, {
      actionId: "action-rb-001",
      incidentId: "inc-rb-001",
      userId: "test-user",
      riskTier: 1,
      plan: planWithRollback,
      rollbackPlan: planWithRollback.rollbackPlan,
      status: "applied",
      outcome: "success",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    });

    return actionRepo;
  }

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("fails explicitly when no rollback plan exists", async () => {
    const actionRepo = seedAppliedAction({
      actionId: "action-rb-no-plan",
      plan: { ...planWithRollback, rollbackPlan: undefined },
      rollbackPlan: undefined,
    });

    const service = createFridayAutoFixRollbackService({
      db,
      actionRepo,
      nowIso: () => NOW,
    });

    const result = await service.rollback("action-rb-no-plan", "verification failed");

    expect(result.success).toBe(false);
    expect(result.rollbackSucceeded).toBe(false);
    expect(result.errorMessage).toContain("no rollback plan available");
    expect(
      db.withReadConnection((rdb) => actionRepo.getById(rdb, "action-rb-no-plan"))?.status,
    ).toBe("applied");
  });

  it("fails closed when no hub executor backs a rollback step", async () => {
    const actionRepo = seedAppliedAction();

    const service = createFridayAutoFixRollbackService({
      db,
      actionRepo,
      nowIso: () => NOW,
      stepExecutors: {},
    });

    const result = await service.rollback("action-rb-001", "verification failed");

    expect(result.success).toBe(false);
    expect(result.rollbackSucceeded).toBe(false);
    expect(result.errorMessage).toContain("has no executor");
    expect(
      db.withReadConnection((rdb) => actionRepo.getById(rdb, "action-rb-001"))?.status,
    ).toBe("applied");
  });

  it("fails closed when an explicit override removes the executor", async () => {
    const actionRepo = seedAppliedAction();

    const service = createFridayAutoFixRollbackService({
      db,
      actionRepo,
      nowIso: () => NOW,
      stepExecutors: {
        disable_skill: undefined,
      },
    });

    const result = await service.rollback("action-rb-001", "verification failed");

    expect(result.success).toBe(false);
    expect(result.rollbackSucceeded).toBe(false);
    expect(result.errorMessage).toContain("has no executor");
    expect(
      db.withReadConnection((rdb) => actionRepo.getById(rdb, "action-rb-001"))?.status,
    ).toBe("applied");
  });

  it("marks the action rolled_back only when rollback executes and verifies", async () => {
    const actionRepo = seedAppliedAction();

    const service = createFridayAutoFixRollbackService({
      db,
      actionRepo,
      nowIso: () => NOW,
      stepExecutors: {
        disable_skill: async () => true,
      },
      stepVerifiers: {
        disable_skill: async () => true,
      },
    });

    const result = await service.rollback("action-rb-001", "verification failed");

    expect(result.rollbackSucceeded).toBe(true);
    expect(result.action.status).toBe("rolled_back");
    expect(
      db.withReadConnection((rdb) => actionRepo.getById(rdb, "action-rb-001"))?.status,
    ).toBe("rolled_back");
  });

  it("leaves the action applied when rollback verification fails", async () => {
    const actionRepo = seedAppliedAction();

    const service = createFridayAutoFixRollbackService({
      db,
      actionRepo,
      nowIso: () => NOW,
      stepExecutors: {
        disable_skill: async () => true,
      },
      stepVerifiers: {
        disable_skill: async () => false,
      },
    });

    const result = await service.rollback("action-rb-001", "verification failed");

    expect(result.success).toBe(false);
    expect(result.rollbackSucceeded).toBe(false);
    expect(result.errorMessage).toContain("failed verification");
    expect(
      db.withReadConnection((rdb) => actionRepo.getById(rdb, "action-rb-001"))?.status,
    ).toBe("applied");
  });
});
