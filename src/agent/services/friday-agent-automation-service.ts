import { FridayDomainError } from "#errors";
import type { FridayLearningEventAppendInput } from "#ledger";

import type {
  CreateFridayAgentAutomationServiceDeps,
  FridayAgentAutomationRecord,
  FridayAgentAutomationSchedulerBridge,
  FridayAgentAutomationService,
  FridayAgentAutomationSessionTarget,
} from "./friday-agent-automation-service.types.js";
import {
  computeAutomationOutcomeScore,
  deriveAutomationPromotionState,
  estimateAutomationTimeSavedMinutes,
  updateAutomationInsightsAfterRun,
} from "./friday-agent-automation-insights.js";

// ─── Error codes ───

const AUTOMATION_NOT_FOUND = "AGENT_AUTOMATION_NOT_FOUND";
const AUTOMATION_DISABLED = "AGENT_AUTOMATION_DISABLED";
const AUTOMATION_SCHEDULER_SYNC_FAILED = "AGENT_AUTOMATION_SCHEDULER_SYNC_FAILED";
const AUTOMATION_INVALID_SESSION_TARGET = "AGENT_AUTOMATION_INVALID_SESSION_TARGET";

const PROMOTION_STATE_RANK = {
  private: 0,
  team: 1,
  public_boost_eligible: 2,
  public: 3,
} as const;

// ─── Factory ───

