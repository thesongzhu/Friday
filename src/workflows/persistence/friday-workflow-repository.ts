import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { safeJsonParse } from "#utilities";
import type {
  FridayWorkflowCreateInput,
  FridayWorkflowEntity,
  FridayWorkflowListInput,
  FridayWorkflowRow,
  FridayWorkflowUpdateInput,
  FridayWorkflowVersionEntity,
  FridayWorkflowVersionRow,
  JsonValue,
  UUID,
} from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowRepository {
  insertWorkflow(
    db: Database.Database,
    id: UUID,
    input: FridayWorkflowCreateInput,
    etag: string,
    nowIso: string,
  ): FridayWorkflowEntity;

  getWorkflowById(
    db: Database.Database,
    id: UUID,
  ): FridayWorkflowEntity | null;

  getWorkflowBySlug(
    db: Database.Database,
    slug: string,
  ): FridayWorkflowEntity | null;

  listWorkflows(
    db: Database.Database,
    input: FridayWorkflowListInput,
  ): FridayWorkflowEntity[];

  updateWorkflow(
    db: Database.Database,
    input: FridayWorkflowUpdateInput,
    newEtag: string,
    nowIso: string,
  ): FridayWorkflowEntity;

  archiveWorkflow(
    db: Database.Database,
    id: UUID,
    deletedBy: string,
    nowIso: string,
  ): void;

  incrementVersionNumber(
    db: Database.Database,
    workflowId: UUID,
    nowIso: string,
  ): number;

  setPublishedVersion(
    db: Database.Database,
    workflowId: UUID,
    versionNumber: number,
    nowIso: string,
  ): void;

  insertVersion(
    db: Database.Database,
    id: UUID,
    workflowId: UUID,
    versionNumber: number,
    checksum: string,
    graphJson: string,
    createdByUserId: UUID | undefined,
    changeNote: string | undefined,
    nowIso: string,
  ): FridayWorkflowVersionEntity;

  getVersionById(
    db: Database.Database,
    id: UUID,
  ): FridayWorkflowVersionEntity | null;

  getLatestVersion(
    db: Database.Database,
    workflowId: UUID,
  ): FridayWorkflowVersionEntity | null;

  getPublishedVersion(
    db: Database.Database,
    workflowId: UUID,
  ): FridayWorkflowVersionEntity | null;

  listVersions(
    db: Database.Database,
    workflowId: UUID,
    limit?: number,
  ): FridayWorkflowVersionEntity[];

  publishVersion(
    db: Database.Database,
    workflowId: UUID,
    versionId: UUID,
    nowIso: string,
  ): void;
}

// ─── Row mappers ───

function mapWorkflowRow(row: FridayWorkflowRow): FridayWorkflowEntity {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? undefined,
    tags: safeJsonParse<string[]>(row.tags_json) ?? [],
    ownerUserId: row.owner_user_id ?? undefined,
    latestVersionNumber: row.latest_version_number,
    publishedVersionNumber: row.published_version_number ?? undefined,
    isArchived: row.is_archived === 1,
    revision: row.revision,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
    deletedBy: row.deleted_by ?? undefined,
  };
}

