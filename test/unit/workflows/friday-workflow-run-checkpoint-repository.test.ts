import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayWorkflowRunCheckpointRepository,
  createFridayWorkflowRepository,
  createFridayWorkflowRunRepository,
} from "#workflows";
import type { FridayWorkflowRunCheckpointEntity } from "#workflows";
import { createTestDb } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowRunCheckpointRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";
  const LATER = "2025-01-15T11:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    // Seed workflow, version, and a run for FK constraints
    const wfRepo = createFridayWorkflowRepository({ db });
    const runRepo = createFridayWorkflowRunRepository();
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
      runRepo.insertRun(conn, {
        id: "run-2",
        workflowId: "wf-1",
        workflowVersionId: "wv-1",
        status: "running",
        triggerType: "cron",
        startedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
      runRepo.insertRun(conn, {
        id: "run-3",
        workflowId: "wf-1",
        workflowVersionId: "wv-1",
        status: "completed",
        triggerType: "cron",
        startedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowRunCheckpointRepository({ db });
  }

  function makeCheckpoint(
    overrides?: Partial<FridayWorkflowRunCheckpointEntity>,
  ): FridayWorkflowRunCheckpointEntity {
    return {
      runId: "run-1",
      checkpointSeq: 1,
      runStatus: "running",
      activeNodeIds: ["node-a"],
      completedNodeIds: ["node-b"],
      failedNodeIds: [],
      waitingApprovalNodeIds: [],
      context: { key: "value" },
      lastNodeId: "node-a",
      updatedAt: NOW,
      ...overrides,
    };
  }

  // ─── upsert + get ───

  it("inserts and retrieves a checkpoint", () => {
    const repo = createRepo();
    repo.upsert(makeCheckpoint());

    const cp = repo.get("run-1");
    expect(cp).not.toBeNull();
    expect(cp!.runId).toBe("run-1");
    expect(cp!.checkpointSeq).toBe(1);
    expect(cp!.runStatus).toBe("running");
    expect(cp!.activeNodeIds).toEqual(["node-a"]);
    expect(cp!.completedNodeIds).toEqual(["node-b"]);
    expect(cp!.failedNodeIds).toEqual([]);
    expect(cp!.waitingApprovalNodeIds).toEqual([]);
    expect(cp!.context).toEqual({ key: "value" });
    expect(cp!.lastNodeId).toBe("node-a");
  });

  it("updates checkpoint on conflict (same run_id)", () => {
    const repo = createRepo();
    repo.upsert(makeCheckpoint());

    repo.upsert(
      makeCheckpoint({
        checkpointSeq: 2,
        runStatus: "paused",
        activeNodeIds: [],
        waitingApprovalNodeIds: ["node-c"],
        context: { key: "updated" },
        lastNodeId: "node-c",
        updatedAt: LATER,
      }),
    );

    const cp = repo.get("run-1");
    expect(cp!.checkpointSeq).toBe(2);
    expect(cp!.runStatus).toBe("paused");
    expect(cp!.waitingApprovalNodeIds).toEqual(["node-c"]);
    expect(cp!.context).toEqual({ key: "updated" });
  });

  it("returns null for non-existent run", () => {
    const repo = createRepo();
    const cp = repo.get("run-999");
    expect(cp).toBeNull();
  });

  // ─── delete ───

  it("deletes checkpoint", () => {
    const repo = createRepo();
    repo.upsert(makeCheckpoint());

    repo.delete("run-1");

    const cp = repo.get("run-1");
    expect(cp).toBeNull();
  });

  it("delete is idempotent for non-existent run", () => {
    const repo = createRepo();
    // Should not throw
    repo.delete("run-999");
  });

  // ─── listRecoverableRuns ───

  it("lists runs in pending/running/paused status", () => {
    const repo = createRepo();
    repo.upsert(
      makeCheckpoint({ runId: "run-1", runStatus: "running", updatedAt: NOW }),
    );
    repo.upsert(
      makeCheckpoint({ runId: "run-2", runStatus: "paused", updatedAt: LATER }),
    );
    repo.upsert(
      makeCheckpoint({ runId: "run-3", runStatus: "completed", updatedAt: NOW }),
    );

    const recoverable = repo.listRecoverableRuns(10);
    expect(recoverable).toHaveLength(2);
    // Ordered by updated_at ASC
    expect(recoverable[0]!.runId).toBe("run-1");
    expect(recoverable[1]!.runId).toBe("run-2");
  });

  it("respects limit on recoverable runs", () => {
    const repo = createRepo();
    repo.upsert(
      makeCheckpoint({ runId: "run-1", runStatus: "running" }),
    );
    repo.upsert(
      makeCheckpoint({ runId: "run-2", runStatus: "pending" }),
    );

    const recoverable = repo.listRecoverableRuns(1);
    expect(recoverable).toHaveLength(1);
  });

  it("returns empty when no recoverable runs exist", () => {
    const repo = createRepo();
    repo.upsert(
      makeCheckpoint({ runId: "run-3", runStatus: "completed" }),
    );

    const recoverable = repo.listRecoverableRuns(10);
    expect(recoverable).toHaveLength(0);
  });

  // ─── Edge case: empty arrays and context ───

  it("handles empty arrays and empty context", () => {
    const repo = createRepo();
    repo.upsert(
      makeCheckpoint({
        activeNodeIds: [],
        completedNodeIds: [],
        failedNodeIds: [],
        waitingApprovalNodeIds: [],
        context: {},
        lastNodeId: undefined,
      }),
    );

    const cp = repo.get("run-1");
    expect(cp!.activeNodeIds).toEqual([]);
    expect(cp!.context).toEqual({});
    expect(cp!.lastNodeId).toBeUndefined();
  });
});
