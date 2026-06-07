import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFridayWorkflowRuntime,
  type FridayCompiledWorkflowGraphV2,
  type FridayWorkflowRuntime,
} from "#workflows";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";

// Audit C Stage 2(B): the run-level completion-verification label is persisted
// durably (workflow_runs.completion_verification, v089), so the truth survives
// a hub restart. Stage 1 tracked it in-memory only, so a side-effect run that
// settled `proof_pending` would amnesiacally read `verified` in a fresh process
// (unknown -> verified default). This test simulates a restart by building a
// SECOND runtime on the SAME db (fresh in-memory aggregate) and asserting the
// persisted label is read back.
//
// NOTE: this proves ENFORCEMENT + PERSISTENCE only. Letting an honest
// side-effect node EARN `verified` from runtime-observed evidence is the
// separate contract-change (a) PR; here a side-effect node stays proof_pending.

const NOW = "2026-05-29T00:00:00.000Z";
const waitMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function settle(runtime: FridayWorkflowRuntime, runId: string): Promise<string> {
  for (let i = 0; i < 250; i += 1) {
    const run = runtime.execution.getRun(runId);
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) return run.status;
    await waitMs(20);
  }
  throw new Error(`run ${runId} did not settle`);
}

function graph(workflowId: string): FridayCompiledWorkflowGraphV2 {
  return {
    schemaVersion: "2.0", workflowId, workflowVersionId: "placeholder", sourceSpecSchemaVersion: "1.0",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", label: "Trigger", config: {} },
        { id: "act", type: "action", label: "Act", config: { skillId: "the-skill" } },
      ],
      edges: [{ id: "e1", sourceNodeId: "trigger", targetNodeId: "act" }],
    },
    failurePolicy: { onFailure: "fail_fast", notifyUser: false }, tests: [], checksum: "c-stage2b",
  };
}

function runtimeOn(db: FridaySqliteLayer, grants: Array<{ action: string }>): FridayWorkflowRuntime {
  return createFridayWorkflowRuntime({
    allowTestOnlyWorkflowRunExecution: true, // TS-retirement method guard: test-oracle opt-in
    db, idGenerator: createTestIdGenerator(), nowIso: () => NOW,
    computeChecksum: (c: string) => createHash("sha256").update(c).digest("hex"),
    resolveSkill: () => ({ id: "the-skill", manifest: { permissions: { grants } } }),
    invokeSkill: async () => ({ ok: true }),
  });
}

async function runOn(runtime: FridayWorkflowRuntime): Promise<string> {
  const wf = runtime.crud.createWorkflow({ slug: `c2b-${Math.random().toString(16).slice(2)}`, name: "C stage2b" });
  const v = runtime.crud.createVersion(wf.id, graph(wf.id));
  runtime.crud.publishVersion(wf.id, v.versionNumber);
  const run = await runtime.execution.startRun({ workflowId: wf.id, workflowVersionId: v.id, triggerType: "manual" });
  await settle(runtime, run.id);
  return run.id;
}

describe("workflow completion-verification persistence (audit C Stage 2(B))", () => {
  let envEnable: string | undefined;
  let envMode: string | undefined;
  beforeEach(() => {
    envEnable = process.env.FRIDAY_PIPELINE_ENABLE; envMode = process.env.FRIDAY_PIPELINE_MODE;
    process.env.FRIDAY_PIPELINE_ENABLE = "true"; process.env.FRIDAY_PIPELINE_MODE = "enforce";
  });
  afterEach(() => {
    if (envEnable === undefined) delete process.env.FRIDAY_PIPELINE_ENABLE; else process.env.FRIDAY_PIPELINE_ENABLE = envEnable;
    if (envMode === undefined) delete process.env.FRIDAY_PIPELINE_MODE; else process.env.FRIDAY_PIPELINE_MODE = envMode;
  });

  it("side-effect run: completion_verification column persists proof_pending", () => {
    const db = createTestDb();
    try {
      // synchronous DDL/DML check is done via the runtime path below; here just
      // confirm the column exists (migration applied).
      const cols = db.withReadConnection((conn) =>
        conn.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>,
      );
      expect(cols.some((c) => c.name === "completion_verification")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("RESTART: a proof_pending run is still proof_pending after a fresh runtime (no amnesia)", async () => {
    const db = createTestDb();
    try {
      const first = runtimeOn(db, [{ action: "send" }]); // side-effect → proof_pending
      const runId = await runOn(first);
      expect(first.evidence.getRunCompletionVerification(runId)).toBe("proof_pending");
      // Persisted to the column:
      const persisted = db.withReadConnection((conn) =>
        (conn.prepare("SELECT completion_verification AS c FROM workflow_runs WHERE id = ?").get(runId) as { c: string | null }).c,
      );
      expect(persisted).toBe("proof_pending");

      // Simulate a hub restart: a brand-new runtime instance on the SAME db has
      // an EMPTY in-memory aggregate. Without persistence it would read the
      // amnesiac "verified"; with v089 it reads the persisted truth.
      const afterRestart = runtimeOn(db, [{ action: "send" }]);
      expect(afterRestart.evidence.getRunCompletionVerification(runId)).toBe("proof_pending");
    } finally {
      db.close();
    }
  });

  it("RESTART: a clean verified (read-only) run reads verified after restart (NULL column → default)", async () => {
    const db = createTestDb();
    try {
      const first = runtimeOn(db, [{ action: "read" }]); // informational → verified
      const runId = await runOn(first);
      expect(first.evidence.getRunCompletionVerification(runId)).toBe("verified");
      const persisted = db.withReadConnection((conn) =>
        (conn.prepare("SELECT completion_verification AS c FROM workflow_runs WHERE id = ?").get(runId) as { c: string | null }).c,
      );
      expect(persisted).toBeNull(); // verified is never persisted (NULL default)

      const afterRestart = runtimeOn(db, [{ action: "read" }]);
      expect(afterRestart.evidence.getRunCompletionVerification(runId)).toBe("verified");
    } finally {
      db.close();
    }
  });
});
