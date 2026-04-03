import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayApprovalRequestRepository } from "#learning";
import type { FridayApprovalRequestRepository } from "#learning";
import { createFridayAutoFixActionRepository } from "#learning";
import { createFridayErrorIncidentRepository } from "#learning";
import type { FridayApprovalRequestEntity, FridayAutoFixPlan } from "#learning";

describe("FridayApprovalRequestRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayApprovalRequestRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

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

  const baseRequest: FridayApprovalRequestEntity = {
    requestId: "req-001",
    actionId: "action-001",
    userId: "test-user",
    description: "Approval needed: disable skill",
    riskTier: 2,
    plan: basePlan,
    requestedAt: NOW,
    expiresAt: "2025-06-16T10:00:00.000Z",
    status: "pending",
    createdAt: NOW,
    updatedAt: NOW,
  };

  function setupActionDeps() {
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-001",
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

    const actionRepo = createFridayAutoFixActionRepository();
    actionRepo.insert(db.writer, {
      actionId: "action-001",
      incidentId: "inc-001",
      userId: "test-user",
      riskTier: 2,
      plan: basePlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayApprovalRequestRepository();
    setupActionDeps();
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and retrieves a request", () => {
    repo.insert(db.writer, baseRequest);
    const result = repo.getById(db.writer, "req-001");
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe("req-001");
    expect(result!.actionId).toBe("action-001");
    expect(result!.riskTier).toBe(2);
    expect(result!.status).toBe("pending");
    expect(result!.plan.title).toBe("Auto-fix: disable skill");
  });

  it("getByActionId returns the latest request", () => {
    repo.insert(db.writer, baseRequest);
    const result = repo.getByActionId(db.writer, "action-001");
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe("req-001");
  });

  it("listPending returns only pending requests", () => {
    repo.insert(db.writer, baseRequest);
    repo.insert(db.writer, {
      ...baseRequest,
      requestId: "req-002",
      status: "approved",
    });

    const pending = repo.listPending(db.writer);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requestId).toBe("req-001");
  });

  it("listPending filters by userId", () => {
    repo.insert(db.writer, baseRequest);
    const results = repo.listPending(db.writer, { userId: "test-user" });
    expect(results).toHaveLength(1);

    const empty = repo.listPending(db.writer, { userId: "other-user" });
    expect(empty).toHaveLength(0);
  });

  it("resolvePending approves a pending request", () => {
    repo.insert(db.writer, baseRequest);
    const result = repo.resolvePending(
      db.writer,
      "req-001",
      "approved",
      "test-user",
      "Looks good",
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("approved");
    expect(result!.responseReason).toBe("Looks good");
    expect(result!.respondedBy).toBe("test-user");
    expect(result!.respondedAt).toBe(NOW);
  });

  it("resolvePending rejects a pending request", () => {
    repo.insert(db.writer, baseRequest);
    const result = repo.resolvePending(
      db.writer,
      "req-001",
      "rejected",
      "test-user",
      "Too risky",
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("rejected");
  });

  it("resolvePending returns null for non-pending request", () => {
    repo.insert(db.writer, { ...baseRequest, status: "approved" });
    const result = repo.resolvePending(
      db.writer,
      "req-001",
      "rejected",
      "test-user",
      undefined,
      NOW,
    );
    expect(result).toBeNull();
  });

  it("expirePending expires requests past expiry time", () => {
    repo.insert(db.writer, {
      ...baseRequest,
      expiresAt: "2025-06-14T10:00:00.000Z", // Already expired
    });

    const expired = repo.expirePending(db.writer, NOW);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.status).toBe("expired");
  });

  it("expirePending batches the updated row lookup", () => {
    repo.insert(db.writer, {
      ...baseRequest,
      requestId: "req-001",
      expiresAt: "2025-06-14T10:00:00.000Z",
    });
    repo.insert(db.writer, {
      ...baseRequest,
      requestId: "req-002",
      expiresAt: "2025-06-14T11:00:00.000Z",
    });

    const listByIdsSpy = vi.spyOn(repo, "listByIds");
    const getByIdSpy = vi.spyOn(repo, "getById");

    const expired = repo.expirePending(db.writer, NOW);

    expect(listByIdsSpy).toHaveBeenCalledTimes(1);
    expect(getByIdSpy).not.toHaveBeenCalled();
    expect(expired.map((request) => request.requestId)).toEqual(["req-001", "req-002"]);
    expect(expired.every((request) => request.status === "expired")).toBe(true);
  });

  it("expirePending does not expire non-expired requests", () => {
    repo.insert(db.writer, baseRequest); // expires 2025-06-16

    const expired = repo.expirePending(db.writer, NOW);
    expect(expired).toHaveLength(0);
  });

  it("handles optional runId", () => {
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

    repo.insert(db.writer, {
      ...baseRequest,
      runId: "run-001",
    });
    const result = repo.getById(db.writer, "req-001");
    expect(result!.runId).toBe("run-001");
  });

  it("handles missing optional fields as undefined", () => {
    repo.insert(db.writer, baseRequest);
    const result = repo.getById(db.writer, "req-001");
    expect(result!.runId).toBeUndefined();
    expect(result!.responseReason).toBeUndefined();
    expect(result!.respondedAt).toBeUndefined();
    expect(result!.respondedBy).toBeUndefined();
  });
});