function mapVersionRow(row: FridayWorkflowVersionRow): FridayWorkflowVersionEntity {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    versionNumber: row.version_number,
    checksum: row.checksum,
    graphJson: safeJsonParse<JsonValue>(row.graph_json) as JsonValue,
    createdByUserId: row.created_by_user_id ?? undefined,
    isPublished: row.is_published === 1,
    changeNote: row.change_note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export interface CreateWorkflowRepositoryDeps {
  db: FridaySqliteLayer;
}

export function createFridayWorkflowRepository(
  _deps: CreateWorkflowRepositoryDeps,
): FridayWorkflowRepository {
  return {
    insertWorkflow(db, id, input, etag, nowIso) {
      try {
        db.prepare(
          `INSERT INTO workflows (id, slug, name, description, tags_json, owner_user_id,
           latest_version_number, published_version_number, is_archived, revision, etag,
           created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 0, 1, ?, ?, ?)`,
        ).run(
          id,
          input.slug,
          input.name,
          input.description ?? null,
          JSON.stringify(input.tags ?? []),
          input.ownerUserId ?? null,
          etag,
          nowIso,
          nowIso,
        );
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.message.includes("UNIQUE constraint failed: workflows.slug")
        ) {
          throw new FridayDomainError(
            "WORKFLOW_SLUG_CONFLICT",
            `A workflow with slug "${input.slug}" already exists`,
            { httpStatus: 409 },
          );
        }
        throw err;
      }

      return mapWorkflowRow(
        db
          .prepare("SELECT * FROM workflows WHERE id = ?")
          .get(id) as FridayWorkflowRow,
      );
    },

    getWorkflowById(db, id) {
      const row = db
        .prepare("SELECT * FROM workflows WHERE id = ? AND deleted_at IS NULL")
        .get(id) as FridayWorkflowRow | undefined;
      return row ? mapWorkflowRow(row) : null;
    },

    getWorkflowBySlug(db, slug) {
      const row = db
        .prepare("SELECT * FROM workflows WHERE slug = ? AND deleted_at IS NULL")
        .get(slug) as FridayWorkflowRow | undefined;
      return row ? mapWorkflowRow(row) : null;
    },

    listWorkflows(db, input) {
      const conditions: string[] = ["deleted_at IS NULL"];
      const params: unknown[] = [];

      if (input.tag) {
        conditions.push("tags_json LIKE ?");
        params.push(`%"${input.tag}"%`);
      }

      if (input.archived !== undefined) {
        conditions.push("is_archived = ?");
        params.push(input.archived ? 1 : 0);
      }

      const limit = input.limit ?? 50;
      const offset = input.cursor ? parseInt(input.cursor, 10) : 0;

      const sql = `SELECT * FROM workflows WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as FridayWorkflowRow[];
      return rows.map(mapWorkflowRow);
    },

    updateWorkflow(db, input, newEtag, nowIso) {
      const result = db
        .prepare(
          `UPDATE workflows SET
           name = COALESCE(?, name),
           description = COALESCE(?, description),
           tags_json = COALESCE(?, tags_json),
           revision = revision + 1,
           etag = ?,
           updated_at = ?
           WHERE id = ? AND revision = ? AND etag = ? AND deleted_at IS NULL`,
        )
        .run(
          input.name ?? null,
          input.description ?? null,
          input.tags ? JSON.stringify(input.tags) : null,
          newEtag,
          nowIso,
          input.workflowId,
          input.expectedRevision,
          input.etag,
        );

      if (result.changes === 0) {
        throw new FridayDomainError("WORKFLOW_VERSION_CONFLICT", "WORKFLOW_VERSION_CONFLICT", { httpStatus: 409 });
      }

      return mapWorkflowRow(
        db
          .prepare("SELECT * FROM workflows WHERE id = ?")
          .get(input.workflowId) as FridayWorkflowRow,
      );
    },

    archiveWorkflow(db, id, deletedBy, nowIso) {
      const result = db.prepare(
        `UPDATE workflows SET
         is_archived = 1,
         deleted_at = ?,
         deleted_by = ?,
         updated_at = ?,
         slug = slug || '__archived__' || id
         WHERE id = ? AND deleted_at IS NULL`,
      ).run(nowIso, deletedBy, nowIso, id);
      if (result.changes === 0) {
        throw new FridayDomainError("WORKFLOW_NOT_FOUND", "Workflow not found", { httpStatus: 404 });
      }
    },

    incrementVersionNumber(db, workflowId, nowIso) {
      const row = db
        .prepare(
          `UPDATE workflows SET latest_version_number = latest_version_number + 1, updated_at = ?
           WHERE id = ? RETURNING latest_version_number`,
        )
        .get(nowIso, workflowId) as { latest_version_number: number };
      return row.latest_version_number;
    },

    setPublishedVersion(db, workflowId, versionNumber, nowIso) {
      db.prepare(
        "UPDATE workflows SET published_version_number = ?, updated_at = ? WHERE id = ?",
      ).run(versionNumber, nowIso, workflowId);
    },

    insertVersion(db, id, workflowId, versionNumber, checksum, graphJson, createdByUserId, changeNote, nowIso) {
      db.prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json,
         created_by_user_id, is_published, change_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        id,
        workflowId,
        versionNumber,
        checksum,
        graphJson,
        createdByUserId ?? null,
        changeNote ?? null,
        nowIso,
        nowIso,
      );

      return mapVersionRow(
        db.prepare("SELECT * FROM workflow_versions WHERE id = ?").get(id) as FridayWorkflowVersionRow,
      );
    },

    getVersionById(db, id) {
      const row = db
        .prepare("SELECT * FROM workflow_versions WHERE id = ?")
        .get(id) as FridayWorkflowVersionRow | undefined;
      return row ? mapVersionRow(row) : null;
    },

    getLatestVersion(db, workflowId) {
      const row = db
        .prepare(
          "SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version_number DESC LIMIT 1",
        )
        .get(workflowId) as FridayWorkflowVersionRow | undefined;
      return row ? mapVersionRow(row) : null;
    },

    getPublishedVersion(db, workflowId) {
      const row = db
        .prepare(
          `SELECT wv.* FROM workflow_versions wv
           JOIN workflows w ON w.id = wv.workflow_id AND w.published_version_number = wv.version_number
           WHERE wv.workflow_id = ?
             AND wv.is_published = 1
             AND w.deleted_at IS NULL
             AND w.is_archived = 0
           LIMIT 1`,
        )
        .get(workflowId) as FridayWorkflowVersionRow | undefined;
      return row ? mapVersionRow(row) : null;
    },

    listVersions(db, workflowId, limit) {
      const rows = db
        .prepare(
          "SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version_number DESC LIMIT ?",
        )
        .all(workflowId, limit ?? 50) as FridayWorkflowVersionRow[];
      return rows.map(mapVersionRow);
    },

    publishVersion(db, workflowId, versionId, nowIso) {
      db.prepare(
        "UPDATE workflow_versions SET is_published = 0, updated_at = ? WHERE workflow_id = ? AND is_published = 1",
      ).run(nowIso, workflowId);

      db.prepare(
        "UPDATE workflow_versions SET is_published = 1, updated_at = ? WHERE id = ?",
      ).run(nowIso, versionId);
    },
  };
}
