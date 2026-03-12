import type Database from "better-sqlite3";
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
}

// ─── Row mapper ───

function mapRunRow(row: FridayWorkflowRunRow): FridayWorkflowRunEntity {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status as WorkflowRunStatus,
    triggerType: row.trigger_type,
    triggerPayload: row.trigger_payload_json
      ? (JSON.parse(row.trigger_payload_json) as JsonObject)
      : undefined,
    startedByUserId: row.started_by_user_id ?? undefined,
    startedBySatelliteId: row.started_by_satellite_id ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    context: row.context_json
      ? (JSON.parse(row.context_json) as JsonObject)
      : undefined,
    failure:
      row.failure_code
        ? {
            code: row.failure_code,
            message: row.failure_message ?? "",
            details: row.failure_details_json
              ? (JSON.parse(row.failure_details_json) as JsonValue)
              : undefined,
          }
        : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayWorkflowRunRepository(): FridayWorkflowRunRepository {
  return {
    insertRun(db, entity) {
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version_id, status, trigger_type,
         trigger_payload_json, started_by_user_id, started_by_satellite_id, started_at,
         finished_at, correlation_id, context_json, failure_code, failure_message,
         failure_details_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    },

    getRunById(db, id) {
      const row = db
        .prepare("SELECT * FROM workflow_runs WHERE id = ?")
        .get(id) as FridayWorkflowRunRow | undefined;
      return row ? mapRunRow(row) : null;
    },

    updateRunStatus(db, id, status, nowIso, failure) {
      db.prepare(
        `UPDATE workflow_runs SET status = ?, failure_code = ?, failure_message = ?,
         failure_details_json = ?, updated_at = ? WHERE id = ?`,
      ).run(
        status,
        failure?.code ?? null,
        failure?.message ?? null,
        failure?.details !== undefined ? JSON.stringify(failure.details) : null,
        nowIso,
        id,
      );
    },

    finalizeRun(db, id, status, nowIso, failure) {
      db.prepare(
        `UPDATE workflow_runs SET status = ?, finished_at = ?, failure_code = ?,
         failure_message = ?, failure_details_json = ?, updated_at = ? WHERE id = ?`,
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
            "SELECT * FROM workflow_runs WHERE status IN ('queued', 'running', 'pausing', 'compensating')",
          )
          .all() as FridayWorkflowRunRow[]
      ).map(mapRunRow);
    },

    mergeRunContext(db, id, context, nowIso) {
      const row = db
        .prepare("SELECT context_json FROM workflow_runs WHERE id = ?")
        .get(id) as { context_json: string | null } | undefined;

      const existing = row?.context_json
        ? (JSON.parse(row.context_json) as Record<string, unknown>)
        : {};
      const merged = { ...existing, ...context };

      db.prepare(
        "UPDATE workflow_runs SET context_json = ?, updated_at = ? WHERE id = ?",
      ).run(JSON.stringify(merged), nowIso, id);
    },
  };
}
