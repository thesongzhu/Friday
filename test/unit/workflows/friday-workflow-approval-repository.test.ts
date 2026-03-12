import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayWorkflowApprovalRepository,
  createFridayWorkflowRepository,
  createFridayWorkflowRunRepository,
  createFridayWorkflowRunNodeRepository,
} from "#workflows";
import type { FridayWorkflowApprovalRequestEntity } from "#workflows";
import { createTestDb } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowApprovalRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";
  const LATER = "2025-01-15T11:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    // Seed workflow, version, run, run node for FK constraints
    const wfRepo = createFridayWorkflowRepository({ db });
    const runRepo = createFridayWorkflowRunRepository();
    const nodeRepo = createFridayWorkflowRunNodeRepository();
    db.withWriteTransaction((conn) => {
      wfRepo.insertWorkflow(conn, "wf-1", { slug: "test-wf", name: "Test WF" }, "etag-1", NOW);
      wfRepo.insertVersion(conn, "wv-1", "wf-1", 1, "cs1", "{}", undefined, undefined, NOW);
      runRepo.insertRun(conn, {
        id: "run-1",
        workflowId: "wf-1",
        workflowVersionId: "wv-1",
        status: "running",
        triggerType: "cron",
        startedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
      nodeRepo.insertNodeAttempt(conn, {
        id: "rn-1",
        runId: "run-1",
        nodeId: "node-approval",
        attempt: 1,
        attemptId: "rn-1",
        status: "running",
        idempotencyKey: "idem-1",
        createdAt: NOW,
        updatedAt: NOW,
      });
      nodeRepo.insertNodeAttempt(conn, {
        id: "rn-2",
        runId: "run-1",
        nodeId: "node-approval-2",
        attempt: 1,
        attemptId: "rn-2",
        status: "running",
        idempotencyKey: "idem-2",
        createdAt: NOW,
        updatedAt: NOW,
      });
      nodeRepo.insertNodeAttempt(conn, {
        id: "rn-3",
        runId: "run-1",
        nodeId: "node-approval-3",
        attempt: 1,
        attemptId: "rn-3",
        status: "running",
        idempotencyKey: "idem-3",
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowApprovalRepository({ db });
  }

  function makeApproval(
    overrides?: Partial<FridayWorkflowApprovalRequestEntity>,
  ): FridayWorkflowApprovalRequestEntity {
    return {
      id: "apr-1",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      runId: "run-1",
      runNodeAttemptId: "rn-1",
      nodeId: "node-approval",
      approverUserId: "test-user",
      approverRole: "admin",
      status: "pending",
      requestPayload: { message: "Please approve" },
      timeoutAt: "2025-01-16T10:00:00.000Z",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  // ─── insert + getById ───

  it("inserts and retrieves an approval request", () => {
    const repo = createRepo();
    repo.insert(makeApproval());

    const found = repo.getById("apr-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("apr-1");
    expect(found!.workflowId).toBe("wf-1");
    expect(found!.runId).toBe("run-1");
    expect(found!.nodeId).toBe("node-approval");
    expect(found!.approverUserId).toBe("test-user");
    expect(found!.approverRole).toBe("admin");
    expect(found!.status).toBe("pending");
    expect(found!.requestPayload).toEqual({ message: "Please approve" });
    expect(found!.timeoutAt).toBe("2025-01-16T10:00:00.000Z");
  });

  it("returns null for non-existent approval", () => {
    const repo = createRepo();
    const found = repo.getById("missing");
    expect(found).toBeNull();
  });

  // ─── getByRunNodeAttemptId ───

  it("finds approval by run node attempt id", () => {
    const repo = createRepo();
    repo.insert(makeApproval());

    const found = repo.getByRunNodeAttemptId("rn-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("apr-1");
  });

  it("returns null for unknown run node attempt id", () => {
    const repo = createRepo();
    const found = repo.getByRunNodeAttemptId("rn-999");
    expect(found).toBeNull();
  });

  // ─── Unique constraint on run_node_attempt_id ───

  it("enforces unique run_node_attempt_id", () => {
    const repo = createRepo();
    repo.insert(makeApproval());

    expect(() =>
      repo.insert(
        makeApproval({ id: "apr-dup", runNodeAttemptId: "rn-1" }),
      ),
    ).toThrow();
  });

  // ─── listPending ───

  it("lists pending approvals", () => {
    const repo = createRepo();
    repo.insert(makeApproval());
    repo.insert(
      makeApproval({
        id: "apr-2",
        runNodeAttemptId: "rn-2",
        nodeId: "node-approval-2",
        status: "pending",
      }),
    );
    repo.insert(
      makeApproval({
        id: "apr-3",
        runNodeAttemptId: "rn-3",
        nodeId: "node-approval-3",
        status: "approved",
        decidedAt: LATER,
        decidedByUserId: "test-user",
      }),
    );

    const pending = repo.listPending({});
    expect(pending).toHaveLength(2);
  });

  it("filters pending by approver user id", () => {
    const repo = createRepo();
    repo.insert(makeApproval({ approverUserId: "test-user" }));
    repo.insert(
      makeApproval({
        id: "apr-2",
        runNodeAttemptId: "rn-2",
        nodeId: "node-approval-2",
        approverUserId: undefined,
      }),
    );

    const pending = repo.listPending({ approverUserId: "test-user" });
    // Should match both: explicit user match and null (wildcard) approver
    expect(pending).toHaveLength(2);
  });

  it("respects limit on listPending", () => {
    const repo = createRepo();
    repo.insert(makeApproval());
    repo.insert(
      makeApproval({
        id: "apr-2",
        runNodeAttemptId: "rn-2",
        nodeId: "node-approval-2",
      }),
    );

    const pending = repo.listPending({ limit: 1 });
    expect(pending).toHaveLength(1);
  });

  it("paginates with cursor using created_at", () => {
    const repo = createRepo();
    const T1 = "2025-01-15T10:00:00.000Z";
    const T2 = "2025-01-15T10:05:00.000Z";
    const T3 = "2025-01-15T10:10:00.000Z";

    repo.insert(makeApproval({ id: "apr-1", runNodeAttemptId: "rn-1", createdAt: T1, updatedAt: T1 }));
    repo.insert(makeApproval({ id: "apr-2", runNodeAttemptId: "rn-2", nodeId: "node-approval-2", createdAt: T2, updatedAt: T2 }));
    repo.insert(makeApproval({ id: "apr-3", runNodeAttemptId: "rn-3", nodeId: "node-approval-3", createdAt: T3, updatedAt: T3 }));

    // First page: most recent (T3, T2)
    const page1 = repo.listPending({ limit: 2 });
    expect(page1).toHaveLength(2);
    expect(page1[0]!.id).toBe("apr-3");
    expect(page1[1]!.id).toBe("apr-2");

    // Second page: use last item's createdAt as cursor
    const cursor = page1[1]!.createdAt;
    const page2 = repo.listPending({ limit: 2, cursor });
    expect(page2).toHaveLength(1);
    expect(page2[0]!.id).toBe("apr-1");
  });

  // ─── resolvePending ───

  it("approves a pending request", () => {
    const repo = createRepo();
    repo.insert(makeApproval());

    const resolved = repo.resolvePending({
      id: "apr-1",
      status: "approved",
      decidedByUserId: "test-user",
      comment: "Looks good",
      nowIso: LATER,
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("approved");
    expect(resolved!.decidedAt).toBe(LATER);
    expect(resolved!.decidedByUserId).toBe("test-user");
    expect(resolved!.decisionComment).toBe("Looks good");
  });

  it("rejects a pending request", () => {
    const repo = createRepo();
    repo.insert(makeApproval());

    const resolved = repo.resolvePending({
      id: "apr-1",
      status: "rejected",
      decidedByUserId: "test-user",
      comment: "Not approved",
      nowIso: LATER,
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("rejected");
  });

  it("returns null when resolving non-pending request", () => {
    const repo = createRepo();
    repo.insert(
      makeApproval({
        status: "approved",
        decidedAt: NOW,
        decidedByUserId: "test-user",
      }),
    );

    const resolved = repo.resolvePending({
      id: "apr-1",
      status: "rejected",
      decidedByUserId: "test-user",
      nowIso: LATER,
    });
    expect(resolved).toBeNull();
  });

  it("returns null when resolving non-existent request", () => {
    const repo = createRepo();
    const resolved = repo.resolvePending({
      id: "apr-missing",
      status: "approved",
      decidedByUserId: "test-user",
      nowIso: LATER,
    });
    expect(resolved).toBeNull();
  });

  // ─── expirePending ───

  it("expires pending requests past timeout", () => {
    const repo = createRepo();
    repo.insert(
      makeApproval({ timeoutAt: "2025-01-15T09:00:00.000Z" }),
    );
    repo.insert(
      makeApproval({
        id: "apr-2",
        runNodeAttemptId: "rn-2",
        nodeId: "node-approval-2",
        timeoutAt: "2025-01-15T09:30:00.000Z",
      }),
    );

    const expired = repo.expirePending(NOW, 10);
    expect(expired).toHaveLength(2);
    expect(expired[0]!.status).toBe("expired");
    expect(expired[1]!.status).toBe("expired");
  });

  it("does not expire already resolved requests", () => {
    const repo = createRepo();
    repo.insert(
      makeApproval({
        status: "approved",
        timeoutAt: "2025-01-15T09:00:00.000Z",
        decidedAt: NOW,
        decidedByUserId: "test-user",
      }),
    );

    const expired = repo.expirePending(NOW, 10);
    expect(expired).toHaveLength(0);
  });

  it("does not expire requests without timeout", () => {
    const repo = createRepo();
    repo.insert(makeApproval({ timeoutAt: undefined }));

    const expired = repo.expirePending(NOW, 10);
    expect(expired).toHaveLength(0);
  });

  it("respects limit on expirePending", () => {
    const repo = createRepo();
    repo.insert(
      makeApproval({ timeoutAt: "2025-01-15T09:00:00.000Z" }),
    );
    repo.insert(
      makeApproval({
        id: "apr-2",
        runNodeAttemptId: "rn-2",
        nodeId: "node-approval-2",
        timeoutAt: "2025-01-15T09:30:00.000Z",
      }),
    );

    const expired = repo.expirePending(NOW, 1);
    expect(expired).toHaveLength(1);
  });

  it("returns empty when nothing to expire", () => {
    const repo = createRepo();
    const expired = repo.expirePending(NOW, 10);
    expect(expired).toHaveLength(0);
  });

  // ─── insert with optional fields ───

  it("handles approval without approver or timeout", () => {
    const repo = createRepo();
    repo.insert(
      makeApproval({
        approverUserId: undefined,
        approverRole: undefined,
        timeoutAt: undefined,
      }),
    );

    const found = repo.getById("apr-1");
    expect(found!.approverUserId).toBeUndefined();
    expect(found!.approverRole).toBeUndefined();
    expect(found!.timeoutAt).toBeUndefined();
  });
});
