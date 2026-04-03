import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayApprovalWorkflowService } from "#learning";
import { createFridayApprovalRequestRepository } from "#learning";
import { createFridayAutoFixActionRepository } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import type { FridayApprovalWorkflowService } from "#learning";
import type { FridayAutoFixActionEntity, FridayAutoFixPlan } from "#learning";

describe("FridayApprovalWorkflowService", () => {
  let db: FridaySqliteLayer;
  let service: FridayApprovalWorkflowService;
  let idGen: () => string;
  let actionRepo: ReturnType<typeof createFridayAutoFixActionRepository>;
  const NOW = "2025-06-15T10:00:00.000Z";
  const EXPIRES = "2025-06-16T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
    title: "Auto-fix: disable skill",
    summary: "Disable the broken skill",
    steps: [
      {
        stepId: "step-001",
        kind: "disable_skill",
        target: "skill-x",
        payload: {},
      },
    ],
    evidence: {
      fingerprint: "sig-abc",
      matchedLessonIds: [],
      diagnosisId: "diag-001",
      recurrenceCount: 1,
    },
  };

  const baseAction: FridayAutoFixActionEntity = {
    actionId: "action-001",
    incidentId: "inc-001",
    userId: "test-user",
    riskTier: 2,
    plan: basePlan,
    status: "planned",
    outcome: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  function insertIncident(incidentId: string) {
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId,
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "high",
      signature: "sig-abc",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    // Setup FK deps
    insertIncident("inc-001");

    actionRepo = createFridayAutoFixActionRepository();
    actionRepo.insert(db.writer, baseAction);

    const approvalRepo = createFridayApprovalRequestRepository();
    service = createFridayApprovalWorkflowService({
      db,
      approvalRepo,
      actionRepo,
      idGenerator: idGen,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("creates an approval request for a Tier 2 action", () => {
    const request = service.createRequestForAction({
      action: baseAction,
      description: "Please approve skill disable",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    expect(request.requestId).toBeTruthy();
    expect(request.actionId).toBe("action-001");
    expect(request.riskTier).toBe(2);
    expect(request.status).toBe("pending");
    expect(request.expiresAt).toBe(EXPIRES);
  });

  it("approves a pending request", () => {
    const request = service.createRequestForAction({
      action: baseAction,
      description: "Approve",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    const approved = service.approve({
      requestId: request.requestId,
      respondedBy: "test-user",
      reason: "Looks safe",
      nowIso: NOW,
    });

    expect(approved.status).toBe("approved");
    expect(approved.responseReason).toBe("Looks safe");
    expect(approved.respondedBy).toBe("test-user");
  });

  it("rejects a pending request and marks action rejected", () => {
    const request = service.createRequestForAction({
      action: baseAction,
      description: "Approve",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    const rejected = service.reject({
      requestId: request.requestId,
      respondedBy: "test-user",
      reason: "Too risky",
      nowIso: NOW,
    });

    expect(rejected.status).toBe("rejected");

    // Verify linked action is rejected
    const actionRepo = createFridayAutoFixActionRepository();
    const action = actionRepo.getById(db.writer, "action-001");
    expect(action!.status).toBe("rejected");
  });

  it("throws when approving a non-pending request", () => {
    const request = service.createRequestForAction({
      action: baseAction,
      description: "Approve",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    service.approve({
      requestId: request.requestId,
      respondedBy: "test-user",
      nowIso: NOW,
    });

    // Second approve should throw
    expect(() =>
      service.approve({
        requestId: request.requestId,
        respondedBy: "test-user",
        nowIso: NOW,
      }),
    ).toThrow("not found or not pending");
  });

  it("expires pending requests and marks linked actions rejected", () => {
    service.createRequestForAction({
      action: baseAction,
      description: "Approve",
      nowIso: NOW,
      expiresAt: "2025-06-14T10:00:00.000Z", // Already expired
    });

    const expired = service.expirePending({ nowIso: NOW });
    expect(expired).toHaveLength(1);
    expect(expired[0]!.status).toBe("expired");

    // Verify linked action is rejected
    const actionRepo = createFridayAutoFixActionRepository();
    const action = actionRepo.getById(db.writer, "action-001");
    expect(action!.status).toBe("rejected");
  });

  it("expirePending rejects linked actions in one batch", () => {
    const markRejectedByIdsSpy = vi.spyOn(actionRepo, "markRejectedByIds");
    const markRejectedSpy = vi.spyOn(actionRepo, "markRejected");

    service.createRequestForAction({
      action: baseAction,
      description: "Approve",
      nowIso: NOW,
      expiresAt: "2025-06-14T10:00:00.000Z",
    });

    insertIncident("inc-002");
    actionRepo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
    });
    service.createRequestForAction({
      action: {
        ...baseAction,
        actionId: "action-002",
        incidentId: "inc-002",
      },
      description: "Approve second",
      nowIso: NOW,
      expiresAt: "2025-06-14T10:00:00.000Z",
    });

    const expired = service.expirePending({ nowIso: NOW });

    expect(expired).toHaveLength(2);
    expect(markRejectedByIdsSpy).toHaveBeenCalledTimes(1);
    expect(markRejectedByIdsSpy).toHaveBeenCalledWith(
      expect.anything(),
      ["action-001", "action-002"],
      NOW,
    );
    expect(markRejectedSpy).not.toHaveBeenCalled();
  });

  it("expirePending does not affect future requests", () => {
    service.createRequestForAction({
      action: baseAction,
      description: "Approve",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    const expired = service.expirePending({ nowIso: NOW });
    expect(expired).toHaveLength(0);
  });

  it("creates request with optional runId", () => {
    // Insert FK chain for workflow_runs
    db.writer
      .prepare(
        `INSERT INTO workflows (id, slug, name, latest_version_number, is_archived, revision, etag, created_at, updated_at)
         VALUES ('wf-1', 'test-wf', 'Test', 1, 0, 1, 'etag', ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json, is_published, created_at, updated_at)
         VALUES ('wv-1', 'wf-1', 1, 'cs', '{}', 1, ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version_id, status, trigger_type, started_at, created_at, updated_at)
         VALUES ('run-001', 'wf-1', 'wv-1', 'running', 'manual', ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW);

    const request = service.createRequestForAction({
      action: baseAction,
      runId: "run-001",
      description: "Approve",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    expect(request.runId).toBe("run-001");
  });
});
