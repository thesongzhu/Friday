import { describe, it, expect, vi } from "vitest";
import { createFridayWorkflowCronTriggerJob } from "#jobs";

describe("FridayWorkflowCronTriggerJob", () => {
  it("delegates to tickCron with nowIso and returns runs started", async () => {
    const mockTriggerService = {
      tickCron: vi.fn().mockResolvedValue(3),
    };

    const nowIso = () => "2025-06-15T12:00:00Z";

    const job = createFridayWorkflowCronTriggerJob({
      triggerService: mockTriggerService as any,
      nowIso,
    });

    const result = await job.run();

    expect(mockTriggerService.tickCron).toHaveBeenCalledWith("2025-06-15T12:00:00Z");
    expect(result.runsStarted).toBe(3);
  });

  it("returns 0 when no cron triggers fire", async () => {
    const mockTriggerService = {
      tickCron: vi.fn().mockResolvedValue(0),
    };

    const job = createFridayWorkflowCronTriggerJob({
      triggerService: mockTriggerService as any,
      nowIso: () => "2025-06-15T12:00:00Z",
    });

    const result = await job.run();
    expect(result.runsStarted).toBe(0);
  });
});
