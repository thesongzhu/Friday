import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import type { FridayLearningEventCollectionService } from "./friday-learning-event-collection-service.js";
import type { FridayPreferenceExtractionService } from "./friday-preference-extraction-service.js";
import type { FridayPreferenceFactService } from "./friday-preference-fact-service.js";
import type { FridayLearningLifecycleService } from "./friday-learning-lifecycle-service.js";
import type { FridayErrorDiagnosisService } from "./friday-error-diagnosis-service.js";
import type { FridayAutoFixPlanService } from "./friday-auto-fix-plan-service.js";
import type { FridayAutoFixRiskAssessmentService } from "./friday-auto-fix-risk-assessment-service.js";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import type { FridayLearnedLessonRepository } from "../persistence/friday-learned-lesson-repository.js";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { FridayApprovalRequestRepository } from "../persistence/friday-approval-request-repository.js";
import type {
  FridayDiagnosisRecordEntity,
  FridayErrorIncidentEntity,
  FridayLearnedLessonEntity,
  FridayLearningEventAppendInput,
  FridaySelfLearningProcessResult,
  JsonObject,
} from "../model/friday-learning.types.js";
import type {
  FridayApprovalRequestEntity,
  FridayAutoFixActionEntity,
} from "../model/friday-auto-fix.types.js";

export interface FridaySelfLearningPipelineService {
  processEvent(
    event: FridayLearningEventAppendInput,
  ): FridaySelfLearningProcessResult;
  processBatch(
    events: FridayLearningEventAppendInput[],
  ): FridaySelfLearningProcessResult[];
}

export interface FridayLearningMemoryWriter {
  store(namespace: string, content: string, metadata?: Record<string, unknown>): Promise<unknown>;
}

export interface CreateSelfLearningPipelineServiceDeps {
  db: FridaySqliteLayer;
  events: FridayLearningEventCollectionService;
  extraction: FridayPreferenceExtractionService;
  facts: FridayPreferenceFactService;
  lifecycle: FridayLearningLifecycleService;
  incidentRepo: FridayErrorIncidentRepository;
  diagnosisRepo: FridayDiagnosisRecordRepository;
  lessonRepo: FridayLearnedLessonRepository;
  actionRepo?: FridayAutoFixActionRepository;
  approvalRepo?: FridayApprovalRequestRepository;
  diagnosisService?: FridayErrorDiagnosisService;
  planService?: FridayAutoFixPlanService;
  riskService?: FridayAutoFixRiskAssessmentService;
  /** Optional memory service for persisting extracted preferences as searchable memory items. */
  memoryWriter?: FridayLearningMemoryWriter;
  idGenerator: () => string;
  nowIso: () => string;
}

function computeIncidentSignature(
  category: string,
  key: string,
  context: string,
): string {
  return createHash("sha256")
    .update(`incident:${category}:${key}:${context}`)
    .digest("hex")
    .slice(0, 16);
}

