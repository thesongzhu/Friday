import type Database from "better-sqlite3";

import type { FridaySqliteLayer } from "#state";
import type { FridayLearningEventAppendInput } from "#ledger";

import type {
  FridayAgentExecutionContext,
  FridayAgentRuntimeResult,
} from "../runtime/friday-agent-runtime.types.js";

export interface FridayAgentAutomationSchedule {
  type: "cron";
  cron: string;
  timezone?: string;
}

export type FridayAgentAutomationPromotionState =
  | "private"
  | "team"
  | "public_boost_eligible"
  | "public";

export type FridayAgentAutomationSessionTarget =
  | { type: "isolated" }
  | { type: "named"; sessionKey: string }
  | { type: "current"; sessionKey?: string };

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
  sessionTarget?: FridayAgentAutomationSessionTarget;
  enabled: boolean;
  lastRunId?: string;
  lastRunAt?: string;
  runCount: number;
  estimatedTimeSavedMinutes: number;
  reuseCount: number;
  promotionState: FridayAgentAutomationPromotionState;
  lastOutcomeScore: number;
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
  sessionTarget?: FridayAgentAutomationSessionTarget;
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
  sessionTarget?: FridayAgentAutomationSessionTarget | null;
  enabled?: boolean;
}

export interface FridayAgentAutomationRunInput {
  taskOverride?: string;
  providerId?: string;
  model?: string;
  timezone?: string;
  timeoutMs?: number;
  sessionTarget?: FridayAgentAutomationSessionTarget;
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
      sessionTarget?: FridayAgentAutomationSessionTarget | null;
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
    sessionKey?: string;
    providerId?: string;
    model?: string;
    timezone?: string;
    timeoutMs?: number;
    executionContext?: FridayAgentExecutionContext;
  }) => Promise<FridayAgentRuntimeResult>;
  idGenerator: () => string;
  nowIso: () => string;
  learningEventWriter?: (events: FridayLearningEventAppendInput[]) => void;
  learningUserId?: string;
  resolveSourceSessionKey?: (sourceRunId: string) => string | null;
}
