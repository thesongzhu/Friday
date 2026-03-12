import type Database from "better-sqlite3";
import type { UUID } from "../../model/friday-workflow.types.js";
import { FridayDomainError } from "#errors";
import type {
  FridayWorkflowDraftEntity,
  FridayWorkflowDraftStatus,
} from "../model/friday-workflow-builder-draft.types.js";

// ─── Interface ───

export interface FridayWorkflowBuilderDraftRepository {
  create(db: Database.Database, draft: FridayWorkflowDraftEntity): void;
  getById(db: Database.Database, draftId: UUID): FridayWorkflowDraftEntity | null;
  listByWorkflow(db: Database.Database, workflowId: UUID): FridayWorkflowDraftEntity[];
  listByStatus(db: Database.Database, status: FridayWorkflowDraftStatus): FridayWorkflowDraftEntity[];
  update(db: Database.Database, draft: FridayWorkflowDraftEntity): void;
  updateStatus(db: Database.Database, draftId: UUID, status: FridayWorkflowDraftStatus, nowIso: string): void;
}

// ─── Constants ───

const NAMESPACE = "workflow_builder_drafts";

function draftKey(workflowId: UUID, draftId: UUID): string {
  return `${workflowId}:${draftId}`;
}

// ─── Factory ───

export function createFridayWorkflowBuilderDraftRepository(): FridayWorkflowBuilderDraftRepository {
  return {
    create(db, draft) {
      db.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        draft.draftId,
        NAMESPACE,
        draftKey(draft.workflowId, draft.draftId),
        JSON.stringify(draft),
        JSON.stringify([draft.status]),
        draft.createdAt,
        draft.updatedAt,
      );
    },

    getById(db, draftId) {
      const row = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ?`,
        )
        .get(NAMESPACE, `%:${draftId}`) as { value_json: string } | undefined;
      return row ? (JSON.parse(row.value_json) as FridayWorkflowDraftEntity) : null;
    },

    listByWorkflow(db, workflowId) {
      const rows = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY updated_at DESC`,
        )
        .all(NAMESPACE, `${workflowId}:%`) as Array<{ value_json: string }>;
      return rows.map((r) => JSON.parse(r.value_json) as FridayWorkflowDraftEntity);
    },

    listByStatus(db, status) {
      const rows = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? ORDER BY updated_at DESC`,
        )
        .all(NAMESPACE) as Array<{ value_json: string }>;
      return rows
        .map((r) => JSON.parse(r.value_json) as FridayWorkflowDraftEntity)
        .filter((d) => d.status === status);
    },

    update(db, draft) {
      const result = db
        .prepare(
          `UPDATE memory_items SET value_json = ?, tags_json = ?, updated_at = ?
           WHERE namespace = ? AND key = ?`,
        )
        .run(
          JSON.stringify(draft),
          JSON.stringify([draft.status]),
          draft.updatedAt,
          NAMESPACE,
          draftKey(draft.workflowId, draft.draftId),
        );
      if (result.changes === 0) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "DRAFT_NOT_FOUND", { httpStatus: 404 });
      }
    },

    updateStatus(db, draftId, status, nowIso) {
      const existing = this.getById(db, draftId);
      if (!existing) throw new FridayDomainError("DRAFT_NOT_FOUND", "DRAFT_NOT_FOUND", { httpStatus: 404 });
      existing.status = status;
      existing.updatedAt = nowIso;
      this.update(db, existing);
    },
  };
}
