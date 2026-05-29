import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFridayWorkflowRuntime,
  type FridayCompiledWorkflowGraphV2,
  type FridayWorkflowRuntime,
} from "#workflows";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";

// Audit C part-2: RUN-LEVEL enforcement of workflow node completion-truth.
//
// A side-effect node lacking deterministic evidence must make the run's
// completion-verification aggregate non-`verified` (`proof_pending`) — so it
// cannot be read as a clean/verified completion. This is ORTHOGONAL to the
// evidence-persistence axis (`evidenceStatus`): a healthy-persistence run must
// stay `evidenceStatus === "available"` while reporting `proof_pending`.
// Conflating the two (the earlier overload) would falsely report a
// healthy-persistence run as "degraded" — a reverse lie. The node still runs
// (status completed); only the verified-completion truth changes. Closes the 3
// run-level bypasses (arbitrary non-empty baseline, output==null, disabled
// pipeline / legacy).

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
    failurePolicy: { onFailure: "fail_fast", notifyUser: false }, tests: [], checksum: "c-part2",
  };
}

function runtimeWith(db: FridaySqliteLayer, grants: Array<{ action: string }>, output: unknown = { ok: true }): FridayWorkflowRuntime {
  return createFridayWorkflowRuntime({
    db, idGenerator: createTestIdGenerator(), nowIso: () => NOW,
    computeChecksum: (c: string) => createHash("sha256").update(c).digest("hex"),
    resolveSkill: () => ({ id: "the-skill", manifest: { permissions: { grants } } }),
    invokeSkill: async () => output,
  });
}

async function runAndGetTruth(
  runtime: FridayWorkflowRuntime,
): Promise<{ status: string; evidenceStatus?: string; completionVerification?: string }> {
  const wf = runtime.crud.createWorkflow({ slug: `c2-${Math.random().toString(16).slice(2)}`, name: "C part2" });
  const v = runtime.crud.createVersion(wf.id, graph(wf.id));
  runtime.crud.publishVersion(wf.id, v.versionNumber);
  const run = await runtime.execution.startRun({ workflowId: wf.id, workflowVersionId: v.id, triggerType: "manual" });
  const status = await settle(runtime, run.id);
  return {
    status,
    evidenceStatus: runtime.evidence.getRunEvidenceStatus(run.id),
    completionVerification: runtime.evidence.getRunCompletionVerification(run.id),
  };
}

describe("workflow acceptance run-level enforcement (audit C part-2)", () => {
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

  it("ORTHOGONALITY: side-effect node (send grant) → completion proof_pending AND evidence available (no reverse lie)", async () => {
    const db = createTestDb();
    const r = await runAndGetTruth(runtimeWith(db, [{ action: "send" }]));
    db.close();
    expect(r.status).toBe("completed"); // node still ran — no over-blocking
    expect(r.completionVerification).toBe("proof_pending"); // not a clean/verified completion
    expect(r.evidenceStatus).toBe("available"); // persistence is HEALTHY — must NOT be downgraded
  });

  it("informational/read-only node → completion verified AND evidence available (no over-blocking)", async () => {
    const db = createTestDb();
    const r = await runAndGetTruth(runtimeWith(db, [{ action: "read" }]));
    db.close();
    expect(r.completionVerification).toBe("verified");
    expect(r.evidenceStatus).toBe("available");
  });

  it("bypass 2: side-effect node with null output cannot stay clean — still proof_pending (output never decides truth)", async () => {
    const db = createTestDb();
    const r = await runAndGetTruth(runtimeWith(db, [{ action: "write" }], null));
    db.close();
    expect(r.completionVerification).toBe("proof_pending");
    expect(r.evidenceStatus).toBe("available");
  });

  it("fail-closed: action node with empty grants (unknown capability) → proof_pending", async () => {
    const db = createTestDb();
    const r = await runAndGetTruth(runtimeWith(db, []));
    db.close();
    expect(r.completionVerification).toBe("proof_pending");
    expect(r.evidenceStatus).toBe("available");
  });

  it("bypass 3: disabled pipeline (legacy) side-effect node is NOT a verified completion → proof_pending", async () => {
    process.env.FRIDAY_PIPELINE_ENABLE = "false";
    const db = createTestDb();
    const r = await runAndGetTruth(runtimeWith(db, [{ action: "send" }]));
    db.close();
    expect(r.completionVerification).toBe("proof_pending");
    expect(r.evidenceStatus).toBe("available");
  });
});
