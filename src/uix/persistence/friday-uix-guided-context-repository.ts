import type Database from "better-sqlite3";

import type { FridayProviderTenantContext } from "#providers";

import type { FridayGuidedContextRow } from "../model/friday-uix.types.js";

export interface FridayPersistedWizardContext {
  contextId: string;
  wizardId: string;
  title: string;
  principalId: string;
  channelId: string;
  status: string;
  currentStepId: string;
  steps: Array<Record<string, unknown>>;
  collectedValues: Record<string, unknown>;
  nextActionLabel?: string;
  objective?: string;
  assumptions?: string[];
  unknowns?: string[];
  successTest?: string;
  fallbackPath?: string;
  skillSessionId?: string;
  workflowSessionId?: string;
  flowKind?: "skill" | "workflow";
  resolvedIntent?: string;
  assistantSessionKey?: string;
  tenantContext?: FridayProviderTenantContext;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface FridayUixGuidedContextRepository {
  save(db: Database.Database, context: FridayPersistedWizardContext): void;
  getById(db: Database.Database, contextId: string): FridayPersistedWizardContext | null;
}

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: FridayGuidedContextRow): FridayPersistedWizardContext {
  const sessionData = safeParseJson<Record<string, unknown>>(row.session_data_json, {});
  const wizard = sessionData.wizard;
  const typedWizard = wizard && typeof wizard === "object"
    ? wizard as Record<string, unknown>
    : {};

  return {
    contextId: row.id,
    wizardId: row.workflow_id,
    title: typeof typedWizard.title === "string" ? typedWizard.title : "",
    principalId: row.principal_id,
    channelId: row.channel_id,
    status: row.status,
    currentStepId: typeof typedWizard.currentStepId === "string" ? typedWizard.currentStepId : "",
    steps: Array.isArray(typedWizard.steps) ? typedWizard.steps as Array<Record<string, unknown>> : [],
    collectedValues: typedWizard.collectedValues && typeof typedWizard.collectedValues === "object"
      ? typedWizard.collectedValues as Record<string, unknown>
      : {},
    nextActionLabel: typeof typedWizard.nextActionLabel === "string" ? typedWizard.nextActionLabel : undefined,
    objective: typeof sessionData.objective === "string" ? sessionData.objective : undefined,
    assumptions: Array.isArray(sessionData.assumptions) ? sessionData.assumptions as string[] : undefined,
    unknowns: Array.isArray(sessionData.unknowns) ? sessionData.unknowns as string[] : undefined,
    successTest: typeof sessionData.successTest === "string" ? sessionData.successTest : undefined,
    fallbackPath: typeof sessionData.fallbackPath === "string" ? sessionData.fallbackPath : undefined,
    skillSessionId: typeof sessionData.skillSessionId === "string" ? sessionData.skillSessionId : undefined,
    workflowSessionId: typeof sessionData.workflowSessionId === "string" ? sessionData.workflowSessionId : undefined,
    flowKind: sessionData.flowKind === "skill" || sessionData.flowKind === "workflow"
      ? sessionData.flowKind
      : undefined,
    resolvedIntent: typeof sessionData.resolvedIntent === "string" ? sessionData.resolvedIntent : undefined,
    assistantSessionKey: typeof sessionData.assistantSessionKey === "string" ? sessionData.assistantSessionKey : undefined,
    tenantContext: sessionData.tenantContext && typeof sessionData.tenantContext === "object"
      ? sessionData.tenantContext as FridayProviderTenantContext
      : undefined,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

export function createFridayUixGuidedContextRepository(): FridayUixGuidedContextRepository {
  return {
    save(db, context) {
      const stepIndex = Math.max(
        0,
        context.steps.findIndex((step) => step.id === context.currentStepId),
      );
      const completedStepIds = context.steps
        .filter((step) => typeof step.id === "string" && typeof step.status === "string" && step.status === "completed")
        .map((step) => step.id as string);

      const sessionData = {
        wizard: {
          wizardId: context.wizardId,
          contextId: context.contextId,
          title: context.title,
          status: context.status,
          currentStepId: context.currentStepId,
          steps: context.steps,
          collectedValues: context.collectedValues,
          nextActionLabel: context.nextActionLabel,
        },
        objective: context.objective,
        assumptions: context.assumptions,
        unknowns: context.unknowns,
        successTest: context.successTest,
        fallbackPath: context.fallbackPath,
        skillSessionId: context.skillSessionId,
        workflowSessionId: context.workflowSessionId,
        flowKind: context.flowKind,
        resolvedIntent: context.resolvedIntent,
        assistantSessionKey: context.assistantSessionKey,
        tenantContext: context.tenantContext,
      };

      db.prepare(`
        INSERT OR REPLACE INTO uix_guided_contexts (
          id,
          workflow_id,
          principal_id,
          channel_id,
          status,
          current_step_index,
          completed_steps_json,
          session_data_json,
          started_at,
          updated_at,
          expires_at,
          finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        context.contextId,
        context.wizardId,
        context.principalId,
        context.channelId,
        context.status,
        stepIndex === -1 ? 0 : stepIndex,
        JSON.stringify(completedStepIds),
        JSON.stringify(sessionData),
        context.startedAt,
        context.updatedAt,
        new Date(new Date(context.updatedAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
        context.finishedAt ?? null,
      );
    },

    getById(db, contextId) {
      const row = db.prepare(`
        SELECT * FROM uix_guided_contexts
        WHERE id = ?
        LIMIT 1
      `).get(contextId) as FridayGuidedContextRow | undefined;
      return row ? mapRow(row) : null;
    },
  };
}
