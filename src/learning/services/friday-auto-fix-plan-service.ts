import type {
  FridayDiagnosisRecordEntity,
  FridayErrorIncidentEntity,
  FridayLearnedLessonEntity,
  JsonObject,
} from "../model/friday-learning.types.js";
import type { FridayAutoFixPlan, FridayAutoFixStepKind } from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixPlanService {
  buildPlans(input: {
    incident: FridayErrorIncidentEntity;
    diagnosis: FridayDiagnosisRecordEntity;
    matchedLessons: FridayLearnedLessonEntity[];
    recurrenceCount: number;
  }): FridayAutoFixPlan[];
}

export interface CreateAutoFixPlanServiceDeps {
  idGenerator: () => string;
}

const CATEGORY_STEP_MAP: Record<FridayErrorIncidentEntity["category"], FridayAutoFixStepKind> = {
  tool: "retry_node",
  model: "switch_model_fallback",
  config: "apply_config_patch",
  routing: "trim_payload",
  workflow: "retry_node",
};

function deriveAutoFixStepKind(
  incident: FridayErrorIncidentEntity,
): FridayAutoFixStepKind {
  const source = typeof incident.context.source === "string"
    ? incident.context.source
    : undefined;
  const skillId = typeof incident.context.skillId === "string"
    ? incident.context.skillId.trim()
    : "";
  if (source === "skills_lifecycle" && skillId.length > 0) {
    return "disable_skill";
  }
  return CATEGORY_STEP_MAP[incident.category];
}

function deriveAutoFixTarget(
  incident: FridayErrorIncidentEntity,
  stepKind: FridayAutoFixStepKind,
): string {
  if (stepKind === "disable_skill") {
    const skillId = typeof incident.context.skillId === "string"
      ? incident.context.skillId.trim()
      : "";
    if (skillId.length > 0) {
      return skillId;
    }
  }
  return incident.runId ?? incident.nodeId ?? incident.category;
}

