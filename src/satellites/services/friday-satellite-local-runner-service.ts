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

function nodeResultKey(result: Pick<FridaySyncNodeResultInput, "runId" | "nodeId" | "attemptId">): string {
  return `${result.runId}\u0000${result.nodeId}\u0000${result.attemptId}`;
}

export function createFridaySatelliteLocalRunnerService(
  deps: CreateFridaySatelliteLocalRunnerServiceDeps,
): FridaySatelliteLocalRunnerService {
  return {
    async drain(input) {
      const streamId = input.streamId ?? `outbox:${input.satelliteId}`;
      const maxItems =
        typeof input.maxItems === "number" && Number.isInteger(input.maxItems) && input.maxItems > 0
          ? input.maxItems
          : undefined;
      const pull = deps.sync.pull({
        satelliteId: input.satelliteId,
        streamId,
        lastAckedSeq: input.lastAckedSeq ?? 0,
        subscriptions: ["workflow.node.execute"],
        resumeCursor: input.resumeCursor,
        limit: maxItems,
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

      const queueItems = pull.queueItems;
      const nodeResults: FridaySyncNodeResultInput[] = [];
      const processed: Array<{ seq: number; result: FridaySyncNodeResultInput }> = [];
      let failed = 0;

      for (const item of queueItems) {
        if (item.messageType !== "workflow.node.execute") {
          failed += 1;
          break;
        }

        let task: FridaySatelliteWorkflowNodeTask | undefined;
        try {
          task = decodeWorkflowTask(item.payloadCiphertext);
          const result = await input.executor(task);
          const nodeResult: FridaySyncNodeResultInput = {
            runId: task.runId,
            nodeId: task.nodeId,
            attemptId: task.attemptId,
            attempt: task.attempt,
            status: result.status,
            output: result.output,
            ...(result.status === "failed" ? { error: result.error } : {}),
          };
          if (result.status === "failed") {
            failed += 1;
          }
          nodeResults.push(nodeResult);
          processed.push({ seq: item.seq, result: nodeResult });
        } catch (error) {
          failed += 1;
          if (task === undefined) {
            // Malformed queue payloads remain leased until expiry so the hub can requeue or dead-letter them.
            break;
          }
          const nodeResult = executionErrorToNodeResult(task, error);
          nodeResults.push(nodeResult);
          processed.push({ seq: item.seq, result: nodeResult });
        }
      }

      if (nodeResults.length === 0) {
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

      const resultPush = await deps.sync.push({
        satelliteId: input.satelliteId,
        acks: [],
        nodeResults,
      });
      const acceptedKeys = new Set(resultPush.acceptedNodeResults.map(nodeResultKey));
      let lastAckSeq = 0;
      for (const item of processed) {
        if (!acceptedKeys.has(nodeResultKey(item.result))) {
          break;
        }
        lastAckSeq = item.seq;
      }

      let acked = 0;
      const conflicts = [...resultPush.conflicts];
      if (lastAckSeq > 0) {
        const ackPush = await deps.sync.push({
          satelliteId: input.satelliteId,
          acks: [{ streamId: pull.streamId, seq: lastAckSeq, epoch: pull.epoch }],
          nodeResults: [],
        });
        acked = ackPush.acceptedAcks.length;
        conflicts.push(...ackPush.conflicts);
      }

      return {
        epoch: pull.epoch,
        streamId: pull.streamId,
        executed: nodeResults.length,
        acked,
        failed,
        conflicts,
        nextCursor: pull.nextCursor,
      };
    },
  };
}
