/**
 * API Entry Adapter — Initiative A.4
 *
 * Thin adapter that translates an HTTP session-run request into a
 * `FridayEngineRunInput` and maps the engine result back to the
 * API response shape.
 *
 * This adapter does NOT own execution logic — it delegates entirely
 * to the orchestration engine (or the existing facade during migration).
 */

import type { FridayAgentRunStatus } from "../../agent/model/friday-agent.types.js";
import type {
  FridayEngineRunInput,
  FridayEngineRunResult,
  FridayOrchestrationEngine,
} from "../friday-orchestration-engine.types.js";

// ─── Request / response shapes matching existing API contract ───

export interface FridayApiSessionRunRequest {
  task?: string;
  providerId?: string;
  model?: string;
  replyToMessageId?: string;
  timezone?: string;
  timeoutMs?: number;
}

export interface FridayApiSessionRunResponse {
  run: {
    runId: string;
    status: FridayAgentRunStatus;
    response: string;
    toolCallCount: number;
    durationMs: number;
    usageInput: number;
    usageOutput: number;
  };
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
  }>;
}

// ─── Adapter ───

export interface FridayApiEntryAdapterDeps {
  engine: FridayOrchestrationEngine;
  idGenerator: () => string;
}

export function createFridayApiEntryAdapter(deps: FridayApiEntryAdapterDeps) {
  const { engine, idGenerator } = deps;

  async function handleSessionRun(
    req: FridayApiSessionRunRequest,
    context: {
      sessionKey: string;
      principalId?: string;
      scopes?: string[];
    },
  ): Promise<FridayApiSessionRunResponse> {
    const task = req.task?.trim();
    if (!task) {
      return {
        run: {
          runId: "",
          status: "failed",
          response: "Task is required.",
          toolCallCount: 0,
          durationMs: 0,
          usageInput: 0,
          usageOutput: 0,
        },
        messages: [],
      };
    }

    const input: FridayEngineRunInput = {
      task,
      runId: idGenerator(),
      sessionKey: context.sessionKey,
      providerId: req.providerId,
      model: req.model,
      replyToMessageId: req.replyToMessageId,
      timezone: req.timezone,
      timeoutMs: req.timeoutMs,
      principalId: context.principalId,
      scopes: context.scopes,
      idempotencyPrefix: "api-session-run",
    };

    const result = await engine.executeRun(input);

    return toApiResponse(result);
  }

  return { handleSessionRun };
}

// ─── Response mapping ───

function toApiResponse(result: FridayEngineRunResult): FridayApiSessionRunResponse {
  // Map terminal status back to FridayAgentRunStatus for API compatibility
  const statusMap: Record<string, FridayAgentRunStatus> = {
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
    awaiting_clarification: "awaiting_clarification",
    awaiting_plan_approval: "awaiting_plan_approval",
    failed_tests: "failed_tests",
    timeout: "failed",
  };

  return {
    run: {
      runId: result.runId,
      status: statusMap[result.status] ?? "failed",
      response: result.response ?? "",
      toolCallCount: result.toolCallCount,
      durationMs: result.durationMs,
      usageInput: result.usageInput ?? 0,
      usageOutput: result.usageOutput ?? 0,
    },
    messages: result.response
      ? [{ role: "assistant" as const, content: result.response }]
      : [],
  };
}
