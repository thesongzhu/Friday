import type { FridayLearningEventAppendInput } from "#ledger";

import type {
  FridayAgentRunCompletedPayload,
  FridayAgentRunFailedPayload,
} from "../model/friday-agent.types.js";
import type { FridayAgentEventEmitter, FridayAgentEventListener } from "./friday-agent-event-emitter.js";

// ─── Bridge interface ───

export interface FridayAgentLearningBridge {
  /** Subscribe to agent events and start forwarding to learning pipeline. */
  start(): void;
  /** Unsubscribe all listeners. */
  stop(): void;
}

// ─── Factory deps ───

export interface CreateFridayAgentLearningBridgeDeps {
  eventEmitter: FridayAgentEventEmitter;
  learningEventWriter: (events: FridayLearningEventAppendInput[]) => void;
  idGenerator: () => string;
  nowIso: () => string;
  /** User ID to attribute learning events to (must exist in users table). */
  defaultUserId: string;
}

// ─── Factory ───

export function createFridayAgentLearningBridge(
  deps: CreateFridayAgentLearningBridgeDeps,
): FridayAgentLearningBridge {
  const { eventEmitter, learningEventWriter, idGenerator, nowIso, defaultUserId } = deps;

  const onFailed: FridayAgentEventListener<"agent.run.failed"> = (
    payload: FridayAgentRunFailedPayload,
  ) => {
    learningEventWriter([
      {
        eventId: idGenerator(),
        ts: nowIso(),
        userId: defaultUserId,
        // Note: run_id FK references workflow_runs, not friday_agent_runs.
        // Store the agent runId in payload instead.
        kind: "error_incident",
        payload: {
          agentRunId: payload.runId,
          errorCode: payload.error.code,
          errorMessage: payload.error.message,
          durationMs: payload.durationMs,
        },
      },
    ]);
  };

  const onCompleted: FridayAgentEventListener<"agent.run.completed"> = (
    payload: FridayAgentRunCompletedPayload,
  ) => {
    learningEventWriter([
      {
        eventId: idGenerator(),
        ts: nowIso(),
        userId: defaultUserId,
        kind: "workflow_outcome",
        payload: {
          agentRunId: payload.runId,
          toolCallCount: payload.toolCallCount,
          durationMs: payload.durationMs,
          testsPassed: payload.testsPassed,
          artifactCount: payload.artifacts.length,
        },
      },
    ]);
  };

  return {
    start() {
      eventEmitter.on("agent.run.failed", onFailed);
      eventEmitter.on("agent.run.completed", onCompleted);
    },

    stop() {
      eventEmitter.off("agent.run.failed", onFailed);
      eventEmitter.off("agent.run.completed", onCompleted);
    },
  };
}
