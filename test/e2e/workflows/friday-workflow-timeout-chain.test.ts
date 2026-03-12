/**
 * E2E: Workflow timeout job — reap expired leases, sweep timed-out runs
 * and nodes.
 *
 * Uses real DB + real workflow runtime (no HTTP). Creates workflows/runs/nodes
 * via CRUD + execution services directly, then exercises the timeout job
 * with deterministic `nowIso` to control time.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import Database from "better-sqlite3";

import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowRuntime } from "#workflows";
import type { FridayWorkflowRuntime } from "#workflows";
import { createFridayWorkflowTimeoutJob } from "#jobs";
import type { FridayWorkflowTimeoutJob } from "#jobs";

// ─── In-memory DB ───

function createTestDb(): FridaySqliteLayer {
  const db = new Database(":memory:");
  runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

  // Insert test user for FK constraints
  db.prepare(
    `INSERT OR IGNORE INTO users (id, display_name, role, is_local_only, created_at, updated_at)
     VALUES ('test-user', 'Test User', 'admin', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
  ).run();

  return {
    dbPath: ":memory:",
    writer: db,
    reads: {
      size: 1,
      withReadConnection<T>(fn: (d: Database.Database) => T): T {
        return fn(db);
      },
      close() {},
    },
    withWriteTransaction<T>(fn: (writerDb: Database.Database) => T): T {
      return db.transaction(() => fn(db))();
    },
    withReadConnection<T>(fn: (d: Database.Database) => T): T {
      return fn(db);
    },
    checkpoint() {},
    close() {
      db.close();
    },
  };
}

// ─── ID generator ───

function createIdGenerator(): () => string {
  let counter = 0;
  return () => `tid-${String(++counter).padStart(6, "0")}`;
}

// ─── Deterministic time control ───

function createTimeController(initial: string) {
  let current = initial;
  return {
    get: () => current,
    set: (iso: string) => {
      current = iso;
    },
    advance: (ms: number) => {
      current = new Date(new Date(current).getTime() + ms).toISOString();
    },
  };
}

// ─── Minimal valid graph with configurable runTimeoutMs ───

function makeGraph(opts?: { runTimeoutMs?: number; nodeTimeoutMs?: number }) {
  return {
    schemaVersion: "2.0" as const,
    workflowId: "placeholder",
    workflowVersionId: "placeholder",
    sourceSpecSchemaVersion: "1.0" as const,
    graph: {
      nodes: [
        { id: "trigger", type: "trigger" as const, label: "Trigger", config: {} },
        {
          id: "action1",
          type: "action" as const,
          label: "Action 1",
          config: { skillId: "test-skill" },
          timeoutMs: opts?.nodeTimeoutMs,
        },
      ],
      edges: [{ id: "e1", sourceNodeId: "trigger", targetNodeId: "action1" }],
      variables: opts?.runTimeoutMs !== undefined ? { runTimeoutMs: opts.runTimeoutMs } : undefined,
    },
    failurePolicy: { onFailure: "fail_fast" as const, notifyUser: false },
    tests: [],
    checksum: "test-checksum",
  };
}

// ─── Tests ───

describe("Workflow timeout job", () => {
  let sqlite: FridaySqliteLayer;
  let runtime: FridayWorkflowRuntime;
  let timeoutJob: FridayWorkflowTimeoutJob;
  let time: ReturnType<typeof createTimeController>;
  let idGen: () => string;

  beforeEach(() => {
    sqlite = createTestDb();
    idGen = createIdGenerator();
    time = createTimeController("2025-06-15T10:00:00.000Z");

    // Skill invocations never resolve (hang forever — simulates long-running node)
    runtime = createFridayWorkflowRuntime({
      db: sqlite,
      idGenerator: idGen,
      nowIso: () => time.get(),
      computeChecksum: (content: string) =>
        crypto.createHash("sha256").update(content).digest("hex"),
      resolveSkill: () => ({ id: "test-skill" }),
      invokeSkill: () => new Promise(() => {}), // never resolves
    });

    timeoutJob = createFridayWorkflowTimeoutJob({
      executionService: runtime.execution,
      nowIso: () => time.get(),
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  /** Helper: create a workflow, publish it, return IDs. */
  function createPublishedWorkflow(opts?: { runTimeoutMs?: number; nodeTimeoutMs?: number }) {
    const wf = runtime.crud.createWorkflow({
      slug: `wf-${idGen()}`,
      name: "Timeout Test Workflow",
    });

    const graph = makeGraph(opts);
    const version = runtime.crud.createVersion(wf.id, graph);
    runtime.crud.publishVersion(wf.id, version.versionNumber);

    return { workflowId: wf.id, versionId: version.id };
  }

  it("sweep_timed_out_runs_marks_failed", async () => {
    // Create workflow with a short run timeout (5 seconds)
    const { workflowId } = createPublishedWorkflow({ runTimeoutMs: 5000 });

    // Start a run at T=0
    const run = await runtime.execution.startRun({
      workflowId,
      triggerType: "manual",
      startedByUserId: "test-user",
    });

    // Wait briefly for execution to start
    await new Promise((r) => setTimeout(r, 50));

    // Advance time past the 5s timeout
    time.advance(6000);

    // Sweep should pick up the timed-out run
    const swept = await runtime.execution.sweepTimedOutRuns(time.get());
    expect(swept).toBeGreaterThanOrEqual(1);

    // The run should now be marked as failed
    const updatedRun = runtime.execution.getRun(run.id);
    expect(updatedRun).toBeTruthy();
    expect(updatedRun!.status).toBe("failed");
    expect(updatedRun!.failure?.code).toBe("WORKFLOW_RUN_TIMEOUT");
  });

  it("sweep_timed_out_nodes_marks_failed", async () => {
    // Create workflow with a short node timeout (3 seconds)
    const { workflowId } = createPublishedWorkflow({ nodeTimeoutMs: 3000 });

    // Start a run so we have valid run + workflow references
    const run = await runtime.execution.startRun({
      workflowId,
      triggerType: "manual",
      startedByUserId: "test-user",
    });

    // Wait briefly for execution to create node attempts
    await new Promise((r) => setTimeout(r, 100));

    // Instead of relying on the race between execution loop and sweep,
    // directly insert a node_attempt row with status='running' and a
    // past startedAt so the sweep deterministically finds it.
    // Use nodeId "action1" to match the graph node (which has timeoutMs: 3000).
    const nodeAttemptId = idGen();
    const pastStartedAt = new Date(
      new Date(time.get()).getTime() - 5000,
    ).toISOString(); // 5s in the past (exceeds 3s node timeout)

    // First, remove any existing node attempts for action1 that the execution
    // loop may have created to avoid UNIQUE constraint conflicts.
    sqlite.writer.prepare(
      `DELETE FROM workflow_run_nodes WHERE run_id = ? AND node_id = 'action1'`,
    ).run(run.id);

    sqlite.writer.prepare(
      `INSERT INTO workflow_run_nodes
         (id, run_id, node_id, attempt, attempt_id, status,
          started_at, created_at, updated_at, idempotency_key)
       VALUES (?, ?, 'action1', 1, ?, 'running', ?, ?, ?, ?)`,
    ).run(
      nodeAttemptId,
      run.id,
      nodeAttemptId,
      pastStartedAt,
      time.get(),
      time.get(),
      `idem-${nodeAttemptId}`,
    );

    // Sweep timed-out nodes — our injected row should be caught
    const swept = await runtime.execution.sweepTimedOutNodes(time.get());
    expect(swept).toBeGreaterThanOrEqual(1);

    // Verify the injected node attempt is now failed with NODE_TIMEOUT
    const row = sqlite.writer
      .prepare(`SELECT status, error_json FROM workflow_run_nodes WHERE id = ?`)
      .get(nodeAttemptId) as { status: string; error_json: string | null };

    expect(row.status).toBe("failed");
    expect(row.error_json).toBeTruthy();
    const error = JSON.parse(row.error_json!) as { code: string };
    expect(error.code).toBe("NODE_TIMEOUT");
  });

  it("timeout_job_reaps_expired_leases", async () => {
    // Start a run so we have valid run + workflow references
    const { workflowId } = createPublishedWorkflow();

    const run = await runtime.execution.startRun({
      workflowId,
      triggerType: "manual",
      startedByUserId: "test-user",
    });

    // Wait briefly for execution to create node attempts
    await new Promise((r) => setTimeout(r, 100));

    // Directly insert a node_attempt row with status='running' and an
    // expired lease (lease_expires_at in the past) so the reap is deterministic.
    const nodeId = `lease-node-${idGen()}`;
    const nodeAttemptId = idGen();
    const pastLeaseExpiry = new Date(
      new Date(time.get()).getTime() - 60_000,
    ).toISOString(); // expired 1 minute ago

    sqlite.writer.prepare(
      `INSERT INTO workflow_run_nodes
         (id, run_id, node_id, attempt, attempt_id, status,
          lease_owner, lease_expires_at, started_at,
          created_at, updated_at, idempotency_key)
       VALUES (?, ?, ?, 1, ?, 'running', 'hub', ?, ?, ?, ?, ?)`,
    ).run(
      nodeAttemptId,
      run.id,
      nodeId,
      nodeAttemptId,
      pastLeaseExpiry,
      time.get(),
      time.get(),
      time.get(),
      `idem-${nodeAttemptId}`,
    );

    // Run the full timeout job
    const result = await timeoutJob.run();

    // The injected expired-lease row must be reaped
    expect(typeof result.leasesReaped).toBe("number");
    expect(result.leasesReaped).toBeGreaterThanOrEqual(1);

    // Verify the node attempt is now failed with NODE_TIMEOUT
    const row = sqlite.writer
      .prepare(`SELECT status, error_json FROM workflow_run_nodes WHERE id = ?`)
      .get(nodeAttemptId) as { status: string; error_json: string | null };

    expect(row.status).toBe("failed");
    expect(row.error_json).toBeTruthy();
    const error = JSON.parse(row.error_json!) as { code: string };
    expect(error.code).toBe("NODE_TIMEOUT");
  });

  it("timeout_job_returns_aggregate_counts", async () => {
    // Create workflow with short timeout
    const { workflowId } = createPublishedWorkflow({ runTimeoutMs: 1000 });

    await runtime.execution.startRun({
      workflowId,
      triggerType: "manual",
      startedByUserId: "test-user",
    });

    // Wait briefly for execution to start
    await new Promise((r) => setTimeout(r, 50));

    // Advance time past all timeouts
    time.advance(10_000);

    const result = await timeoutJob.run();

    // Verify the result object has the expected shape with numeric counts
    expect(typeof result.leasesReaped).toBe("number");
    expect(typeof result.runsTimedOut).toBe("number");
    expect(typeof result.nodesTimedOut).toBe("number");

    // At least the run should be swept (1000ms timeout, 10s elapsed)
    expect(result.runsTimedOut).toBeGreaterThanOrEqual(1);
  });
});
