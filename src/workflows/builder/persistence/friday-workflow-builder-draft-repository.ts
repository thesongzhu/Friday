import type Database from "better-sqlite3";
import type { UUID } from "../../model/friday-workflow.types.js";
import { FridayDomainError } from "#errors";
import { safeJsonParse } from "#utilities";
import type {
  FridayWorkflowDraftEntity,
  FridayWorkflowDraftSourceReview,
  FridayWorkflowDraftStatus,
} from "../model/friday-workflow-builder-draft.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";

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

const LEGACY_MEMORY_NAMESPACE = "workflow_builder_drafts";

interface DraftRow {
  draft_id: string;
  workflow_id: string;
  title: string;
  status: string;
  revision: number;
  spec_json: string;
  visual_json: string;
  owner_user_id: string | null;
  base_workflow_version_id: string | null;
  created_at: string;
  updated_at: string;
  autosave_enabled: number;
  autosave_interval_ms: number;
  autosave_last_saved_at: string | null;
  published_workflow_version_id: string | null;
  source_review_json: string | null;
}

function rowToDraft(row: DraftRow): FridayWorkflowDraftEntity | null {
  const spec = safeJsonParse<FridayWorkflowSpecV1>(row.spec_json);
  const visual = safeJsonParse<FridayWorkflowVisualGraphV1>(row.visual_json);
  if (!spec || !visual) return null;

  const sourceReview = row.source_review_json
    ? safeJsonParse<FridayWorkflowDraftSourceReview>(row.source_review_json)
    : undefined;

  return {
    draftId: row.draft_id,
    workflowId: row.workflow_id,
    ownerUserId: row.owner_user_id ?? undefined,
    title: row.title,
    status: row.status as FridayWorkflowDraftStatus,
    revision: row.revision,
    baseWorkflowVersionId: row.base_workflow_version_id ?? undefined,
    spec,
    visual,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedVersionId: row.published_workflow_version_id ?? undefined,
    autosave: {
      enabled: row.autosave_enabled === 1,
      intervalMs: row.autosave_interval_ms,
      lastSavedAt: row.autosave_last_saved_at ?? undefined,
    },
    sourceReview,
  };
}

function readDraftRowById(
  db: Database.Database,
  draftId: UUID,
): FridayWorkflowDraftEntity | null {
  const row = db
    .prepare("SELECT * FROM workflow_builder_drafts WHERE draft_id = ?")
    .get(draftId) as DraftRow | undefined;
  return row ? rowToDraft(row) : null;
}

function readLegacyDraftById(
  db: Database.Database,
  draftId: UUID,
): FridayWorkflowDraftEntity | null {
  const row = db
    .prepare(
      `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ?`,
    )
    .get(LEGACY_MEMORY_NAMESPACE, `%:${draftId}`) as { value_json: string } | undefined;
  return row ? safeJsonParse<FridayWorkflowDraftEntity>(row.value_json) ?? null : null;
}

