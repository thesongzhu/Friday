import type { FridaySqliteLayer } from "#state";
import type { FridayAgentRunStatus } from "#agent";

export type FridayHeartbeatRunStatus = "ok" | "skipped" | "error";

export interface FridayHeartbeatActiveHours {
  enabled: boolean;
  startHour: number;
  endHour: number;
  timezone?: string;
}

export interface FridayHeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  cooldownMs: number;
  activeHours?: FridayHeartbeatActiveHours;
  promptPath?: string;
  fallbackPrompt: string;
  sessionKey: string;
  timezone?: string;
  timeoutMs?: number;
}

export interface FridayHeartbeatRunRecord {
  id: string;
  startedAt: string;
  finishedAt: string;
  status: FridayHeartbeatRunStatus;
  reason?: string;
  actionRequired: boolean;
  runId?: string;
  responseText?: string;
}

export interface FridayHeartbeatState {
  lastRunAt: string | null;
  lastActionAt: string | null;
  cooldownUntil: string | null;
  updatedAt: string;
}

export interface FridayHeartbeatRunResult {
  status: FridayHeartbeatRunStatus;
  reason?: string;
  actionRequired: boolean;
  runId?: string;
  responseText?: string;
}

export interface FridayHeartbeatContextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface FridayHeartbeatStateRepository {
  getState(): FridayHeartbeatState;
  saveState(state: FridayHeartbeatState): void;
  appendRun(record: FridayHeartbeatRunRecord): void;
  listRuns(limit?: number): FridayHeartbeatRunRecord[];
}

export interface FridayHeartbeatAgentRuntimeLike {
  executeRun(input: {
    task: string;
    sessionKey?: string;
    historyMessages?: FridayHeartbeatContextMessage[];
    timezone?: string;
    timeoutMs?: number;
  }): Promise<{ runId: string; status: FridayAgentRunStatus; response?: string }>;
}

export interface FridayHeartbeatRunner {
  runOnce(): Promise<FridayHeartbeatRunResult>;
}

export interface CreateFridayHeartbeatStateRepositoryDeps {
  db: FridaySqliteLayer;
  nowIso: () => string;
}
