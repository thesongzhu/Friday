import { describe, expect, it, vi } from "vitest";
import { createFridaySatelliteLocalRunnerService } from "#satellites";
import type { FridaySatelliteSyncService } from "#satellites";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("FridaySatelliteLocalRunnerService", () => {
  it("executes leased workflow node commands, pushes node results, and acks the outbox stream", async () => {
    const push = vi.fn<FridaySatelliteSyncService["push"]>().mockResolvedValue({
      acceptedAcks: [{ streamId: "outbox:sat-1", seq: 7 }],
      acceptedNodeResults: [{ runId: "run-1", nodeId: "node-1", attemptId: "attempt-1" }],
      conflicts: [],
    });
    const sync: FridaySatelliteSyncService = {
      pull: vi.fn().mockReturnValue({
        epoch: 3,
        streamId: "outbox:sat-1",
        events: [],
        queueItems: [{
          id: "msg-1",
          seq: 7,
          messageType: "workflow.node.execute",
          payloadCiphertext: encode({
            type: "workflow.node.execute",
            runId: "run-1",
            workflowId: "wf-1",
            workflowVersionId: "ver-1",
            nodeId: "node-1",
            attemptId: "attempt-1",
            attempt: 2,
            node: { id: "node-1", type: "action" },
            inputData: { value: 1 },
          }),
        }],
        nextCursor: "cursor-1",
      }),
      push,
    };
    const runner = createFridaySatelliteLocalRunnerService({ sync });

    const result = await runner.drain({
      satelliteId: "sat-1",
      executor: async (task) => ({
        status: "completed",
        output: { received: task.inputData },
      }),
    });

    expect(result).toMatchObject({
      epoch: 3,
      streamId: "outbox:sat-1",
      executed: 1,
      acked: 1,
      failed: 0,
      conflicts: [],
      nextCursor: "cursor-1",
    });
    expect(push).toHaveBeenCalledWith({
      satelliteId: "sat-1",
      acks: [{ streamId: "outbox:sat-1", seq: 7, epoch: 3 }],
      nodeResults: [{
        runId: "run-1",
        nodeId: "node-1",
        attemptId: "attempt-1",
        attempt: 2,
        status: "completed",
        output: { received: { value: 1 } },
      }],
    });
  });

  it("keeps malformed queue items unacked so the hub can requeue or dead-letter them", async () => {
    const push = vi.fn<FridaySatelliteSyncService["push"]>();
    const sync: FridaySatelliteSyncService = {
      pull: vi.fn().mockReturnValue({
        epoch: 1,
        streamId: "outbox:sat-1",
        events: [],
        queueItems: [{
          id: "msg-1",
          seq: 4,
          messageType: "workflow.node.execute",
          payloadCiphertext: encode({ type: "workflow.node.execute", runId: "run-1" }),
        }],
      }),
      push,
    };
    const runner = createFridaySatelliteLocalRunnerService({ sync });

    const result = await runner.drain({
      satelliteId: "sat-1",
      executor: async () => ({ status: "completed" }),
    });

    expect(result).toMatchObject({ executed: 0, acked: 0, failed: 1 });
    expect(push).not.toHaveBeenCalled();
  });
});
