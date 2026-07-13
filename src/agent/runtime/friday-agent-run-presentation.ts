import type { FridayAgentRunRecord } from "../model/friday-agent.types.js";

export type FridayAgentRunHealthState =
  | "healthy"
  | "needs_approval"
  | "degraded"
  | "retryable"
  | "failed"
  | "rollback_available";

export interface FridayAgentRunHealthSnapshot {
  state: FridayAgentRunHealthState;
  rollbackAvailable: boolean;
  reasonCodes: string[];
}

export interface FridayAgentRunContextSummarySnapshot {
  taskProfileId?: string;
  taskProfileLabel?: string;
  totalEstimatedChars?: number;
  totalEstimatedInputTokens?: number;
  dominantContextKinds: string[];
  learningAdjusted: boolean;
  fallbackAttemptCount: number;
  blockedToolCount: number;
  modelSelectionSource?: string;
}

function isRetryableMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  return /\b(429|529|rate limit|rate-limited|overloaded|timeout|timed out|deadline exceeded|temporarily unavailable|econnreset|eai_again|etimedout)\b/i
    .test(message);
}

export function buildFridayAgentRunHealthSnapshot(input: {
  run: FridayAgentRunRecord;
  rollbackAvailable?: boolean;
}): FridayAgentRunHealthSnapshot {
  const rollbackAvailable = input.rollbackAvailable === true;
  const run = input.run;
  const reasonCodes: string[] = [];
  const failureText = run.errorMessage
    ?? run.errorCode
    ?? run.actualExecution?.finalFailureReason;

  if (rollbackAvailable) {
    reasonCodes.push("rollback_available");
    return {
      state: "rollback_available",
      rollbackAvailable: true,
      reasonCodes,
    };
  }

  const runStatus = String(run.status);

  if (
    runStatus === "awaiting_plan_approval"
    || runStatus === "awaiting_tool_approval"
    || runStatus === "awaiting_clarification"
  ) {
    const reasonCode =
      runStatus === "awaiting_tool_approval" ? "tool_approval_required"
      : runStatus === "awaiting_clarification" ? "clarification_required"
      : "plan_approval_required";
    reasonCodes.push(reasonCode);
    return {
      state: "needs_approval",
      rollbackAvailable: false,
      reasonCodes,
    };
  }

  if (
    run.status === "failed"
    || run.status === "failed_tests"
    || run.status === "cancelled"
  ) {
    if (isRetryableMessage(failureText)) {
      reasonCodes.push("retryable_provider_or_network_failure");
      return {
        state: "retryable",
        rollbackAvailable: false,
        reasonCodes,
      };
    }
    reasonCodes.push(run.status === "failed_tests" ? "failed_tests" : run.status);
    return {
      state: "failed",
      rollbackAvailable: false,
      reasonCodes,
    };
  }

  if (
    (run.actualExecution?.fallbackAttempts?.length ?? 0) > 0
    || (run.actualExecution?.blockedTools?.length ?? 0) > 0
    || run.actualExecution?.learningAdjusted
  ) {
    if ((run.actualExecution?.fallbackAttempts?.length ?? 0) > 0) {
      reasonCodes.push("route_fallback");
    }
    if ((run.actualExecution?.blockedTools?.length ?? 0) > 0) {
      reasonCodes.push("blocked_tools");
    }
    if (run.actualExecution?.learningAdjusted) {
      reasonCodes.push("learning_adjusted_route");
    }
    return {
      state: "degraded",
      rollbackAvailable: false,
      reasonCodes,
    };
  }

  return {
    state: "healthy",
    rollbackAvailable: false,
    reasonCodes,
  };
}

export function buildFridayAgentRunContextSummarySnapshot(
  run: FridayAgentRunRecord,
): FridayAgentRunContextSummarySnapshot {
  const dominantContextKinds = [...(run.contextCostSummary?.components ?? [])]
    .sort((left, right) => (right.estimatedChars ?? 0) - (left.estimatedChars ?? 0))
    .slice(0, 2)
    .map((component) => component.kind);

  return {
    taskProfileId: run.taskProfile?.id,
    taskProfileLabel: run.taskProfile?.label,
    totalEstimatedChars: run.contextCostSummary?.totalEstimatedChars,
    totalEstimatedInputTokens: run.contextCostSummary?.totalEstimatedInputTokens,
    dominantContextKinds,
    learningAdjusted: run.actualExecution?.learningAdjusted === true,
    fallbackAttemptCount: run.actualExecution?.fallbackAttempts?.length ?? 0,
    blockedToolCount: run.actualExecution?.blockedTools?.length ?? 0,
    modelSelectionSource: run.actualExecution?.modelSelectionSource,
  };
}
