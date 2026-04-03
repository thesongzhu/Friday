import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayAutoFixActionRepository } from "#learning";
import type { FridayAutoFixActionRepository } from "#learning";
import type { FridayAutoFixActionEntity, FridayAutoFixPlan } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import type { FridayErrorIncidentEntity } from "#learning";

describe("FridayAutoFixActionRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayAutoFixActionRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
    title: "Auto-fix: retry node",
    summary: "Retry the failed tool operation",
    steps: [
      {
        stepId: "step-001",
        kind: "retry_node",
        target: "tool",
        payload: { fix: "retry" },
        verify: { method: "error_absent", timeoutMs: 5000 },
      },
    ],
    evidence: {
      fingerprint: "sig-abc",
      matchedLessonIds: ["lesson-001"],
      diagnosisId: "diag-001",
      recurrenceCount: 3,
    },
  };

  const baseAction: FridayAutoFixActionEntity = {
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

  function insertIncident(incidentId: string) {
    const incidentRepo = createFridayErrorIncidentRepository();
    const incident: FridayErrorIncidentEntity = {
      incidentId,
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "medium",
      signature: "sig-abc",
      context: {},
      autoFixEligible: false,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    };
    incidentRepo.insert(db.writer, incident);
  }

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayAutoFixActionRepository();
    insertIncident("inc-001");
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and retrieves an action", () => {
    repo.insert(db.writer, baseAction);
    const result = repo.getById(db.writer, "action-001");
    expect(result).not.toBeNull();
    expect(result!.actionId).toBe("action-001");
    expect(result!.plan.title).toBe("Auto-fix: retry node");
    expect(result!.riskTier).toBe(0);
    expect(result!.status).toBe("planned");
    expect(result!.outcome).toBeNull();
  });

  it("getById returns null for missing action", () => {
    const result = repo.getById(db.writer, "nonexistent");
    expect(result).toBeNull();
  });

  it("listPlanned returns only planned actions", () => {
    repo.insert(db.writer, baseAction);
    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
      status: "applied",
    });

    const planned = repo.listPlanned(db.writer);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.actionId).toBe("action-001");
  });

  it("listPlanned filters by maxRiskTier", () => {
    repo.insert(db.writer, baseAction);
    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
      riskTier: 2,
    });

    const tier01 = repo.listPlanned(db.writer, { maxRiskTier: 1 });
    expect(tier01).toHaveLength(1);
    expect(tier01[0]!.actionId).toBe("action-001");

    const tier2 = repo.listPlanned(db.writer, { maxRiskTier: 2 });
    expect(tier2).toHaveLength(2);
  });

  it("listPlanned filters by incidentIds", () => {
    repo.insert(db.writer, baseAction);
    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
    });

    const filtered = repo.listPlanned(db.writer, {
      incidentIds: ["inc-001"],
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.incidentId).toBe("inc-001");
  });

  it("markApplied transitions planned to applied", () => {
    repo.insert(db.writer, baseAction);
    const result = repo.markApplied(db.writer, "action-001", "success", NOW);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("applied");
    expect(result!.outcome).toBe("success");
    expect(result!.appliedAt).toBe(NOW);
  });

  it("markApplied returns null for non-planned action", () => {
    repo.insert(db.writer, { ...baseAction, status: "applied" });
    const result = repo.markApplied(db.writer, "action-001", "success", NOW);
    expect(result).toBeNull();
  });

  it("markRolledBack transitions to rolled_back", () => {
    repo.insert(db.writer, baseAction);
    const result = repo.markRolledBack(db.writer, "action-001", NOW);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("rolled_back");
    expect(result!.outcome).toBe("failed");
    expect(result!.rolledBackAt).toBe(NOW);
  });

  it("markRejected transitions planned to rejected", () => {
    repo.insert(db.writer, baseAction);
    const result = repo.markRejected(db.writer, "action-001", NOW);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("rejected");
  });

  it("markRejectedByIds updates planned actions in one batch and skips non-planned rows", () => {
    repo.insert(db.writer, baseAction);
    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
    });
    insertIncident("inc-003");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-003",
      incidentId: "inc-003",
      status: "applied",
      outcome: "success",
      appliedAt: NOW,
    });

    const updatedIds = repo.markRejectedByIds(
      db.writer,
      ["action-002", "missing", "action-001", "action-003", "action-002"],
      NOW,
    );

    expect(updatedIds).toEqual(["action-002", "action-001"]);
    expect(repo.getById(db.writer, "action-001")?.status).toBe("rejected");
    expect(repo.getById(db.writer, "action-002")?.status).toBe("rejected");
    expect(repo.getById(db.writer, "action-003")?.status).toBe("applied");
  });

  it("setRollbackPlan updates the rollback plan", () => {
    repo.insert(db.writer, baseAction);
    const rollbackPlan = {
      summary: "Revert changes",
      steps: [{ stepId: "rb-001", kind: "retry_node" as const, target: "tool", payload: {} }],
    };
    const result = repo.setRollbackPlan(db.writer, "action-001", rollbackPlan, NOW);
    expect(result).not.toBeNull();
    expect(result!.rollbackPlan).toEqual(rollbackPlan);
  });

  it("countByDay counts applied and rolled back actions", () => {
    repo.insert(db.writer, baseAction);
    repo.markApplied(db.writer, "action-001", "success", NOW);

    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
    });
    repo.markRolledBack(db.writer, "action-002", NOW);

    const counts = repo.countByDay(db.writer, "2025-06-15");
    expect(counts.applied).toBe(1);
    expect(counts.rolledBack).toBe(1);
    expect(counts.total).toBe(2);
  });

  it("handles rollbackPlan JSON serialization", () => {
    const actionWithRollback: FridayAutoFixActionEntity = {
      ...baseAction,
      rollbackPlan: {
        summary: "Revert",
        steps: [{ stepId: "rb-001", kind: "retry_node", target: "tool", payload: {} }],
      },
    };
    repo.insert(db.writer, actionWithRollback);
    const result = repo.getById(db.writer, "action-001");
    expect(result!.rollbackPlan).toEqual(actionWithRollback.rollbackPlan);
  });

  it("summarizeByFingerprint aggregates recent action outcomes without materializing rows", () => {
    repo.insert(db.writer, baseAction);
    repo.markApplied(db.writer, "action-001", "success", NOW);

    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
      status: "planned",
      createdAt: "2025-06-15T09:00:00.000Z",
      updatedAt: "2025-06-15T09:00:00.000Z",
    });
    repo.markRolledBack(db.writer, "action-002", "2025-06-15T09:30:00.000Z");

    insertIncident("inc-003");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-003",
      incidentId: "inc-003",
      status: "rejected",
      createdAt: "2025-06-15T08:00:00.000Z",
      updatedAt: "2025-06-15T08:00:00.000Z",
    });

    const summary = repo.summarizeByFingerprint(db.writer, {
      userId: "test-user",
      fingerprint: "sig-abc",
      limit: 10,
    });

    expect(summary).toEqual({
      sampleCount: 3,
      successCount: 1,
      rollbackCount: 1,
      rejectedCount: 1,
      executedCount: 2,
    });
  });

  it("listRejectedByUser returns only rejected actions in reverse chronology", () => {
    repo.insert(db.writer, baseAction);
    repo.markRejected(db.writer, "action-001", NOW);

    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
      status: "planned",
      createdAt: "2025-06-15T09:00:00.000Z",
      updatedAt: "2025-06-15T09:00:00.000Z",
    });

    insertIncident("inc-003");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-003",
      incidentId: "inc-003",
      status: "rejected",
      createdAt: "2025-06-15T11:00:00.000Z",
      updatedAt: "2025-06-15T11:00:00.000Z",
    });

    const rejected = repo.listRejectedByUser(db.writer, {
      userId: "test-user",
      limit: 10,
    });

    expect(rejected.map((action) => action.actionId)).toEqual([
      "action-003",
      "action-001",
    ]);
  });

  it("summarizeRecentHotspots aggregates rollback and rejection hotspots", () => {
    repo.insert(db.writer, baseAction);
    repo.markRejected(db.writer, "action-001", NOW);

    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
      createdAt: "2025-06-15T09:00:00.000Z",
      updatedAt: "2025-06-15T09:00:00.000Z",
      plan: {
        ...basePlan,
        evidence: {
          ...basePlan.evidence,
          fingerprint: "sig-beta",
        },
      },
    });
    repo.markRolledBack(db.writer, "action-002", "2025-06-15T09:30:00.000Z");

    insertIncident("inc-003");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-003",
      incidentId: "inc-003",
      createdAt: "2025-06-15T08:00:00.000Z",
      updatedAt: "2025-06-15T08:00:00.000Z",
      plan: {
        ...basePlan,
        evidence: {
          ...basePlan.evidence,
          fingerprint: "sig-beta",
        },
      },
    });

    const hotspots = repo.summarizeRecentHotspots(db.writer, {
      userId: "test-user",
      recentLimit: 10,
      hotspotLimit: 10,
    });

    expect(hotspots).toEqual([
      {
        fingerprint: "sig-abc",
        rolledBackCount: 0,
        appliedCount: 0,
        rejectedCount: 1,
        totalCount: 1,
        lastSeenAt: NOW,
      },
      {
        fingerprint: "sig-beta",
        rolledBackCount: 1,
        appliedCount: 0,
        rejectedCount: 0,
        totalCount: 2,
        lastSeenAt: "2025-06-15T09:30:00.000Z",
      },
    ]);
  });
});
