import type {
  FridayAgentAutomationPromotionState,
  FridayAgentAutomationRecord,
} from "./friday-agent-automation-service.types.js";
import type { FridayAgentRuntimeResult } from "../runtime/friday-agent-runtime.types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function estimateAutomationTimeSavedMinutes(input: {
  taskTemplate: string;
  skillIds?: string[];
  workflowIds?: string[];
  schedule?: { type: "cron"; cron: string; timezone?: string };
  result?: FridayAgentRuntimeResult;
}): number {
  const taskLengthFactor = Math.ceil(input.taskTemplate.trim().length / 80);
  const skillFactor = input.skillIds?.length ?? 0;
  const workflowFactor = input.workflowIds?.length ?? 0;
  const scheduleFactor = input.schedule ? 4 : 0;
  const durationFactor = input.result?.durationMs
    ? Math.ceil(input.result.durationMs / 60_000) * 3
    : 0;
  const toolFactor = (input.result?.toolCallCount ?? 0) * 2;

  return clamp(
    6 + taskLengthFactor * 2 + skillFactor * 4 + workflowFactor * 5 + scheduleFactor + durationFactor + toolFactor,
    5,
    120,
  );
}

export function computeAutomationOutcomeScore(
  result: FridayAgentRuntimeResult,
): number {
  const completionScore = result.status === "completed"
    ? 55
    : result.status === "failed_tests"
      ? 30
      : result.status === "failed"
        ? 10
        : 20;
  const toolScore = clamp(result.toolCallCount * 6, 0, 18);
  const responseScore = result.response.trim().length > 0 ? 12 : 0;
  const durationScore = result.durationMs > 0
    ? clamp(Math.round(result.durationMs / 1000), 0, 10)
    : 0;

  return clamp(completionScore + toolScore + responseScore + durationScore, 0, 100);
}

export function deriveAutomationPromotionState(input: {
  reuseCount: number;
  lastOutcomeScore: number;
  current?: FridayAgentAutomationPromotionState;
}): FridayAgentAutomationPromotionState {
  if (input.current === "public") {
    return "public";
  }
  if (input.reuseCount >= 5 && input.lastOutcomeScore >= 80) {
    return "public_boost_eligible";
  }
  if (input.reuseCount >= 3 || input.current === "team" || input.current === "public_boost_eligible") {
    return "team";
  }
  return "private";
}

export function updateAutomationInsightsAfterRun(
  automation: FridayAgentAutomationRecord,
  result: FridayAgentRuntimeResult,
): Pick<
  FridayAgentAutomationRecord,
  "estimatedTimeSavedMinutes" | "reuseCount" | "promotionState" | "lastOutcomeScore"
> {
  const lastOutcomeScore = computeAutomationOutcomeScore(result);
  const reuseCount = automation.reuseCount + (result.status === "completed" ? 1 : 0);
  const estimatedTimeSavedMinutes = Math.max(
    automation.estimatedTimeSavedMinutes,
    estimateAutomationTimeSavedMinutes({
      taskTemplate: automation.taskTemplate,
      skillIds: automation.skillIds,
      workflowIds: automation.workflowIds,
      schedule: automation.schedule,
      result,
    }),
  );
  const promotionState = deriveAutomationPromotionState({
    reuseCount,
    lastOutcomeScore,
    current: automation.promotionState,
  });

  return {
    estimatedTimeSavedMinutes,
    reuseCount,
    promotionState,
    lastOutcomeScore,
  };
}