export function createFridayAutoFixPlanService(
  deps: CreateAutoFixPlanServiceDeps,
): FridayAutoFixPlanService {
  return {
    buildPlans(input) {
      const { incident, diagnosis, matchedLessons, recurrenceCount } = input;
      const plans: FridayAutoFixPlan[] = [];
      const stepKind = deriveAutoFixStepKind(incident);
      const target = deriveAutoFixTarget(incident, stepKind);
      const fallbackProviderIds = Array.isArray(incident.context.fallbackProviderIds)
        ? incident.context.fallbackProviderIds.filter(
            (providerId): providerId is string => typeof providerId === "string" && providerId.trim().length > 0,
          )
        : [];
      const preferredFallbackProviderId = fallbackProviderIds[0];
      const basePayload: JsonObject = {
        incidentId: incident.incidentId,
        category: incident.category,
        signature: incident.signature,
        ...(typeof incident.runId === "string" ? { runId: incident.runId } : {}),
        ...(typeof incident.nodeId === "string" ? { nodeId: incident.nodeId } : {}),
        ...(typeof incident.context.providerId === "string" ? { providerId: incident.context.providerId } : {}),
        ...(typeof incident.context.actualProviderId === "string" ? { actualProviderId: incident.context.actualProviderId } : {}),
        ...(typeof incident.context.model === "string" ? { model: incident.context.model } : {}),
        ...(typeof incident.context.actualModel === "string" ? { actualModel: incident.context.actualModel } : {}),
        ...(fallbackProviderIds.length > 0
          ? {
              fallbackProviderIds,
              fallbackProviderId: preferredFallbackProviderId,
              nextProviderId: preferredFallbackProviderId,
            }
          : {}),
        ...(typeof incident.context.enforceRequestedModel === "boolean"
          ? { enforceRequestedModel: incident.context.enforceRequestedModel }
          : {}),
      };

      if (matchedLessons.length === 0) {
        // No lessons: generate a single retry-based plan
        const plan: FridayAutoFixPlan = {
          title: `Auto-fix: retry ${incident.category}`,
          summary: `Retry the failed ${incident.category} operation`,
          steps: [
            {
              stepId: deps.idGenerator(),
              kind: stepKind,
              target,
              payload: {
                ...basePayload,
              },
              verify: {
                method: "error_absent",
                timeoutMs: 5000,
              },
            },
          ],
          evidence: {
            fingerprint: incident.signature,
            matchedLessonIds: [],
            diagnosisId: diagnosis.id,
            recurrenceCount,
          },
        };

        // Tier 1 steps MUST include rollback plans
        if (
          stepKind === "apply_config_patch" ||
          stepKind === "grant_permission" ||
          stepKind === "switch_model_fallback"
        ) {
          plan.rollbackPlan = {
            summary: `Revert ${stepKind} for ${incident.category}`,
            steps: [
                {
                  stepId: deps.idGenerator(),
                  kind: stepKind,
                  target,
                  payload: {
                    revert: true,
                    ...(stepKind === "switch_model_fallback"
                      ? {
                          restoreProviderId:
                            (typeof incident.context.actualProviderId === "string"
                              ? incident.context.actualProviderId
                              : typeof incident.context.providerId === "string"
                                ? incident.context.providerId
                                : undefined),
                          restoreModel:
                            (typeof incident.context.actualModel === "string"
                              ? incident.context.actualModel
                              : typeof incident.context.model === "string"
                                ? incident.context.model
                                : undefined),
                          ...(Array.isArray(incident.context.fallbackProviderIds)
                            ? {
                                restoreFallbackProviderIds: incident.context.fallbackProviderIds.filter(
                                  (providerId): providerId is string =>
                                    typeof providerId === "string" && providerId.trim().length > 0,
                                ),
                              }
                            : {}),
                          ...(typeof incident.context.enforceRequestedModel === "boolean"
                            ? { restoreEnforceRequestedModel: incident.context.enforceRequestedModel }
                            : {}),
                        }
                      : {}),
                    ...basePayload,
                  },
                },
              ],
          };
        }

        plans.push(plan);
        return plans;
      }

      for (const lesson of matchedLessons) {
        const plan: FridayAutoFixPlan = {
          title: `Auto-fix: ${lesson.title}`,
          summary: lesson.fix,
          steps: [
            {
              stepId: deps.idGenerator(),
              kind: stepKind,
              target,
              payload: {
                ...basePayload,
                lessonId: lesson.id,
                fix: lesson.fix,
                ...(lesson.mitigation ?? {}),
              },
              verify: {
                method: "error_absent",
                timeoutMs: 5000,
              },
            },
          ],
          evidence: {
            fingerprint: incident.signature,
            matchedLessonIds: [lesson.id],
            diagnosisId: diagnosis.id,
            recurrenceCount,
          },
        };

        // Add rollback plan for config patches
        if (
          stepKind === "apply_config_patch" ||
          stepKind === "grant_permission" ||
          stepKind === "switch_model_fallback"
        ) {
          plan.rollbackPlan = {
            summary: `Revert config change for ${lesson.title}`,
            steps: [
                {
                  stepId: deps.idGenerator(),
                  kind: stepKind,
                  target,
                  payload: {
                    revert: true,
                    ...(stepKind === "switch_model_fallback"
                      ? {
                          restoreProviderId:
                            (typeof incident.context.actualProviderId === "string"
                              ? incident.context.actualProviderId
                              : typeof incident.context.providerId === "string"
                                ? incident.context.providerId
                                : undefined),
                          restoreModel:
                            (typeof incident.context.actualModel === "string"
                              ? incident.context.actualModel
                              : typeof incident.context.model === "string"
                                ? incident.context.model
                                : undefined),
                          ...(Array.isArray(incident.context.fallbackProviderIds)
                            ? {
                                restoreFallbackProviderIds: incident.context.fallbackProviderIds.filter(
                                  (providerId): providerId is string =>
                                    typeof providerId === "string" && providerId.trim().length > 0,
                                ),
                              }
                            : {}),
                          ...(typeof incident.context.enforceRequestedModel === "boolean"
                            ? { restoreEnforceRequestedModel: incident.context.enforceRequestedModel }
                            : {}),
                        }
                      : {}),
                    ...basePayload,
                    lessonId: lesson.id,
                  },
                },
            ],
          };
        }

        plans.push(plan);
      }

      return plans;
    },
  };
}
