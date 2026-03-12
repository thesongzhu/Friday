> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 7: Auto-Fix System Implementation Plan

## 1. File structure
```text
src/learning/model/
  friday-learning.types.ts                         (modify: extend process result + metrics comments)
  friday-auto-fix.types.ts                         (new)

src/learning/persistence/
  friday-error-incident-repository.ts              (modify: update eligibility/status methods)
  friday-diagnosis-record-repository.ts            (modify: resolve markers + richer lookup)
  friday-learned-lesson-repository.ts              (modify: fingerprint lookup helpers)
  friday-auto-fix-action-repository.ts             (new)
  friday-approval-request-repository.ts            (new)

src/learning/services/
  friday-error-diagnosis-service.ts                (new)
  friday-auto-fix-plan-service.ts                  (new)
  friday-auto-fix-risk-assessment-service.ts       (new)
  friday-auto-fix-execution-service.ts             (new)
  friday-auto-fix-rollback-service.ts              (new)
  friday-approval-workflow-service.ts              (new)
  friday-auto-fix-lesson-extraction-service.ts     (new)
  friday-auto-fix-dispatcher-service.ts            (new)
  friday-self-learning-pipeline-service.ts         (modify: diagnosis+plan+action/approval creation)
  friday-learning-metrics-service.ts               (modify: compute auto-fix + rollback metrics)

src/learning/runtime/
  friday-self-learning-runtime.types.ts            (modify: expose auto-fix services)
  friday-self-learning-runtime.ts                  (modify: compose new repos/services)

src/learning/
  index.ts                                         (modify exports)

src/jobs/learning/
  friday-approval-expiry.types.ts                  (new)
  friday-approval-expiry-job.ts                    (new)

test/unit/learning/persistence/
  friday-auto-fix-action-repository.test.ts        (new)
  friday-approval-request-repository.test.ts       (new)

test/unit/learning/services/
  friday-error-diagnosis-service.test.ts           (new)
  friday-auto-fix-plan-service.test.ts             (new)
  friday-auto-fix-risk-assessment-service.test.ts  (new)
  friday-auto-fix-execution-service.test.ts        (new)
  friday-approval-workflow-service.test.ts         (new)
  friday-auto-fix-dispatcher-service.test.ts       (new)

test/unit/learning/runtime/
  friday-self-learning-runtime.test.ts             (modify)

test/unit/learning/services/
  friday-self-learning-pipeline-service.test.ts    (modify)

test/unit/jobs/learning/
  friday-learning-metrics-job.test.ts              (modify)
  friday-approval-expiry-job.test.ts               (new)
```

## 2. Type definitions (full signatures)
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

## 3. Persistence layer
1. Keep V001 schema exactly as-is (`error_incidents`, `diagnosis_records`, `learned_lessons`, `auto_fix_actions`, `approval_requests`, `learning_metrics`).
2. Add `FridayAutoFixActionRepository` for `auto_fix_actions` with insert/get/list-planned/mark-applied/mark-rolled-back/mark-rejected/set-rollback-plan.
3. Add `FridayApprovalRequestRepository` for `approval_requests` with insert/get/list/resolve-pending/expire-pending.
4. Extend `FridayErrorIncidentRepository` with `setAutoFixEligibility(...)` and `updateStatus(...)`.
5. Extend `FridayDiagnosisRecordRepository` with `markResolved(...)` and richer list-by-fingerprint helpers.
6. Extend `FridayLearnedLessonRepository` with `getByFingerprint(...)` for direct matching.
7. Enforce transactional rules with `FridaySqliteLayer.withWriteTransaction`:
   - Incident + diagnosis + action/approval creation in one transaction.
   - Execution result updates in separate transaction.
   - Lesson extraction + incident/diagnosis resolution updates in one transaction.

