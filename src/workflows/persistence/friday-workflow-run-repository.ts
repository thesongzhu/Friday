import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridayWorkflowRunEntity,
  FridayWorkflowRunRow,
  JsonObject,
  JsonValue,
  UUID,
  WorkflowRunStatus,
} from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowRunRepository {
  insertRun(db: Database.Database, entity: FridayWorkflowRunEntity): void;

  getRunById(
    db: Database.Database,
    id: UUID,
  ): FridayWorkflowRunEntity | null;

  updateRunStatus(
    db: Database.Database,
    id: UUID,
    status: WorkflowRunStatus,
    nowIso: string,
    failure?: { code: string; message: string; details?: unknown },
    metadata?: {
      deadlineAt?: string;
      pausedAt?: string;
      resumedAt?: string;
      finishedAt?: string;
      clearPausedAt?: boolean;
      clearResumedAt?: boolean;
      clearFinishedAt?: boolean;
    },
  ): void;

  finalizeRun(
    db: Database.Database,
    id: UUID,
    status: WorkflowRunStatus,
    nowIso: string,
    failure?: { code: string; message: string; details?: unknown },
  ): void;

  listRunsByWorkflow(
    db: Database.Database,
    workflowId: UUID,
    status?: WorkflowRunStatus,
    limit?: number,
  ): FridayWorkflowRunEntity[];

  listActiveRuns(db: Database.Database): FridayWorkflowRunEntity[];

  mergeRunContext(
    db: Database.Database,
    id: UUID,
    context: Record<string, unknown>,
    nowIso: string,
  ): void;

  /**
   * Audit C Stage 2(B): persist the run-level completion-verification label so
   * the orthogonal completion truth survives a hub restart (the runtime
   * aggregate is otherwise process-lifetime in-memory). Best-effort caller:
   * the runtime swallows a "no such column" error on legacy DBs predating
   * v089. Only ever downgrades to a non-verified label (NULL = clean verified).
   */
  setCompletionVerification(
    db: Database.Database,
    id: UUID,
    completionVerification: string,
  ): void;
}

// ─── Row mapper ───

function mapRunRow(row: FridayWorkflowRunRow): FridayWorkflowRunEntity {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status as WorkflowRunStatus,
    triggerType: row.trigger_type,
    triggerPayload: safeJsonParse<JsonObject>(row.trigger_payload_json),
    startedByUserId: row.started_by_user_id ?? undefined,
    startedBySatelliteId: row.started_by_satellite_id ?? undefined,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at ?? undefined,
    pausedAt: row.paused_at ?? undefined,
    resumedAt: row.resumed_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    context: safeJsonParse<JsonObject>(row.context_json),
    failure:
      row.failure_code
        ? {
            code: row.failure_code,
            message: row.failure_message ?? "",
            details: safeJsonParse<JsonValue>(row.failure_details_json),
          }
        : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    proofRequired: row.proof_required === 1,
    completionVerification:
      (row.completion_verification ?? undefined) as
        | FridayWorkflowRunEntity["completionVerification"]
        | undefined,
  };
}

// ─── Factory ───

