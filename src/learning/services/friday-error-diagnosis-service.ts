import type { FridaySqliteLayer } from "#state";
import type Database from "better-sqlite3";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import type { FridayLearnedLessonRepository } from "../persistence/friday-learned-lesson-repository.js";
import type { FridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import type {
  FridayDiagnosisRecordEntity,
  FridayErrorIncidentEntity,
  ISODateTime,
  JsonObject,
} from "../model/friday-learning.types.js";
import type {
  FridayAutoFixPlan,
  FridayDiagnosisOutcome,
} from "../model/friday-auto-fix.types.js";

export interface FridayErrorDiagnosisService {
  /** Diagnose within an existing transaction (caller provides db handle). */
  diagnoseInTransaction(
    db: Database.Database,
    input: {
      incident: FridayErrorIncidentEntity;
      nowIso: ISODateTime;
    },
  ): FridayDiagnosisOutcome;

  /** Standalone diagnose that creates its own transaction. */
  diagnose(input: {
    incident: FridayErrorIncidentEntity;
    nowIso: ISODateTime;
  }): FridayDiagnosisOutcome;
}

export interface CreateErrorDiagnosisServiceDeps {
  db: FridaySqliteLayer;
  incidentRepo: FridayErrorIncidentRepository;
  diagnosisRepo: FridayDiagnosisRecordRepository;
  lessonRepo: FridayLearnedLessonRepository;
  factRepo?: FridayPreferenceFactRepository;
  idGenerator: () => string;
}

/** Confidence threshold for auto-fix eligibility. */
const AUTO_FIX_CONFIDENCE_THRESHOLD = 0.6;
const INTERNAL_RUNTIME_AUTO_FIX_SOURCES = new Set([
  "assistant",
  "satellite_runtime",
  "skills_lifecycle",
  "skill_generator",
]);

export function createFridayErrorDiagnosisService(
  deps: CreateErrorDiagnosisServiceDeps,
): FridayErrorDiagnosisService {
  function diagnoseCore(
    db: Database.Database,
    input: { incident: FridayErrorIncidentEntity; nowIso: ISODateTime },
  ): FridayDiagnosisOutcome {
    const { incident, nowIso } = input;
    const fingerprint = incident.signature;

    // 1. Look up matching lessons
    const lesson = deps.lessonRepo.getByFingerprint(db, fingerprint);
    const lessonDisabled = lesson && deps.factRepo
      ? deps.factRepo.getByUserAndKey(db, incident.userId, `lesson_disabled:${lesson.id}`)
      : null;
    let matchedLessons = lesson && !(lessonDisabled?.value === true || (typeof lessonDisabled?.value === "object" && lessonDisabled?.value !== null && "disabled" in lessonDisabled.value && lessonDisabled.value.disabled === true))
      ? [lesson]
      : [];

    // 1b. Check for rejected/negative lessons — avoid recommending same fix
    const isNegativeLesson = lesson?.mitigation &&
      typeof lesson.mitigation === "object" &&
      lesson.mitigation !== null &&
      "rejected" in (lesson.mitigation as Record<string, unknown>) &&
      (lesson.mitigation as Record<string, unknown>).rejected === true;
    const isFailedLesson = lesson?.mitigation &&
      typeof lesson.mitigation === "object" &&
      lesson.mitigation !== null &&
      "autoFixFailed" in (lesson.mitigation as Record<string, unknown>) &&
      (lesson.mitigation as Record<string, unknown>).autoFixFailed === true;

    if (isNegativeLesson || isFailedLesson) {
      matchedLessons = [];
    }

    // 2. Recurrence count: recent incidents with same signature
    const recentIncidents = deps.incidentRepo.findRecentBySignature(
      db,
      incident.userId,
      fingerprint,
      50,
    );
    const recurrenceCount = recentIncidents.length;

    // 3. Historical diagnoses for confidence boost
    const historicalDiagnoses = deps.diagnosisRepo.listByFingerprint(
      db,
      fingerprint,
      5,
    );

    // 4. Compute confidence using deterministic scoring (always in [0, 1])
    const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
    let confidence = incident.severity === "high" ? 0.5 : 0.3;

    // Exact lesson match boost
    if (matchedLessons.length > 0) {
      confidence = clamp01(confidence + 0.3);
    }

    // Recurrence boost (capped)
    confidence = clamp01(confidence + Math.min(recurrenceCount * 0.05, 0.2));

    // Historical high-confidence diagnosis boost
    const highConfDiagnoses = historicalDiagnoses.filter(
      (d) => d.confidence >= 0.7,
    );
    if (highConfDiagnoses.length > 0) {
      confidence = clamp01(confidence + 0.1);
    }

    // Internal structured runtime failures are deterministic product signals,
    // so they can safely enter the supervised loop at lower recurrence counts.
    const source = typeof incident.context.source === "string"
      ? incident.context.source
      : undefined;
    if (source && INTERNAL_RUNTIME_AUTO_FIX_SOURCES.has(source)) {
      confidence = clamp01(confidence + 0.3);
    }

    // 5. Build diagnosis entity
    const diagnosisJson: JsonObject = {
      summary: `Diagnosis for ${incident.category} error: ${fingerprint}`,
      rankedCauses: [
        {
          cause: lesson?.cause ?? `Detected ${incident.category} failure`,
          confidence,
        },
      ],
      suggestedFixes: matchedLessons.map((l) => l.fix),
      matchedLessonIds: matchedLessons.map((l) => l.id),
      recurrenceCount,
      autoDetected: true,
    };

    const diagnosis: FridayDiagnosisRecordEntity = {
      id: deps.idGenerator(),
      incidentId: incident.incidentId,
      runId: incident.runId,
      nodeId: incident.nodeId,
      errorFingerprint: fingerprint,
      confidence,
      diagnosis: diagnosisJson,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    deps.diagnosisRepo.insert(db, diagnosis);

    // 6. Determine auto-fix eligibility
    const autoFixEligible = confidence >= AUTO_FIX_CONFIDENCE_THRESHOLD;

    // 7. Build candidate plans from matched lessons
    const candidatePlans: FridayAutoFixPlan[] = [];

    if (autoFixEligible && matchedLessons.length > 0) {
      const TIER_1_KINDS = new Set(["apply_config_patch", "grant_permission"]);

      for (const l of matchedLessons) {
        const planStepKind = mapCategoryToStepKind(incident.category);
        const target = incident.nodeId ?? incident.category;
        const plan: FridayAutoFixPlan = {
          title: `Auto-fix: ${l.title}`,
          summary: l.fix,
          steps: [
            {
              stepId: deps.idGenerator(),
              kind: planStepKind,
              target,
              payload: {
                lessonId: l.id,
                fix: l.fix,
                ...(l.mitigation ?? {}),
              },
              verify: {
                method: "error_absent",
                timeoutMs: 5000,
              },
            },
          ],
          evidence: {
            fingerprint,
            matchedLessonIds: [l.id],
            diagnosisId: diagnosis.id,
            recurrenceCount,
          },
        };

        // Tier 1 steps require rollback plans
        if (TIER_1_KINDS.has(planStepKind)) {
          plan.rollbackPlan = {
            summary: `Revert: ${l.fix}`,
            steps: [
              {
                stepId: deps.idGenerator(),
                kind: planStepKind,
                target,
                payload: { revert: true, lessonId: l.id },
              },
            ],
          };
        }

        candidatePlans.push(plan);
      }
    }

    return {
      diagnosis,
      matchedLessons,
      recurrenceCount,
      autoFixEligible,
      candidatePlans,
    };
  }

  return {
    diagnoseInTransaction: diagnoseCore,

    diagnose(input) {
      return deps.db.withWriteTransaction((db) => diagnoseCore(db, input));
    },
  };
}

function mapCategoryToStepKind(
  category: FridayErrorIncidentEntity["category"],
): FridayAutoFixPlan["steps"][number]["kind"] {
  switch (category) {
    case "tool":
      return "retry_node";
    case "model":
      return "switch_model_fallback";
    case "config":
      return "apply_config_patch";
    case "routing":
      return "trim_payload";
    case "workflow":
      return "retry_node";
  }
}
