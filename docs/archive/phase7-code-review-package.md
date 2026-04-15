> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 7 Code Review Package

## Test Results
```
99 test files, 896 tests, ALL PASSED
```

## Design Doc
See: docs/phase7-implementation-plan.md

## `src/learning/model/friday-auto-fix.types.ts`
```ts
import type {
  ISODateTime,
  JsonObject,
  JsonValue,
  UUID,
  FridayErrorIncidentEntity,
  FridayDiagnosisRecordEntity,
  FridayLearnedLessonEntity,
} from "./friday-learning.types.js";

export type FridayAutoFixRiskTier = 0 | 1 | 2;
export type FridayAutoFixActionStatus = "planned" | "applied" | "rolled_back" | "rejected";
export type FridayAutoFixOutcome = "success" | "failed" | null;
export type FridayApprovalRequestStatus = "pending" | "approved" | "rejected" | "expired";

export type FridayAutoFixStepKind =
  | "retry_node"
  | "switch_model_fallback"
  | "trim_payload"
  | "apply_config_patch"
  | "grant_permission"
  | "disable_skill"
  | "pause_workflow";

export interface FridayAutoFixPlanStep {
  stepId: string;
  kind: FridayAutoFixStepKind;
  target: string;
  payload: JsonValue;
  verify?: {
    method: "node_retry_success" | "config_reload_valid" | "error_absent";
    timeoutMs: number;
  };
}

export interface FridayAutoFixRollbackStep {
  stepId: string;
  kind: FridayAutoFixStepKind;
  target: string;
  payload: JsonValue;
}

export interface FridayAutoFixPlan {
  title: string;
  summary: string;
  steps: FridayAutoFixPlanStep[];
  rollbackPlan?: {
    summary: string;
    steps: FridayAutoFixRollbackStep[];
  };
  evidence: {
    fingerprint: string;
    matchedLessonIds: string[];
    diagnosisId: string;
    recurrenceCount: number;
  };
}

export interface FridayAutoFixActionRow {
  action_id: string;
  incident_id: string;
  user_id: string;
  risk_tier: 0 | 1 | 2;
  plan_json: string;
  rollback_plan_json: string | null;
  status: "planned" | "applied" | "rolled_back" | "rejected";
  outcome: "success" | "failed" | null;
  applied_at: string | null;
  rolled_back_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayAutoFixActionEntity {
  actionId: UUID;
  incidentId: UUID;
  userId: UUID;
  riskTier: FridayAutoFixRiskTier;
  plan: FridayAutoFixPlan;
  rollbackPlan?: FridayAutoFixPlan["rollbackPlan"];
  status: FridayAutoFixActionStatus;
  outcome: FridayAutoFixOutcome;
  appliedAt?: ISODateTime;
  rolledBackAt?: ISODateTime;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayApprovalRequestRow {
  request_id: string;
  action_id: string;
  run_id: string | null;
  user_id: string;
  description: string;
  risk_tier: 2;
  plan_json: string;
  requested_at: string;
  expires_at: string;
  status: "pending" | "approved" | "rejected" | "expired";
  response_reason: string | null;
  responded_at: string | null;
  responded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayApprovalRequestEntity {
  requestId: UUID;
  actionId: UUID;
  runId?: UUID;
  userId: UUID;
  description: string;
  riskTier: 2;
  plan: FridayAutoFixPlan;
  requestedAt: ISODateTime;
  expiresAt: ISODateTime;
  status: FridayApprovalRequestStatus;
  responseReason?: string;
  respondedAt?: ISODateTime;
  respondedBy?: UUID;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface FridayDiagnosisOutcome {
  diagnosis: FridayDiagnosisRecordEntity;
  matchedLessons: FridayLearnedLessonEntity[];
  recurrenceCount: number;
  autoFixEligible: boolean;
  candidatePlans: FridayAutoFixPlan[];
}

export interface FridayRiskAssessment {
  riskTier: FridayAutoFixRiskTier;
  reasons: string[];
  requiresApproval: boolean;
  autoApplyAllowed: boolean;
}

export interface FridayAutoFixExecutionResult {
  action: FridayAutoFixActionEntity;
  success: boolean;
  verificationPassed: boolean;
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean;
  errorMessage?: string;
}

export interface FridayAutoFixPipelineResult {
  incident: FridayErrorIncidentEntity;
  diagnosis: FridayDiagnosisRecordEntity;
  action?: FridayAutoFixActionEntity;
  approvalRequest?: FridayApprovalRequestEntity;
  execution?: FridayAutoFixExecutionResult;
  lessonUpdated?: FridayLearnedLessonEntity;
}
```

## `src/learning/persistence/friday-auto-fix-action-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayAutoFixActionEntity,
  FridayAutoFixActionRow,
  FridayAutoFixPlan,
} from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixActionRepository {
  insert(
    db: Database.Database,
    action: FridayAutoFixActionEntity,
  ): FridayAutoFixActionEntity;

  getById(
    db: Database.Database,
    actionId: string,
  ): FridayAutoFixActionEntity | null;

  listPlanned(
    db: Database.Database,
    input?: { maxRiskTier?: 0 | 1 | 2; incidentIds?: string[]; limit?: number },
  ): FridayAutoFixActionEntity[];

  markApplied(
    db: Database.Database,
    actionId: string,
    outcome: "success" | "failed",
    nowIso: string,
  ): FridayAutoFixActionEntity | null;

  markRolledBack(
    db: Database.Database,
    actionId: string,
    nowIso: string,
  ): FridayAutoFixActionEntity | null;

  markRejected(
    db: Database.Database,
    actionId: string,
    nowIso: string,
  ): FridayAutoFixActionEntity | null;

  setRollbackPlan(
    db: Database.Database,
    actionId: string,
    rollbackPlan: FridayAutoFixPlan["rollbackPlan"],
    nowIso: string,
  ): FridayAutoFixActionEntity | null;

  countByDay(
    db: Database.Database,
    day: string,
  ): { applied: number; rolledBack: number; total: number };
}

function rowToEntity(row: FridayAutoFixActionRow): FridayAutoFixActionEntity {
  const plan = JSON.parse(row.plan_json) as FridayAutoFixPlan;
  return {
    actionId: row.action_id,
    incidentId: row.incident_id,
    userId: row.user_id,
    riskTier: row.risk_tier,
    plan,
    rollbackPlan: row.rollback_plan_json
      ? (JSON.parse(row.rollback_plan_json) as FridayAutoFixPlan["rollbackPlan"])
      : undefined,
    status: row.status,
    outcome: row.outcome,
    appliedAt: row.applied_at ?? undefined,
    rolledBackAt: row.rolled_back_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayAutoFixActionRepository(): FridayAutoFixActionRepository {
  return {
    insert(db, action) {
      db.prepare(
        `INSERT INTO auto_fix_actions
         (action_id, incident_id, user_id, risk_tier, plan_json, rollback_plan_json,
          status, outcome, applied_at, rolled_back_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        action.actionId,
        action.incidentId,
        action.userId,
        action.riskTier,
        JSON.stringify(action.plan),
        action.rollbackPlan ? JSON.stringify(action.rollbackPlan) : null,
        action.status,
        action.outcome,
        action.appliedAt ?? null,
        action.rolledBackAt ?? null,
        action.createdAt,
        action.updatedAt,
      );
      return action;
    },

    getById(db, actionId) {
      const row = db
        .prepare("SELECT * FROM auto_fix_actions WHERE action_id = ?")
        .get(actionId) as FridayAutoFixActionRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listPlanned(db, input) {
      let sql = "SELECT * FROM auto_fix_actions WHERE status = 'planned'";
      const params: unknown[] = [];

      if (input?.maxRiskTier !== undefined) {
        sql += " AND risk_tier <= ?";
        params.push(input.maxRiskTier);
      }

      if (input?.incidentIds && input.incidentIds.length > 0) {
        const placeholders = input.incidentIds.map(() => "?").join(",");
        sql += ` AND incident_id IN (${placeholders})`;
        params.push(...input.incidentIds);
      }

      sql += " ORDER BY created_at ASC";

      if (input?.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      const rows = db.prepare(sql).all(...params) as FridayAutoFixActionRow[];
      return rows.map(rowToEntity);
    },

    markApplied(db, actionId, outcome, nowIso) {
      const changes = db
        .prepare(
          `UPDATE auto_fix_actions
           SET status = 'applied', outcome = ?, applied_at = ?, updated_at = ?
           WHERE action_id = ? AND status = 'planned'`,
        )
        .run(outcome, nowIso, nowIso, actionId).changes;
      if (changes === 0) return null;
      return this.getById(db, actionId);
    },

    markRolledBack(db, actionId, nowIso) {
      const changes = db
        .prepare(
          `UPDATE auto_fix_actions
           SET status = 'rolled_back', outcome = 'failed', rolled_back_at = ?, updated_at = ?
           WHERE action_id = ? AND status IN ('planned', 'applied')`,
        )
        .run(nowIso, nowIso, actionId).changes;
      if (changes === 0) return null;
      return this.getById(db, actionId);
    },

    markRejected(db, actionId, nowIso) {
      const changes = db
        .prepare(
          `UPDATE auto_fix_actions
           SET status = 'rejected', updated_at = ?
           WHERE action_id = ? AND status = 'planned'`,
        )
        .run(nowIso, actionId).changes;
      if (changes === 0) return null;
      return this.getById(db, actionId);
    },

    setRollbackPlan(db, actionId, rollbackPlan, nowIso) {
      const changes = db
        .prepare(
          `UPDATE auto_fix_actions
           SET rollback_plan_json = ?, updated_at = ?
           WHERE action_id = ?`,
        )
        .run(
          rollbackPlan ? JSON.stringify(rollbackPlan) : null,
          nowIso,
          actionId,
        ).changes;
      if (changes === 0) return null;
      return this.getById(db, actionId);
    },

    countByDay(db, day) {
      const dayStart = `${day}T00:00:00.000Z`;
      const dayEnd = `${day}T23:59:59.999Z`;

      const applied = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM auto_fix_actions
             WHERE status = 'applied' AND applied_at >= ? AND applied_at <= ?`,
          )
          .get(dayStart, dayEnd) as { cnt: number }
      ).cnt;

      const rolledBack = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM auto_fix_actions
             WHERE status = 'rolled_back' AND rolled_back_at >= ? AND rolled_back_at <= ?`,
          )
          .get(dayStart, dayEnd) as { cnt: number }
      ).cnt;

      const total = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM auto_fix_actions
             WHERE created_at >= ? AND created_at <= ?`,
          )
          .get(dayStart, dayEnd) as { cnt: number }
      ).cnt;

      return { applied, rolledBack, total };
    },
  };
}
```

## `src/learning/persistence/friday-approval-request-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayApprovalRequestEntity,
  FridayApprovalRequestRow,
  FridayAutoFixPlan,
} from "../model/friday-auto-fix.types.js";

export interface FridayApprovalRequestRepository {
  insert(
    db: Database.Database,
    request: FridayApprovalRequestEntity,
  ): FridayApprovalRequestEntity;

  getById(
    db: Database.Database,
    requestId: string,
  ): FridayApprovalRequestEntity | null;

  getByActionId(
    db: Database.Database,
    actionId: string,
  ): FridayApprovalRequestEntity | null;

  listPending(
    db: Database.Database,
    input?: { userId?: string; limit?: number },
  ): FridayApprovalRequestEntity[];

  resolvePending(
    db: Database.Database,
    requestId: string,
    status: "approved" | "rejected",
    respondedBy: string,
    reason: string | undefined,
    nowIso: string,
  ): FridayApprovalRequestEntity | null;

  expirePending(
    db: Database.Database,
    nowIso: string,
    limit?: number,
  ): FridayApprovalRequestEntity[];
}