export function createFridaySelfLearningPipelineService(
  deps: CreateSelfLearningPipelineServiceDeps,
): FridaySelfLearningPipelineService {
  function processOne(
    event: FridayLearningEventAppendInput,
  ): FridaySelfLearningProcessResult {
    // 1. Collect event
    const { inserted } = deps.events.collect(event);

    // Short-circuit on duplicate events — no downstream writes
    if (!inserted) {
      return {
        eventId: event.eventId,
        inserted: false,
        extractedSignals: [],
        factsUpdated: [],
        incidentsCreated: [],
        diagnosisCreated: [],
        lessonsUpdated: [],
        lifecycleState: deps.lifecycle.getState(event.userId),
      };
    }

    // 2. Extract signals
    const extractedSignals = deps.extraction.extract(event);

    // 3. Update facts
    const nowIso = deps.nowIso();
    const factsUpdated = deps.facts.applySignals({
      event,
      signals: extractedSignals,
      nowIso,
    });

    // 3b. Persist preference signals to memory for cross-session retrieval
    if (deps.memoryWriter) {
      const preferenceSignals = extractedSignals.filter(
        (s) => s.kind === "preference" || s.kind === "correction",
      );
      for (const signal of preferenceSignals) {
        const content = typeof signal.value === "string"
          ? `${signal.key}: ${signal.value}`
          : `${signal.key}: ${JSON.stringify(signal.value)}`;
        // Fire-and-forget: must not block the synchronous pipeline
        void deps.memoryWriter.store("learning.preferences", content, {
          source: `learning:${event.userId}:${event.eventId}`,
          key: `pref:${signal.key}`,
          tags: ["learning", "auto", "preference", event.userId],
          memoryType: "preference",
          confidence: signal.confidence,
          ttlSeconds: 30 * 24 * 60 * 60, // 30 days
        }).catch(() => {/* non-fatal */});
      }
    }

    // 4. Classify/create incidents if error signals exist
    const errorSignals = extractedSignals.filter((s) => s.kind === "error");
    const incidentsCreated: FridayErrorIncidentEntity[] = [];
    const diagnosisCreated: FridayDiagnosisRecordEntity[] = [];
    const lessonsUpdated: FridayLearnedLessonEntity[] = [];

    if (errorSignals.length > 0) {
      deps.db.withWriteTransaction((db) => {
        for (const signal of errorSignals) {
          const signalValue = signal.value as JsonObject;
          const category =
            (signalValue["category"] as string) ??
            (signal.key.startsWith("tool_failure:") ? "tool" : "workflow");
          const signature =
            (signalValue["signature"] as string) ??
            computeIncidentSignature(category, signal.key, signal.sourceEventId);

          // Derive severity from signal context
          const VALID_SEVERITIES = new Set(["low", "medium", "high"]);
          const rawSeverity = (signalValue["severity"] as string) ?? "medium";
          const derivedSeverity = (
            VALID_SEVERITIES.has(rawSeverity) ? rawSeverity : "medium"
          ) as FridayErrorIncidentEntity["severity"];

          // Create incident (auto-fix eligibility determined below)
          const incident: FridayErrorIncidentEntity = {
            incidentId: deps.idGenerator(),
            userId: signal.userId,
            runId: signal.runId,
            nodeId: undefined,
            ts: signal.ts,
            category: category as FridayErrorIncidentEntity["category"],
            severity: derivedSeverity,
            signature,
            context: signalValue,
            autoFixEligible: false,
            status: "open",
            createdAt: nowIso,
            updatedAt: nowIso,
          };

          deps.incidentRepo.insert(db, incident);

          // Phase 7: Use diagnosis service if available
          if (deps.diagnosisService && deps.planService && deps.riskService && deps.actionRepo) {
            const diagOutcome = deps.diagnosisService.diagnoseInTransaction(db, {
              incident,
              nowIso,
            });

            // Update incident eligibility
            if (diagOutcome.autoFixEligible) {
              incident.autoFixEligible = true;
              deps.incidentRepo.setAutoFixEligibility(
                db,
                incident.incidentId,
                true,
                nowIso,
              );
            }

            diagnosisCreated.push(diagOutcome.diagnosis);

            // Build plans from diagnosis
            let plans = diagOutcome.candidatePlans;
            if (plans.length === 0 && diagOutcome.autoFixEligible) {
              plans = deps.planService.buildPlans({
                incident,
                diagnosis: diagOutcome.diagnosis,
                matchedLessons: diagOutcome.matchedLessons,
                recurrenceCount: diagOutcome.recurrenceCount,
              });
            }

            // Create auto-fix actions for eligible plans
            if (plans.length > 0 && diagOutcome.autoFixEligible) {
              const bestPlan = plans[0]!;
              const riskAssessment = deps.riskService.assess({
                incident,
                plan: bestPlan,
                nowIso,
              });

              const action: FridayAutoFixActionEntity = {
                actionId: deps.idGenerator(),
                incidentId: incident.incidentId,
                userId: incident.userId,
                riskTier: riskAssessment.riskTier,
                plan: bestPlan,
                rollbackPlan: bestPlan.rollbackPlan,
                status: "planned",
                outcome: null,
                createdAt: nowIso,
                updatedAt: nowIso,
              };

              deps.actionRepo.insert(db, action);

              // Create approval request for Tier 2
              if (riskAssessment.requiresApproval && deps.approvalRepo) {
                const expiresAt = new Date(
                  new Date(nowIso).getTime() + 24 * 60 * 60 * 1000,
                ).toISOString();
                const approvalRequest: FridayApprovalRequestEntity = {
                  requestId: deps.idGenerator(),
                  actionId: action.actionId,
                  runId: incident.runId,
                  userId: incident.userId,
                  description: `Approval needed: ${bestPlan.title}`,
                  riskTier: 2,
                  plan: bestPlan,
                  requestedAt: nowIso,
                  expiresAt,
                  status: "pending",
                  createdAt: nowIso,
                  updatedAt: nowIso,
                };
                deps.approvalRepo.insert(db, approvalRequest);
              }
            }

            // Phase 7: lesson extraction happens after successful auto-fix execution,
            // NOT during ingestion. See FridayAutoFixLessonExtractionService.
          } else {
            // Fallback: original Phase 6 behavior (no diagnosis service)
            const diagnosis: FridayDiagnosisRecordEntity = {
              id: deps.idGenerator(),
              incidentId: incident.incidentId,
              runId: signal.runId,
              nodeId: undefined,
              errorFingerprint: signature,
              confidence: signal.confidence,
              diagnosis: {
                signalKey: signal.key,
                category,
                autoDetected: true,
              } satisfies JsonObject,
              createdAt: nowIso,
              updatedAt: nowIso,
            };

            deps.diagnosisRepo.insert(db, diagnosis);
            diagnosisCreated.push(diagnosis);

            const lesson = deps.lessonRepo.upsertByFingerprint(db, {
              id: deps.idGenerator(),
              fingerprint: signature,
              title: `Error: ${signal.key}`,
              cause: `Detected via ${event.kind} event`,
              fix: `Review ${category} configuration`,
              sourceIncidentId: incident.incidentId,
              sourceDiagnosisId: diagnosis.id,
              nowIso,
            });
            lessonsUpdated.push(lesson);
          }

          incidentsCreated.push(incident);
        }
      });
    }

    // 7. Recompute lifecycle state
    const lifecycleState = deps.lifecycle.getState(event.userId);

    return {
      eventId: event.eventId,
      inserted,
      extractedSignals,
      factsUpdated,
      incidentsCreated,
      diagnosisCreated,
      lessonsUpdated,
      lifecycleState,
    };
  }

  return {
    processEvent: processOne,
    processBatch(events) {
      return events.map(processOne);
    },
  };
}
