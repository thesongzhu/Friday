import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFridayWorkflowRuntime,
  createFridayWorkflowTriggerRepository,
  type FridayCompiledWorkflowGraphV2,
  type FridayWorkflowRuntime,
} from "#workflows";
import { createFridaySqliteLayer, type FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunSettled(
  runtime: FridayWorkflowRuntime,
  runId: string,
): Promise<"completed" | "failed" | "cancelled"> {
  const terminal = new Set(["completed", "failed", "cancelled"] as const);
  for (let i = 0; i < 250; i += 1) {
    const run = runtime.execution.getRun(runId);
    if (run && terminal.has(run.status as "completed" | "failed" | "cancelled")) {
      return run.status as "completed" | "failed" | "cancelled";
    }
    await wait(20);
  }
  throw new Error(`Run ${runId} did not settle in time`);
}

function makeGraph(
  workflowId: string,
  versionId: string,
): FridayCompiledWorkflowGraphV2 {
  return {
    schemaVersion: "2.0",
    workflowId,
    workflowVersionId: versionId,
    sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", config: {} },
        { id: "action", type: "action", label: "Action", config: { skillId: "test-skill" } },
      ],
      edges: [{ id: "edge-1", sourceNodeId: "trigger", targetNodeId: "action" }],
    },
    failurePolicy: { onFailure: "continue", notifyUser: false },
    tests: [],
    checksum: "placeholder",
  };
}

function createRuntime(db: FridaySqliteLayer): FridayWorkflowRuntime {
  return createFridayWorkflowRuntime({
    db,
    idGenerator: createTestIdGenerator(),
    nowIso: () => "2026-02-28T12:00:00.000Z",
    computeChecksum: (content: string) => createHash("sha256").update(content).digest("hex"),
    resolveSkill: () => ({ id: "test-skill" }),
    invokeSkill: async () => ({ ok: true, data: { status: "done" } }),
    triggerRepo: createFridayWorkflowTriggerRepository({ db }),
  });
}

describe("Workflow runtime playbook persistence", () => {
  it("persists candidate evidence to sqlite and reuses it across runtime restarts", async () => {
    const db = createTestDb();
    const runtime1 = createRuntime(db);

    const workflow = runtime1.crud.createWorkflow({
      slug: "playbook-persistence-smoke",
      name: "Playbook Persistence Smoke",
    });
    const version = runtime1.crud.createVersion(workflow.id, makeGraph(workflow.id, "placeholder"));
    runtime1.crud.publishVersion(workflow.id, version.versionNumber);

    const run1 = await runtime1.execution.startRun({
      workflowId: workflow.id,
      workflowVersionId: version.id,
      triggerType: "manual",
    });
    const status1 = await waitForRunSettled(runtime1, run1.id);
    expect(status1).toBe("completed");

    const firstCandidateSnapshot = db.withReadConnection((conn) =>
      conn.prepare(
        `SELECT fingerprint, evidence_count AS evidenceCount
         FROM playbook_candidates
         WHERE workflow_type = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      ).get(workflow.slug) as { fingerprint: string; evidenceCount: number } | undefined,
    );

    expect(firstCandidateSnapshot).toBeDefined();
    expect(firstCandidateSnapshot!.evidenceCount).toBe(1);

    // Restart runtime instance while keeping the same DB.
    const runtime2 = createRuntime(db);
    const run2 = await runtime2.execution.startRun({
      workflowId: workflow.id,
      workflowVersionId: version.id,
      triggerType: "manual",
    });
    const status2 = await waitForRunSettled(runtime2, run2.id);
    expect(status2).toBe("completed");

    const afterRestartSnapshot = db.withReadConnection((conn) =>
      conn.prepare(
        `SELECT COUNT(*) AS candidateCount,
                MAX(evidence_count) AS maxEvidenceCount
         FROM playbook_candidates
         WHERE workflow_type = ?`,
      ).get(workflow.slug) as { candidateCount: number; maxEvidenceCount: number },
    );

    expect(afterRestartSnapshot.candidateCount).toBe(1);
    expect(afterRestartSnapshot.maxEvidenceCount).toBe(2);

    db.close();
  });

  it("fails fast when playbook tables are unavailable", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-playbook-runtime-"));
    const dbPath = path.join(tmpDir, "friday.db");
    const db = createFridaySqliteLayer({
      dbPath,
      readPoolSize: 1,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
      runMigrations: false,
    });

    try {
      expect(() => createRuntime(db)).toThrowError("PLAYBOOK_TABLES_NOT_AVAILABLE");
    } finally {
      db.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
