import { describe, it, expect, vi } from "vitest";
import { createFridayHeartbeatJob } from "../../../src/heartbeat/friday-heartbeat-job.js";
import type { FridayHeartbeatRunner } from "../../../src/heartbeat/friday-heartbeat.types.js";

describe("FridayHeartbeatJob", () => {
  it("delegates to runner.runOnce()", async () => {
    const mockResult = {
      status: "ok" as const,
      actionRequired: false,
      runId: "run-1",
      responseText: "HEARTBEAT_OK",
    };
    const runner: FridayHeartbeatRunner = {
      runOnce: vi.fn().mockResolvedValue(mockResult),
    };
    const job = createFridayHeartbeatJob({ runner });

    const result = await job.run();

    expect(result).toEqual(mockResult);
    expect(runner.runOnce).toHaveBeenCalledOnce();
  });

  it("propagates runner errors", async () => {
    const runner: FridayHeartbeatRunner = {
      runOnce: vi.fn().mockRejectedValue(new Error("agent timeout")),
    };
    const job = createFridayHeartbeatJob({ runner });

    await expect(job.run()).rejects.toThrow("agent timeout");
  });

  it("returns error status from failed agent execution", async () => {
    const errorResult = {
      status: "error" as const,
      reason: "agent_failed",
      actionRequired: false,
      runId: "run-2",
      responseText: "",
    };
    const runner: FridayHeartbeatRunner = {
      runOnce: vi.fn().mockResolvedValue(errorResult),
    };
    const job = createFridayHeartbeatJob({ runner });

    const result = await job.run();

    expect(result.status).toBe("error");
    expect(result.reason).toBe("agent_failed");
  });
});
