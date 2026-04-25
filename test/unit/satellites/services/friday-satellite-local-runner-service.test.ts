import { describe, expect, it, vi } from "vitest";
import { createFridaySatelliteLocalRunnerService } from "#satellites";
import type { FridaySatelliteSyncService } from "#satellites";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("FridaySatelliteLocalRunnerService", () => {
  it("executes leased workflow node commands, pushes node results, and acks the outbox stream", async () => {
    const push = vi.fn<FridaySatelliteSyncService["push"]>()
      .mockResolvedValueOnce({
        acceptedAcks: [],
        acceptedNodeResults: [{ runId: "run-1", nodeId: "node-1", attemptId: "attempt-1" }],
        conflicts: [],
      })
      .mockResolvedValueOnce({
        acceptedAcks: [{ streamId: "outbox:sat-1", seq: 7 }],
        acceptedNodeResults: [],
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
    expect(push).toHaveBeenNthCalledWith(1, {
      satelliteId: "sat-1",
      acks: [],
      nodeResults: [{
        runId: "run-1",
        nodeId: "node-1",
        attemptId: "attempt-1",
        attempt: 2,
        status: "completed",
        output: { received: { value: 1 } },
      }],
    });
    expect(push).toHaveBeenNthCalledWith(2, {
      satelliteId: "sat-1",
      acks: [{ streamId: "outbox:sat-1", seq: 7, epoch: 3 }],
      nodeResults: [],
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

  it("does not ack later commands when a malformed command appears first in the leased stream", async () => {
    const push = vi.fn<FridaySatelliteSyncService["push"]>();
    const executor = vi.fn();
    const sync: FridaySatelliteSyncService = {
      pull: vi.fn().mockReturnValue({
        epoch: 1,
        streamId: "outbox:sat-1",
        events: [],
        queueItems: [
          {
            id: "bad-msg",
            seq: 4,
            messageType: "workflow.node.execute",
            payloadCiphertext: encode({ type: "workflow.node.execute", runId: "run-1" }),
          },
          {
            id: "good-msg",
            seq: 5,
            messageType: "workflow.node.execute",
            payloadCiphertext: encode({
              type: "workflow.node.execute",
              runId: "run-2",
              workflowId: "wf-2",
              workflowVersionId: "ver-2",
              nodeId: "node-2",
              attemptId: "attempt-2",
              attempt: 1,
              node: { id: "node-2", type: "action" },
            }),
          },
        ],
      }),
      push,
    };
    const runner = createFridaySatelliteLocalRunnerService({ sync });

    const result = await runner.drain({
      satelliteId: "sat-1",
      executor,
    });

    expect(result).toMatchObject({ executed: 0, acked: 0, failed: 1 });
    expect(executor).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("does not ack commands whose node result is rejected by the hub", async () => {
    const push = vi.fn<FridaySatelliteSyncService["push"]>().mockResolvedValueOnce({
      acceptedAcks: [],
      acceptedNodeResults: [],
      conflicts: [{
        streamId: "workflow:run-1",
        seq: 0,
        code: "WORKFLOW_RUN_NODE_ATTEMPT_MISMATCH",
        message: "Workflow node attempt number mismatch",
      }],
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
          }),
        }],
        nextCursor: "cursor-1",
      }),
      push,
    };
    const runner = createFridaySatelliteLocalRunnerService({ sync });

    const result = await runner.drain({
      satelliteId: "sat-1",
      executor: async () => ({ status: "completed", output: { ok: true } }),
    });

    expect(result).toMatchObject({
      executed: 1,
      acked: 0,
      failed: 0,
      conflicts: [{
        streamId: "workflow:run-1",
        seq: 0,
        code: "WORKFLOW_RUN_NODE_ATTEMPT_MISMATCH",
        message: "Workflow node attempt number mismatch",
      }],
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      satelliteId: "sat-1",
      acks: [],
      nodeResults: [expect.objectContaining({
        runId: "run-1",
        nodeId: "node-1",
        attemptId: "attempt-1",
      })],
    });
  });
});
