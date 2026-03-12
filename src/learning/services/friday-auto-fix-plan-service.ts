import type {
  FridayDiagnosisRecordEntity,
  FridayErrorIncidentEntity,
  FridayLearnedLessonEntity,
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

export function createFridayAutoFixPlanService(
  deps: CreateAutoFixPlanServiceDeps,
): FridayAutoFixPlanService {
  return {
    buildPlans(input) {
      const { incident, diagnosis, matchedLessons, recurrenceCount } = input;
      const plans: FridayAutoFixPlan[] = [];

      if (matchedLessons.length === 0) {
        // No lessons: generate a single retry-based plan
        const stepKind = CATEGORY_STEP_MAP[incident.category];
        const plan: FridayAutoFixPlan = {
          title: `Auto-fix: retry ${incident.category}`,
          summary: `Retry the failed ${incident.category} operation`,
          steps: [
            {
              stepId: deps.idGenerator(),
              kind: stepKind,
              target: incident.nodeId ?? incident.category,
              payload: {
                category: incident.category,
                signature: incident.signature,
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
        if (stepKind === "apply_config_patch" || stepKind === "grant_permission") {
          plan.rollbackPlan = {
            summary: `Revert ${stepKind} for ${incident.category}`,
            steps: [
              {
                stepId: deps.idGenerator(),
                kind: stepKind,
                target: incident.nodeId ?? incident.category,
                payload: {
                  revert: true,
                  category: incident.category,
                  signature: incident.signature,
                },
              },
            ],
          };
        }

        plans.push(plan);
        return plans;
      }

      for (const lesson of matchedLessons) {
        const stepKind = CATEGORY_STEP_MAP[incident.category];
        const plan: FridayAutoFixPlan = {
          title: `Auto-fix: ${lesson.title}`,
          summary: lesson.fix,
          steps: [
            {
              stepId: deps.idGenerator(),
              kind: stepKind,
              target: incident.nodeId ?? incident.category,
              payload: {
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
        if (stepKind === "apply_config_patch" || stepKind === "grant_permission") {
          plan.rollbackPlan = {
            summary: `Revert config change for ${lesson.title}`,
            steps: [
              {
                stepId: deps.idGenerator(),
                kind: stepKind,
                target: incident.nodeId ?? incident.category,
                payload: {
                  revert: true,
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
