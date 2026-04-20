import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowRunRepository } from "#workflows";
import type { FridayWorkflowRunEntity } from "#workflows";
import { createTestDb } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowRunRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    // Insert workflow + version for FK constraints
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
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowRunRepository();
  }

  function makeRunEntity(
    overrides: Partial<FridayWorkflowRunEntity> = {},
  ): FridayWorkflowRunEntity {
    return {
      id: "run-1",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      status: "queued",
      triggerType: "manual",
      startedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it("inserts and gets a run", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertRun(conn, makeRunEntity());
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getRunById(conn, "run-1"),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("run-1");
    expect(fetched!.status).toBe("queued");
    expect(fetched!.triggerType).toBe("manual");
  });

  it("updates run status", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertRun(conn, makeRunEntity());
      repo.updateRunStatus(conn, "run-1", "running", NOW);
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getRunById(conn, "run-1"),
    );
    expect(fetched!.status).toBe("running");
  });

  it("persists deadline/pause/resume metadata and clears stale finishedAt on resume", () => {
    const repo = createRepo();
    const deadlineAt = "2025-01-15T10:30:00.000Z";
    const pausedAt = "2025-01-15T10:02:00.000Z";
    const finishedAt = "2025-01-15T10:03:00.000Z";
    const resumedAt = "2025-01-15T10:04:00.000Z";

    db.withWriteTransaction((conn) => {
      repo.insertRun(
        conn,
        makeRunEntity({
          status: "failed",
          deadlineAt,
          finishedAt,
        }),
      );
      repo.updateRunStatus(conn, "run-1", "paused", pausedAt);
      repo.updateRunStatus(conn, "run-1", "running", resumedAt, undefined, {
        resumedAt,
        clearFinishedAt: true,
      });
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getRunById(conn, "run-1"),
    );
    expect(fetched!.status).toBe("running");
    expect(fetched!.deadlineAt).toBe(deadlineAt);
    expect(fetched!.pausedAt).toBe(pausedAt);
    expect(fetched!.resumedAt).toBe(resumedAt);
    expect(fetched!.finishedAt).toBeUndefined();
  });

  it("finalizes run with finished_at and status", () => {
    const repo = createRepo();
    const finishedAt = "2025-01-15T10:05:00.000Z";
    db.withWriteTransaction((conn) => {
      repo.insertRun(conn, makeRunEntity());
      repo.finalizeRun(conn, "run-1", "completed", finishedAt);
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getRunById(conn, "run-1"),
    );
    expect(fetched!.status).toBe("completed");
    expect(fetched!.finishedAt).toBe(finishedAt);
  });

  it("rehydrates persisted failure details when finalizing a failed run", () => {
    const repo = createRepo();
    const finishedAt = "2025-01-15T10:05:00.000Z";

    db.withWriteTransaction((conn) => {
      repo.insertRun(conn, makeRunEntity());
      repo.finalizeRun(conn, "run-1", "failed", finishedAt, {
        code: "WORKFLOW_FAILED",
        message: "Unsupported start node",
        details: { nodeId: "start", reason: "missing adapter" },
      });
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getRunById(conn, "run-1"),
    );
    expect(fetched!.status).toBe("failed");
    expect(fetched!.finishedAt).toBe(finishedAt);
    expect(fetched!.failure).toEqual({
      code: "WORKFLOW_FAILED",
      message: "Unsupported start node",
      details: { nodeId: "start", reason: "missing adapter" },
    });
  });

  it("lists active (non-terminal) runs", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertRun(conn, makeRunEntity({ id: "run-1", status: "running" }));
      repo.insertRun(conn, makeRunEntity({ id: "run-2", status: "completed" }));
      repo.insertRun(conn, makeRunEntity({ id: "run-3", status: "queued" }));
    });

    const active = db.withReadConnection((conn) => repo.listActiveRuns(conn));
    const ids = active.map((r) => r.id);
    expect(ids).toContain("run-1");
    expect(ids).toContain("run-3");
    expect(ids).not.toContain("run-2");
  });

  it("lists runs by workflow", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertRun(conn, makeRunEntity({ id: "run-1" }));
      repo.insertRun(conn, makeRunEntity({ id: "run-2" }));
    });

    const runs = db.withReadConnection((conn) =>
      repo.listRunsByWorkflow(conn, "wf-1"),
    );
    expect(runs).toHaveLength(2);
  });

  it("merges run context", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertRun(
        conn,
        makeRunEntity({ context: { a: 1 } as unknown as FridayWorkflowRunEntity["context"] }),
      );
      repo.mergeRunContext(conn, "run-1", { b: 2 }, NOW);
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getRunById(conn, "run-1"),
    );
    expect(fetched!.context).toEqual({ a: 1, b: 2 });
  });
});
