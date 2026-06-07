import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import {
  createFridayWorkflowRuntime,
  createFridayWorkflowTriggerRepository,
} from "#workflows";
import type { FridayWorkflowRuntime, FridayCompiledWorkflowGraphV2 } from "#workflows";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

/**
 * Waits for a run to reach a stable status (not queued/running).
 */
async function waitForRunStable(
  runtime: FridayWorkflowRuntime,
  runId: string,
  timeoutMs = 5000,
): Promise<string> {
  const start = Date.now();
  const transient = new Set(["queued", "running"]);
  while (Date.now() - start < timeoutMs) {
    const run = runtime.execution.getRun(runId);
    if (run && !transient.has(run.status)) return run.status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const run = runtime.execution.getRun(runId);
  return run?.status ?? "unknown";
}

describe("Workflow Approval Chain (Integration)", () => {
  let db: FridaySqliteLayer;
  let runtime: FridayWorkflowRuntime;
  let invokeSkill: ReturnType<typeof vi.fn>;
  const NOW = "2026-02-18T10:00:00.000Z";

  function makeApprovalGraph(
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
          {
            id: "approval1",
            type: "approval",
            label: "Approval Gate",
            config: {
              approverRole: "admin",
              message: "Please approve",
              timeoutMs: 3_600_000,
            },
          },
          {
            id: "action1",
            type: "action",
            label: "Post-Approval Action",
            config: { skillId: "test-skill" },
          },
        ],
        edges: [
          { id: "e1", sourceNodeId: "trigger", targetNodeId: "approval1" },
          { id: "e2", sourceNodeId: "approval1", targetNodeId: "action1" },
        ],
      },
      failurePolicy: { onFailure: "fail_fast", notifyUser: false },
      tests: [],
      checksum: "placeholder",
    };
  }

  beforeEach(() => {
    db = createTestDb();
    invokeSkill = vi.fn().mockResolvedValue({ result: "ok" });

    runtime = createFridayWorkflowRuntime({
      allowTestOnlyWorkflowRunExecution: true, // TS-retirement method guard: test-oracle opt-in
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      computeChecksum: (content: string) =>
        createHash("sha256").update(content).digest("hex"),
      resolveSkill: () => ({ id: "test-skill" }),
      invokeSkill,
      triggerRepo: createFridayWorkflowTriggerRepository({ db }),
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    db.close();
  });

  function createAndPublishApprovalWorkflow(): {
    workflowId: string;
    versionId: string;
  } {
    const wf = runtime.crud.createWorkflow({
      slug: "approval-wf",
      name: "Approval WF",
    });
    const version = runtime.crud.createVersion(
      wf.id,
      makeApprovalGraph(wf.id, "placeholder"),
    );
    runtime.crud.publishVersion(wf.id, version.versionNumber);
    return { workflowId: wf.id, versionId: version.id };
  }

  // ─── Run pauses at approval node ───

  it("run pauses when reaching an approval node", async () => {
    const { workflowId, versionId } = createAndPublishApprovalWorkflow();

    const run = await runtime.execution.startRun({
      workflowId,
      workflowVersionId: versionId,
      triggerType: "manual",
    });

    const status = await waitForRunStable(runtime, run.id);
    // The run should be in a paused/waiting state, not completed
    expect(["waiting_for_approval", "paused", "blocked", "pause_for_approval"]).toContain(status);
  });

  // ─── Approval request created ───

  it("creates an approval request when run pauses", async () => {
    const { workflowId, versionId } = createAndPublishApprovalWorkflow();

    const run = await runtime.execution.startRun({
      workflowId,
      workflowVersionId: versionId,
      triggerType: "manual",
    });

    await waitForRunStable(runtime, run.id);

    const pending = runtime.approval.listPending({});
    expect(pending.length).toBeGreaterThanOrEqual(1);

    const approval = pending.find((a) => a.runId === run.id);
    expect(approval).toBeDefined();
    expect(approval!.nodeId).toBe("approval1");
    expect(approval!.status).toBe("pending");
  });

  // ─── Approve → run resumes and completes ───

  it("approving resumes the run to completion", async () => {
    const { workflowId, versionId } = createAndPublishApprovalWorkflow();

    const run = await runtime.execution.startRun({
      workflowId,
      workflowVersionId: versionId,
      triggerType: "manual",
    });

    await waitForRunStable(runtime, run.id);

    const pending = runtime.approval.listPending({});
    const approval = pending.find((a) => a.runId === run.id);
    expect(approval).toBeDefined();

    const result = await runtime.approval.approve({
      approvalId: approval!.id,
      decidedByUserId: "test-user",
      comment: "Looks good",
    });

    expect(result.approval.status).toBe("approved");
    expect(result.resumed).toBe(true);

    // Wait for post-approval execution
    await waitForRunStable(runtime, run.id);

    const finalRun = runtime.execution.getRun(run.id);
    expect(finalRun!.status).toBe("completed");
    expect(invokeSkill).toHaveBeenCalled();
  });

  // ─── Reject → run fails ───

  it("rejecting causes the run to fail", async () => {
    const { workflowId, versionId } = createAndPublishApprovalWorkflow();

    const run = await runtime.execution.startRun({
      workflowId,
      workflowVersionId: versionId,
      triggerType: "manual",
    });

    await waitForRunStable(runtime, run.id);

    const pending = runtime.approval.listPending({});
    const approval = pending.find((a) => a.runId === run.id);
    expect(approval).toBeDefined();

    const result = await runtime.approval.reject({
      approvalId: approval!.id,
      decidedByUserId: "test-user",
      comment: "Not approved",
    });

    expect(result.approval.status).toBe("rejected");

    // Wait for post-rejection execution
    await waitForRunStable(runtime, run.id);

    const finalRun = runtime.execution.getRun(run.id);
    expect(["failed", "cancelled"]).toContain(finalRun!.status);
    expect(invokeSkill).not.toHaveBeenCalled();
  });
});
