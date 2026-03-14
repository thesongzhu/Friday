import { existsSync, readFileSync } from "node:fs";

import type {
  FridayHeartbeatAgentRuntimeLike,
  FridayHeartbeatConfig,
  FridayHeartbeatContextMessage,
  FridayHeartbeatRunner,
  FridayHeartbeatRunRecord,
  FridayHeartbeatRunResult,
  FridayHeartbeatStateRepository,
} from "./friday-heartbeat.types.js";
import { isFridayHeartbeatWithinActiveHours } from "./friday-heartbeat-active-hours.js";

const DEFAULT_HEARTBEAT_HISTORY_LIMIT = 24;

export interface CreateFridayHeartbeatRunnerDeps {
  config: FridayHeartbeatConfig;
  repository: FridayHeartbeatStateRepository;
  agentRuntime: FridayHeartbeatAgentRuntimeLike;
  nowIso: () => string;
  idGenerator: () => string;
  loadHistoryMessages?: (
    sessionKey: string,
    limit: number,
  ) => Promise<FridayHeartbeatContextMessage[]>;
  onActionRequired?: (result: FridayHeartbeatRunResult) => Promise<void> | void;
}

export function createFridayHeartbeatRunner(
  deps: CreateFridayHeartbeatRunnerDeps,
): FridayHeartbeatRunner {
  const {
    config,
    repository,
    agentRuntime,
    nowIso,
    idGenerator,
    onActionRequired,
  } = deps;

  return {
    async runOnce(): Promise<FridayHeartbeatRunResult> {
      const startedAt = nowIso();

      if (!config.enabled) {
        return finalizeSkip("disabled", startedAt);
      }

      if (!isFridayHeartbeatWithinActiveHours(startedAt, config.activeHours)) {
        return finalizeSkip("outside_active_hours", startedAt);
      }

      const state = repository.getState();
      if (state.cooldownUntil && state.cooldownUntil > startedAt) {
        return finalizeSkip("cooldown_active", startedAt);
      }

      const prompt = resolvePrompt(config);
      const historyMessages = deps.loadHistoryMessages
        ? await deps
            .loadHistoryMessages(config.sessionKey, DEFAULT_HEARTBEAT_HISTORY_LIMIT)
            .catch(() => undefined)
        : undefined;
      const execution = await agentRuntime.executeRun({
        task: prompt,
        sessionKey: config.sessionKey,
        historyMessages,
        timezone: config.timezone ?? config.activeHours?.timezone,
        timeoutMs: config.timeoutMs,
      });

      const finishedAt = nowIso();
      const runId = execution.runId;
      const responseText = execution.response ?? "";

      if (execution.status !== "completed") {
        const errorResult: FridayHeartbeatRunResult = {
          status: "error",
          reason: `agent_${execution.status}`,
          actionRequired: false,
          runId,
          responseText,
        };
        repository.appendRun(makeRecord(idGenerator(), startedAt, finishedAt, errorResult));
        repository.saveState({
          ...state,
          lastRunAt: finishedAt,
          updatedAt: finishedAt,
        });
        return errorResult;
      }

      const actionRequired = isActionRequired(responseText);
      const result: FridayHeartbeatRunResult = {
        status: "ok",
        actionRequired,
        runId,
        responseText,
      };

      repository.appendRun(makeRecord(idGenerator(), startedAt, finishedAt, result));

      const cooldownUntil =
        actionRequired && config.cooldownMs > 0
          ? new Date(new Date(finishedAt).getTime() + config.cooldownMs).toISOString()
          : null;

      repository.saveState({
        lastRunAt: finishedAt,
        lastActionAt: actionRequired ? finishedAt : state.lastActionAt,
        cooldownUntil,
        updatedAt: finishedAt,
      });

      if (actionRequired && onActionRequired) {
        await onActionRequired(result);
      }

      return result;
    },
  };

  function finalizeSkip(reason: string, startedAt: string): FridayHeartbeatRunResult {
    const finishedAt = nowIso();
    const result: FridayHeartbeatRunResult = {
      status: "skipped",
      reason,
      actionRequired: false,
    };
    repository.appendRun(makeRecord(idGenerator(), startedAt, finishedAt, result));
    const state = repository.getState();
    repository.saveState({
      ...state,
      lastRunAt: finishedAt,
      updatedAt: finishedAt,
    });
    return result;
  }
}

function resolvePrompt(config: FridayHeartbeatConfig): string {
  const defaultPrompt = config.fallbackPrompt.trim();
  if (!config.promptPath) {
    return defaultPrompt;
  }
  if (!existsSync(config.promptPath)) {
    return defaultPrompt;
  }
  try {
    const filePrompt = readFileSync(config.promptPath, "utf-8").trim();
    return filePrompt.length > 0 ? filePrompt : defaultPrompt;
  } catch {
    return defaultPrompt;
  }
}

function isActionRequired(response: string): boolean {
  const trimmed = response.trim();
  if (trimmed.length === 0) return false;
  return !/\bHEARTBEAT_OK\b/i.test(trimmed);
}

function makeRecord(
  id: string,
  startedAt: string,
  finishedAt: string,
  result: FridayHeartbeatRunResult,
): FridayHeartbeatRunRecord {
  return {
    id,
    startedAt,
    finishedAt,
    status: result.status,
    reason: result.reason,
    actionRequired: result.actionRequired,
    runId: result.runId,
    responseText: result.responseText,
  };
}