export function createFridayAgentAutomationService(
  deps: CreateFridayAgentAutomationServiceDeps,
): FridayAgentAutomationService {
  const { db, repository, startRun, idGenerator, nowIso } = deps;
  let schedulerBridge: FridayAgentAutomationSchedulerBridge | null = null;

  function writeLearningEvent(event: Omit<FridayLearningEventAppendInput, "eventId" | "ts" | "userId">): void {
    if (!deps.learningEventWriter || !deps.learningUserId) {
      return;
    }
    deps.learningEventWriter([
      {
        eventId: idGenerator(),
        ts: nowIso(),
        userId: deps.learningUserId,
        ...event,
      },
    ]);
  }

  function syncScheduler(automation: FridayAgentAutomationRecord): void {
    if (!schedulerBridge) return;
    try {
      schedulerBridge.sync(automation);
    } catch (error) {
      throw new FridayDomainError(
        AUTOMATION_SCHEDULER_SYNC_FAILED,
        `Failed to sync automation scheduler state for ${automation.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { httpStatus: 500 },
      );
    }
  }

  function removeScheduler(automation: FridayAgentAutomationRecord): void {
    if (!schedulerBridge) return;
    try {
      schedulerBridge.remove(automation);
    } catch (error) {
      throw new FridayDomainError(
        AUTOMATION_SCHEDULER_SYNC_FAILED,
        `Failed to remove automation scheduler state for ${automation.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { httpStatus: 500 },
      );
    }
  }

  function resolveSessionTarget(input: {
    sessionTarget?: FridayAgentAutomationSessionTarget | null;
    sourceRunId?: string;
  }): FridayAgentAutomationSessionTarget {
    const sessionTarget = input.sessionTarget ?? { type: "isolated" as const };
    if (sessionTarget.type === "isolated") {
      return { type: "isolated" };
    }

    const providedSessionKey = typeof sessionTarget.sessionKey === "string"
      ? sessionTarget.sessionKey.trim()
      : "";
    if (providedSessionKey.length > 0) {
      return {
        type: sessionTarget.type,
        sessionKey: providedSessionKey,
      };
    }

    if (sessionTarget.type === "current" && input.sourceRunId && deps.resolveSourceSessionKey) {
      const resolved = deps.resolveSourceSessionKey(input.sourceRunId)?.trim();
      if (resolved) {
        return {
          type: "current",
          sessionKey: resolved,
        };
      }
    }

    throw new FridayDomainError(
      AUTOMATION_INVALID_SESSION_TARGET,
      "Automation sessionTarget requires a sessionKey or a sourceRunId with a resolvable session",
      { httpStatus: 400 },
    );
  }

  function resolveRunSessionKey(
    sessionTarget: FridayAgentAutomationSessionTarget | undefined,
  ): string | undefined {
    if (!sessionTarget || sessionTarget.type === "isolated") {
      return undefined;
    }
    return sessionTarget.sessionKey;
  }

  function buildAutomationTargetEvidence(input: {
    automation: FridayAgentAutomationRecord;
    sessionTarget: FridayAgentAutomationSessionTarget;
    source: "saved" | "run_override";
  }): {
    automationId: string;
    automationSessionTargetType: FridayAgentAutomationSessionTarget["type"];
    automationSessionTargetSource: "saved" | "run_override";
    automationSessionKey?: string;
    automationSourceRunId?: string;
  } {
    const sessionKey = input.sessionTarget.type === "isolated"
      ? undefined
      : input.sessionTarget.sessionKey;
    return {
      automationId: input.automation.id,
      automationSessionTargetType: input.sessionTarget.type,
      automationSessionTargetSource: input.source,
      ...(sessionKey ? { automationSessionKey: sessionKey } : {}),
      ...(input.automation.sourceRunId ? { automationSourceRunId: input.automation.sourceRunId } : {}),
    };
  }

  return {
    attachSchedulerBridge(bridge) {
      schedulerBridge = bridge;
    },

    syncScheduledAutomations() {
      if (!schedulerBridge) return;
      let cursor: string | undefined;
      while (true) {
        const batch = db.withReadConnection((reader) =>
          repository.findMany(reader, { limit: 500, cursor }),
        );
        if (batch.length === 0) break;
        for (const automation of batch) {
          syncScheduler(automation);
        }
        if (batch.length < 500) break;
        cursor = batch[batch.length - 1]?.createdAt;
      }
    },

    save(params) {
      const now = nowIso();
      const record = {
        id: idGenerator(),
        name: params.name,
        description: params.description,
        sourceRunId: params.sourceRunId,
        taskTemplate: params.taskTemplate,
        variables: params.variables,
        skillIds: params.skillIds,
        workflowIds: params.workflowIds,
        triggerId: params.triggerId,
        schedule: params.schedule,
        sessionTarget: resolveSessionTarget({
          sessionTarget: params.sessionTarget,
          sourceRunId: params.sourceRunId,
        }),
        enabled: params.enabled ?? true,
        runCount: 0,
        estimatedTimeSavedMinutes: estimateAutomationTimeSavedMinutes({
          taskTemplate: params.taskTemplate,
          skillIds: params.skillIds,
          workflowIds: params.workflowIds,
          schedule: params.schedule,
        }),
        reuseCount: 0,
        promotionState: deriveAutomationPromotionState({
          reuseCount: 0,
          lastOutcomeScore: 0,
        }),
        lastOutcomeScore: 0,
        createdAt: now,
        updatedAt: now,
      };

      const inserted = db.withWriteTransaction((writer) => repository.insert(writer, record));
      syncScheduler(inserted);
      writeLearningEvent({
        kind: "automation_saved",
        runId: undefined,
        payload: {
          automationId: inserted.id,
          sourceRunId: inserted.sourceRunId ?? null,
          estimatedTimeSavedMinutes: inserted.estimatedTimeSavedMinutes,
          promotionState: inserted.promotionState,
        },
      });
      return inserted;
    },

    get(automationId) {
      return db.withReadConnection((reader) => repository.findById(reader, automationId));
    },

    list(filters) {
      return db.withReadConnection((reader) => repository.findMany(reader, filters));
    },

    update(automationId, patch) {
      const existing = db.withReadConnection((reader) =>
        repository.findById(reader, automationId),
      );
      if (!existing) {
        throw new FridayDomainError(
          AUTOMATION_NOT_FOUND,
          `Automation not found: ${automationId}`,
          { httpStatus: 404 },
        );
      }

      const {
        sessionTarget: requestedSessionTarget,
        ...restPatch
      } = patch;

      const updated = db.withWriteTransaction((writer) =>
        repository.update(writer, automationId, {
          ...restPatch,
          ...(requestedSessionTarget !== undefined
            ? {
                sessionTarget: requestedSessionTarget === null
                  ? { type: "isolated" }
                  : resolveSessionTarget({
                      sessionTarget: requestedSessionTarget,
                      sourceRunId: existing.sourceRunId,
                    }),
              }
            : {}),
          updatedAt: nowIso(),
        }),
      );

      if (!updated) {
        throw new FridayDomainError(
          AUTOMATION_NOT_FOUND,
          `Automation not found after update: ${automationId}`,
          { httpStatus: 404 },
        );
      }

      syncScheduler(updated);
      return updated;
    },

    remove(automationId) {
      const existing = db.withReadConnection((reader) =>
        repository.findById(reader, automationId),
      );
      if (!existing) {
        throw new FridayDomainError(
          AUTOMATION_NOT_FOUND,
          `Automation not found: ${automationId}`,
          { httpStatus: 404 },
        );
      }

      db.withWriteTransaction((writer) => repository.remove(writer, automationId));
      removeScheduler(existing);
    },

    async run(automationId, input) {
      const automation = db.withReadConnection((reader) =>
        repository.findById(reader, automationId),
      );
      if (!automation) {
        throw new FridayDomainError(
          AUTOMATION_NOT_FOUND,
          `Automation not found: ${automationId}`,
          { httpStatus: 404 },
        );
      }

      if (!automation.enabled) {
        throw new FridayDomainError(
          AUTOMATION_DISABLED,
          `Automation is disabled: ${automationId}`,
          { httpStatus: 409 },
        );
      }

      const task = input?.taskOverride ?? automation.taskTemplate;
      const sessionTargetSource = input?.sessionTarget ? "run_override" : "saved";
      const sessionTarget = input?.sessionTarget
        ? resolveSessionTarget({
            sessionTarget: input.sessionTarget,
            sourceRunId: automation.sourceRunId,
          })
        : resolveSessionTarget({
            sessionTarget: automation.sessionTarget,
            sourceRunId: automation.sourceRunId,
          });
      const targetEvidence = buildAutomationTargetEvidence({
        automation,
        sessionTarget,
        source: sessionTargetSource,
      });

      const result = await startRun({
        task,
        sessionKey: resolveRunSessionKey(sessionTarget),
        providerId: input?.providerId,
        model: input?.model,
        timezone: input?.timezone ?? automation.schedule?.timezone,
        timeoutMs: input?.timeoutMs,
        executionContext: {
          surface: "agent.automation",
          interactive: false,
          ...targetEvidence,
        },
      });

      const nextInsights = updateAutomationInsightsAfterRun(automation, result);

      // Update automation with last run info
      db.withWriteTransaction((writer) =>
        repository.update(writer, automationId, {
          lastRunId: result.runId,
          lastRunAt: nowIso(),
          runCount: automation.runCount + 1,
          estimatedTimeSavedMinutes: nextInsights.estimatedTimeSavedMinutes,
          reuseCount: nextInsights.reuseCount,
          promotionState: nextInsights.promotionState,
          lastOutcomeScore: nextInsights.lastOutcomeScore,
          updatedAt: nowIso(),
        }),
      );

      if (
        PROMOTION_STATE_RANK[nextInsights.promotionState] >
        PROMOTION_STATE_RANK[automation.promotionState]
      ) {
        writeLearningEvent({
          kind: "asset_promoted",
          payload: {
            assetId: automationId,
            assetKind: "automation",
            sourceAutomationId: automationId,
            sourceRunId: automation.sourceRunId ?? null,
            resultRunId: result.runId,
            ...targetEvidence,
            previousPromotionState: automation.promotionState,
            promotionState: nextInsights.promotionState,
            reuseCount: nextInsights.reuseCount,
            lastOutcomeScore: nextInsights.lastOutcomeScore,
          },
        });
      }

      writeLearningEvent({
        kind: "automation_reused",
        payload: {
          sourceRunId: automation.sourceRunId ?? null,
          resultRunId: result.runId,
          ...targetEvidence,
          reuseCount: nextInsights.reuseCount,
          lastOutcomeScore: nextInsights.lastOutcomeScore,
          success: result.status === "completed",
        },
      });
      if (result.status === "completed") {
        writeLearningEvent({
          kind: "outcome_confirmed",
          payload: {
            resultRunId: result.runId,
            ...targetEvidence,
            outcomeScore: computeAutomationOutcomeScore(result),
            estimatedTimeSavedMinutes: nextInsights.estimatedTimeSavedMinutes,
          },
        });
      }

      return result;
    },
  };
}