function insertDraftRow(db: Database.Database, draft: FridayWorkflowDraftEntity): void {
  db.prepare(
    `INSERT INTO workflow_builder_drafts (
      draft_id, workflow_id, title, status, revision, spec_json, visual_json,
      owner_user_id, base_workflow_version_id, created_at, updated_at,
      autosave_enabled, autosave_interval_ms, autosave_last_saved_at,
      published_workflow_version_id, source_review_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    draft.draftId,
    draft.workflowId,
    draft.title,
    draft.status,
    draft.revision,
    JSON.stringify(draft.spec),
    JSON.stringify(draft.visual),
    draft.ownerUserId ?? null,
    draft.baseWorkflowVersionId ?? null,
    draft.createdAt,
    draft.updatedAt,
    draft.autosave.enabled ? 1 : 0,
    draft.autosave.intervalMs,
    draft.autosave.lastSavedAt ?? null,
    draft.publishedVersionId ?? null,
    draft.sourceReview ? JSON.stringify(draft.sourceReview) : null,
  );
}

function upsertDraftRow(db: Database.Database, draft: FridayWorkflowDraftEntity): void {
  db.prepare(
    `INSERT INTO workflow_builder_drafts (
      draft_id, workflow_id, title, status, revision, spec_json, visual_json,
      owner_user_id, base_workflow_version_id, created_at, updated_at,
      autosave_enabled, autosave_interval_ms, autosave_last_saved_at,
      published_workflow_version_id, source_review_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(draft_id) DO UPDATE SET
      workflow_id = excluded.workflow_id,
      title = excluded.title,
      status = excluded.status,
      revision = excluded.revision,
      spec_json = excluded.spec_json,
      visual_json = excluded.visual_json,
      owner_user_id = excluded.owner_user_id,
      base_workflow_version_id = excluded.base_workflow_version_id,
      updated_at = excluded.updated_at,
      autosave_enabled = excluded.autosave_enabled,
      autosave_interval_ms = excluded.autosave_interval_ms,
      autosave_last_saved_at = excluded.autosave_last_saved_at,
      published_workflow_version_id = excluded.published_workflow_version_id,
      source_review_json = excluded.source_review_json`,
  ).run(
    draft.draftId,
    draft.workflowId,
    draft.title,
    draft.status,
    draft.revision,
    JSON.stringify(draft.spec),
    JSON.stringify(draft.visual),
    draft.ownerUserId ?? null,
    draft.baseWorkflowVersionId ?? null,
    draft.createdAt,
    draft.updatedAt,
    draft.autosave.enabled ? 1 : 0,
    draft.autosave.intervalMs,
    draft.autosave.lastSavedAt ?? null,
    draft.publishedVersionId ?? null,
    draft.sourceReview ? JSON.stringify(draft.sourceReview) : null,
  );
}

function readLegacyDraftsByWorkflow(
  db: Database.Database,
  workflowId: UUID,
): FridayWorkflowDraftEntity[] {
  const rows = db
    .prepare(
      `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY updated_at DESC`,
    )
    .all(LEGACY_MEMORY_NAMESPACE, `${workflowId}:%`) as Array<{ value_json: string }>;
  return rows
    .map((row) => safeJsonParse<FridayWorkflowDraftEntity>(row.value_json))
    .filter((draft): draft is FridayWorkflowDraftEntity => draft !== undefined);
}

function readLegacyDraftsByStatus(
  db: Database.Database,
  status: FridayWorkflowDraftStatus,
): FridayWorkflowDraftEntity[] {
  const rows = db
    .prepare(
      `SELECT value_json FROM memory_items WHERE namespace = ? ORDER BY updated_at DESC`,
    )
    .all(LEGACY_MEMORY_NAMESPACE) as Array<{ value_json: string }>;
  return rows
    .map((row) => safeJsonParse<FridayWorkflowDraftEntity>(row.value_json))
    .filter((draft): draft is FridayWorkflowDraftEntity => draft?.status === status);
}

function mergeLegacyDrafts(
  rows: FridayWorkflowDraftEntity[],
  legacyRows: FridayWorkflowDraftEntity[],
): FridayWorkflowDraftEntity[] {
  const seen = new Set(rows.map((row) => row.draftId));
  return [
    ...rows,
    ...legacyRows.filter((row) => !seen.has(row.draftId)),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ─── Factory ───

export function createFridayWorkflowBuilderDraftRepository(): FridayWorkflowBuilderDraftRepository {
  return {
    create(db, draft) {
      insertDraftRow(db, draft);
    },

    getById(db, draftId) {
      return readDraftRowById(db, draftId) ?? readLegacyDraftById(db, draftId);
    },

    listByWorkflow(db, workflowId) {
      const rows = db
        .prepare(
          `SELECT * FROM workflow_builder_drafts WHERE workflow_id = ? ORDER BY updated_at DESC`,
        )
        .all(workflowId) as DraftRow[];
      const drafts = rows
        .map((row) => rowToDraft(row))
        .filter((draft): draft is FridayWorkflowDraftEntity => draft !== null);
      return mergeLegacyDrafts(drafts, readLegacyDraftsByWorkflow(db, workflowId));
    },

    listByStatus(db, status) {
      const rows = db
        .prepare(
          `SELECT * FROM workflow_builder_drafts WHERE status = ? ORDER BY updated_at DESC`,
        )
        .all(status) as DraftRow[];
      const drafts = rows
        .map((row) => rowToDraft(row))
        .filter((draft): draft is FridayWorkflowDraftEntity => draft !== null);
      return mergeLegacyDrafts(drafts, readLegacyDraftsByStatus(db, status));
    },

    update(db, draft) {
      if (!this.getById(db, draft.draftId)) {
        throw new FridayDomainError("DRAFT_NOT_FOUND", "DRAFT_NOT_FOUND", { httpStatus: 404 });
      }
      upsertDraftRow(db, draft);
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
