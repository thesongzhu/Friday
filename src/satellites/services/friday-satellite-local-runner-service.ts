import type { FridaySatelliteSyncService, FridaySyncNodeResultInput } from "./friday-satellite-sync-service.js";

export interface FridaySatelliteWorkflowNodeTask {
  type: "workflow.node.execute";
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  attemptId: string;
  attempt: number;
  node: unknown;
  inputData?: unknown;
  expressionContext?: unknown;
  requestedAt?: string;
}

export type FridaySatelliteLocalNodeExecutor = (
  task: FridaySatelliteWorkflowNodeTask,
) => Promise<
  | { status: "completed"; output?: unknown }
  | {
    status: "failed";
    output?: unknown;
    error: { code: string; message: string; retryable: boolean; details?: unknown };
  }
>;

export interface FridaySatelliteLocalRunnerDrainInput {
  satelliteId: string;
  executor: FridaySatelliteLocalNodeExecutor;
  streamId?: string;
  lastAckedSeq?: number;
  resumeCursor?: string;
  maxItems?: number;
}

export interface FridaySatelliteLocalRunnerDrainResult {
  epoch: number;
  streamId: string;
  executed: number;
  acked: number;
  failed: number;
  conflicts: Array<{ streamId: string; seq: number; code: string; message: string }>;
  nextCursor?: string;
  fullPullRequired?: boolean;
}

export interface FridaySatelliteLocalRunnerService {
  drain(input: FridaySatelliteLocalRunnerDrainInput): Promise<FridaySatelliteLocalRunnerDrainResult>;
}

export interface CreateFridaySatelliteLocalRunnerServiceDeps {
  sync: FridaySatelliteSyncService;
}

function decodeWorkflowTask(payloadCiphertext: string): FridaySatelliteWorkflowNodeTask {
  const raw = Buffer.from(payloadCiphertext, "base64").toString("utf8");
  const payload = JSON.parse(raw) as Partial<FridaySatelliteWorkflowNodeTask>;
  if (
    payload.type !== "workflow.node.execute"
    || typeof payload.runId !== "string"
    || typeof payload.workflowId !== "string"
    || typeof payload.workflowVersionId !== "string"
    || typeof payload.nodeId !== "string"
    || typeof payload.attemptId !== "string"
    || typeof payload.attempt !== "number"
  ) {
    throw new Error("Invalid workflow.node.execute payload");
  }
  return payload as FridaySatelliteWorkflowNodeTask;
}

function executionErrorToNodeResult(
  task: FridaySatelliteWorkflowNodeTask,
  error: unknown,
): FridaySyncNodeResultInput {
  return {
    runId: task.runId,
    nodeId: task.nodeId,
    attemptId: task.attemptId,
    attempt: task.attempt,
    status: "failed",
    error: {
      code: "SATELLITE_EXECUTOR_ERROR",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    },
  };
}

export function createFridaySatelliteLocalRunnerService(
  deps: CreateFridaySatelliteLocalRunnerServiceDeps,
): FridaySatelliteLocalRunnerService {
  return {
    async drain(input) {
      const streamId = input.streamId ?? `outbox:${input.satelliteId}`;
      const pull = deps.sync.pull({
        satelliteId: input.satelliteId,
        streamId,
        lastAckedSeq: input.lastAckedSeq ?? 0,
        subscriptions: ["workflow.node.execute"],
        resumeCursor: input.resumeCursor,
      });

      if (pull.fullPullRequired || pull.queueItems.length === 0) {
        return {
          epoch: pull.epoch,
          streamId: pull.streamId,
          executed: 0,
          acked: 0,
          failed: 0,
          conflicts: [],
          nextCursor: pull.nextCursor,
          fullPullRequired: pull.fullPullRequired,
        };
      }

      const queueItems = pull.queueItems.slice(0, input.maxItems ?? pull.queueItems.length);
      const nodeResults: FridaySyncNodeResultInput[] = [];
      let failed = 0;
      let lastAckSeq = 0;

      for (const item of queueItems) {
        if (item.messageType !== "workflow.node.execute") {
          lastAckSeq = item.seq;
          continue;
        }

        try {
          const task = decodeWorkflowTask(item.payloadCiphertext);
          const result = await input.executor(task);
          nodeResults.push({
            runId: task.runId,
            nodeId: task.nodeId,
            attemptId: task.attemptId,
            attempt: task.attempt,
            status: result.status,
            output: result.output,
            ...(result.status === "failed" ? { error: result.error } : {}),
          });
          lastAckSeq = item.seq;
        } catch (error) {
          failed += 1;
          try {
            const task = decodeWorkflowTask(item.payloadCiphertext);
            nodeResults.push(executionErrorToNodeResult(task, error));
            lastAckSeq = item.seq;
          } catch {
            // Malformed queue payloads remain leased until expiry so the hub can requeue or dead-letter them.
          }
        }
      }

      if (lastAckSeq === 0 && nodeResults.length === 0) {
        return {
          epoch: pull.epoch,
          streamId: pull.streamId,
          executed: 0,
          acked: 0,
          failed,
          conflicts: [],
          nextCursor: pull.nextCursor,
        };
      }

      const push = await deps.sync.push({
        satelliteId: input.satelliteId,
        acks: [{ streamId: pull.streamId, seq: lastAckSeq, epoch: pull.epoch }],
        nodeResults,
      });

      return {
        epoch: pull.epoch,
        streamId: pull.streamId,
        executed: nodeResults.length,
        acked: push.acceptedAcks.length,
        failed,
        conflicts: push.conflicts,
        nextCursor: pull.nextCursor,
      };
    },
  };
}