## 4. Services
```ts
export interface FridayErrorDiagnosisService {
  diagnose(input: { incident: FridayErrorIncidentEntity; nowIso: ISODateTime }): FridayDiagnosisOutcome;
}

export interface FridayAutoFixPlanService {
  buildPlans(input: {
    incident: FridayErrorIncidentEntity;
    diagnosis: FridayDiagnosisRecordEntity;
    matchedLessons: FridayLearnedLessonEntity[];
    recurrenceCount: number;
  }): FridayAutoFixPlan[];
}

export interface FridayAutoFixRiskAssessmentService {
  assess(input: {
    incident: FridayErrorIncidentEntity;
    plan: FridayAutoFixPlan;
    nowIso: ISODateTime;
  }): FridayRiskAssessment;
}

export interface FridayAutoFixExecutionService {
  execute(actionId: UUID): Promise<FridayAutoFixExecutionResult>;
}

export interface FridayAutoFixRollbackService {
  rollback(actionId: UUID, reason: string): Promise<FridayAutoFixExecutionResult>;
}

export interface FridayApprovalWorkflowService {
  createRequestForAction(input: {
    action: FridayAutoFixActionEntity;
    runId?: UUID;
    description: string;
    nowIso: ISODateTime;
    expiresAt: ISODateTime;
  }): FridayApprovalRequestEntity;
  approve(input: { requestId: UUID; respondedBy: UUID; reason?: string; nowIso: ISODateTime }): FridayApprovalRequestEntity;
  reject(input: { requestId: UUID; respondedBy: UUID; reason?: string; nowIso: ISODateTime }): FridayApprovalRequestEntity;
  expirePending(input: { nowIso: ISODateTime; limit?: number }): FridayApprovalRequestEntity[];
}

export interface FridayAutoFixLessonExtractionService {
  extractFromSuccess(input: {
    incident: FridayErrorIncidentEntity;
    diagnosis: FridayDiagnosisRecordEntity;
    action: FridayAutoFixActionEntity;
    nowIso: ISODateTime;
  }): FridayLearnedLessonEntity | null;
}

export interface FridayAutoFixDispatcherService {
  runReadyActions(input?: {
    incidentIds?: UUID[];
    maxRiskTier?: 0 | 1;
    limit?: number;
  }): Promise<FridayAutoFixExecutionResult[]>;
  runApprovedAction(actionId: UUID): Promise<FridayAutoFixExecutionResult>;
}
```

## 5. Diagnosis algorithm
1. Use incident `signature` as primary fingerprint; fallback deterministic hash of category + normalized error fields.
2. Pull evidence from:
   - `learned_lessons` exact fingerprint.
   - `diagnosis_records` recent by fingerprint.
   - `error_incidents` recent by user+signature (recurrence count).
3. Build ranked causes and fixes using deterministic scoring:
   - exact lesson match boost.
   - recurrence boost.
   - historical high-confidence diagnosis boost.
   - ambiguity penalty for weak context.
4. Set `autoFixEligible=true` only when confidence threshold and at least one executable plan step exist.
5. Persist `diagnosis_records.diagnosis_json` with summary, ranked causes, suggested fixes, matched lesson IDs, recurrence metadata.
6. Emit `diagnosis.created` event.

## 6. Risk tier model
1. Tier 0: stateless remediation (`retry_node`, `switch_model_fallback`, `trim_payload`), auto-apply.
2. Tier 1: reversible config/safe patch (`apply_config_patch`, `grant_permission`), auto-apply with mandatory rollback plan + verification.
3. Tier 2: destructive or broad-scope changes (`disable_skill`, `pause_workflow`, workflow mutation), approval required.
4. Escalation rules:
   - High severity incident bumps minimum to Tier 2.
   - 24h rollback rate > 30% disables Tier 1 auto-apply.
   - 1h error spike > 3x baseline disables Tier 0/1 auto-apply.
5. Persist final tier in `auto_fix_actions.risk_tier` and mirror it for approvals in `approval_requests.risk_tier=2`.

