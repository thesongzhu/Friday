import type Database from "better-sqlite3";

import type { FridaySqliteLayer } from "#state";

import type { FridayAgentRuntimeResult } from "../runtime/friday-agent-runtime.types.js";

export interface FridayAgentAutomationSchedule {
  type: "cron";
  cron: string;
  timezone?: string;
}

// ─── Persisted automation record ───

export interface FridayAgentAutomationRecord {
  id: string;
  name: string;
  description?: string;
  sourceRunId?: string;
  taskTemplate: string;
  variables?: Record<string, string>;
  skillIds?: string[];
  workflowIds?: string[];
  triggerId?: string;
  schedule?: FridayAgentAutomationSchedule;
  enabled: boolean;
  lastRunId?: string;
  lastRunAt?: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Service input/output types ───

export interface FridayAgentAutomationSaveInput {
  name: string;
  description?: string;
  sourceRunId?: string;
  taskTemplate: string;
  variables?: Record<string, string>;
  skillIds?: string[];
  workflowIds?: string[];
  triggerId?: string;
  schedule?: FridayAgentAutomationSchedule;
  enabled?: boolean;
}

export interface FridayAgentAutomationListFilters {
  enabled?: boolean;
  limit?: number;
  cursor?: string;
}

export interface FridayAgentAutomationUpdateInput {
  name?: string;
  description?: string;
  taskTemplate?: string;
  variables?: Record<string, string>;
  skillIds?: string[];
  workflowIds?: string[];
  triggerId?: string;
  schedule?: FridayAgentAutomationSchedule | null;
  enabled?: boolean;
}

export interface FridayAgentAutomationRunInput {
  taskOverride?: string;
  providerId?: string;
  model?: string;
  timezone?: string;
  timeoutMs?: number;
}

// ─── Service interface ───

export interface FridayAgentAutomationService {
  attachSchedulerBridge(bridge: FridayAgentAutomationSchedulerBridge): void;
  syncScheduledAutomations(): void;
  save(params: FridayAgentAutomationSaveInput): FridayAgentAutomationRecord;
  get(automationId: string): FridayAgentAutomationRecord | null;
  list(filters?: FridayAgentAutomationListFilters): FridayAgentAutomationRecord[];
  update(automationId: string, patch: FridayAgentAutomationUpdateInput): FridayAgentAutomationRecord;
  remove(automationId: string): void;
  run(automationId: string, input?: FridayAgentAutomationRunInput): Promise<FridayAgentRuntimeResult>;
}

// ─── Repository interface ───

export interface FridayAgentAutomationRepository {
  insert(db: Database.Database, record: FridayAgentAutomationRecord): FridayAgentAutomationRecord;
  findById(db: Database.Database, id: string): FridayAgentAutomationRecord | null;
  findMany(
    db: Database.Database,
    filters?: FridayAgentAutomationListFilters,
  ): FridayAgentAutomationRecord[];
  update(
    db: Database.Database,
    id: string,
    patch: Partial<Omit<FridayAgentAutomationRecord, "id" | "createdAt" | "schedule">> & {
      schedule?: FridayAgentAutomationSchedule | null;
    },
  ): FridayAgentAutomationRecord | null;
  remove(db: Database.Database, id: string): boolean;
}

export interface FridayAgentAutomationSchedulerBridge {
  sync(automation: FridayAgentAutomationRecord): void;
  remove(automation: FridayAgentAutomationRecord): void;
}

// ─── Factory deps ───

export interface CreateFridayAgentAutomationServiceDeps {
  db: FridaySqliteLayer;
  repository: FridayAgentAutomationRepository;
  startRun: (input: {
    task: string;
    providerId?: string;
    model?: string;
    timezone?: string;
    timeoutMs?: number;
  }) => Promise<FridayAgentRuntimeResult>;
  idGenerator: () => string;
  nowIso: () => string;
}
