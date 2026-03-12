import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowRunNodeRepository } from "#workflows";
import type { FridayWorkflowRunNodeEntity } from "#workflows";
import { createTestDb } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowRunNodeRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    // Insert workflow, version, and run for FK constraints
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
         VALUES ('run-1', 'wf-1', 'wv-1', 'running', 'manual', ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW);
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowRunNodeRepository();
  }

  function makeNodeEntity(
    overrides: Partial<FridayWorkflowRunNodeEntity> = {},
  ): FridayWorkflowRunNodeEntity {
    return {
      id: "na-1",
      runId: "run-1",
      nodeId: "node-A",
      attempt: 1,
      attemptId: "att-1",
      status: "queued",
      idempotencyKey: "wfrun:run-1:node:node-A:attempt:1",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it("inserts and gets a node attempt", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(conn, makeNodeEntity());
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getNodeAttemptById(conn, "na-1"),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.nodeId).toBe("node-A");
    expect(fetched!.status).toBe("queued");
  });

  it("enforces unique constraint on (run_id, node_id, attempt)", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(conn, makeNodeEntity());
    });

    expect(() =>
      db.withWriteTransaction((conn) => {
        repo.insertNodeAttempt(conn, makeNodeEntity({ id: "na-2", attemptId: "att-2" }));
      }),
    ).toThrow();
  });

  it("gets latest attempt for a node", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-1",
          attempt: 1,
          attemptId: "att-1",
          idempotencyKey: "k1",
        }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-2",
          attempt: 2,
          attemptId: "att-2",
          idempotencyKey: "k2",
        }),
      );
    });

    const latest = db.withReadConnection((conn) =>
      repo.getLatestAttempt(conn, "run-1", "node-A"),
    );
    expect(latest!.attempt).toBe(2);
  });

  it("lists attempts by node ordered by attempt ASC", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({ id: "na-1", attempt: 1, attemptId: "a1", idempotencyKey: "k1" }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({ id: "na-2", attempt: 2, attemptId: "a2", idempotencyKey: "k2" }),
      );
    });

    const attempts = db.withReadConnection((conn) =>
      repo.listAttemptsByNode(conn, "run-1", "node-A"),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.attempt).toBe(1);
    expect(attempts[1]!.attempt).toBe(2);
  });

  it("acquires lease on queued node", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(conn, makeNodeEntity());
    });

    const acquired = db.withWriteTransaction((conn) =>
      repo.acquireLease(conn, "na-1", "hub", "2025-01-15T10:05:00.000Z", NOW),
    );
    expect(acquired).toBe(true);

    const fetched = db.withReadConnection((conn) =>
      repo.getNodeAttemptById(conn, "na-1"),
    );
    expect(fetched!.status).toBe("running");
    expect(fetched!.leaseOwner).toBe("hub");
  });

  it("acquireLease fails for already-running node", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          status: "running",
          leaseOwner: "other",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
      );
    });

    const acquired = db.withWriteTransaction((conn) =>
      repo.acquireLease(conn, "na-1", "hub", "2025-01-15T10:05:00.000Z", NOW),
    );
    expect(acquired).toBe(false);
  });

  it("lists expired leases", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-1",
          status: "running",
          leaseOwner: "hub",
          leaseExpiresAt: "2025-01-15T09:00:00.000Z", // expired
        }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-2",
          nodeId: "node-B",
          attempt: 1,
          attemptId: "a2",
          status: "running",
          leaseOwner: "hub",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z", // not expired
          idempotencyKey: "k2",
        }),
      );
    });

    const expired = db.withReadConnection((conn) =>
      repo.listExpiredLeases(conn, NOW),
    );
    expect(expired).toHaveLength(1);
    expect(expired[0]!.id).toBe("na-1");
  });

  it("cancels all pending nodes for a run", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({ id: "na-1", status: "queued", idempotencyKey: "k1" }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-2",
          nodeId: "node-B",
          attempt: 1,
          attemptId: "a2",
          status: "running",
          idempotencyKey: "k2",
        }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-3",
          nodeId: "node-C",
          attempt: 1,
          attemptId: "a3",
          status: "completed",
          idempotencyKey: "k3",
        }),
      );
    });

    const count = db.withWriteTransaction((conn) =>
      repo.cancelAllPendingNodes(conn, "run-1", NOW),
    );
    // queued + running = 2 cancelled
    expect(count).toBe(2);

    // completed should remain
    const nodeC = db.withReadConnection((conn) =>
      repo.getNodeAttemptById(conn, "na-3"),
    );
    expect(nodeC!.status).toBe("completed");
  });

  it("counts by status using latest attempt per node", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-1",
          nodeId: "n1",
          attempt: 1,
          attemptId: "a1",
          status: "failed",
          idempotencyKey: "k1",
        }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-2",
          nodeId: "n1",
          attempt: 2,
          attemptId: "a2",
          status: "completed",
          idempotencyKey: "k2",
        }),
      );
      repo.insertNodeAttempt(
        conn,
        makeNodeEntity({
          id: "na-3",
          nodeId: "n2",
          attempt: 1,
          attemptId: "a3",
          status: "failed",
          idempotencyKey: "k3",
        }),
      );
    });

    const counts = db.withReadConnection((conn) =>
      repo.countByStatus(conn, "run-1"),
    );
    // Latest: n1=completed, n2=failed
    expect(counts.completed).toBe(1);
    expect(counts.failed).toBe(1);
  });
});