## 7. Fix execution + rollback
1. Dispatcher selects `auto_fix_actions.status='planned'` and policy-eligible rows.
2. Execution service applies plan steps in order via in-process executor map.
3. For Tier 1+, ensure rollback plan exists before applying first step.
4. Verification runs after apply; if verification fails, call rollback service immediately.
5. Status transitions:
   - Success: `planned -> applied`, `outcome='success'`, set `applied_at`.
   - Failed + rollback: `planned -> rolled_back`, `outcome='failed'`, set `rolled_back_at`.
   - Rejected/expired approval: `planned -> rejected`, `outcome=NULL`.
6. On successful apply, mark incident `mitigated`/`resolved`, set `diagnosis_records.resolved_at`, and extract lesson.
7. Reuse existing config backup path through `writeFridayConfig` for config patch steps; no new dependency.

## 8. Approval workflow
1. Create request for Tier 2 action with `status='pending'`, `expires_at=now+24h` (configurable).
2. Approve path:
   - Transition `pending -> approved`.
   - Execute associated action through dispatcher.
   - Emit `approval.resolved`.
3. Reject path:
   - Transition `pending -> rejected`.
   - Mark action `rejected`.
   - Emit `approval.resolved`.
4. Expiry path:
   - Job/service marks stale pending requests as `expired`.
   - Mark linked action `rejected`.
   - Emit `approval.resolved`.
5. Idempotency/concurrency:
   - All resolve operations use conditional update `WHERE request_id=? AND status='pending'`.
6. API alignment remains with existing contract (`GET /v1/approvals`, `POST /approve`, `POST /reject`).

## 9. Runtime compositor
1. Extend `createFridaySelfLearningRuntime` to compose new repositories and services.
2. Expose runtime handles: `diagnosis`, `autoFixPlan`, `autoFixRisk`, `autoFixExecution`, `approvals`, `autoFixDispatcher`.
3. Keep `FridaySelfLearningPipelineService` as ingestion/classification entrypoint; add planning + action/approval creation there.
4. In workflow failure hook (`workflow.node.failed`), run:
   - `pipeline.processEvent(...)`
   - `autoFixDispatcher.runReadyActions({ incidentIds, maxRiskTier: 1 })`
5. On approval approval endpoint, after marking approved, call `runApprovedAction(actionId)`.
6. Keep event publication optional via existing `publishEvent` dep (`diagnosis.created`, `lesson.updated`, `approval.requested`, `approval.resolved`).

## 10. Unit test plan
1. `test/unit/learning/persistence/friday-auto-fix-action-repository.test.ts`: CRUD + state transitions + JSON serialization.
2. `test/unit/learning/persistence/friday-approval-request-repository.test.ts`: create/list/resolve/expire semantics.
3. `test/unit/learning/services/friday-error-diagnosis-service.test.ts`: fingerprint matching, recurrence confidence, non-eligible fallback.
4. `test/unit/learning/services/friday-auto-fix-plan-service.test.ts`: plan generation from diagnosis + lessons.
5. `test/unit/learning/services/friday-auto-fix-risk-assessment-service.test.ts`: tier assignment and policy escalation.
6. `test/unit/learning/services/friday-auto-fix-execution-service.test.ts`: success path, verification fail -> rollback, reject path.
7. `test/unit/learning/services/friday-approval-workflow-service.test.ts`: approve/reject/expire lifecycle and idempotency.
8. `test/unit/learning/services/friday-auto-fix-dispatcher-service.test.ts`: ready action selection and tier cap behavior.
9. `test/unit/learning/services/friday-self-learning-pipeline-service.test.ts`: replace Phase 6 invariant with Phase 7 assertions (writes actions/approvals when eligible).
10. `test/unit/learning/runtime/friday-self-learning-runtime.test.ts`: compositor exposes all new services.
11. `test/unit/jobs/learning/friday-learning-metrics-job.test.ts`: assert `autoFixSuccessRate`, `rollbackRate`, `actionsExecuted`.
12. `test/unit/jobs/learning/friday-approval-expiry-job.test.ts`: pending -> expired updates and linked action rejection.
