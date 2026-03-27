import type Database from "better-sqlite3";
import type {
  FridayAgentLoopPolicyEntity,
  FridayAgentLoopPolicyRow,
  FridayAgentLoopRunEntity,
  FridayAgentLoopRunRow,
} from "../model/friday-agent-loop.types.js";

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch (err) {
    console.warn("[friday][agent-loop-repository] JSON array parse failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function parseJsonValue<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    console.warn("[friday][agent-loop-repository] JSON parse failed:", err instanceof Error ? err.message : String(err));
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export interface FridayAgentLoopRepository {
  getPolicy(db: Database.Database): FridayAgentLoopPolicyEntity | null;
  upsertPolicy(
    db: Database.Database,
    policy: FridayAgentLoopPolicyEntity,
  ): FridayAgentLoopPolicyEntity;
  insertRun(
    db: Database.Database,
    run: FridayAgentLoopRunEntity,
  ): FridayAgentLoopRunEntity;
  getRunById(
    db: Database.Database,
    loopRunId: string,
  ): FridayAgentLoopRunEntity | null;
  getLatestRunByIncidentId(
    db: Database.Database,
    incidentId: string,
  ): FridayAgentLoopRunEntity | null;
  getLatestRunByActionId(
    db: Database.Database,
    actionId: string,
  ): FridayAgentLoopRunEntity | null;
  listRuns(
    db: Database.Database,
    input?: {
      userId?: string;
      status?: FridayAgentLoopRunEntity["status"];
      limit?: number;
    },
  ): FridayAgentLoopRunEntity[];
  countFailuresByFingerprint(
    db: Database.Database,
    userId: string,
    fingerprint: string,
  ): number;
  updateRun(
    db: Database.Database,
    loopRunId: string,
    patch: Partial<FridayAgentLoopRunEntity>,
  ): FridayAgentLoopRunEntity | null;
}

function rowToPolicy(row: FridayAgentLoopPolicyRow): FridayAgentLoopPolicyEntity {
  return {
    id: row.id,
    mode: row.mode,
    paused: row.paused === 1,
    autoApplyLowRisk: row.auto_apply_low_risk === 1,
    maxAttemptsPerFingerprint: row.max_attempts_per_fingerprint,
    cooldownMinutes: row.cooldown_minutes,
    requireRollbackPlan: row.require_rollback_plan === 1,
    requireAcceptanceCheck: row.require_acceptance_check === 1,
    expertModeEnabled: row.expert_mode_enabled === 1,
    expertModeUserIds: parseJsonArray(row.expert_mode_user_ids_json),
    expertModeWorkspaceIds: parseJsonArray(row.expert_mode_workspace_ids_json),
    expertModeEnvironments: parseJsonArray(row.expert_mode_environments_json),
    contextInferenceAllowed: row.context_inference_allowed === 1,
    multiStepHypothesisSearchAllowed: row.multi_step_hypothesis_search_allowed === 1,
    safeProbeExecutionAllowed: row.safe_probe_execution_allowed === 1,
    crossSurfaceOrchestrationAllowed: row.cross_surface_orchestration_allowed === 1,
    highRiskFinalApprovalRequired: row.high_risk_final_approval_required === 1,
    productionDestructiveActionApprovalRequired:
      row.production_destructive_action_approval_required === 1,
    probeBudget: row.probe_budget,
    timeBudgetMinutes: row.time_budget_minutes,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row: FridayAgentLoopRunRow): FridayAgentLoopRunEntity {
  return {
    loopRunId: row.loop_run_id,
    userId: row.user_id,
    incidentId: row.incident_id,
    actionId: row.action_id ?? undefined,
    fingerprint: row.fingerprint,
    trigger: row.trigger,
    status: row.status,
    riskTier: row.risk_tier,
    approvalRequired: row.approval_required === 1,
    attemptNumber: row.attempt_number,
    verificationPassed: row.verification_passed === null ? undefined : row.verification_passed === 1,
    rollbackAttempted: row.rollback_attempted === 1,
    rollbackSucceeded: row.rollback_succeeded === 1,
    haltReason: row.halt_reason ?? undefined,
    lastError: row.last_error ?? undefined,
    lessonId: row.lesson_id ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    pausedAt: row.paused_at ?? undefined,
    resumedAt: row.resumed_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    cooldownUntil: row.cooldown_until ?? undefined,
    expertModeEnabled: row.expert_mode_enabled === 1,
    riskClass: row.risk_class ?? undefined,
    requiresFinalApproval: row.requires_final_approval === 1,
    assumptions: parseJsonArray(row.assumptions_json),
    unknowns: parseJsonArray(row.unknowns_json),
    hypotheses: parseJsonValue(row.hypotheses_json, []),
    probeSteps: parseJsonValue(row.probe_steps_json, []),
    probeBudget: row.probe_budget ?? undefined,
    objective: row.objective ?? undefined,
    planSummary: row.plan_summary ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayAgentLoopRepository(): FridayAgentLoopRepository {
  return {
    getPolicy(db) {
      const row = db
        .prepare("SELECT * FROM friday_agent_loop_policy WHERE id = 'default'")
        .get() as FridayAgentLoopPolicyRow | undefined;
      return row ? rowToPolicy(row) : null;
    },

    upsertPolicy(db, policy) {
      db.prepare(
        `INSERT INTO friday_agent_loop_policy
         (id, mode, paused, auto_apply_low_risk, max_attempts_per_fingerprint,
          cooldown_minutes, require_rollback_plan, require_acceptance_check,
          expert_mode_enabled, expert_mode_user_ids_json, expert_mode_workspace_ids_json,
          expert_mode_environments_json, context_inference_allowed,
          multi_step_hypothesis_search_allowed, safe_probe_execution_allowed,
          cross_surface_orchestration_allowed, high_risk_final_approval_required,
          production_destructive_action_approval_required, probe_budget, time_budget_minutes,
          updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           mode = excluded.mode,
           paused = excluded.paused,
           auto_apply_low_risk = excluded.auto_apply_low_risk,
           max_attempts_per_fingerprint = excluded.max_attempts_per_fingerprint,
           cooldown_minutes = excluded.cooldown_minutes,
           require_rollback_plan = excluded.require_rollback_plan,
           require_acceptance_check = excluded.require_acceptance_check,
           expert_mode_enabled = excluded.expert_mode_enabled,
           expert_mode_user_ids_json = excluded.expert_mode_user_ids_json,
           expert_mode_workspace_ids_json = excluded.expert_mode_workspace_ids_json,
           expert_mode_environments_json = excluded.expert_mode_environments_json,
           context_inference_allowed = excluded.context_inference_allowed,
           multi_step_hypothesis_search_allowed = excluded.multi_step_hypothesis_search_allowed,
           safe_probe_execution_allowed = excluded.safe_probe_execution_allowed,
           cross_surface_orchestration_allowed = excluded.cross_surface_orchestration_allowed,
           high_risk_final_approval_required = excluded.high_risk_final_approval_required,
           production_destructive_action_approval_required = excluded.production_destructive_action_approval_required,
           probe_budget = excluded.probe_budget,
           time_budget_minutes = excluded.time_budget_minutes,
           updated_at = excluded.updated_at`,
      ).run(
        policy.id,
        policy.mode,
        policy.paused ? 1 : 0,
        policy.autoApplyLowRisk ? 1 : 0,
        policy.maxAttemptsPerFingerprint,
        policy.cooldownMinutes,
        policy.requireRollbackPlan ? 1 : 0,
        policy.requireAcceptanceCheck ? 1 : 0,
        policy.expertModeEnabled ? 1 : 0,
        stringifyJson(policy.expertModeUserIds),
        stringifyJson(policy.expertModeWorkspaceIds),
        stringifyJson(policy.expertModeEnvironments),
        policy.contextInferenceAllowed ? 1 : 0,
        policy.multiStepHypothesisSearchAllowed ? 1 : 0,
        policy.safeProbeExecutionAllowed ? 1 : 0,
        policy.crossSurfaceOrchestrationAllowed ? 1 : 0,
        policy.highRiskFinalApprovalRequired ? 1 : 0,
        policy.productionDestructiveActionApprovalRequired ? 1 : 0,
        policy.probeBudget,
        policy.timeBudgetMinutes,
        policy.updatedAt,
      );
      return policy;
    },

    insertRun(db, run) {
      db.prepare(
        `INSERT INTO friday_agent_loop_runs
         (loop_run_id, user_id, incident_id, action_id, fingerprint, trigger, status, risk_tier,
          approval_required, attempt_number, verification_passed, rollback_attempted,
          rollback_succeeded, halt_reason, last_error, lesson_id, correlation_id, started_at,
          completed_at, paused_at, resumed_at, cancelled_at, cooldown_until, expert_mode_enabled,
          risk_class, requires_final_approval, assumptions_json, unknowns_json, hypotheses_json,
          probe_steps_json, probe_budget, objective, plan_summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.loopRunId,
        run.userId,
        run.incidentId,
        run.actionId ?? null,
        run.fingerprint,
        run.trigger,
        run.status,
        run.riskTier,
        run.approvalRequired ? 1 : 0,
        run.attemptNumber,
        run.verificationPassed === undefined ? null : (run.verificationPassed ? 1 : 0),
        run.rollbackAttempted ? 1 : 0,
        run.rollbackSucceeded ? 1 : 0,
        run.haltReason ?? null,
        run.lastError ?? null,
        run.lessonId ?? null,
        run.correlationId ?? null,
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.pausedAt ?? null,
        run.resumedAt ?? null,
        run.cancelledAt ?? null,
        run.cooldownUntil ?? null,
        run.expertModeEnabled ? 1 : 0,
        run.riskClass ?? null,
        run.requiresFinalApproval ? 1 : 0,
        stringifyJson(run.assumptions),
        stringifyJson(run.unknowns),
        stringifyJson(run.hypotheses),
        stringifyJson(run.probeSteps),
        run.probeBudget ?? null,
        run.objective ?? null,
        run.planSummary ?? null,
        run.createdAt,
        run.updatedAt,
      );
      return run;
    },

    getRunById(db, loopRunId) {
      const row = db
        .prepare("SELECT * FROM friday_agent_loop_runs WHERE loop_run_id = ?")
        .get(loopRunId) as FridayAgentLoopRunRow | undefined;
      return row ? rowToRun(row) : null;
    },

    getLatestRunByIncidentId(db, incidentId) {
      const row = db
        .prepare(
          "SELECT * FROM friday_agent_loop_runs WHERE incident_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(incidentId) as FridayAgentLoopRunRow | undefined;
      return row ? rowToRun(row) : null;
    },

    getLatestRunByActionId(db, actionId) {
      const row = db
        .prepare(
          "SELECT * FROM friday_agent_loop_runs WHERE action_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(actionId) as FridayAgentLoopRunRow | undefined;
      return row ? rowToRun(row) : null;
    },

    listRuns(db, input) {
      let sql = "SELECT * FROM friday_agent_loop_runs WHERE 1 = 1";
      const params: unknown[] = [];

      if (input?.userId) {
        sql += " AND user_id = ?";
        params.push(input.userId);
      }
      if (input?.status) {
        sql += " AND status = ?";
        params.push(input.status);
      }

      sql += " ORDER BY created_at DESC";

      if (input?.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      const rows = db.prepare(sql).all(...params) as FridayAgentLoopRunRow[];
      return rows.map(rowToRun);
    },

    countFailuresByFingerprint(db, userId, fingerprint) {
      const row = db
        .prepare(
          `SELECT COUNT(*) as count
           FROM friday_agent_loop_runs
           WHERE user_id = ?
             AND fingerprint = ?
             AND status IN ('rolled_back', 'failed', 'halted', 'cooldown')`,
        )
        .get(userId, fingerprint) as { count: number };
      return row.count;
    },

    updateRun(db, loopRunId, patch) {
      const current = this.getRunById(db, loopRunId);
      if (!current) {
        return null;
      }
      const next: FridayAgentLoopRunEntity = {
        ...current,
        ...patch,
        loopRunId: current.loopRunId,
        userId: patch.userId ?? current.userId,
        incidentId: patch.incidentId ?? current.incidentId,
        fingerprint: patch.fingerprint ?? current.fingerprint,
        trigger: patch.trigger ?? current.trigger,
        createdAt: current.createdAt,
        updatedAt: patch.updatedAt ?? current.updatedAt,
      };

      db.prepare(
        `UPDATE friday_agent_loop_runs
         SET action_id = ?, fingerprint = ?, trigger = ?, status = ?, risk_tier = ?,
             approval_required = ?, attempt_number = ?, verification_passed = ?,
             rollback_attempted = ?, rollback_succeeded = ?, halt_reason = ?, last_error = ?,
             lesson_id = ?, correlation_id = ?, started_at = ?, completed_at = ?, paused_at = ?,
             resumed_at = ?, cancelled_at = ?, cooldown_until = ?, expert_mode_enabled = ?,
             risk_class = ?, requires_final_approval = ?, assumptions_json = ?, unknowns_json = ?,
             hypotheses_json = ?, probe_steps_json = ?, probe_budget = ?, objective = ?,
             plan_summary = ?, updated_at = ?
         WHERE loop_run_id = ?`,
      ).run(
        next.actionId ?? null,
        next.fingerprint,
        next.trigger,
        next.status,
        next.riskTier,
        next.approvalRequired ? 1 : 0,
        next.attemptNumber,
        next.verificationPassed === undefined ? null : (next.verificationPassed ? 1 : 0),
        next.rollbackAttempted ? 1 : 0,
        next.rollbackSucceeded ? 1 : 0,
        next.haltReason ?? null,
        next.lastError ?? null,
        next.lessonId ?? null,
        next.correlationId ?? null,
        next.startedAt ?? null,
        next.completedAt ?? null,
        next.pausedAt ?? null,
        next.resumedAt ?? null,
        next.cancelledAt ?? null,
        next.cooldownUntil ?? null,
        next.expertModeEnabled ? 1 : 0,
        next.riskClass ?? null,
        next.requiresFinalApproval ? 1 : 0,
        stringifyJson(next.assumptions),
        stringifyJson(next.unknowns),
        stringifyJson(next.hypotheses),
        stringifyJson(next.probeSteps),
        next.probeBudget ?? null,
        next.objective ?? null,
        next.planSummary ?? null,
        next.updatedAt,
        loopRunId,
      );
      return next;
    },
  };
}
