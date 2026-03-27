import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridayWorkflowConflictEntity,
  FridayWorkflowConflictKind,
  FridayWorkflowConflictStatus,
} from "../model/friday-api-workflow.types.js";
import type { JsonValue } from "#workflows";

// ─── Row type ───

export interface FridayWorkflowConflictRow {
  conflict_id: string;
  workflow_id: string;
  draft_id: string;
  kind: string;
  status: string;
  base_workflow_version_id: string | null;
  head_workflow_version_id: string;
  detected_at: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  summary: string;
  patches_json: string;
  created_at: string;
  updated_at: string;
}

function rowToEntity(row: FridayWorkflowConflictRow): FridayWorkflowConflictEntity {
  return {
    conflictId: row.conflict_id,
    workflowId: row.workflow_id,
    draftId: row.draft_id,
    kind: row.kind as FridayWorkflowConflictKind,
    status: row.status as FridayWorkflowConflictStatus,
    baseWorkflowVersionId: row.base_workflow_version_id ?? undefined,
    headWorkflowVersionId: row.head_workflow_version_id,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedByUserId: row.resolved_by_user_id ?? undefined,
    summary: row.summary,
    patches: safeJsonParse<FridayWorkflowConflictEntity["patches"]>(row.patches_json) ?? [],
  };
}

// ─── Repository ───

export interface FridayWorkflowConflictRepository {
  findById(db: Database.Database, conflictId: string): FridayWorkflowConflictEntity | null;
  listByWorkflow(
    db: Database.Database,
    workflowId: string,
    status?: FridayWorkflowConflictStatus,
    limit?: number,
    cursor?: string,
  ): FridayWorkflowConflictEntity[];
  create(db: Database.Database, entity: FridayWorkflowConflictEntity, now: string): void;
  resolve(
    db: Database.Database,
    conflictId: string,
    resolvedByUserId: string | undefined,
    now: string,
  ): FridayWorkflowConflictEntity | null;
  dismiss(
    db: Database.Database,
    conflictId: string,
    now: string,
  ): FridayWorkflowConflictEntity | null;
}

// ─── Factory ───

export function createFridayWorkflowConflictRepository(): FridayWorkflowConflictRepository {
  return {
    findById(db, conflictId) {
      const row = db
        .prepare("SELECT * FROM workflow_conflicts WHERE conflict_id = ?")
        .get(conflictId) as FridayWorkflowConflictRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listByWorkflow(db, workflowId, status, limit = 50, cursor) {
      let sql = "SELECT * FROM workflow_conflicts WHERE workflow_id = ?";
      const params: unknown[] = [workflowId];

      if (status) {
        sql += " AND status = ?";
        params.push(status);
      }
      if (cursor) {
        sql += " AND conflict_id > ?";
        params.push(cursor);
      }

      sql += " ORDER BY detected_at DESC LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as FridayWorkflowConflictRow[];
      return rows.map(rowToEntity);
    },

    create(db, entity, now) {
      db.prepare(
        `INSERT INTO workflow_conflicts
         (conflict_id, workflow_id, draft_id, kind, status, base_workflow_version_id,
          head_workflow_version_id, detected_at, resolved_at, resolved_by_user_id,
          summary, patches_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entity.conflictId,
        entity.workflowId,
        entity.draftId,
        entity.kind,
        entity.status,
        entity.baseWorkflowVersionId ?? null,
        entity.headWorkflowVersionId,
        entity.detectedAt,
        entity.resolvedAt ?? null,
        entity.resolvedByUserId ?? null,
        entity.summary,
        JSON.stringify(entity.patches),
        now,
        now,
      );
    },

    resolve(db, conflictId, resolvedByUserId, now) {
      db.prepare(
        "UPDATE workflow_conflicts SET status = 'resolved', resolved_at = ?, resolved_by_user_id = ?, updated_at = ? WHERE conflict_id = ?",
      ).run(now, resolvedByUserId ?? null, now, conflictId);
      return this.findById(db, conflictId);
    },

    dismiss(db, conflictId, now) {
      db.prepare(
        "UPDATE workflow_conflicts SET status = 'dismissed', resolved_at = ?, updated_at = ? WHERE conflict_id = ?",
      ).run(now, now, conflictId);
      return this.findById(db, conflictId);
    },
  };
}
