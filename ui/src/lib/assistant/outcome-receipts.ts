import type { AgentAutomationRecord, AgentRunRecord } from "@/lib/api/types";

export type FridayAssistantOutcomeNextStep =
  | "save"
  | "schedule"
  | "package"
  | "publish_later";

export interface FridayAssistantOutcomeReceipt {
  runId: string;
  task: string;
  summary: string;
  evidence: string[];
  estimatedTimeSavedMinutes: number;
  nextRecommendedAction: FridayAssistantOutcomeNextStep;
  nextReason: string;
  matchingAutomation?: AgentAutomationRecord;
}

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeAssistantTask(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, " ");
}

export function estimateAssistantOutcomeTimeSavedMinutes(run: AgentRunRecord): number {
  const durationFactor = run.durationMs ? Math.ceil(run.durationMs / 60_000) * 3 : 3;
  const toolFactor = (run.actualExecution?.turns.length ?? 0) * 2;
  const textFactor = Math.ceil((run.responseText ?? run.output ?? run.summary ?? "").length / 120);
  return clamp(durationFactor + toolFactor + textFactor + 4, 5, 120);
}

export function deriveAssistantOutcomeReceipt(input: {
  runs: AgentRunRecord[];
  automations: AgentAutomationRecord[];
  suppressedTaskKeys?: string[];
}): FridayAssistantOutcomeReceipt | null {
  const completedRuns = [...input.runs]
    .filter((run) => run.status === "completed")
    .sort((left, right) =>
      new Date(right.completedAt ?? right.startedAt).getTime() - new Date(left.completedAt ?? left.startedAt).getTime(),
    );
  const latestRun = completedRuns[0];
  if (!latestRun) {
    return null;
  }

  const taskKey = normalizeAssistantTask(latestRun.task);
  if (input.suppressedTaskKeys?.includes(taskKey)) {
    return null;
  }

  const matchingAutomation = input.automations.find((automation) =>
    automation.sourceRunId === latestRun.id
    || normalizeAssistantTask(automation.taskTemplate) === taskKey,
  );

  const similarRunCountWithin14Days = completedRuns.filter((run) => {
    if (normalizeAssistantTask(run.task) !== taskKey) {
      return false;
    }
    const latestTs = new Date(latestRun.completedAt ?? latestRun.startedAt).getTime();
    const currentTs = new Date(run.completedAt ?? run.startedAt).getTime();
    return Math.abs(latestTs - currentTs) <= FOURTEEN_DAYS_MS;
  }).length;

  let nextRecommendedAction: FridayAssistantOutcomeNextStep = "publish_later";
  let nextReason = "Keep this private for now and let Friday wait for stronger proof-of-use before pushing you to share it.";

  if (!matchingAutomation) {
    nextRecommendedAction = "save";
    nextReason = similarRunCountWithin14Days >= 2
      ? "You solved the same task twice within 14 days. Save it once so the next run is one click."
      : "You already proved this works once. Save it now so you never have to restate the task from scratch.";
  } else if (matchingAutomation.reuseCount >= 3) {
    nextRecommendedAction = "package";
    nextReason = "This automation is now reused enough to promote into a private asset that can compound into team or public distribution later.";
  } else if (!matchingAutomation.schedule && matchingAutomation.reuseCount >= 2) {
    nextRecommendedAction = "schedule";
    nextReason = "This is becoming repeat work. Add a schedule so the right thing happens without supervision.";
  }

  const estimatedTimeSavedMinutes = matchingAutomation?.estimatedTimeSavedMinutes
    ?? estimateAssistantOutcomeTimeSavedMinutes(latestRun);
  const summary = latestRun.summary
    ?? latestRun.responseText
    ?? latestRun.output
    ?? "Friday completed the latest task and can now turn it into a repeatable asset.";
  const evidence = [
    `Run status: ${latestRun.status}`,
    `Estimated time saved next time: ${estimatedTimeSavedMinutes} min`,
    latestRun.durationMs ? `Duration: ${Math.max(1, Math.round(latestRun.durationMs / 1000))}s` : null,
    latestRun.actualExecution?.turns.length
      ? `Model turns: ${latestRun.actualExecution.turns.length}`
      : null,
    matchingAutomation
      ? `Automation leverage: reuse ${matchingAutomation.reuseCount}, score ${Math.round(matchingAutomation.lastOutcomeScore)}`
      : `Similar successful runs in 14 days: ${similarRunCountWithin14Days}`,
  ].filter((line): line is string => Boolean(line));

  return {
    runId: latestRun.id,
    task: latestRun.task,
    summary,
    evidence,
    estimatedTimeSavedMinutes,
    nextRecommendedAction,
    nextReason,
    matchingAutomation,
  };
}