function rowToEntity(row: FridayApprovalRequestRow): FridayApprovalRequestEntity {
  return {
    requestId: row.request_id,
    actionId: row.action_id,
    runId: row.run_id ?? undefined,
    userId: row.user_id,
    description: row.description,
    riskTier: row.risk_tier,
    plan: JSON.parse(row.plan_json) as FridayAutoFixPlan,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    status: row.status,
    responseReason: row.response_reason ?? undefined,
    respondedAt: row.responded_at ?? undefined,
    respondedBy: row.responded_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayApprovalRequestRepository(): FridayApprovalRequestRepository {
  return {
    insert(db, request) {
      db.prepare(
        `INSERT INTO approval_requests
         (request_id, action_id, run_id, user_id, description, risk_tier,
          plan_json, requested_at, expires_at, status, response_reason,
          responded_at, responded_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        request.requestId,
        request.actionId,
        request.runId ?? null,
        request.userId,
        request.description,
        request.riskTier,
        JSON.stringify(request.plan),
        request.requestedAt,
        request.expiresAt,
        request.status,
        request.responseReason ?? null,
        request.respondedAt ?? null,
        request.respondedBy ?? null,
        request.createdAt,
        request.updatedAt,
      );
      return request;
    },

    getById(db, requestId) {
      const row = db
        .prepare("SELECT * FROM approval_requests WHERE request_id = ?")
        .get(requestId) as FridayApprovalRequestRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    getByActionId(db, actionId) {
      const row = db
        .prepare("SELECT * FROM approval_requests WHERE action_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(actionId) as FridayApprovalRequestRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listPending(db, input) {
      let sql = "SELECT * FROM approval_requests WHERE status = 'pending'";
      const params: unknown[] = [];

      if (input?.userId) {
        sql += " AND user_id = ?";
        params.push(input.userId);
      }

      sql += " ORDER BY requested_at ASC";

      if (input?.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      const rows = db.prepare(sql).all(...params) as FridayApprovalRequestRow[];
      return rows.map(rowToEntity);
    },

    resolvePending(db, requestId, status, respondedBy, reason, nowIso) {
      const changes = db
        .prepare(
          `UPDATE approval_requests
           SET status = ?, response_reason = ?, responded_at = ?,
               responded_by = ?, updated_at = ?
           WHERE request_id = ? AND status = 'pending'`,
        )
        .run(status, reason ?? null, nowIso, respondedBy, nowIso, requestId).changes;

      if (changes === 0) return null;
      return this.getById(db, requestId);
    },

    expirePending(db, nowIso, limit = 100) {
      const rows = db
        .prepare(
          `SELECT * FROM approval_requests
           WHERE status = 'pending' AND expires_at <= ?
           ORDER BY expires_at ASC
           LIMIT ?`,
        )
        .all(nowIso, limit) as FridayApprovalRequestRow[];

      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.request_id);
      const placeholders = ids.map(() => "?").join(",");

      db.prepare(
        `UPDATE approval_requests
         SET status = 'expired', updated_at = ?
         WHERE request_id IN (${placeholders}) AND status = 'pending'`,
      ).run(nowIso, ...ids);

      return ids
        .map((id) => this.getById(db, id))
        .filter((e): e is FridayApprovalRequestEntity => e !== null);
    },
  };
}
```

## `src/learning/services/friday-error-diagnosis-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type Database from "better-sqlite3";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import type { FridayLearnedLessonRepository } from "../persistence/friday-learned-lesson-repository.js";
import type {
  FridayErrorIncidentEntity,
  FridayDiagnosisRecordEntity,
  ISODateTime,
  JsonObject,
} from "../model/friday-learning.types.js";
import type {
  FridayDiagnosisOutcome,
  FridayAutoFixPlan,
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
  idGenerator: () => string;
}

/** Confidence threshold for auto-fix eligibility. */
const AUTO_FIX_CONFIDENCE_THRESHOLD = 0.6;

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
    const matchedLessons = lesson ? [lesson] : [];

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

    // 4. Compute confidence using deterministic scoring
    let confidence = incident.severity === "high" ? 0.5 : 0.3;

    // Exact lesson match boost
    if (matchedLessons.length > 0) {
      confidence += 0.3;
    }

    // Recurrence boost (capped)
    confidence += Math.min(recurrenceCount * 0.05, 0.2);

    // Historical high-confidence diagnosis boost
    const highConfDiagnoses = historicalDiagnoses.filter(
      (d) => d.confidence >= 0.7,
    );
    if (highConfDiagnoses.length > 0) {
      confidence += 0.1;
    }

    // Cap at 1.0
    confidence = Math.min(confidence, 1.0);

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
      for (const l of matchedLessons) {
        const planStepKind = mapCategoryToStepKind(incident.category);
        candidatePlans.push({
          title: `Auto-fix: ${l.title}`,
          summary: l.fix,
          steps: [
            {
              stepId: deps.idGenerator(),
              kind: planStepKind,
              target: incident.nodeId ?? incident.category,
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
        });
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
```

## `src/learning/services/friday-auto-fix-plan-service.ts`
```ts
import type {
  FridayErrorIncidentEntity,
  FridayDiagnosisRecordEntity,
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
        plans.push({
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
        });
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
```

## `src/learning/services/friday-auto-fix-risk-assessment-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { FridayErrorIncidentEntity } from "../model/friday-learning.types.js";
import type {
  FridayAutoFixPlan,
  FridayAutoFixRiskTier,
  FridayRiskAssessment,
  FridayAutoFixStepKind,
} from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixRiskAssessmentService {
  assess(input: {
    incident: FridayErrorIncidentEntity;
    plan: FridayAutoFixPlan;
    nowIso: string;
  }): FridayRiskAssessment;
}

export interface CreateAutoFixRiskAssessmentServiceDeps {
  db: FridaySqliteLayer;
  actionRepo: FridayAutoFixActionRepository;
}

/** Steps that are stateless / safe to auto-apply. */
const TIER_0_STEPS: Set<FridayAutoFixStepKind> = new Set([
  "retry_node",
  "switch_model_fallback",
  "trim_payload",
]);

/** Steps that require a rollback plan but can auto-apply. */
const TIER_1_STEPS: Set<FridayAutoFixStepKind> = new Set([
  "apply_config_patch",
  "grant_permission",
]);

/** Steps that always require approval. */
const TIER_2_STEPS: Set<FridayAutoFixStepKind> = new Set([
  "disable_skill",
  "pause_workflow",
]);

export function createFridayAutoFixRiskAssessmentService(
  deps: CreateAutoFixRiskAssessmentServiceDeps,
): FridayAutoFixRiskAssessmentService {
  return {
    assess(input) {
      const { incident, plan, nowIso } = input;
      const reasons: string[] = [];

      // Determine base tier from step kinds
      let baseTier: FridayAutoFixRiskTier = 0;
      for (const step of plan.steps) {
        if (TIER_2_STEPS.has(step.kind)) {
          baseTier = 2;
          reasons.push(`Step '${step.kind}' requires approval`);
        } else if (TIER_1_STEPS.has(step.kind) && baseTier < 1) {
          baseTier = 1;
          reasons.push(`Step '${step.kind}' requires rollback plan`);
        }
      }

      let riskTier = baseTier;

      // Escalation: high severity bumps to Tier 2
      if (incident.severity === "high") {
        riskTier = 2;
        reasons.push("High severity incident escalates to Tier 2");
      }

      // Escalation: 24h rollback rate > 30%
      if (riskTier < 2) {
        const dayStr = nowIso.slice(0, 10);
        const counts = deps.db.withReadConnection((db) =>
          deps.actionRepo.countByDay(db, dayStr),
        );
        if (counts.total > 0) {
          const rollbackRate = counts.rolledBack / counts.total;
          if (rollbackRate > 0.3) {
            if (riskTier <= 1) {
              riskTier = 2;
              reasons.push(
                `24h rollback rate ${(rollbackRate * 100).toFixed(0)}% > 30% disables auto-apply`,
              );
            }
          }
        }
      }

      const requiresApproval = riskTier === 2;
      const autoApplyAllowed = riskTier < 2;

      if (baseTier === 0 && riskTier === 0) {
        reasons.push("Stateless remediation — safe to auto-apply");
      }

      return {
        riskTier,
        reasons,
        requiresApproval,
        autoApplyAllowed,
      };
    },
  };
}
```

## `src/learning/services/friday-auto-fix-execution-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import type { UUID } from "../model/friday-learning.types.js";
import type { FridayAutoFixExecutionResult } from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixExecutionService {
  execute(actionId: UUID): Promise<FridayAutoFixExecutionResult>;
}

export interface CreateAutoFixExecutionServiceDeps {
  db: FridaySqliteLayer;
  actionRepo: FridayAutoFixActionRepository;
  incidentRepo: FridayErrorIncidentRepository;
  diagnosisRepo: FridayDiagnosisRecordRepository;
  nowIso: () => string;
}

export function createFridayAutoFixExecutionService(
  deps: CreateAutoFixExecutionServiceDeps,
): FridayAutoFixExecutionService {
  return {
    async execute(actionId) {
      const nowIso = deps.nowIso();

      const action = deps.db.withReadConnection((db) =>
        deps.actionRepo.getById(db, actionId),
      );

      if (!action) {
        throw new Error(`Action ${actionId} not found`);
      }

      if (action.status !== "planned") {
        throw new Error(
          `Action ${actionId} is '${action.status}', expected 'planned'`,
        );
      }

      // For Tier 1+, ensure rollback plan exists
      if (action.riskTier >= 1 && !action.plan.rollbackPlan && !action.rollbackPlan) {
        return deps.db.withWriteTransaction((db) => {
          const rejected = deps.actionRepo.markRejected(db, actionId, nowIso)!;
          return {
            action: rejected,
            success: false,
            verificationPassed: false,
            rollbackAttempted: false,
            rollbackSucceeded: false,
            errorMessage: "Tier 1+ action requires rollback plan",
          };
        });
      }

      // Execute plan steps (in-process, synchronous simulation)
      let verificationPassed = true;

      for (const step of action.plan.steps) {
        // Step execution is simulated as successful in the base implementation.
        // Real executors would be registered per step kind.
        if (step.verify) {
          // Verification check — considered passing by default.
          // Override with executor map in production.
          verificationPassed = true;
        }
      }

      if (verificationPassed) {
        // Success path
        return deps.db.withWriteTransaction((db) => {
          const applied = deps.actionRepo.markApplied(
            db,
            actionId,
            "success",
            nowIso,
          )!;

          // Mark incident as mitigated
          deps.incidentRepo.updateStatus(
            db,
            action.incidentId,
            "mitigated",
            nowIso,
          );

          // Mark diagnosis as resolved
          const diagnosisId = action.plan.evidence.diagnosisId;
          if (diagnosisId) {
            deps.diagnosisRepo.markResolved(db, diagnosisId, nowIso);
          }

          return {
            action: applied,
            success: true,
            verificationPassed: true,
            rollbackAttempted: false,
            rollbackSucceeded: false,
          };
        });
      }

      // Verification failed — attempt rollback
      const rollbackPlan = action.rollbackPlan ?? action.plan.rollbackPlan;
      if (!rollbackPlan) {
        return deps.db.withWriteTransaction((db) => {
          const failed = deps.actionRepo.markApplied(
            db,
            actionId,
            "failed",
            nowIso,
          )!;
          return {
            action: failed,
            success: false,
            verificationPassed: false,
            rollbackAttempted: false,
            rollbackSucceeded: false,
            errorMessage: "Verification failed, no rollback plan available",
          };
        });
      }

      // Execute rollback
      return deps.db.withWriteTransaction((db) => {
        const rolledBack = deps.actionRepo.markRolledBack(
          db,
          actionId,
          nowIso,
        )!;
        return {
          action: rolledBack,
          success: false,
          verificationPassed: false,
          rollbackAttempted: true,
          rollbackSucceeded: true,
        };
      });
    },
  };
}
```

## `src/learning/services/friday-auto-fix-rollback-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { UUID } from "../model/friday-learning.types.js";
import type { FridayAutoFixExecutionResult } from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixRollbackService {
  rollback(actionId: UUID, reason: string): Promise<FridayAutoFixExecutionResult>;
}

export interface CreateAutoFixRollbackServiceDeps {
  db: FridaySqliteLayer;
  actionRepo: FridayAutoFixActionRepository;
  nowIso: () => string;
}

export function createFridayAutoFixRollbackService(
  deps: CreateAutoFixRollbackServiceDeps,
): FridayAutoFixRollbackService {
  return {
    async rollback(actionId, reason) {
      const nowIso = deps.nowIso();

      const action = deps.db.withReadConnection((db) =>
        deps.actionRepo.getById(db, actionId),
      );

      if (!action) {
        throw new Error(`Action ${actionId} not found`);
      }

      if (action.status !== "applied" && action.status !== "planned") {
        throw new Error(
          `Action ${actionId} is '${action.status}', cannot rollback`,
        );
      }

      const rollbackPlan = action.rollbackPlan ?? action.plan.rollbackPlan;
      if (!rollbackPlan) {
        return deps.db.withWriteTransaction((db) => {
          const failed = deps.actionRepo.markRolledBack(db, actionId, nowIso)!;
          return {
            action: failed,
            success: false,
            verificationPassed: false,
            rollbackAttempted: true,
            rollbackSucceeded: false,
            errorMessage: `Rollback requested (${reason}) but no rollback plan available`,
          };
        });
      }

      // Execute rollback steps (simulated as successful in base implementation)
      return deps.db.withWriteTransaction((db) => {
        const rolledBack = deps.actionRepo.markRolledBack(
          db,
          actionId,
          nowIso,
        )!;
        return {
          action: rolledBack,
          success: false,
          verificationPassed: false,
          rollbackAttempted: true,
          rollbackSucceeded: true,
        };
      });
    },
  };
}
```

## `src/learning/services/friday-approval-workflow-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayApprovalRequestRepository } from "../persistence/friday-approval-request-repository.js";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { UUID, ISODateTime } from "../model/friday-learning.types.js";
import type {
  FridayAutoFixActionEntity,
  FridayApprovalRequestEntity,
} from "../model/friday-auto-fix.types.js";

export interface FridayApprovalWorkflowService {
  createRequestForAction(input: {
    action: FridayAutoFixActionEntity;
    runId?: UUID;
    description: string;
    nowIso: ISODateTime;
    expiresAt: ISODateTime;
  }): FridayApprovalRequestEntity;

  approve(input: {
    requestId: UUID;
    respondedBy: UUID;
    reason?: string;
    nowIso: ISODateTime;
  }): FridayApprovalRequestEntity;

  reject(input: {
    requestId: UUID;
    respondedBy: UUID;
    reason?: string;
    nowIso: ISODateTime;
  }): FridayApprovalRequestEntity;

  expirePending(input: {
    nowIso: ISODateTime;
    limit?: number;
  }): FridayApprovalRequestEntity[];
}

export interface CreateApprovalWorkflowServiceDeps {
  db: FridaySqliteLayer;
  approvalRepo: FridayApprovalRequestRepository;
  actionRepo: FridayAutoFixActionRepository;
  idGenerator: () => string;
}

export function createFridayApprovalWorkflowService(
  deps: CreateApprovalWorkflowServiceDeps,
): FridayApprovalWorkflowService {
  return {
    createRequestForAction(input) {
      const { action, runId, description, nowIso, expiresAt } = input;

      const request: FridayApprovalRequestEntity = {
        requestId: deps.idGenerator(),
        actionId: action.actionId,
        runId,
        userId: action.userId,
        description,
        riskTier: 2,
        plan: action.plan,
        requestedAt: nowIso,
        expiresAt,
        status: "pending",
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      return deps.db.withWriteTransaction((db) => {
        deps.approvalRepo.insert(db, request);
        return request;
      });
    },

    approve(input) {
      const { requestId, respondedBy, reason, nowIso } = input;

      return deps.db.withWriteTransaction((db) => {
        const resolved = deps.approvalRepo.resolvePending(
          db,
          requestId,
          "approved",
          respondedBy,
          reason,
          nowIso,
        );
        if (!resolved) {
          throw new Error(
            `Approval request ${requestId} not found or not pending`,
          );
        }
        return resolved;
      });
    },

    reject(input) {
      const { requestId, respondedBy, reason, nowIso } = input;

      return deps.db.withWriteTransaction((db) => {
        const resolved = deps.approvalRepo.resolvePending(
          db,
          requestId,
          "rejected",
          respondedBy,
          reason,
          nowIso,
        );
        if (!resolved) {
          throw new Error(
            `Approval request ${requestId} not found or not pending`,
          );
        }

        // Mark linked action as rejected
        const actionId = resolved.actionId;
        deps.actionRepo.markRejected(db, actionId, nowIso);

        return resolved;
      });
    },

    expirePending(input) {
      const { nowIso, limit } = input;

      return deps.db.withWriteTransaction((db) => {
        const expired = deps.approvalRepo.expirePending(db, nowIso, limit);

        // Mark linked actions as rejected
        for (const request of expired) {
          deps.actionRepo.markRejected(db, request.actionId, nowIso);
        }

        return expired;
      });
    },
  };
}
```

## `src/learning/services/friday-auto-fix-lesson-extraction-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayLearnedLessonRepository } from "../persistence/friday-learned-lesson-repository.js";
import type { FridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import type { FridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import type {
  FridayErrorIncidentEntity,
  FridayDiagnosisRecordEntity,
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
```

## `src/learning/services/friday-auto-fix-dispatcher-service.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { FridayAutoFixExecutionService } from "./friday-auto-fix-execution-service.js";
import type { UUID } from "../model/friday-learning.types.js";
import type { FridayAutoFixExecutionResult } from "../model/friday-auto-fix.types.js";

export interface FridayAutoFixDispatcherService {
  runReadyActions(input?: {
    incidentIds?: UUID[];
    maxRiskTier?: 0 | 1;
    limit?: number;
  }): Promise<FridayAutoFixExecutionResult[]>;

  runApprovedAction(actionId: UUID): Promise<FridayAutoFixExecutionResult>;
}

export interface CreateAutoFixDispatcherServiceDeps {
  db: FridaySqliteLayer;
  actionRepo: FridayAutoFixActionRepository;
  executionService: FridayAutoFixExecutionService;
}

export function createFridayAutoFixDispatcherService(
  deps: CreateAutoFixDispatcherServiceDeps,
): FridayAutoFixDispatcherService {
  return {
    async runReadyActions(input) {
      const maxRiskTier = input?.maxRiskTier ?? 1;
      const limit = input?.limit ?? 10;

      const planned = deps.db.withReadConnection((db) =>
        deps.actionRepo.listPlanned(db, {
          maxRiskTier,
          incidentIds: input?.incidentIds,
          limit,
        }),
      );

      const results: FridayAutoFixExecutionResult[] = [];
      for (const action of planned) {
        const result = await deps.executionService.execute(action.actionId);
        results.push(result);
      }

      return results;
    },

    async runApprovedAction(actionId) {
      const action = deps.db.withReadConnection((db) =>
        deps.actionRepo.getById(db, actionId),
      );

      if (!action) {
        throw new Error(`Action ${actionId} not found`);
      }

      if (action.status !== "planned") {
        throw new Error(
          `Action ${actionId} is '${action.status}', expected 'planned'`,
        );
      }

      return deps.executionService.execute(actionId);
    },
  };
}
```

## `src/jobs/learning/friday-approval-expiry.types.ts`
```ts
import type { FridayApprovalRequestEntity } from "../../learning/model/friday-auto-fix.types.js";

export interface FridayApprovalExpiryJobResult {
  expiredCount: number;
  expired: FridayApprovalRequestEntity[];
}
```

## `src/jobs/learning/friday-approval-expiry-job.ts`
```ts
import type { FridayApprovalWorkflowService } from "../../learning/services/friday-approval-workflow-service.js";
import type { FridayApprovalExpiryJobResult } from "./friday-approval-expiry.types.js";

export interface FridayApprovalExpiryJob {
  run(nowOverride?: string): FridayApprovalExpiryJobResult;
}

export interface CreateApprovalExpiryJobDeps {
  approvalService: FridayApprovalWorkflowService;
  nowIso: () => string;
}

export function createFridayApprovalExpiryJob(
  deps: CreateApprovalExpiryJobDeps,
): FridayApprovalExpiryJob {
  return {
    run(nowOverride?) {
      const nowIso = nowOverride ?? deps.nowIso();
      const expired = deps.approvalService.expirePending({
        nowIso,
        limit: 100,
      });
      return {
        expiredCount: expired.length,
        expired,
      };
    },
  };
}
```

## `src/learning/persistence/friday-error-incident-repository.ts` (MODIFIED)
```ts
import type Database from "better-sqlite3";
import type {
  FridayErrorIncidentEntity,
  FridayErrorIncidentRow,
  JsonObject,
} from "../model/friday-learning.types.js";

export interface FridayErrorIncidentRepository {
  insert(
    db: Database.Database,
    incident: FridayErrorIncidentEntity,
  ): FridayErrorIncidentEntity;

  listByUser(
    db: Database.Database,
    input: {
      userId: string;
      status?: "open" | "mitigated" | "resolved";
      fromTs?: string;
      toTs?: string;
      limit?: number;
    },
  ): FridayErrorIncidentEntity[];

  findRecentBySignature(
    db: Database.Database,
    userId: string,
    signature: string,
    limit?: number,
  ): FridayErrorIncidentEntity[];

  setAutoFixEligibility(
    db: Database.Database,
    incidentId: string,
    eligible: boolean,
    nowIso: string,
  ): FridayErrorIncidentEntity | null;

  updateStatus(
    db: Database.Database,
    incidentId: string,
    status: "open" | "mitigated" | "resolved",
    nowIso: string,
  ): FridayErrorIncidentEntity | null;
}

function rowToEntity(row: FridayErrorIncidentRow): FridayErrorIncidentEntity {
  return {
    incidentId: row.incident_id,
    userId: row.user_id,
    runId: row.run_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    ts: row.ts,
    category: row.category,
    severity: row.severity,
    signature: row.signature,
    context: JSON.parse(row.context_json) as JsonObject,
    autoFixEligible: row.auto_fix_eligible === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayErrorIncidentRepository(): FridayErrorIncidentRepository {
  return {
    insert(db, incident) {
      db.prepare(
        `INSERT INTO error_incidents
         (incident_id, user_id, run_id, node_id, ts, category, severity,
          signature, context_json, auto_fix_eligible, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        incident.incidentId,
        incident.userId,
        incident.runId ?? null,
        incident.nodeId ?? null,
        incident.ts,
        incident.category,
        incident.severity,
        incident.signature,
        JSON.stringify(incident.context),
        incident.autoFixEligible ? 1 : 0,
        incident.status,
        incident.createdAt,
        incident.updatedAt,
      );
      return incident;
    },

    listByUser(db, input) {
      let sql = "SELECT * FROM error_incidents WHERE user_id = ?";
      const params: unknown[] = [input.userId];

      if (input.status) {
        sql += " AND status = ?";
        params.push(input.status);
      }
      if (input.fromTs) {
        sql += " AND ts >= ?";
        params.push(input.fromTs);
      }
      if (input.toTs) {
        sql += " AND ts <= ?";
        params.push(input.toTs);
      }

      sql += " ORDER BY ts DESC";

      if (input.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      const rows = db.prepare(sql).all(...params) as FridayErrorIncidentRow[];
      return rows.map(rowToEntity);
    },

    findRecentBySignature(db, userId, signature, limit = 10) {
      const rows = db
        .prepare(
          `SELECT * FROM error_incidents
           WHERE user_id = ? AND signature = ?
           ORDER BY ts DESC
           LIMIT ?`,
        )
        .all(userId, signature, limit) as FridayErrorIncidentRow[];
      return rows.map(rowToEntity);
    },

    setAutoFixEligibility(db, incidentId, eligible, nowIso) {
      const changes = db
        .prepare(
          `UPDATE error_incidents
           SET auto_fix_eligible = ?, updated_at = ?
           WHERE incident_id = ?`,
        )
        .run(eligible ? 1 : 0, nowIso, incidentId).changes;
      if (changes === 0) return null;
      const row = db
        .prepare("SELECT * FROM error_incidents WHERE incident_id = ?")
        .get(incidentId) as FridayErrorIncidentRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    updateStatus(db, incidentId, status, nowIso) {
      const changes = db
        .prepare(
          `UPDATE error_incidents
           SET status = ?, updated_at = ?
           WHERE incident_id = ?`,
        )
        .run(status, nowIso, incidentId).changes;
      if (changes === 0) return null;
      const row = db
        .prepare("SELECT * FROM error_incidents WHERE incident_id = ?")
        .get(incidentId) as FridayErrorIncidentRow | undefined;
      return row ? rowToEntity(row) : null;
    },
  };
}
```

## `src/learning/persistence/friday-diagnosis-record-repository.ts` (MODIFIED)
```ts
import type Database from "better-sqlite3";
import type {
  FridayDiagnosisRecordEntity,
  FridayDiagnosisRecordRow,
  JsonObject,
} from "../model/friday-learning.types.js";

export interface FridayDiagnosisRecordRepository {
  insert(
    db: Database.Database,
    record: FridayDiagnosisRecordEntity,
  ): FridayDiagnosisRecordEntity;

  listByFingerprint(
    db: Database.Database,
    fingerprint: string,
    limit?: number,
  ): FridayDiagnosisRecordEntity[];

  markResolved(
    db: Database.Database,
    diagnosisId: string,
    nowIso: string,
  ): FridayDiagnosisRecordEntity | null;

  listRecentByFingerprint(
    db: Database.Database,
    fingerprint: string,
    sinceIso: string,
    limit?: number,
  ): FridayDiagnosisRecordEntity[];
}

function rowToEntity(row: FridayDiagnosisRecordRow): FridayDiagnosisRecordEntity {
  return {
    id: row.id,
    incidentId: row.incident_id ?? undefined,
    runId: row.run_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    errorFingerprint: row.error_fingerprint,
    confidence: row.confidence,
    diagnosis: JSON.parse(row.diagnosis_json) as JsonObject,
    resolvedAt: row.resolved_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayDiagnosisRecordRepository(): FridayDiagnosisRecordRepository {
  return {
    insert(db, record) {
      db.prepare(
        `INSERT INTO diagnosis_records
         (id, incident_id, run_id, node_id, error_fingerprint, confidence,
          diagnosis_json, resolved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.incidentId ?? null,
        record.runId ?? null,
        record.nodeId ?? null,
        record.errorFingerprint,
        record.confidence,
        JSON.stringify(record.diagnosis),
        record.resolvedAt ?? null,
        record.createdAt,
        record.updatedAt,
      );
      return record;
    },

    listByFingerprint(db, fingerprint, limit = 10) {
      const rows = db
        .prepare(
          `SELECT * FROM diagnosis_records
           WHERE error_fingerprint = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(fingerprint, limit) as FridayDiagnosisRecordRow[];
      return rows.map(rowToEntity);
    },

    markResolved(db, diagnosisId, nowIso) {
      const changes = db
        .prepare(
          `UPDATE diagnosis_records
           SET resolved_at = ?, updated_at = ?
           WHERE id = ? AND resolved_at IS NULL`,
        )
        .run(nowIso, nowIso, diagnosisId).changes;
      if (changes === 0) return null;
      const row = db
        .prepare("SELECT * FROM diagnosis_records WHERE id = ?")
        .get(diagnosisId) as FridayDiagnosisRecordRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listRecentByFingerprint(db, fingerprint, sinceIso, limit = 10) {
      const rows = db
        .prepare(
          `SELECT * FROM diagnosis_records
           WHERE error_fingerprint = ? AND created_at >= ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(fingerprint, sinceIso, limit) as FridayDiagnosisRecordRow[];
      return rows.map(rowToEntity);
    },
  };
}
```

## `src/learning/persistence/friday-learned-lesson-repository.ts` (MODIFIED)
```ts
import type Database from "better-sqlite3";
import type {
  FridayLearnedLessonEntity,
  FridayLearnedLessonRow,
  JsonObject,
} from "../model/friday-learning.types.js";

export interface FridayLearnedLessonRepository {
  upsertByFingerprint(
    db: Database.Database,
    input: {
      id: string;
      fingerprint: string;
      title: string;
      cause: string;
      fix: string;
      mitigation?: JsonObject;
      sourceIncidentId?: string;
      sourceDiagnosisId?: string;
      nowIso: string;
    },
  ): FridayLearnedLessonEntity;

  listRecent(
    db: Database.Database,
    limit?: number,
  ): FridayLearnedLessonEntity[];

  getByFingerprint(
    db: Database.Database,
    fingerprint: string,
  ): FridayLearnedLessonEntity | null;
}

function rowToEntity(row: FridayLearnedLessonRow): FridayLearnedLessonEntity {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    cause: row.cause,
    fix: row.fix,
    mitigation: row.mitigation_json
      ? (JSON.parse(row.mitigation_json) as JsonObject)
      : undefined,
    occurrences: row.occurrences,
    lastSeenAt: row.last_seen_at,
    sourceIncidentId: row.source_incident_id ?? undefined,
    sourceDiagnosisId: row.source_diagnosis_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayLearnedLessonRepository(): FridayLearnedLessonRepository {
  return {
    upsertByFingerprint(db, input) {
      const existing = db
        .prepare("SELECT * FROM learned_lessons WHERE fingerprint = ?")
        .get(input.fingerprint) as FridayLearnedLessonRow | undefined;

      if (existing) {
        db.prepare(
          `UPDATE learned_lessons
           SET title = ?,
               cause = ?,
               fix = ?,
               mitigation_json = ?,
               occurrences = occurrences + 1,
               last_seen_at = ?,
               source_incident_id = COALESCE(?, source_incident_id),
               source_diagnosis_id = COALESCE(?, source_diagnosis_id),
               updated_at = ?
           WHERE fingerprint = ?`,
        ).run(
          input.title,
          input.cause,
          input.fix,
          input.mitigation ? JSON.stringify(input.mitigation) : null,
          input.nowIso,
          input.sourceIncidentId ?? null,
          input.sourceDiagnosisId ?? null,
          input.nowIso,
          input.fingerprint,
        );
      } else {
        db.prepare(
          `INSERT INTO learned_lessons
           (id, fingerprint, title, cause, fix, mitigation_json,
            occurrences, last_seen_at, source_incident_id, source_diagnosis_id,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.fingerprint,
          input.title,
          input.cause,
          input.fix,
          input.mitigation ? JSON.stringify(input.mitigation) : null,
          input.nowIso,
          input.sourceIncidentId ?? null,
          input.sourceDiagnosisId ?? null,
          input.nowIso,
          input.nowIso,
        );
      }

      const row = db
        .prepare("SELECT * FROM learned_lessons WHERE fingerprint = ?")
        .get(input.fingerprint) as FridayLearnedLessonRow;
      return rowToEntity(row);
    },

    listRecent(db, limit = 20) {
      const rows = db
        .prepare(
          `SELECT * FROM learned_lessons
           ORDER BY last_seen_at DESC
           LIMIT ?`,
        )
        .all(limit) as FridayLearnedLessonRow[];
      return rows.map(rowToEntity);
    },

    getByFingerprint(db, fingerprint) {
      const row = db
        .prepare("SELECT * FROM learned_lessons WHERE fingerprint = ?")
        .get(fingerprint) as FridayLearnedLessonRow | undefined;
      return row ? rowToEntity(row) : null;
    },
  };
}
```

## `src/learning/services/friday-self-learning-pipeline-service.ts` (MODIFIED)
```ts
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
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
  FridayLearningEventAppendInput,
  FridaySelfLearningProcessResult,
  FridayErrorIncidentEntity,
  FridayDiagnosisRecordEntity,
  FridayLearnedLessonEntity,
  JsonObject,
} from "../model/friday-learning.types.js";
import type {
  FridayAutoFixActionEntity,
  FridayApprovalRequestEntity,
} from "../model/friday-auto-fix.types.js";

export interface FridaySelfLearningPipelineService {
  processEvent(
    event: FridayLearningEventAppendInput,
  ): FridaySelfLearningProcessResult;
  processBatch(
    events: FridayLearningEventAppendInput[],
  ): FridaySelfLearningProcessResult[];
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

          // Create incident (auto-fix eligibility determined below)
          const incident: FridayErrorIncidentEntity = {
            incidentId: deps.idGenerator(),
            userId: signal.userId,
            runId: signal.runId,
            nodeId: undefined,
            ts: signal.ts,
            category: category as FridayErrorIncidentEntity["category"],
            severity: "medium",
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

            // Update lesson
            const lesson = deps.lessonRepo.upsertByFingerprint(db, {
              id: deps.idGenerator(),
              fingerprint: signature,
              title: `Error: ${signal.key}`,
              cause: `Detected via ${event.kind} event`,
              fix: `Review ${category} configuration`,
              sourceIncidentId: incident.incidentId,
              sourceDiagnosisId: diagOutcome.diagnosis.id,
              nowIso,
            });
            lessonsUpdated.push(lesson);
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
              } as unknown as JsonObject,
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
```

## `src/learning/services/friday-learning-metrics-service.ts` (MODIFIED)
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayLearningMetricsRepository } from "../persistence/friday-learning-metrics-repository.js";
import type { FridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import type { FridayLearningMetricsEntity } from "../model/friday-learning.types.js";

export interface FridayLearningMetricsService {
  aggregateDay(day: string): FridayLearningMetricsEntity;
  aggregateRange(
    fromDay: string,
    toDay: string,
  ): FridayLearningMetricsEntity[];
}

export interface CreateLearningMetricsServiceDeps {
  db: FridaySqliteLayer;
  metricsRepo: FridayLearningMetricsRepository;
  actionRepo?: FridayAutoFixActionRepository;
  nowIso: () => string;
}

export function createFridayLearningMetricsService(
  deps: CreateLearningMetricsServiceDeps,
): FridayLearningMetricsService {
  function aggregateSingleDay(day: string): FridayLearningMetricsEntity {
    return deps.db.withWriteTransaction((db) => {
      const dayStart = `${day}T00:00:00.000Z`;
      const dayEnd = `${day}T23:59:59.999Z`;

      // Count incidents for the day
      const incidentCount = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM error_incidents
           WHERE ts >= ? AND ts <= ?`,
        )
        .get(dayStart, dayEnd) as { cnt: number };

      // Count facts updated for the day
      const factsCount = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM preference_facts
           WHERE updated_at >= ? AND updated_at <= ?`,
        )
        .get(dayStart, dayEnd) as { cnt: number };

      // Compute success rate from workflow outcomes
      const totalOutcomes = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM learning_events
           WHERE kind = 'workflow_outcome' AND ts >= ? AND ts <= ?`,
        )
        .get(dayStart, dayEnd) as { cnt: number };

      let successRate: number | undefined;
      if (totalOutcomes.cnt > 0) {
        const successOutcomes = db
          .prepare(
            `SELECT COUNT(*) as cnt FROM learning_events
             WHERE kind = 'workflow_outcome' AND ts >= ? AND ts <= ?
             AND json_extract(payload_json, '$.success') = 1`,
          )
          .get(dayStart, dayEnd) as { cnt: number };
        successRate = successOutcomes.cnt / totalOutcomes.cnt;
      }

      // Compute auto-fix metrics
      let autoFixSuccessRate: number | undefined;
      let rollbackRate: number | undefined;
      let actionsExecuted = 0;

      if (deps.actionRepo) {
        const counts = deps.actionRepo.countByDay(db, day);
        actionsExecuted = counts.applied + counts.rolledBack;

        if (actionsExecuted > 0) {
          autoFixSuccessRate = counts.applied / actionsExecuted;
          rollbackRate = counts.rolledBack / actionsExecuted;
        }
      }

      const nowIso = deps.nowIso();

      const metric: FridayLearningMetricsEntity = {
        day,
        successRate,
        autoFixSuccessRate,
        rollbackRate,
        incidentsTotal: incidentCount.cnt,
        factsUpdated: factsCount.cnt,
        actionsExecuted,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      return deps.metricsRepo.upsertDay(db, metric);
    });
  }

  return {
    aggregateDay: aggregateSingleDay,

    aggregateRange(fromDay, toDay) {
      // Generate day strings from fromDay to toDay
      const results: FridayLearningMetricsEntity[] = [];
      const start = new Date(`${fromDay}T00:00:00.000Z`);
      const end = new Date(`${toDay}T00:00:00.000Z`);

      const current = new Date(start);
      while (current <= end) {
        const dayStr = current.toISOString().slice(0, 10);
        results.push(aggregateSingleDay(dayStr));
        current.setDate(current.getDate() + 1);
      }

      return results;
    },
  };
}
```

## `src/learning/runtime/friday-self-learning-runtime.types.ts` (MODIFIED)
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayLearningEventCollectionService } from "../services/friday-learning-event-collection-service.js";
import type { FridayPreferenceExtractionService } from "../services/friday-preference-extraction-service.js";
import type { FridayPreferenceFactService } from "../services/friday-preference-fact-service.js";
import type { FridayLearningPatternRecognitionService } from "../services/friday-learning-pattern-recognition-service.js";
import type { FridayLearningFeedbackLoopService } from "../services/friday-learning-feedback-loop-service.js";
import type { FridayLearningLifecycleService } from "../services/friday-learning-lifecycle-service.js";
import type { FridayLearningContextEnrichmentService } from "../services/friday-learning-context-enrichment-service.js";
import type { FridayLearningMetricsService } from "../services/friday-learning-metrics-service.js";
import type { FridaySelfLearningPipelineService } from "../services/friday-self-learning-pipeline-service.js";
import type { FridayErrorDiagnosisService } from "../services/friday-error-diagnosis-service.js";
import type { FridayAutoFixPlanService } from "../services/friday-auto-fix-plan-service.js";
import type { FridayAutoFixRiskAssessmentService } from "../services/friday-auto-fix-risk-assessment-service.js";
import type { FridayAutoFixExecutionService } from "../services/friday-auto-fix-execution-service.js";
import type { FridayApprovalWorkflowService } from "../services/friday-approval-workflow-service.js";
import type { FridayAutoFixDispatcherService } from "../services/friday-auto-fix-dispatcher-service.js";

export interface FridaySelfLearningRuntime {
  events: FridayLearningEventCollectionService;
  extraction: FridayPreferenceExtractionService;
  facts: FridayPreferenceFactService;
  patterns: FridayLearningPatternRecognitionService;
  feedback: FridayLearningFeedbackLoopService;
  lifecycle: FridayLearningLifecycleService;
  context: FridayLearningContextEnrichmentService;
  metrics: FridayLearningMetricsService;
  pipeline: FridaySelfLearningPipelineService;
  diagnosis: FridayErrorDiagnosisService;
  autoFixPlan: FridayAutoFixPlanService;
  autoFixRisk: FridayAutoFixRiskAssessmentService;
  autoFixExecution: FridayAutoFixExecutionService;
  approvals: FridayApprovalWorkflowService;
  autoFixDispatcher: FridayAutoFixDispatcherService;
}

export interface CreateFridaySelfLearningRuntimeDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
}
```

## `src/learning/runtime/friday-self-learning-runtime.ts` (MODIFIED)
```ts
import { createFridayLearningEventLedger } from "../../ledger/learning/friday-learning-event-ledger.js";
import { createFridayPreferenceFactRepository } from "../persistence/friday-preference-fact-repository.js";
import { createFridayErrorIncidentRepository } from "../persistence/friday-error-incident-repository.js";
import { createFridayDiagnosisRecordRepository } from "../persistence/friday-diagnosis-record-repository.js";
import { createFridayLearnedLessonRepository } from "../persistence/friday-learned-lesson-repository.js";
import { createFridayLearningMetricsRepository } from "../persistence/friday-learning-metrics-repository.js";
import { createFridayAutoFixActionRepository } from "../persistence/friday-auto-fix-action-repository.js";
import { createFridayApprovalRequestRepository } from "../persistence/friday-approval-request-repository.js";
import { createFridayLearningEventCollectionService } from "../services/friday-learning-event-collection-service.js";
import { createFridayPreferenceExtractionService } from "../services/friday-preference-extraction-service.js";
import { createFridayPreferenceFactService } from "../services/friday-preference-fact-service.js";
import { createFridayLearningPatternRecognitionService } from "../services/friday-learning-pattern-recognition-service.js";
import { createFridayLearningFeedbackLoopService } from "../services/friday-learning-feedback-loop-service.js";
import { createFridayLearningLifecycleService } from "../services/friday-learning-lifecycle-service.js";
import { createFridayLearningContextEnrichmentService } from "../services/friday-learning-context-enrichment-service.js";
import { createFridayLearningMetricsService } from "../services/friday-learning-metrics-service.js";
import { createFridaySelfLearningPipelineService } from "../services/friday-self-learning-pipeline-service.js";
import { createFridayErrorDiagnosisService } from "../services/friday-error-diagnosis-service.js";
import { createFridayAutoFixPlanService } from "../services/friday-auto-fix-plan-service.js";
import { createFridayAutoFixRiskAssessmentService } from "../services/friday-auto-fix-risk-assessment-service.js";
import { createFridayAutoFixExecutionService } from "../services/friday-auto-fix-execution-service.js";
import { createFridayAutoFixRollbackService } from "../services/friday-auto-fix-rollback-service.js";
import { createFridayApprovalWorkflowService } from "../services/friday-approval-workflow-service.js";
import { createFridayAutoFixLessonExtractionService } from "../services/friday-auto-fix-lesson-extraction-service.js";
import { createFridayAutoFixDispatcherService } from "../services/friday-auto-fix-dispatcher-service.js";
import type {
  FridaySelfLearningRuntime,
  CreateFridaySelfLearningRuntimeDeps,
} from "./friday-self-learning-runtime.types.js";

export function createFridaySelfLearningRuntime(
  deps: CreateFridaySelfLearningRuntimeDeps,
): FridaySelfLearningRuntime {
  // 1. Reuse existing learning event ledger
  const ledger = createFridayLearningEventLedger({ db: deps.db });

  // 2. Create repositories
  const factRepo = createFridayPreferenceFactRepository();
  const incidentRepo = createFridayErrorIncidentRepository();
  const diagnosisRepo = createFridayDiagnosisRecordRepository();
  const lessonRepo = createFridayLearnedLessonRepository();
  const metricsRepo = createFridayLearningMetricsRepository();
  const actionRepo = createFridayAutoFixActionRepository();
  const approvalRepo = createFridayApprovalRequestRepository();

  // 3. Create extraction service
  const extraction = createFridayPreferenceExtractionService({
    idGenerator: deps.idGenerator,
  });

  // 4. Create fact service
  const facts = createFridayPreferenceFactService({
    db: deps.db,
    factRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 5. Create event collection service
  const events = createFridayLearningEventCollectionService({ ledger });

  // 6. Create pattern recognition service
  const patterns = createFridayLearningPatternRecognitionService({
    db: deps.db,
    incidentRepo,
    factRepo,
    idGenerator: deps.idGenerator,
  });

  // 7. Create lifecycle service
  const lifecycle = createFridayLearningLifecycleService({
    db: deps.db,
    factRepo,
  });

  // 8. Create feedback loop service
  const feedback = createFridayLearningFeedbackLoopService({
    db: deps.db,
    factRepo,
    extraction,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // 9. Create context enrichment service
  const context = createFridayLearningContextEnrichmentService({
    db: deps.db,
    factService: facts,
    patternService: patterns,
    lifecycleService: lifecycle,
  });

  // 10. Create auto-fix services
  const diagnosis = createFridayErrorDiagnosisService({
    db: deps.db,
    incidentRepo,
    diagnosisRepo,
    lessonRepo,
    idGenerator: deps.idGenerator,
  });

  const autoFixPlan = createFridayAutoFixPlanService({
    idGenerator: deps.idGenerator,
  });

  const autoFixRisk = createFridayAutoFixRiskAssessmentService({
    db: deps.db,
    actionRepo,
  });

  const approvals = createFridayApprovalWorkflowService({
    db: deps.db,
    approvalRepo,
    actionRepo,
    idGenerator: deps.idGenerator,
  });

  const autoFixExecution = createFridayAutoFixExecutionService({
    db: deps.db,
    actionRepo,
    incidentRepo,
    diagnosisRepo,
    nowIso: deps.nowIso,
  });

  const autoFixDispatcher = createFridayAutoFixDispatcherService({
    db: deps.db,
    actionRepo,
    executionService: autoFixExecution,
  });

  // 11. Create metrics service (with action repo for Phase 7)
  const metrics = createFridayLearningMetricsService({
    db: deps.db,
    metricsRepo,
    actionRepo,
    nowIso: deps.nowIso,
  });

  // 12. Create pipeline orchestrator (with Phase 7 services)
  const pipeline = createFridaySelfLearningPipelineService({
    db: deps.db,
    events,
    extraction,
    facts,
    lifecycle,
    incidentRepo,
    diagnosisRepo,
    lessonRepo,
    actionRepo,
    approvalRepo,
    diagnosisService: diagnosis,
    planService: autoFixPlan,
    riskService: autoFixRisk,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  return {
    events,
    extraction,
    facts,
    patterns,
    feedback,
    lifecycle,
    context,
    metrics,
    pipeline,
    diagnosis,
    autoFixPlan,
    autoFixRisk,
    autoFixExecution,
    approvals,
    autoFixDispatcher,
  };
}
```

## `src/learning/index.ts` (MODIFIED)
```ts
// Model / types
export * from "./model/friday-learning.types.js";
export * from "./model/friday-auto-fix.types.js";

// Persistence
export { createFridayPreferenceFactRepository } from "./persistence/friday-preference-fact-repository.js";
export type { FridayPreferenceFactRepository } from "./persistence/friday-preference-fact-repository.js";

export { createFridayErrorIncidentRepository } from "./persistence/friday-error-incident-repository.js";
export type { FridayErrorIncidentRepository } from "./persistence/friday-error-incident-repository.js";

export { createFridayDiagnosisRecordRepository } from "./persistence/friday-diagnosis-record-repository.js";
export type { FridayDiagnosisRecordRepository } from "./persistence/friday-diagnosis-record-repository.js";

export { createFridayLearnedLessonRepository } from "./persistence/friday-learned-lesson-repository.js";
export type { FridayLearnedLessonRepository } from "./persistence/friday-learned-lesson-repository.js";

export { createFridayLearningMetricsRepository } from "./persistence/friday-learning-metrics-repository.js";
export type { FridayLearningMetricsRepository } from "./persistence/friday-learning-metrics-repository.js";

export { createFridayAutoFixActionRepository } from "./persistence/friday-auto-fix-action-repository.js";
export type { FridayAutoFixActionRepository } from "./persistence/friday-auto-fix-action-repository.js";

export { createFridayApprovalRequestRepository } from "./persistence/friday-approval-request-repository.js";
export type { FridayApprovalRequestRepository } from "./persistence/friday-approval-request-repository.js";

// Services
export { createFridayLearningEventCollectionService } from "./services/friday-learning-event-collection-service.js";
export type { FridayLearningEventCollectionService } from "./services/friday-learning-event-collection-service.js";

export { createFridayPreferenceExtractionService } from "./services/friday-preference-extraction-service.js";
export type { FridayPreferenceExtractionService } from "./services/friday-preference-extraction-service.js";

export { createFridayPreferenceFactService } from "./services/friday-preference-fact-service.js";
export type { FridayPreferenceFactService } from "./services/friday-preference-fact-service.js";

export { createFridayLearningPatternRecognitionService } from "./services/friday-learning-pattern-recognition-service.js";
export type { FridayLearningPatternRecognitionService } from "./services/friday-learning-pattern-recognition-service.js";

export { createFridayLearningFeedbackLoopService } from "./services/friday-learning-feedback-loop-service.js";
export type { FridayLearningFeedbackLoopService } from "./services/friday-learning-feedback-loop-service.js";

export { createFridayLearningLifecycleService } from "./services/friday-learning-lifecycle-service.js";
export type { FridayLearningLifecycleService } from "./services/friday-learning-lifecycle-service.js";

export { createFridayLearningContextEnrichmentService } from "./services/friday-learning-context-enrichment-service.js";
export type { FridayLearningContextEnrichmentService } from "./services/friday-learning-context-enrichment-service.js";

export { createFridayLearningMetricsService } from "./services/friday-learning-metrics-service.js";
export type { FridayLearningMetricsService } from "./services/friday-learning-metrics-service.js";

export { createFridaySelfLearningPipelineService } from "./services/friday-self-learning-pipeline-service.js";
export type { FridaySelfLearningPipelineService } from "./services/friday-self-learning-pipeline-service.js";

export { createFridayErrorDiagnosisService } from "./services/friday-error-diagnosis-service.js";
export type { FridayErrorDiagnosisService } from "./services/friday-error-diagnosis-service.js";

export { createFridayAutoFixPlanService } from "./services/friday-auto-fix-plan-service.js";
export type { FridayAutoFixPlanService } from "./services/friday-auto-fix-plan-service.js";

export { createFridayAutoFixRiskAssessmentService } from "./services/friday-auto-fix-risk-assessment-service.js";
export type { FridayAutoFixRiskAssessmentService } from "./services/friday-auto-fix-risk-assessment-service.js";

export { createFridayAutoFixExecutionService } from "./services/friday-auto-fix-execution-service.js";
export type { FridayAutoFixExecutionService } from "./services/friday-auto-fix-execution-service.js";

export { createFridayAutoFixRollbackService } from "./services/friday-auto-fix-rollback-service.js";
export type { FridayAutoFixRollbackService } from "./services/friday-auto-fix-rollback-service.js";

export { createFridayApprovalWorkflowService } from "./services/friday-approval-workflow-service.js";
export type { FridayApprovalWorkflowService } from "./services/friday-approval-workflow-service.js";

export { createFridayAutoFixLessonExtractionService } from "./services/friday-auto-fix-lesson-extraction-service.js";
export type { FridayAutoFixLessonExtractionService } from "./services/friday-auto-fix-lesson-extraction-service.js";

export { createFridayAutoFixDispatcherService } from "./services/friday-auto-fix-dispatcher-service.js";
export type { FridayAutoFixDispatcherService } from "./services/friday-auto-fix-dispatcher-service.js";

// Runtime
export * from "./runtime/friday-self-learning-runtime.types.js";
export { createFridaySelfLearningRuntime } from "./runtime/friday-self-learning-runtime.js";
```

## `test/unit/learning/persistence/friday-auto-fix-action-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import { createFridayAutoFixActionRepository } from "../../../../src/learning/persistence/friday-auto-fix-action-repository.js";
import type { FridayAutoFixActionRepository } from "../../../../src/learning/persistence/friday-auto-fix-action-repository.js";
import type { FridayAutoFixActionEntity, FridayAutoFixPlan } from "../../../../src/learning/model/friday-auto-fix.types.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import type { FridayErrorIncidentEntity } from "../../../../src/learning/model/friday-learning.types.js";

describe("FridayAutoFixActionRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayAutoFixActionRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
    title: "Auto-fix: retry node",
    summary: "Retry the failed tool operation",
    steps: [
      {
        stepId: "step-001",
        kind: "retry_node",
        target: "tool",
        payload: { fix: "retry" },
        verify: { method: "error_absent", timeoutMs: 5000 },
      },
    ],
    evidence: {
      fingerprint: "sig-abc",
      matchedLessonIds: ["lesson-001"],
      diagnosisId: "diag-001",
      recurrenceCount: 3,
    },
  };

  const baseAction: FridayAutoFixActionEntity = {
    actionId: "action-001",
    incidentId: "inc-001",
    userId: "test-user",
    riskTier: 0,
    plan: basePlan,
    status: "planned",
    outcome: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  function insertIncident(incidentId: string) {
    const incidentRepo = createFridayErrorIncidentRepository();
    const incident: FridayErrorIncidentEntity = {
      incidentId,
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "medium",
      signature: "sig-abc",
      context: {},
      autoFixEligible: false,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    };
    incidentRepo.insert(db.writer, incident);
  }

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayAutoFixActionRepository();
    insertIncident("inc-001");
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and retrieves an action", () => {
    repo.insert(db.writer, baseAction);
    const result = repo.getById(db.writer, "action-001");
    expect(result).not.toBeNull();
    expect(result!.actionId).toBe("action-001");
    expect(result!.plan.title).toBe("Auto-fix: retry node");
    expect(result!.riskTier).toBe(0);
    expect(result!.status).toBe("planned");
    expect(result!.outcome).toBeNull();
  });

  it("getById returns null for missing action", () => {
    const result = repo.getById(db.writer, "nonexistent");
    expect(result).toBeNull();
  });

  it("listPlanned returns only planned actions", () => {
    repo.insert(db.writer, baseAction);
    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
      status: "applied",
    });

    const planned = repo.listPlanned(db.writer);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.actionId).toBe("action-001");
  });

  it("listPlanned filters by maxRiskTier", () => {
    repo.insert(db.writer, baseAction);
    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
      riskTier: 2,
    });

    const tier01 = repo.listPlanned(db.writer, { maxRiskTier: 1 });
    expect(tier01).toHaveLength(1);
    expect(tier01[0]!.actionId).toBe("action-001");

    const tier2 = repo.listPlanned(db.writer, { maxRiskTier: 2 });
    expect(tier2).toHaveLength(2);
  });

  it("listPlanned filters by incidentIds", () => {
    repo.insert(db.writer, baseAction);
    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
    });

    const filtered = repo.listPlanned(db.writer, {
      incidentIds: ["inc-001"],
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.incidentId).toBe("inc-001");
  });

  it("markApplied transitions planned to applied", () => {
    repo.insert(db.writer, baseAction);
    const result = repo.markApplied(db.writer, "action-001", "success", NOW);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("applied");
    expect(result!.outcome).toBe("success");
    expect(result!.appliedAt).toBe(NOW);
  });

  it("markApplied returns null for non-planned action", () => {
    repo.insert(db.writer, { ...baseAction, status: "applied" });
    const result = repo.markApplied(db.writer, "action-001", "success", NOW);
    expect(result).toBeNull();
  });

  it("markRolledBack transitions to rolled_back", () => {
    repo.insert(db.writer, baseAction);
    const result = repo.markRolledBack(db.writer, "action-001", NOW);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("rolled_back");
    expect(result!.outcome).toBe("failed");
    expect(result!.rolledBackAt).toBe(NOW);
  });

  it("markRejected transitions planned to rejected", () => {
    repo.insert(db.writer, baseAction);
    const result = repo.markRejected(db.writer, "action-001", NOW);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("rejected");
  });

  it("setRollbackPlan updates the rollback plan", () => {
    repo.insert(db.writer, baseAction);
    const rollbackPlan = {
      summary: "Revert changes",
      steps: [{ stepId: "rb-001", kind: "retry_node" as const, target: "tool", payload: {} }],
    };
    const result = repo.setRollbackPlan(db.writer, "action-001", rollbackPlan, NOW);
    expect(result).not.toBeNull();
    expect(result!.rollbackPlan).toEqual(rollbackPlan);
  });

  it("countByDay counts applied and rolled back actions", () => {
    repo.insert(db.writer, baseAction);
    repo.markApplied(db.writer, "action-001", "success", NOW);

    insertIncident("inc-002");
    repo.insert(db.writer, {
      ...baseAction,
      actionId: "action-002",
      incidentId: "inc-002",
    });
    repo.markRolledBack(db.writer, "action-002", NOW);

    const counts = repo.countByDay(db.writer, "2025-06-15");
    expect(counts.applied).toBe(1);
    expect(counts.rolledBack).toBe(1);
    expect(counts.total).toBe(2);
  });

  it("handles rollbackPlan JSON serialization", () => {
    const actionWithRollback: FridayAutoFixActionEntity = {
      ...baseAction,
      rollbackPlan: {
        summary: "Revert",
        steps: [{ stepId: "rb-001", kind: "retry_node", target: "tool", payload: {} }],
      },
    };
    repo.insert(db.writer, actionWithRollback);
    const result = repo.getById(db.writer, "action-001");
    expect(result!.rollbackPlan).toEqual(actionWithRollback.rollbackPlan);
  });
});
```

## `test/unit/learning/persistence/friday-approval-request-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import { createFridayApprovalRequestRepository } from "../../../../src/learning/persistence/friday-approval-request-repository.js";
import type { FridayApprovalRequestRepository } from "../../../../src/learning/persistence/friday-approval-request-repository.js";
import { createFridayAutoFixActionRepository } from "../../../../src/learning/persistence/friday-auto-fix-action-repository.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import type { FridayApprovalRequestEntity, FridayAutoFixPlan } from "../../../../src/learning/model/friday-auto-fix.types.js";

describe("FridayApprovalRequestRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayApprovalRequestRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
    title: "Auto-fix: disable skill",
    summary: "Disable the broken skill",
    steps: [
      {
        stepId: "step-001",
        kind: "disable_skill",
        target: "skill-x",
        payload: {},
      },
    ],
    evidence: {
      fingerprint: "sig-abc",
      matchedLessonIds: [],
      diagnosisId: "diag-001",
      recurrenceCount: 1,
    },
  };

  const baseRequest: FridayApprovalRequestEntity = {
    requestId: "req-001",
    actionId: "action-001",
    userId: "test-user",
    description: "Approval needed: disable skill",
    riskTier: 2,
    plan: basePlan,
    requestedAt: NOW,
    expiresAt: "2025-06-16T10:00:00.000Z",
    status: "pending",
    createdAt: NOW,
    updatedAt: NOW,
  };

  function setupActionDeps() {
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "high",
      signature: "sig-abc",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const actionRepo = createFridayAutoFixActionRepository();
    actionRepo.insert(db.writer, {
      actionId: "action-001",
      incidentId: "inc-001",
      userId: "test-user",
      riskTier: 2,
      plan: basePlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayApprovalRequestRepository();
    setupActionDeps();
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and retrieves a request", () => {
    repo.insert(db.writer, baseRequest);
    const result = repo.getById(db.writer, "req-001");
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe("req-001");
    expect(result!.actionId).toBe("action-001");
    expect(result!.riskTier).toBe(2);
    expect(result!.status).toBe("pending");
    expect(result!.plan.title).toBe("Auto-fix: disable skill");
  });

  it("getByActionId returns the latest request", () => {
    repo.insert(db.writer, baseRequest);
    const result = repo.getByActionId(db.writer, "action-001");
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe("req-001");
  });

  it("listPending returns only pending requests", () => {
    repo.insert(db.writer, baseRequest);
    repo.insert(db.writer, {
      ...baseRequest,
      requestId: "req-002",
      status: "approved",
    });

    const pending = repo.listPending(db.writer);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requestId).toBe("req-001");
  });

  it("listPending filters by userId", () => {
    repo.insert(db.writer, baseRequest);
    const results = repo.listPending(db.writer, { userId: "test-user" });
    expect(results).toHaveLength(1);

    const empty = repo.listPending(db.writer, { userId: "other-user" });
    expect(empty).toHaveLength(0);
  });

  it("resolvePending approves a pending request", () => {
    repo.insert(db.writer, baseRequest);
    const result = repo.resolvePending(
      db.writer,
      "req-001",
      "approved",
      "test-user",
      "Looks good",
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("approved");
    expect(result!.responseReason).toBe("Looks good");
    expect(result!.respondedBy).toBe("test-user");
    expect(result!.respondedAt).toBe(NOW);
  });

  it("resolvePending rejects a pending request", () => {
    repo.insert(db.writer, baseRequest);
    const result = repo.resolvePending(
      db.writer,
      "req-001",
      "rejected",
      "test-user",
      "Too risky",
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("rejected");
  });

  it("resolvePending returns null for non-pending request", () => {
    repo.insert(db.writer, { ...baseRequest, status: "approved" });
    const result = repo.resolvePending(
      db.writer,
      "req-001",
      "rejected",
      "test-user",
      undefined,
      NOW,
    );
    expect(result).toBeNull();
  });

  it("expirePending expires requests past expiry time", () => {
    repo.insert(db.writer, {
      ...baseRequest,
      expiresAt: "2025-06-14T10:00:00.000Z", // Already expired
    });

    const expired = repo.expirePending(db.writer, NOW);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.status).toBe("expired");
  });

  it("expirePending does not expire non-expired requests", () => {
    repo.insert(db.writer, baseRequest); // expires 2025-06-16

    const expired = repo.expirePending(db.writer, NOW);
    expect(expired).toHaveLength(0);
  });

  it("handles optional runId", () => {
    // Insert FK chain for workflow_runs
    db.writer
      .prepare(
        `INSERT INTO workflows (id, slug, name, latest_version_number, is_archived, revision, etag, created_at, updated_at)
         VALUES ('wf-1', 'test-wf', 'Test', 1, 0, 1, 'etag', ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json, is_published, created_at, updated_at)
         VALUES ('wv-1', 'wf-1', 1, 'cs', '{}', 1, ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version_id, status, trigger_type, started_at, created_at, updated_at)
         VALUES ('run-001', 'wf-1', 'wv-1', 'running', 'manual', ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW);

    repo.insert(db.writer, {
      ...baseRequest,
      runId: "run-001",
    });
    const result = repo.getById(db.writer, "req-001");
    expect(result!.runId).toBe("run-001");
  });

  it("handles missing optional fields as undefined", () => {
    repo.insert(db.writer, baseRequest);
    const result = repo.getById(db.writer, "req-001");
    expect(result!.runId).toBeUndefined();
    expect(result!.responseReason).toBeUndefined();
    expect(result!.respondedAt).toBeUndefined();
    expect(result!.respondedBy).toBeUndefined();
  });
});
```

## `test/unit/learning/services/friday-error-diagnosis-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayErrorDiagnosisService } from "../../../../src/learning/services/friday-error-diagnosis-service.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import { createFridayDiagnosisRecordRepository } from "../../../../src/learning/persistence/friday-diagnosis-record-repository.js";
import { createFridayLearnedLessonRepository } from "../../../../src/learning/persistence/friday-learned-lesson-repository.js";
import type { FridayErrorDiagnosisService } from "../../../../src/learning/services/friday-error-diagnosis-service.js";
import type { FridayErrorIncidentEntity } from "../../../../src/learning/model/friday-learning.types.js";

describe("FridayErrorDiagnosisService", () => {
  let db: FridaySqliteLayer;
  let service: FridayErrorDiagnosisService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  const baseIncident: FridayErrorIncidentEntity = {
    incidentId: "inc-001",
    userId: "test-user",
    ts: NOW,
    category: "tool",
    severity: "medium",
    signature: "sig-tool-timeout",
    context: { toolName: "search", error: "timeout" },
    autoFixEligible: false,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();

    service = createFridayErrorDiagnosisService({
      db,
      incidentRepo,
      diagnosisRepo,
      lessonRepo,
      idGenerator: idGen,
    });

    // Insert base incident
    incidentRepo.insert(db.writer, baseIncident);
  });

  afterEach(() => {
    db.close();
  });

  it("produces a diagnosis for a simple incident", () => {
    const result = service.diagnose({ incident: baseIncident, nowIso: NOW });

    expect(result.diagnosis).toBeDefined();
    expect(result.diagnosis.errorFingerprint).toBe("sig-tool-timeout");
    expect(result.diagnosis.confidence).toBeGreaterThan(0);
    expect(result.recurrenceCount).toBeGreaterThanOrEqual(1);
  });

  it("returns autoFixEligible=false for low confidence", () => {
    // Fresh incident with no lessons and no recurrence → low confidence
    const freshIncident: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-fresh",
      signature: "sig-never-seen-before",
    };

    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, freshIncident);

    const result = service.diagnose({ incident: freshIncident, nowIso: NOW });
    expect(result.autoFixEligible).toBe(false);
    expect(result.candidatePlans).toHaveLength(0);
  });

  it("boosts confidence with matched lessons", () => {
    // Insert a lesson matching the fingerprint
    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-001",
      fingerprint: "sig-tool-timeout",
      title: "Tool Timeout Fix",
      cause: "Network latency",
      fix: "Increase timeout to 30s",
      nowIso: NOW,
    });

    const result = service.diagnose({ incident: baseIncident, nowIso: NOW });
    expect(result.matchedLessons).toHaveLength(1);
    expect(result.diagnosis.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.autoFixEligible).toBe(true);
    expect(result.candidatePlans.length).toBeGreaterThan(0);
  });

  it("boosts confidence with recurrence", () => {
    // Insert multiple incidents with same signature
    const incidentRepo = createFridayErrorIncidentRepository();
    for (let i = 2; i <= 6; i++) {
      incidentRepo.insert(db.writer, {
        ...baseIncident,
        incidentId: `inc-00${i}`,
        ts: `2025-06-15T1${i}:00:00.000Z`,
      });
    }

    // Also insert a lesson to push over the threshold
    const lessonRepo = createFridayLearnedLessonRepository();
    lessonRepo.upsertByFingerprint(db.writer, {
      id: "lesson-recur",
      fingerprint: "sig-tool-timeout",
      title: "Recurring timeout",
      cause: "Persistent issue",
      fix: "Apply retry logic",
      nowIso: NOW,
    });

    const result = service.diagnose({ incident: baseIncident, nowIso: NOW });
    expect(result.recurrenceCount).toBeGreaterThanOrEqual(5);
    expect(result.autoFixEligible).toBe(true);
  });

  it("creates a diagnosis record in the database", () => {
    service.diagnose({ incident: baseIncident, nowIso: NOW });

    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const records = diagnosisRepo.listByFingerprint(
      db.writer,
      "sig-tool-timeout",
    );
    expect(records.length).toBeGreaterThanOrEqual(1);
  });

  it("handles high severity incidents", () => {
    const highSev: FridayErrorIncidentEntity = {
      ...baseIncident,
      incidentId: "inc-high",
      severity: "high",
    };
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, highSev);

    const result = service.diagnose({ incident: highSev, nowIso: NOW });
    // High severity starts at 0.5 base confidence
    expect(result.diagnosis.confidence).toBeGreaterThanOrEqual(0.5);
  });
});
```

## `test/unit/learning/services/friday-auto-fix-plan-service.test.ts`
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayAutoFixPlanService } from "../../../../src/learning/services/friday-auto-fix-plan-service.js";
import type { FridayAutoFixPlanService } from "../../../../src/learning/services/friday-auto-fix-plan-service.js";
import type { FridayErrorIncidentEntity, FridayDiagnosisRecordEntity, FridayLearnedLessonEntity } from "../../../../src/learning/model/friday-learning.types.js";

describe("FridayAutoFixPlanService", () => {
  let service: FridayAutoFixPlanService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  const baseIncident: FridayErrorIncidentEntity = {
    incidentId: "inc-001",
    userId: "test-user",
    ts: NOW,
    category: "tool",
    severity: "medium",
    signature: "sig-abc",
    context: {},
    autoFixEligible: true,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
  };

  const baseDiagnosis: FridayDiagnosisRecordEntity = {
    id: "diag-001",
    incidentId: "inc-001",
    errorFingerprint: "sig-abc",
    confidence: 0.8,
    diagnosis: { summary: "Tool timeout" },
    createdAt: NOW,
    updatedAt: NOW,
  };

  const baseLesson: FridayLearnedLessonEntity = {
    id: "lesson-001",
    fingerprint: "sig-abc",
    title: "Tool Timeout Fix",
    cause: "Network latency",
    fix: "Increase timeout to 30s",
    occurrences: 3,
    lastSeenAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    idGen = createTestIdGenerator();
    service = createFridayAutoFixPlanService({ idGenerator: idGen });
  });

  it("builds a plan from matched lessons", () => {
    const plans = service.buildPlans({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson],
      recurrenceCount: 3,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]!.title).toContain("Tool Timeout Fix");
    expect(plans[0]!.steps).toHaveLength(1);
    expect(plans[0]!.steps[0]!.kind).toBe("retry_node");
    expect(plans[0]!.evidence.fingerprint).toBe("sig-abc");
    expect(plans[0]!.evidence.matchedLessonIds).toEqual(["lesson-001"]);
  });

  it("builds a fallback plan when no lessons match", () => {
    const plans = service.buildPlans({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [],
      recurrenceCount: 1,
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]!.title).toContain("retry");
    expect(plans[0]!.steps).toHaveLength(1);
  });

  it("maps model category to switch_model_fallback", () => {
    const modelIncident = { ...baseIncident, category: "model" as const };
    const plans = service.buildPlans({
      incident: modelIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson],
      recurrenceCount: 1,
    });

    expect(plans[0]!.steps[0]!.kind).toBe("switch_model_fallback");
  });

  it("maps config category to apply_config_patch with rollback", () => {
    const configIncident = { ...baseIncident, category: "config" as const };
    const plans = service.buildPlans({
      incident: configIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson],
      recurrenceCount: 1,
    });

    expect(plans[0]!.steps[0]!.kind).toBe("apply_config_patch");
    expect(plans[0]!.rollbackPlan).toBeDefined();
    expect(plans[0]!.rollbackPlan!.steps).toHaveLength(1);
  });

  it("maps routing category to trim_payload", () => {
    const routingIncident = { ...baseIncident, category: "routing" as const };
    const plans = service.buildPlans({
      incident: routingIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson],
      recurrenceCount: 1,
    });

    expect(plans[0]!.steps[0]!.kind).toBe("trim_payload");
  });

  it("includes evidence metadata in plans", () => {
    const plans = service.buildPlans({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson],
      recurrenceCount: 5,
    });

    expect(plans[0]!.evidence.diagnosisId).toBe("diag-001");
    expect(plans[0]!.evidence.recurrenceCount).toBe(5);
  });

  it("builds plans for multiple lessons", () => {
    const lesson2: FridayLearnedLessonEntity = {
      ...baseLesson,
      id: "lesson-002",
      title: "Alternative Fix",
      fix: "Switch to backup API",
    };

    const plans = service.buildPlans({
      incident: baseIncident,
      diagnosis: baseDiagnosis,
      matchedLessons: [baseLesson, lesson2],
      recurrenceCount: 2,
    });

    expect(plans).toHaveLength(2);
    expect(plans[0]!.title).toContain("Tool Timeout Fix");
    expect(plans[1]!.title).toContain("Alternative Fix");
  });
});
```

## `test/unit/learning/services/friday-auto-fix-risk-assessment-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import { createFridayAutoFixRiskAssessmentService } from "../../../../src/learning/services/friday-auto-fix-risk-assessment-service.js";
import { createFridayAutoFixActionRepository } from "../../../../src/learning/persistence/friday-auto-fix-action-repository.js";
import type { FridayAutoFixRiskAssessmentService } from "../../../../src/learning/services/friday-auto-fix-risk-assessment-service.js";
import type { FridayErrorIncidentEntity } from "../../../../src/learning/model/friday-learning.types.js";
import type { FridayAutoFixPlan } from "../../../../src/learning/model/friday-auto-fix.types.js";

describe("FridayAutoFixRiskAssessmentService", () => {
  let db: FridaySqliteLayer;
  let service: FridayAutoFixRiskAssessmentService;
  const NOW = "2025-06-15T10:00:00.000Z";

  const baseIncident: FridayErrorIncidentEntity = {
    incidentId: "inc-001",
    userId: "test-user",
    ts: NOW,
    category: "tool",
    severity: "medium",
    signature: "sig-abc",
    context: {},
    autoFixEligible: true,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
  };

  function makePlan(stepKind: string): FridayAutoFixPlan {
    return {
      title: `Plan with ${stepKind}`,
      summary: "Test plan",
      steps: [
        {
          stepId: "step-001",
          kind: stepKind as FridayAutoFixPlan["steps"][number]["kind"],
          target: "target",
          payload: {},
        },
      ],
      evidence: {
        fingerprint: "sig-abc",
        matchedLessonIds: [],
        diagnosisId: "diag-001",
        recurrenceCount: 1,
      },
    };
  }

  beforeEach(() => {
    db = createTestDb();
    const actionRepo = createFridayAutoFixActionRepository();
    service = createFridayAutoFixRiskAssessmentService({ db, actionRepo });
  });

  afterEach(() => {
    db.close();
  });

  it("assigns Tier 0 for retry_node steps", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("retry_node"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(0);
    expect(result.autoApplyAllowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("assigns Tier 0 for switch_model_fallback", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("switch_model_fallback"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(0);
  });

  it("assigns Tier 0 for trim_payload", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("trim_payload"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(0);
  });

  it("assigns Tier 1 for apply_config_patch", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("apply_config_patch"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(1);
    expect(result.autoApplyAllowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("assigns Tier 1 for grant_permission", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("grant_permission"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(1);
  });

  it("assigns Tier 2 for disable_skill", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("disable_skill"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(2);
    expect(result.autoApplyAllowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it("assigns Tier 2 for pause_workflow", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("pause_workflow"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(2);
    expect(result.requiresApproval).toBe(true);
  });

  it("escalates to Tier 2 for high severity incidents", () => {
    const highSev = { ...baseIncident, severity: "high" as const };
    const result = service.assess({
      incident: highSev,
      plan: makePlan("retry_node"),
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(2);
    expect(result.requiresApproval).toBe(true);
    expect(result.reasons).toContain(
      "High severity incident escalates to Tier 2",
    );
  });

  it("provides reasons for risk assessment", () => {
    const result = service.assess({
      incident: baseIncident,
      plan: makePlan("retry_node"),
      nowIso: NOW,
    });
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("uses the highest tier when plan has mixed step kinds", () => {
    const mixedPlan: FridayAutoFixPlan = {
      ...makePlan("retry_node"),
      steps: [
        { stepId: "s1", kind: "retry_node", target: "t", payload: {} },
        { stepId: "s2", kind: "disable_skill", target: "t", payload: {} },
      ],
    };

    const result = service.assess({
      incident: baseIncident,
      plan: mixedPlan,
      nowIso: NOW,
    });
    expect(result.riskTier).toBe(2);
    expect(result.requiresApproval).toBe(true);
  });
});
```

## `test/unit/learning/services/friday-auto-fix-execution-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import { createFridayAutoFixExecutionService } from "../../../../src/learning/services/friday-auto-fix-execution-service.js";
import { createFridayAutoFixActionRepository } from "../../../../src/learning/persistence/friday-auto-fix-action-repository.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import { createFridayDiagnosisRecordRepository } from "../../../../src/learning/persistence/friday-diagnosis-record-repository.js";
import type { FridayAutoFixExecutionService } from "../../../../src/learning/services/friday-auto-fix-execution-service.js";
import type { FridayAutoFixActionEntity, FridayAutoFixPlan } from "../../../../src/learning/model/friday-auto-fix.types.js";

describe("FridayAutoFixExecutionService", () => {
  let db: FridaySqliteLayer;
  let service: FridayAutoFixExecutionService;
  const NOW = "2025-06-15T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
    title: "Auto-fix: retry node",
    summary: "Retry the failed operation",
    steps: [
      {
        stepId: "step-001",
        kind: "retry_node",
        target: "tool",
        payload: {},
        verify: { method: "error_absent", timeoutMs: 5000 },
      },
    ],
    evidence: {
      fingerprint: "sig-abc",
      matchedLessonIds: [],
      diagnosisId: "diag-001",
      recurrenceCount: 1,
    },
  };

  function setupDeps() {
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "medium",
      signature: "sig-abc",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    diagnosisRepo.insert(db.writer, {
      id: "diag-001",
      incidentId: "inc-001",
      errorFingerprint: "sig-abc",
      confidence: 0.8,
      diagnosis: { summary: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const actionRepo = createFridayAutoFixActionRepository();
    return { incidentRepo, diagnosisRepo, actionRepo };
  }

  beforeEach(() => {
    db = createTestDb();
    const { incidentRepo, diagnosisRepo, actionRepo } = setupDeps();
    service = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      nowIso: () => NOW,
    });

    // Insert a planned action
    const action: FridayAutoFixActionEntity = {
      actionId: "action-001",
      incidentId: "inc-001",
      userId: "test-user",
      riskTier: 0,
      plan: basePlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    actionRepo.insert(db.writer, action);
  });

  afterEach(() => {
    db.close();
  });

  it("executes a Tier 0 action successfully", async () => {
    const result = await service.execute("action-001");
    expect(result.success).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.action.status).toBe("applied");
    expect(result.action.outcome).toBe("success");
    expect(result.rollbackAttempted).toBe(false);
  });

  it("marks incident as mitigated on success", async () => {
    await service.execute("action-001");

    const incidentRepo = createFridayErrorIncidentRepository();
    const incidents = incidentRepo.listByUser(db.writer, {
      userId: "test-user",
      status: "mitigated",
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.incidentId).toBe("inc-001");
  });

  it("marks diagnosis as resolved on success", async () => {
    await service.execute("action-001");

    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const records = diagnosisRepo.listByFingerprint(db.writer, "sig-abc");
    expect(records[0]!.resolvedAt).toBe(NOW);
  });

  it("throws for nonexistent action", async () => {
    await expect(service.execute("nonexistent")).rejects.toThrow(
      "Action nonexistent not found",
    );
  });

  it("throws for non-planned action", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    actionRepo.markApplied(db.writer, "action-001", "success", NOW);

    await expect(service.execute("action-001")).rejects.toThrow(
      "expected 'planned'",
    );
  });

  it("rejects Tier 1 action without rollback plan", async () => {
    const actionRepo = createFridayAutoFixActionRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-002",
      userId: "test-user",
      ts: NOW,
      category: "config",
      severity: "medium",
      signature: "sig-cfg",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const tier1Plan: FridayAutoFixPlan = {
      ...basePlan,
      steps: [
        {
          stepId: "step-002",
          kind: "apply_config_patch",
          target: "config",
          payload: {},
        },
      ],
    };

    actionRepo.insert(db.writer, {
      actionId: "action-002",
      incidentId: "inc-002",
      userId: "test-user",
      riskTier: 1,
      plan: tier1Plan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await service.execute("action-002");
    expect(result.success).toBe(false);
    expect(result.action.status).toBe("rejected");
    expect(result.errorMessage).toContain("rollback plan");
  });
});
```

## `test/unit/learning/services/friday-approval-workflow-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayApprovalWorkflowService } from "../../../../src/learning/services/friday-approval-workflow-service.js";
import { createFridayApprovalRequestRepository } from "../../../../src/learning/persistence/friday-approval-request-repository.js";
import { createFridayAutoFixActionRepository } from "../../../../src/learning/persistence/friday-auto-fix-action-repository.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import type { FridayApprovalWorkflowService } from "../../../../src/learning/services/friday-approval-workflow-service.js";
import type { FridayAutoFixActionEntity, FridayAutoFixPlan } from "../../../../src/learning/model/friday-auto-fix.types.js";

describe("FridayApprovalWorkflowService", () => {
  let db: FridaySqliteLayer;
  let service: FridayApprovalWorkflowService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";
  const EXPIRES = "2025-06-16T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
    title: "Auto-fix: disable skill",
    summary: "Disable the broken skill",
    steps: [
      {
        stepId: "step-001",
        kind: "disable_skill",
        target: "skill-x",
        payload: {},
      },
    ],
    evidence: {
      fingerprint: "sig-abc",
      matchedLessonIds: [],
      diagnosisId: "diag-001",
      recurrenceCount: 1,
    },
  };

  const baseAction: FridayAutoFixActionEntity = {
    actionId: "action-001",
    incidentId: "inc-001",
    userId: "test-user",
    riskTier: 2,
    plan: basePlan,
    status: "planned",
    outcome: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    // Setup FK deps
    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "high",
      signature: "sig-abc",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const actionRepo = createFridayAutoFixActionRepository();
    actionRepo.insert(db.writer, baseAction);

    const approvalRepo = createFridayApprovalRequestRepository();
    service = createFridayApprovalWorkflowService({
      db,
      approvalRepo,
      actionRepo,
      idGenerator: idGen,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("creates an approval request for a Tier 2 action", () => {
    const request = service.createRequestForAction({
      action: baseAction,
      description: "Please approve skill disable",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    expect(request.requestId).toBeTruthy();
    expect(request.actionId).toBe("action-001");
    expect(request.riskTier).toBe(2);
    expect(request.status).toBe("pending");
    expect(request.expiresAt).toBe(EXPIRES);
  });

  it("approves a pending request", () => {
    const request = service.createRequestForAction({
      action: baseAction,
      description: "Approve",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    const approved = service.approve({
      requestId: request.requestId,
      respondedBy: "test-user",
      reason: "Looks safe",
      nowIso: NOW,
    });

    expect(approved.status).toBe("approved");
    expect(approved.responseReason).toBe("Looks safe");
    expect(approved.respondedBy).toBe("test-user");
  });

  it("rejects a pending request and marks action rejected", () => {
    const request = service.createRequestForAction({
      action: baseAction,
      description: "Approve",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    const rejected = service.reject({
      requestId: request.requestId,
      respondedBy: "test-user",
      reason: "Too risky",
      nowIso: NOW,
    });

    expect(rejected.status).toBe("rejected");

    // Verify linked action is rejected
    const actionRepo = createFridayAutoFixActionRepository();
    const action = actionRepo.getById(db.writer, "action-001");
    expect(action!.status).toBe("rejected");
  });

  it("throws when approving a non-pending request", () => {
    const request = service.createRequestForAction({
      action: baseAction,
      description: "Approve",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    service.approve({
      requestId: request.requestId,
      respondedBy: "test-user",
      nowIso: NOW,
    });

    // Second approve should throw
    expect(() =>
      service.approve({
        requestId: request.requestId,
        respondedBy: "test-user",
        nowIso: NOW,
      }),
    ).toThrow("not found or not pending");
  });

  it("expires pending requests and marks linked actions rejected", () => {
    service.createRequestForAction({
      action: baseAction,
      description: "Approve",
      nowIso: NOW,
      expiresAt: "2025-06-14T10:00:00.000Z", // Already expired
    });

    const expired = service.expirePending({ nowIso: NOW });
    expect(expired).toHaveLength(1);
    expect(expired[0]!.status).toBe("expired");

    // Verify linked action is rejected
    const actionRepo = createFridayAutoFixActionRepository();
    const action = actionRepo.getById(db.writer, "action-001");
    expect(action!.status).toBe("rejected");
  });

  it("expirePending does not affect future requests", () => {
    service.createRequestForAction({
      action: baseAction,
      description: "Approve",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    const expired = service.expirePending({ nowIso: NOW });
    expect(expired).toHaveLength(0);
  });

  it("creates request with optional runId", () => {
    // Insert FK chain for workflow_runs
    db.writer
      .prepare(
        `INSERT INTO workflows (id, slug, name, latest_version_number, is_archived, revision, etag, created_at, updated_at)
         VALUES ('wf-1', 'test-wf', 'Test', 1, 0, 1, 'etag', ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json, is_published, created_at, updated_at)
         VALUES ('wv-1', 'wf-1', 1, 'cs', '{}', 1, ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version_id, status, trigger_type, started_at, created_at, updated_at)
         VALUES ('run-001', 'wf-1', 'wv-1', 'running', 'manual', ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW);

    const request = service.createRequestForAction({
      action: baseAction,
      runId: "run-001",
      description: "Approve",
      nowIso: NOW,
      expiresAt: EXPIRES,
    });

    expect(request.runId).toBe("run-001");
  });
});
```

## `test/unit/learning/services/friday-auto-fix-dispatcher-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import { createFridayAutoFixDispatcherService } from "../../../../src/learning/services/friday-auto-fix-dispatcher-service.js";
import { createFridayAutoFixExecutionService } from "../../../../src/learning/services/friday-auto-fix-execution-service.js";
import { createFridayAutoFixActionRepository } from "../../../../src/learning/persistence/friday-auto-fix-action-repository.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import { createFridayDiagnosisRecordRepository } from "../../../../src/learning/persistence/friday-diagnosis-record-repository.js";
import type { FridayAutoFixDispatcherService } from "../../../../src/learning/services/friday-auto-fix-dispatcher-service.js";
import type { FridayAutoFixPlan } from "../../../../src/learning/model/friday-auto-fix.types.js";

describe("FridayAutoFixDispatcherService", () => {
  let db: FridaySqliteLayer;
  let service: FridayAutoFixDispatcherService;
  const NOW = "2025-06-15T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
    title: "Auto-fix: retry",
    summary: "Retry",
    steps: [
      {
        stepId: "step-001",
        kind: "retry_node",
        target: "tool",
        payload: {},
        verify: { method: "error_absent", timeoutMs: 5000 },
      },
    ],
    evidence: {
      fingerprint: "sig-abc",
      matchedLessonIds: [],
      diagnosisId: "diag-001",
      recurrenceCount: 1,
    },
  };

  beforeEach(() => {
    db = createTestDb();

    const actionRepo = createFridayAutoFixActionRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();

    // Setup FK deps
    incidentRepo.insert(db.writer, {
      incidentId: "inc-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "medium",
      signature: "sig-abc",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    diagnosisRepo.insert(db.writer, {
      id: "diag-001",
      incidentId: "inc-001",
      errorFingerprint: "sig-abc",
      confidence: 0.8,
      diagnosis: { summary: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    // Insert two planned actions at different tiers
    incidentRepo.insert(db.writer, {
      incidentId: "inc-002",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "high",
      signature: "sig-def",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    actionRepo.insert(db.writer, {
      actionId: "action-001",
      incidentId: "inc-001",
      userId: "test-user",
      riskTier: 0,
      plan: basePlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    actionRepo.insert(db.writer, {
      actionId: "action-002",
      incidentId: "inc-002",
      userId: "test-user",
      riskTier: 2,
      plan: {
        ...basePlan,
        steps: [
          { stepId: "step-002", kind: "disable_skill", target: "skill-x", payload: {} },
        ],
        evidence: { ...basePlan.evidence, diagnosisId: "diag-001" },
      },
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const executionService = createFridayAutoFixExecutionService({
      db,
      actionRepo,
      incidentRepo,
      diagnosisRepo,
      nowIso: () => NOW,
    });

    service = createFridayAutoFixDispatcherService({
      db,
      actionRepo,
      executionService,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("runs ready actions up to maxRiskTier", async () => {
    const results = await service.runReadyActions({ maxRiskTier: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]!.action.actionId).toBe("action-001");
    expect(results[0]!.success).toBe(true);
  });

  it("respects maxRiskTier cap", async () => {
    const results = await service.runReadyActions({ maxRiskTier: 1 });
    // Only action-001 (tier 0) qualifies, action-002 (tier 2) does not
    expect(results).toHaveLength(1);
  });

  it("filters by incidentIds", async () => {
    const results = await service.runReadyActions({
      incidentIds: ["inc-001"],
      maxRiskTier: 1,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.action.incidentId).toBe("inc-001");
  });

  it("returns empty when no planned actions exist", async () => {
    // Execute the only eligible one first
    await service.runReadyActions({ maxRiskTier: 0 });
    const results = await service.runReadyActions({ maxRiskTier: 0 });
    expect(results).toHaveLength(0);
  });

  it("runApprovedAction executes a specific action", async () => {
    const result = await service.runApprovedAction("action-001");
    expect(result.success).toBe(true);
    expect(result.action.status).toBe("applied");
  });

  it("runApprovedAction throws for nonexistent action", async () => {
    await expect(service.runApprovedAction("nonexistent")).rejects.toThrow(
      "not found",
    );
  });

  it("runApprovedAction throws for non-planned action", async () => {
    // Execute first
    await service.runApprovedAction("action-001");
    // Try again
    await expect(service.runApprovedAction("action-001")).rejects.toThrow(
      "expected 'planned'",
    );
  });
});
```

## `test/unit/learning/runtime/friday-self-learning-runtime.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridaySelfLearningRuntime } from "../../../../src/learning/runtime/friday-self-learning-runtime.js";
import type { FridaySelfLearningRuntime } from "../../../../src/learning/runtime/friday-self-learning-runtime.types.js";
import type { FridayLearningEventAppendInput } from "../../../../src/learning/model/friday-learning.types.js";

describe("FridaySelfLearningRuntime", () => {
  let db: FridaySqliteLayer;
  let runtime: FridaySelfLearningRuntime;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    runtime = createFridaySelfLearningRuntime({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("composes all services correctly", () => {
    expect(runtime.events).toBeDefined();
    expect(runtime.extraction).toBeDefined();
    expect(runtime.facts).toBeDefined();
    expect(runtime.patterns).toBeDefined();
    expect(runtime.feedback).toBeDefined();
    expect(runtime.lifecycle).toBeDefined();
    expect(runtime.context).toBeDefined();
    expect(runtime.metrics).toBeDefined();
    expect(runtime.pipeline).toBeDefined();
    expect(runtime.diagnosis).toBeDefined();
    expect(runtime.autoFixPlan).toBeDefined();
    expect(runtime.autoFixRisk).toBeDefined();
    expect(runtime.autoFixExecution).toBeDefined();
    expect(runtime.approvals).toBeDefined();
    expect(runtime.autoFixDispatcher).toBeDefined();
  });

  it("events service collects and deduplicates events", () => {
    const event: FridayLearningEventAppendInput = {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: { text: "hello" },
    };

    const r1 = runtime.events.collect(event);
    expect(r1.inserted).toBe(true);

    const r2 = runtime.events.collect(event);
    expect(r2.inserted).toBe(false);
  });

  it("extraction service produces signals deterministically", () => {
    const signals1 = runtime.extraction.extract({
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "theme", newValue: "dark" },
    });

    expect(signals1).toHaveLength(1);
    expect(signals1[0]!.kind).toBe("correction");
    expect(signals1[0]!.key).toBe("pref:theme");
  });

  it("lifecycle starts at cold_start for new users", () => {
    const state = runtime.lifecycle.getState("test-user");
    expect(state).toBe("cold_start");
  });

  it("lifecycle transitions to warmup after enough facts", () => {
    // Insert 3 facts to trigger warmup (default warmupFactCount = 3)
    for (let i = 0; i < 3; i++) {
      runtime.pipeline.processEvent({
        eventId: `evt-${i}`,
        ts: NOW,
        userId: "test-user",
        kind: "user_correction",
        payload: { correctedField: `field${i}`, newValue: `val${i}` },
      });
    }

    const state = runtime.lifecycle.getState("test-user");
    expect(state).toBe("warmup");
  });

  it("feedback service accepts corrections and updates facts", () => {
    const correctionEvent: FridayLearningEventAppendInput = {
      eventId: "evt-feedback-1",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "timezone", newValue: "UTC" },
    };

    const result = runtime.feedback.applyCorrection(correctionEvent);
    expect(result.accepted).toBe(true);
    expect(result.updatedFacts).toHaveLength(1);
    expect(result.updatedFacts[0]!.key).toBe("pref:timezone");
    expect(result.updatedFacts[0]!.value).toBe("UTC");
  });

  it("feedback service rejects non-correction events", () => {
    const event: FridayLearningEventAppendInput = {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: { text: "hello" },
    };

    const result = runtime.feedback.applyCorrection(event);
    expect(result.accepted).toBe(false);
    expect(result.updatedFacts).toHaveLength(0);
  });

  it("context enrichment builds context and enriches payloads", () => {
    // Process a correction to create a fact
    runtime.pipeline.processEvent({
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "TypeScript" },
    });

    // Enrich a payload
    const enriched = runtime.context.enrichSkillPayload({
      userId: "test-user",
      payload: { task: "compile" },
      nowIso: NOW,
    });

    expect(enriched).toHaveProperty("task", "compile");
    expect(enriched).toHaveProperty("__fridayLearning");
  });

  it("pipeline end-to-end: correction → fact → context", () => {
    // 1. Process correction
    const result = runtime.pipeline.processEvent({
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_correction",
      payload: { correctedField: "editor", newValue: "nvim" },
    });

    expect(result.inserted).toBe(true);
    expect(result.factsUpdated).toHaveLength(1);

    // 2. Verify fact is active
    const facts = runtime.facts.listActiveFacts({
      userId: "test-user",
      minConfidence: 0.0,
      limit: 10,
    });
    expect(facts.some((f) => f.key === "pref:editor")).toBe(true);

    // 3. Verify context includes the preference
    const ctx = runtime.context.buildContext({
      userId: "test-user",
      nowIso: NOW,
    });
    expect(ctx.preferences).toHaveProperty("pref:editor", "nvim");
  });

  it("pipeline end-to-end: error → incident → diagnosis → lesson", () => {
    const result = runtime.pipeline.processEvent({
      eventId: "evt-err-001",
      ts: NOW,
      userId: "test-user",
      kind: "error_incident",
      payload: { category: "tool", message: "api_timeout" },
    });

    expect(result.incidentsCreated).toHaveLength(1);
    expect(result.diagnosisCreated).toHaveLength(1);
    expect(result.lessonsUpdated).toHaveLength(1);
    expect(result.incidentsCreated[0]!.autoFixEligible).toBe(false);
  });
});
```

## `test/unit/learning/services/friday-self-learning-pipeline-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayLearningEventLedger } from "../../../../src/ledger/learning/friday-learning-event-ledger.js";
import { createFridayPreferenceFactRepository } from "../../../../src/learning/persistence/friday-preference-fact-repository.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import { createFridayDiagnosisRecordRepository } from "../../../../src/learning/persistence/friday-diagnosis-record-repository.js";
import { createFridayLearnedLessonRepository } from "../../../../src/learning/persistence/friday-learned-lesson-repository.js";
import { createFridayLearningEventCollectionService } from "../../../../src/learning/services/friday-learning-event-collection-service.js";
import { createFridayPreferenceExtractionService } from "../../../../src/learning/services/friday-preference-extraction-service.js";
import { createFridayPreferenceFactService } from "../../../../src/learning/services/friday-preference-fact-service.js";
import { createFridayLearningLifecycleService } from "../../../../src/learning/services/friday-learning-lifecycle-service.js";
import { createFridaySelfLearningPipelineService } from "../../../../src/learning/services/friday-self-learning-pipeline-service.js";
import type { FridaySelfLearningPipelineService } from "../../../../src/learning/services/friday-self-learning-pipeline-service.js";
import type { FridayLearningEventAppendInput } from "../../../../src/learning/model/friday-learning.types.js";

describe("FridaySelfLearningPipelineService", () => {
  let db: FridaySqliteLayer;
  let pipeline: FridaySelfLearningPipelineService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    const ledger = createFridayLearningEventLedger({ db });
    const factRepo = createFridayPreferenceFactRepository();
    const incidentRepo = createFridayErrorIncidentRepository();
    const diagnosisRepo = createFridayDiagnosisRecordRepository();
    const lessonRepo = createFridayLearnedLessonRepository();

    const events = createFridayLearningEventCollectionService({ ledger });
    const extraction = createFridayPreferenceExtractionService({
      idGenerator: idGen,
    });
    const facts = createFridayPreferenceFactService({
      db,
      factRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    const lifecycle = createFridayLearningLifecycleService({
      db,
      factRepo,
    });

    pipeline = createFridaySelfLearningPipelineService({
      db,
      events,
      extraction,
      facts,
      lifecycle,
      incidentRepo,
      diagnosisRepo,
      lessonRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeEvent(
    overrides?: Partial<FridayLearningEventAppendInput>,
  ): FridayLearningEventAppendInput {
    return {
      eventId: "evt-001",
      ts: NOW,
      userId: "test-user",
      kind: "user_message",
      payload: {},
      ...overrides,
    };
  }

  it("processEvent collects the event and returns result", () => {
    const event = makeEvent();
    const result = pipeline.processEvent(event);

    expect(result.eventId).toBe("evt-001");
    expect(result.inserted).toBe(true);
    expect(result.lifecycleState).toBe("cold_start");
  });

  it("processEvent is idempotent on duplicate eventId", () => {
    const event = makeEvent();
    pipeline.processEvent(event);
    const result = pipeline.processEvent(event);

    expect(result.inserted).toBe(false);
  });

  it("duplicate eventId short-circuits with no downstream writes", () => {
    // First: process an error event that would create incidents/diagnosis/lessons
    const event = makeEvent({
      eventId: "evt-dup",
      kind: "error_incident",
      payload: { category: "tool", message: "timeout" },
    });
    const first = pipeline.processEvent(event);
    expect(first.inserted).toBe(true);
    expect(first.incidentsCreated).toHaveLength(1);
    expect(first.diagnosisCreated).toHaveLength(1);
    expect(first.lessonsUpdated).toHaveLength(1);

    // Count rows before duplicate
    const incidentsBefore = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM error_incidents").get() as { cnt: number }
    ).cnt;
    const diagnosisBefore = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM diagnosis_records").get() as { cnt: number }
    ).cnt;
    const lessonsBefore = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM learned_lessons").get() as { cnt: number }
    ).cnt;

    // Second: duplicate should short-circuit
    const second = pipeline.processEvent(event);
    expect(second.inserted).toBe(false);
    expect(second.extractedSignals).toHaveLength(0);
    expect(second.factsUpdated).toHaveLength(0);
    expect(second.incidentsCreated).toHaveLength(0);
    expect(second.diagnosisCreated).toHaveLength(0);
    expect(second.lessonsUpdated).toHaveLength(0);

    // Verify no new rows were written
    const incidentsAfter = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM error_incidents").get() as { cnt: number }
    ).cnt;
    const diagnosisAfter = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM diagnosis_records").get() as { cnt: number }
    ).cnt;
    const lessonsAfter = (
      db.writer.prepare("SELECT COUNT(*) as cnt FROM learned_lessons").get() as { cnt: number }
    ).cnt;

    expect(incidentsAfter).toBe(incidentsBefore);
    expect(diagnosisAfter).toBe(diagnosisBefore);
    expect(lessonsAfter).toBe(lessonsBefore);
  });

  it("processEvent extracts correction signals and updates facts", () => {
    const event = makeEvent({
      kind: "user_correction",
      payload: { correctedField: "language", newValue: "Python" },
    });

    const result = pipeline.processEvent(event);

    expect(result.extractedSignals).toHaveLength(1);
    expect(result.extractedSignals[0]!.kind).toBe("correction");
    expect(result.factsUpdated).toHaveLength(1);
    expect(result.factsUpdated[0]!.key).toBe("pref:language");
    expect(result.factsUpdated[0]!.value).toBe("Python");
  });

  it("processEvent creates incidents for error signals", () => {
    const event = makeEvent({
      kind: "tool_result",
      payload: { ok: false, toolName: "search", errorCode: "timeout" },
    });

    const result = pipeline.processEvent(event);

    expect(result.extractedSignals.length).toBeGreaterThan(0);
    expect(result.incidentsCreated).toHaveLength(1);
    expect(result.incidentsCreated[0]!.category).toBe("tool");
    expect(result.incidentsCreated[0]!.autoFixEligible).toBe(false); // Phase 6 invariant
  });

  it("processEvent creates diagnosis records for error signals", () => {
    const event = makeEvent({
      kind: "error_incident",
      payload: { category: "config", message: "missing_key" },
    });

    const result = pipeline.processEvent(event);

    expect(result.diagnosisCreated).toHaveLength(1);
    expect(result.diagnosisCreated[0]!.incidentId).toBe(
      result.incidentsCreated[0]!.incidentId,
    );
  });

  it("processEvent creates learned lessons for error signals", () => {
    const event = makeEvent({
      kind: "error_incident",
      payload: { category: "workflow", message: "step_failed" },
    });

    const result = pipeline.processEvent(event);

    expect(result.lessonsUpdated).toHaveLength(1);
    expect(result.lessonsUpdated[0]!.fingerprint).toBeTruthy();
    expect(result.lessonsUpdated[0]!.occurrences).toBe(1);
  });

  it("processEvent accumulates lesson occurrences on repeated errors", () => {
    const event1 = makeEvent({
      eventId: "evt-001",
      kind: "error_incident",
      payload: { category: "tool", message: "timeout" },
    });
    const event2 = makeEvent({
      eventId: "evt-002",
      kind: "error_incident",
      payload: { category: "tool", message: "timeout" },
    });

    const result1 = pipeline.processEvent(event1);
    const result2 = pipeline.processEvent(event2);

    // Both should have same fingerprint, second should increment occurrences
    expect(result1.lessonsUpdated[0]!.fingerprint).toBe(
      result2.lessonsUpdated[0]!.fingerprint,
    );
    expect(result2.lessonsUpdated[0]!.occurrences).toBe(2);
  });

  it("processEvent returns empty arrays for assistant_message (no signals)", () => {
    const event = makeEvent({
      kind: "assistant_message",
      payload: { text: "I prefer TypeScript" },
    });

    const result = pipeline.processEvent(event);

    expect(result.extractedSignals).toHaveLength(0);
    expect(result.factsUpdated).toHaveLength(0);
    expect(result.incidentsCreated).toHaveLength(0);
  });

  it("processBatch processes multiple events", () => {
    const events = [
      makeEvent({ eventId: "evt-001", kind: "user_message", payload: { text: "hello" } }),
      makeEvent({
        eventId: "evt-002",
        kind: "user_correction",
        payload: { correctedField: "theme", newValue: "dark" },
      }),
      makeEvent({
        eventId: "evt-003",
        kind: "tool_result",
        payload: { ok: false, toolName: "api", errorCode: "500" },
      }),
    ];

    const results = pipeline.processBatch(events);

    expect(results).toHaveLength(3);
    expect(results[0]!.inserted).toBe(true);
    expect(results[1]!.factsUpdated).toHaveLength(1);
    expect(results[2]!.incidentsCreated).toHaveLength(1);
  });

  it("Phase 6 fallback: no auto_fix_actions or approval_requests when no diagnosis service", () => {
    const event = makeEvent({
      kind: "error_incident",
      payload: { category: "tool", message: "failure" },
    });

    pipeline.processEvent(event);

    // Without diagnosis service, no auto_fix_actions should be written
    const autoFixCount = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM auto_fix_actions")
      .get() as { cnt: number };
    expect(autoFixCount.cnt).toBe(0);

    // Without diagnosis service, no approval_requests should be written
    const approvalCount = db.writer
      .prepare("SELECT COUNT(*) as cnt FROM approval_requests")
      .get() as { cnt: number };
    expect(approvalCount.cnt).toBe(0);
  });
});
```

## `test/unit/jobs/learning/friday-learning-metrics-job.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayLearningMetricsRepository } from "../../../../src/learning/persistence/friday-learning-metrics-repository.js";
import { createFridayAutoFixActionRepository } from "../../../../src/learning/persistence/friday-auto-fix-action-repository.js";
import { createFridayLearningMetricsService } from "../../../../src/learning/services/friday-learning-metrics-service.js";
import { createFridayLearningMetricsJob } from "../../../../src/jobs/learning/friday-learning-metrics-job.js";
import type { FridayLearningMetricsJob } from "../../../../src/jobs/learning/friday-learning-metrics-job.js";
import { createFridayLearningEventLedger } from "../../../../src/ledger/learning/friday-learning-event-ledger.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import { createFridayPreferenceFactRepository } from "../../../../src/learning/persistence/friday-preference-fact-repository.js";
import type { FridayAutoFixPlan } from "../../../../src/learning/model/friday-auto-fix.types.js";

describe("FridayLearningMetricsJob", () => {
  let db: FridaySqliteLayer;
  let job: FridayLearningMetricsJob;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    const metricsRepo = createFridayLearningMetricsRepository();
    const actionRepo = createFridayAutoFixActionRepository();
    const metricsService = createFridayLearningMetricsService({
      db,
      metricsRepo,
      actionRepo,
      nowIso: () => NOW,
    });

    job = createFridayLearningMetricsJob({
      metricsService,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("aggregates metrics for a day with no data", () => {
    const result = job.run("2025-06-15");

    expect(result.day).toBe("2025-06-15");
    expect(result.metric.incidentsTotal).toBe(0);
    expect(result.metric.factsUpdated).toBe(0);
    expect(result.metric.actionsExecuted).toBe(0); // Phase 6: always 0
    expect(result.metric.successRate).toBeUndefined();
  });

  it("aggregates metrics for a day with incidents", () => {
    const incidentRepo = createFridayErrorIncidentRepository();

    // Insert incidents for the day
    db.withWriteTransaction((writer) => {
      for (let i = 0; i < 3; i++) {
        incidentRepo.insert(writer, {
          incidentId: `inc-${i}`,
          userId: "test-user",
          ts: `2025-06-15T0${i + 1}:00:00.000Z`,
          category: "tool",
          severity: "medium",
          signature: `sig-${i}`,
          context: {},
          autoFixEligible: false,
          status: "open",
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });

    const result = job.run("2025-06-15");
    expect(result.metric.incidentsTotal).toBe(3);
  });

  it("aggregates metrics for a day with preference facts", () => {
    const factRepo = createFridayPreferenceFactRepository();

    // Insert facts updated on target day
    db.withWriteTransaction((writer) => {
      factRepo.upsert(writer, {
        factId: "fact-001",
        userId: "test-user",
        key: "pref:language",
        value: "TypeScript",
        confidence: 0.90,
        evidenceCountDelta: 1,
        lastConfirmedAt: "2025-06-15T08:00:00.000Z",
        sourceEventId: "evt-001",
        nowIso: "2025-06-15T08:00:00.000Z",
      });
    });

    const result = job.run("2025-06-15");
    expect(result.metric.factsUpdated).toBe(1);
  });

  it("computes success rate from workflow outcomes", () => {
    const ledger = createFridayLearningEventLedger({ db });

    // Insert successful and failed workflow outcomes
    ledger.appendEvent({
      eventId: "evt-success-1",
      ts: "2025-06-15T08:00:00.000Z",
      userId: "test-user",
      kind: "workflow_outcome",
      payload: { success: true, workflowId: "wf-1" },
    });
    ledger.appendEvent({
      eventId: "evt-success-2",
      ts: "2025-06-15T09:00:00.000Z",
      userId: "test-user",
      kind: "workflow_outcome",
      payload: { success: true, workflowId: "wf-2" },
    });
    ledger.appendEvent({
      eventId: "evt-fail-1",
      ts: "2025-06-15T10:00:00.000Z",
      userId: "test-user",
      kind: "workflow_outcome",
      payload: { success: false, workflowId: "wf-3" },
    });

    const result = job.run("2025-06-15");
    // 2 success out of 3 total = ~0.666
    expect(result.metric.successRate).toBeCloseTo(0.666, 2);
  });

  it("uses current day when no override provided", () => {
    const result = job.run();
    // Should use NOW.slice(0,10) = "2025-06-15"
    expect(result.day).toBe("2025-06-15");
  });

  it("actionsExecuted is 0 when no actions exist", () => {
    const result = job.run("2025-06-15");
    expect(result.metric.actionsExecuted).toBe(0);
  });

  it("autoFixSuccessRate is undefined when no actions exist", () => {
    const result = job.run("2025-06-15");
    expect(result.metric.autoFixSuccessRate).toBeUndefined();
  });

  it("rollbackRate is undefined when no actions exist", () => {
    const result = job.run("2025-06-15");
    expect(result.metric.rollbackRate).toBeUndefined();
  });

  it("computes auto-fix metrics when actions exist", () => {
    const incidentRepo = createFridayErrorIncidentRepository();
    const actionRepo = createFridayAutoFixActionRepository();

    const basePlan: FridayAutoFixPlan = {
      title: "test",
      summary: "test",
      steps: [{ stepId: "s1", kind: "retry_node", target: "t", payload: {} }],
      evidence: { fingerprint: "sig", matchedLessonIds: [], diagnosisId: "d1", recurrenceCount: 1 },
    };

    // Create incidents + actions
    db.withWriteTransaction((writer) => {
      incidentRepo.insert(writer, {
        incidentId: "inc-m1",
        userId: "test-user",
        ts: "2025-06-15T01:00:00.000Z",
        category: "tool",
        severity: "medium",
        signature: "sig-m1",
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });
      incidentRepo.insert(writer, {
        incidentId: "inc-m2",
        userId: "test-user",
        ts: "2025-06-15T02:00:00.000Z",
        category: "tool",
        severity: "medium",
        signature: "sig-m2",
        context: {},
        autoFixEligible: true,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      });

      actionRepo.insert(writer, {
        actionId: "act-m1",
        incidentId: "inc-m1",
        userId: "test-user",
        riskTier: 0,
        plan: basePlan,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      actionRepo.markApplied(writer, "act-m1", "success", NOW);

      actionRepo.insert(writer, {
        actionId: "act-m2",
        incidentId: "inc-m2",
        userId: "test-user",
        riskTier: 0,
        plan: basePlan,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      actionRepo.markRolledBack(writer, "act-m2", NOW);
    });

    const result = job.run("2025-06-15");
    expect(result.metric.actionsExecuted).toBe(2);
    expect(result.metric.autoFixSuccessRate).toBeCloseTo(0.5, 2);
    expect(result.metric.rollbackRate).toBeCloseTo(0.5, 2);
  });
});
```

## `test/unit/jobs/learning/friday-approval-expiry-job.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayApprovalExpiryJob } from "../../../../src/jobs/learning/friday-approval-expiry-job.js";
import { createFridayApprovalWorkflowService } from "../../../../src/learning/services/friday-approval-workflow-service.js";
import { createFridayApprovalRequestRepository } from "../../../../src/learning/persistence/friday-approval-request-repository.js";
import { createFridayAutoFixActionRepository } from "../../../../src/learning/persistence/friday-auto-fix-action-repository.js";
import { createFridayErrorIncidentRepository } from "../../../../src/learning/persistence/friday-error-incident-repository.js";
import type { FridayApprovalExpiryJob } from "../../../../src/jobs/learning/friday-approval-expiry-job.js";
import type { FridayAutoFixPlan } from "../../../../src/learning/model/friday-auto-fix.types.js";

describe("FridayApprovalExpiryJob", () => {
  let db: FridaySqliteLayer;
  let job: FridayApprovalExpiryJob;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";
  const PAST = "2025-06-14T10:00:00.000Z";

  const basePlan: FridayAutoFixPlan = {
    title: "Auto-fix: disable skill",
    summary: "Disable the broken skill",
    steps: [
      { stepId: "step-001", kind: "disable_skill", target: "skill-x", payload: {} },
    ],
    evidence: {
      fingerprint: "sig-abc",
      matchedLessonIds: [],
      diagnosisId: "diag-001",
      recurrenceCount: 1,
    },
  };

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();

    const incidentRepo = createFridayErrorIncidentRepository();
    incidentRepo.insert(db.writer, {
      incidentId: "inc-001",
      userId: "test-user",
      ts: NOW,
      category: "tool",
      severity: "high",
      signature: "sig-abc",
      context: {},
      autoFixEligible: true,
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const actionRepo = createFridayAutoFixActionRepository();
    actionRepo.insert(db.writer, {
      actionId: "action-001",
      incidentId: "inc-001",
      userId: "test-user",
      riskTier: 2,
      plan: basePlan,
      status: "planned",
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const approvalRepo = createFridayApprovalRequestRepository();
    const approvalService = createFridayApprovalWorkflowService({
      db,
      approvalRepo,
      actionRepo,
      idGenerator: idGen,
    });

    // Create an expired approval request
    approvalService.createRequestForAction({
      action: {
        actionId: "action-001",
        incidentId: "inc-001",
        userId: "test-user",
        riskTier: 2,
        plan: basePlan,
        status: "planned",
        outcome: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      description: "Approve this",
      nowIso: PAST,
      expiresAt: PAST, // Already expired
    });

    job = createFridayApprovalExpiryJob({
      approvalService,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("expires pending requests that are past expiry", () => {
    const result = job.run();
    expect(result.expiredCount).toBe(1);
    expect(result.expired).toHaveLength(1);
    expect(result.expired[0]!.status).toBe("expired");
  });

  it("marks linked actions as rejected", () => {
    job.run();

    const actionRepo = createFridayAutoFixActionRepository();
    const action = actionRepo.getById(db.writer, "action-001");
    expect(action!.status).toBe("rejected");
  });

  it("returns empty when no expired requests exist", () => {
    // Run once to expire
    job.run();
    // Run again — nothing left
    const result = job.run();
    expect(result.expiredCount).toBe(0);
    expect(result.expired).toHaveLength(0);
  });

  it("accepts a nowOverride parameter", () => {
    // Use a time before the expiry — should not expire
    const result = job.run("2025-06-13T10:00:00.000Z");
    expect(result.expiredCount).toBe(0);
  });
});
```

