import { describe, expect, it, vi } from "vitest";

import { dispatchManagedAsync } from "../../../src/sessions/services/friday-managed-async-dispatch.js";
import type { FridayManagedAsyncDispatchDeps } from "../../../src/sessions/services/friday-managed-async-dispatch.js";
import type { FridayWorkflowExecutionService, FridayWorkflowRunEntity } from "#workflows";

function makeRun(overrides?: Partial<FridayWorkflowRunEntity>): FridayWorkflowRunEntity {
  return {
    id: "wf-run-1",
    workflowId: "wf-1",
    workflowVersionId: "wf-v-1",
    status: "running",
    triggerType: "manual",
    startedAt: "2026-03-24T10:00:00.000Z",
    createdAt: "2026-03-24T10:00:00.000Z",
    updatedAt: "2026-03-24T10:00:00.000Z",
    ...overrides,
  };
}

function createExecutionService(): FridayWorkflowExecutionService {
  return {
    setDistributedDispatcher: vi.fn(),
    startRun: vi.fn(),
    resumeRun: vi.fn(async (runId: string) => makeRun({ id: runId, status: "running" })),
    cancelRun: vi.fn(async (runId: string) => makeRun({ id: runId, status: "cancelled", finishedAt: "2026-03-24T10:05:00.000Z" })),
    retryRun: vi.fn(async (runId: string) => makeRun({ id: runId, status: "queued" })),
    getRun: vi.fn(() => null),
    listRuns: vi.fn(() => []),
    listActiveRuns: vi.fn(() => []),
    getRunNodes: vi.fn(() => []),
    recoverActiveRuns: vi.fn(async () => 0),
    reportRemoteNodeResult: vi.fn(),
    reapExpiredLeases: vi.fn(async () => 0),
    sweepTimedOutRuns: vi.fn(async () => 0),
    sweepTimedOutNodes: vi.fn(async () => 0),
  };
}

function createDeps(overrides?: Partial<FridayManagedAsyncDispatchDeps>): FridayManagedAsyncDispatchDeps {
  return {
    workflowExecutionService: createExecutionService(),
    ...overrides,
  };
}

describe("dispatchManagedAsync", () => {
  it("returns handled:false when workflow execution service is missing", async () => {
    const result = await dispatchManagedAsync(
      {
        classification: {
          category: "managed_async",
          handler: "workflow_control",
          extractedParams: { controlAction: "cancel", runId: "wf-run-1" },
        },
      },
      { workflowExecutionService: undefined },
    );

    expect(result.handled).toBe(false);
  });

  it("asks for a run id when control action omits one", async () => {
    const result = await dispatchManagedAsync(
      {
        classification: {
          category: "managed_async",
          handler: "workflow_control",
          extractedParams: { controlAction: "retry" },
        },
      },
      createDeps(),
    );

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Please specify a workflow run id");
    expect(result.response).toContain("retry");
  });

  it("cancels a workflow run through the execution service", async () => {
    const deps = createDeps();

    const result = await dispatchManagedAsync(
      {
        classification: {
          category: "managed_async",
          handler: "workflow_control",
          extractedParams: { controlAction: "cancel", runId: "wf-run-9" },
        },
      },
      deps,
    );

    expect(result.handled).toBe(true);
    expect(deps.workflowExecutionService!.cancelRun).toHaveBeenCalledWith("wf-run-9");
    expect(result.response).toContain("Workflow run wf-run-9");
    expect(result.response).toContain("cancelled");
  });

  it("retries a workflow run through the execution service", async () => {
    const deps = createDeps();

    const result = await dispatchManagedAsync(
      {
        classification: {
          category: "managed_async",
          handler: "workflow_control",
          extractedParams: { controlAction: "retry", runId: "wf-run-9" },
        },
      },
      deps,
    );

    expect(result.handled).toBe(true);
    expect(deps.workflowExecutionService!.retryRun).toHaveBeenCalledWith("wf-run-9");
    expect(result.response).toContain("Workflow run wf-run-9");
    expect(result.response).toContain("queued");
  });

  it("resumes a workflow run through the execution service", async () => {
    const deps = createDeps();

    const result = await dispatchManagedAsync(
      {
        classification: {
          category: "managed_async",
          handler: "workflow_control",
          extractedParams: { controlAction: "resume", runId: "wf-run-9" },
        },
      },
      deps,
    );

    expect(result.handled).toBe(true);
    expect(deps.workflowExecutionService!.resumeRun).toHaveBeenCalledWith("wf-run-9");
    expect(result.response).toContain("Workflow run wf-run-9");
    expect(result.response).toContain("running");
  });
});
