import type { FridaySqliteLayer } from "#state";
import type { FridayLearnedLessonRepository } from "../persistence/friday-learned-lesson-repository.js";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import type {
  FridayDiagnosisRecordEntity,
  FridayErrorIncidentEntity,
  FridayLearnedLessonEntity,
  ISODateTime,
  JsonObject,
} from "../model/friday-learning.types.js";
import type { FridayAutoFixActionEntity } from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixLessonExtractionService {
  extractFromSuccess(input: {
    incident: FridayErrorIncidentEntity;
    diagnosis: FridayDiagnosisRecordEntity;
    action: FridayAutoFixActionEntity;
    nowIso: ISODateTime;
  }): FridayLearnedLessonEntity | null;
}

export interface CreateAutoFixLessonExtractionServiceDeps {
  db: FridaySqliteLayer;
  lessonRepo: FridayLearnedLessonRepository;
  incidentRepo: FridayErrorIncidentRepository;
  diagnosisRepo: FridayDiagnosisRecordRepository;
  idGenerator: () => string;
}

export function createFridayAutoFixLessonExtractionService(
  deps: CreateAutoFixLessonExtractionServiceDeps,
): FridayAutoFixLessonExtractionService {
  return {
    extractFromSuccess(input) {
      const { incident, diagnosis, action, nowIso } = input;

      if (action.outcome !== "success") {
        return null;
      }

      return deps.db.withWriteTransaction((db) => {
        // Upsert lesson with auto-fix context
        const mitigation: JsonObject = {
          autoFixApplied: true,
          planTitle: action.plan.title,
          riskTier: action.riskTier,
          stepsApplied: action.plan.steps.map((s) => s.kind),
        };

        const lesson = deps.lessonRepo.upsertByFingerprint(db, {
          id: deps.idGenerator(),
          fingerprint: incident.signature,
          title: `Auto-fixed: ${action.plan.title}`,
          cause: (diagnosis.diagnosis as JsonObject)["summary"] as string ??
            `${incident.category} error`,
          fix: action.plan.summary,
          mitigation,
          sourceIncidentId: incident.incidentId,
          sourceDiagnosisId: diagnosis.id,
          nowIso,
        });

        // Mark incident as resolved
        deps.incidentRepo.updateStatus(
          db,
          incident.incidentId,
          "resolved",
          nowIso,
        );

        // Mark diagnosis as resolved
        deps.diagnosisRepo.markResolved(db, diagnosis.id, nowIso);

        return lesson;
      });
    },
  };
}
