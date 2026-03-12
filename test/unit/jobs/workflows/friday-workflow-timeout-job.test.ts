import { describe, it, expect, vi } from "vitest";
import { createFridayWorkflowTimeoutJob } from "#jobs";

describe("FridayWorkflowTimeoutJob", () => {
  function createMockExecutionService() {
    return {
      reapExpiredLeases: vi.fn().mockResolvedValue(3),
      sweepTimedOutRuns: vi.fn().mockResolvedValue(1),
      sweepTimedOutNodes: vi.fn().mockResolvedValue(2),
      startRun: vi.fn(),
      resumeRun: vi.fn(),
      cancelRun: vi.fn(),
      retryRun: vi.fn(),
      getRun: vi.fn(),
      listRuns: vi.fn(),
      getRunNodes: vi.fn(),
      recoverActiveRuns: vi.fn().mockResolvedValue(0),
    };
  }

  it("calls reapExpiredLeases, sweepTimedOutRuns, and sweepTimedOutNodes", async () => {
    const exec = createMockExecutionService();
    const nowIso = "2026-02-18T06:00:00.000Z";
    const job = createFridayWorkflowTimeoutJob({
      executionService: exec,
      nowIso: () => nowIso,
    });

    const result = await job.run();

    expect(exec.reapExpiredLeases).toHaveBeenCalledOnce();
    expect(exec.sweepTimedOutRuns).toHaveBeenCalledWith(nowIso);
    expect(exec.sweepTimedOutNodes).toHaveBeenCalledWith(nowIso);
    expect(result).toEqual({
      leasesReaped: 3,
      runsTimedOut: 1,
      nodesTimedOut: 2,
    });
  });

  it("returns zero counts when nothing timed out", async () => {
    const exec = createMockExecutionService();
    exec.reapExpiredLeases.mockResolvedValue(0);
    exec.sweepTimedOutRuns.mockResolvedValue(0);
    exec.sweepTimedOutNodes.mockResolvedValue(0);

    const job = createFridayWorkflowTimeoutJob({
      executionService: exec,
      nowIso: () => "2026-02-18T06:00:00.000Z",
    });

    const result = await job.run();
    expect(result).toEqual({
      leasesReaped: 0,
      runsTimedOut: 0,
      nodesTimedOut: 0,
    });
  });

  it("calls all three sweep operations sequentially", async () => {
    const exec = createMockExecutionService();
    const callOrder: string[] = [];
    exec.reapExpiredLeases.mockImplementation(async () => {
      callOrder.push("reapExpiredLeases");
      return 0;
    });
    exec.sweepTimedOutRuns.mockImplementation(async () => {
      callOrder.push("sweepTimedOutRuns");
      return 0;
    });
    exec.sweepTimedOutNodes.mockImplementation(async () => {
      callOrder.push("sweepTimedOutNodes");
      return 0;
    });

    const job = createFridayWorkflowTimeoutJob({
      executionService: exec,
      nowIso: () => "2026-02-18T06:00:00.000Z",
    });

    await job.run();

    expect(callOrder).toEqual([
      "reapExpiredLeases",
      "sweepTimedOutRuns",
      "sweepTimedOutNodes",
    ]);
  });
});