export function createFridayWorkflowRunRepository(): FridayWorkflowRunRepository {
  return {
    insertRun(db, entity) {
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version_id, status, trigger_type,
         trigger_payload_json, started_by_user_id, started_by_satellite_id, started_at,
         deadline_at, paused_at, resumed_at, finished_at, correlation_id, context_json,
         failure_code, failure_message, failure_details_json, created_at, updated_at,
         proof_required)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entity.id,
        entity.workflowId,
        entity.workflowVersionId,
        entity.status,
        entity.triggerType,
        entity.triggerPayload ? JSON.stringify(entity.triggerPayload) : null,
        entity.startedByUserId ?? null,
        entity.startedBySatelliteId ?? null,
        entity.startedAt,
        entity.deadlineAt ?? null,
        entity.pausedAt ?? null,
        entity.resumedAt ?? null,
        entity.finishedAt ?? null,
        entity.correlationId ?? null,
        entity.context ? JSON.stringify(entity.context) : null,
        entity.failure?.code ?? null,
        entity.failure?.message ?? null,
        entity.failure?.details !== undefined
          ? JSON.stringify(entity.failure.details)
          : null,
        entity.createdAt,
        entity.updatedAt,
        entity.proofRequired ? 1 : 0,
      );
    },

    getRunById(db, id) {
      const row = db
        .prepare("SELECT * FROM workflow_runs WHERE id = ?")
        .get(id) as FridayWorkflowRunRow | undefined;
      return row ? mapRunRow(row) : null;
    },

    updateRunStatus(db, id, status, nowIso, failure, metadata) {
      // P2-WF: Enforce state transition by including current status check in WHERE clause
      const result = db.prepare(
        `UPDATE workflow_runs SET status = @status, failure_code = @failure_code, failure_message = @failure_message,
         failure_details_json = @failure_details_json,
         deadline_at = CASE
           WHEN @deadline_at IS NOT NULL THEN @deadline_at
           ELSE deadline_at
         END,
         paused_at = CASE
           WHEN @clear_paused_at = 1 THEN NULL
           WHEN @paused_at IS NOT NULL THEN @paused_at
           ELSE paused_at
         END,
         resumed_at = CASE
           WHEN @clear_resumed_at = 1 THEN NULL
           WHEN @resumed_at IS NOT NULL THEN @resumed_at
           ELSE resumed_at
         END,
         finished_at = CASE
           WHEN @clear_finished_at = 1 THEN NULL
           WHEN @finished_at IS NOT NULL THEN @finished_at
           ELSE finished_at
         END,
         updated_at = @updated_at
         WHERE id = @id AND status != @status_guard`,
      ).run(
        {
          id,
          status,
          failure_code: failure?.code ?? null,
          failure_message: failure?.message ?? null,
          failure_details_json: failure?.details !== undefined
            ? JSON.stringify(failure.details)
            : null,
          deadline_at: metadata?.deadlineAt ?? null,
          paused_at: metadata?.pausedAt ?? (status === "paused" ? nowIso : null),
          resumed_at: metadata?.resumedAt ?? null,
          finished_at: metadata?.finishedAt ?? null,
          clear_paused_at: metadata?.clearPausedAt ? 1 : 0,
          clear_resumed_at: metadata?.clearResumedAt ? 1 : 0,
          clear_finished_at: metadata?.clearFinishedAt ? 1 : 0,
          updated_at: nowIso,
          status_guard: status,
        },
      );
      if (result.changes === 0) {
        // Either the run doesn't exist or it's already in the target status — acceptable no-op
      }
    },

    finalizeRun(db, id, status, nowIso, failure) {
      // Phase 14.5C: first-writer-wins for terminal status. A run that has
      // already been finalized must not be overwritten by a later cascading
      // handler (e.g., fail_fast policy clobbering a more specific
      // WORKFLOW_EVIDENCE_UNAVAILABLE failure code recorded synchronously by
      // proof-required fail-closed evidence persistence). The SQL guard keeps
      // the previously recorded status, finished_at, and failure fields.
      db.prepare(
        `UPDATE workflow_runs SET status = ?, finished_at = ?, failure_code = ?,
         failure_message = ?, failure_details_json = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
      ).run(
        status,
        nowIso,
        failure?.code ?? null,
        failure?.message ?? null,
        failure?.details !== undefined ? JSON.stringify(failure.details) : null,
        nowIso,
        id,
      );
    },

    listRunsByWorkflow(db, workflowId, status, limit) {
      if (status) {
        return (
          db
            .prepare(
              "SELECT * FROM workflow_runs WHERE workflow_id = ? AND status = ? ORDER BY started_at DESC LIMIT ?",
            )
            .all(workflowId, status, limit ?? 50) as FridayWorkflowRunRow[]
        ).map(mapRunRow);
      }
      return (
        db
          .prepare(
            "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?",
          )
          .all(workflowId, limit ?? 50) as FridayWorkflowRunRow[]
      ).map(mapRunRow);
    },

    listActiveRuns(db) {
      return (
        db
          .prepare(
            "SELECT * FROM workflow_runs WHERE status IN ('queued', 'running', 'paused', 'pausing', 'compensating')",
          )
          .all() as FridayWorkflowRunRow[]
      ).map(mapRunRow);
    },

    mergeRunContext(db, id, context, nowIso) {
      const row = db
        .prepare("SELECT context_json FROM workflow_runs WHERE id = ?")
        .get(id) as { context_json: string | null } | undefined;

      const existing = safeJsonParse<Record<string, unknown>>(row?.context_json) ?? {};
      const merged = { ...existing, ...context };

      db.prepare(
        "UPDATE workflow_runs SET context_json = ?, updated_at = ? WHERE id = ?",
      ).run(JSON.stringify(merged), nowIso, id);
    },

    setCompletionVerification(db, id, completionVerification) {
      db.prepare(
        "UPDATE workflow_runs SET completion_verification = ? WHERE id = ?",
      ).run(completionVerification, id);
    },
  };
}
