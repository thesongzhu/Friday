import { describe, it, expect, vi } from "vitest";
import { createFridayAgentWorkflowTool } from "#agent";
import type { FridayWorkflowExecutionService, FridayWorkflowRunEntity } from "#workflows";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function makeRunEntity(
  overrides?: Partial<FridayWorkflowRunEntity>,
): FridayWorkflowRunEntity {
  return {
    id: "wf-run-1",
    workflowId: "wf-1",
    workflowVersionId: "wf-v-1",
    status: "queued",
    triggerType: "agent",
    startedAt: "2026-02-19T00:00:00.000Z",
    createdAt: "2026-02-19T00:00:00.000Z",
    updatedAt: "2026-02-19T00:00:00.000Z",
    ...overrides,
  };
}

function mockExecutionService(
  runEntity?: FridayWorkflowRunEntity,
  error?: Error,
): FridayWorkflowExecutionService {
  return {
    startRun: error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue(runEntity ?? makeRunEntity()),
    resumeRun: vi.fn(),
    cancelRun: vi.fn(),
    retryRun: vi.fn(),
    getRun: vi.fn().mockReturnValue(null),
    listRuns: vi.fn().mockReturnValue([]),
    getRunNodes: vi.fn().mockReturnValue([]),
    recoverActiveRuns: vi.fn().mockResolvedValue(0),
    reapExpiredLeases: vi.fn().mockResolvedValue(0),
    sweepTimedOutRuns: vi.fn().mockResolvedValue(0),
    sweepTimedOutNodes: vi.fn().mockResolvedValue(0),
  };
}

describe("FridayAgentWorkflowTool", () => {
  // ─── Tool definition ───

  it("has correct name and parameters", () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    expect(tool.name).toBe("workflow_run");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
  });

  // ─── Successful start ───

  it("starts a workflow and returns run info", async () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    const result = await tool.execute(
      { workflowId: "wf-1" },
      signal(),
    );

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      runId: "wf-run-1",
      status: "queued",
    });
  });

  // ─── Passes correct parameters ───

  it("passes workflowId, versionId, and input to startRun", async () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    await tool.execute(
      {
        workflowId: "wf-2",
        versionId: "v-2",
        input: { temperature: 72 },
      },
      signal(),
    );

    expect(svc.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-2",
        workflowVersionId: "v-2",
        triggerType: "agent",
        triggerPayload: { temperature: 72 },
        context: { temperature: 72 },
      }),
    );
  });

  // ─── No versionId defaults to undefined ───

  it("omits versionId when not provided", async () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    await tool.execute({ workflowId: "wf-1" }, signal());

    expect(svc.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowVersionId: undefined,
      }),
    );
  });

  // ─── Error handling ───

  it("returns error when startRun throws", async () => {
    const svc = mockExecutionService(
      undefined,
      new Error("Workflow has no published version"),
    );
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    const result = await tool.execute(
      { workflowId: "bad-wf" },
      signal(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("bad-wf");
    expect(result.content).toContain("no published version");
  });

  // ─── Missing required param ───

  it("throws on missing workflowId", async () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    await expect(
      tool.execute({ workflowId: "" }, signal()),
    ).rejects.toThrow("workflowId is required");
  });

  // ─── Non-object input is ignored ───

  it("ignores non-object input", async () => {
    const svc = mockExecutionService();
    const tool = createFridayAgentWorkflowTool({ workflowExecutionService: svc });

    await tool.execute(
      { workflowId: "wf-1", input: "not-an-object" },
      signal(),
    );

    expect(svc.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerPayload: undefined,
      }),
    );
  });
});
