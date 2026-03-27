import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type { ISODateTime, UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";

// ─── Spec Version Record ───

export interface FridayWorkflowSpecVersionRecord {
  workflowId: UUID;
  workflowVersionId: UUID;
  spec: FridayWorkflowSpecV1;
  checksum: string;
  createdAt: ISODateTime;
}

// ─── Interface ───

export interface FridayWorkflowBuilderSpecVersionRepository {
  create(db: Database.Database, record: FridayWorkflowSpecVersionRecord): void;
  getByVersionId(db: Database.Database, workflowVersionId: UUID): FridayWorkflowSpecVersionRecord | null;
  listByWorkflow(db: Database.Database, workflowId: UUID): FridayWorkflowSpecVersionRecord[];
}

// ─── Constants ───

const NAMESPACE = "workflow_builder_spec_versions";

function specVersionKey(workflowId: UUID, workflowVersionId: UUID): string {
  return `${workflowId}:${workflowVersionId}`;
}

// ─── Factory ───

export function createFridayWorkflowBuilderSpecVersionRepository(): FridayWorkflowBuilderSpecVersionRepository {
  return {
    create(db, record) {
      db.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.workflowVersionId,
        NAMESPACE,
        specVersionKey(record.workflowId, record.workflowVersionId),
        JSON.stringify(record),
        "[]",
        record.createdAt,
        record.createdAt,
      );
    },

    getByVersionId(db, workflowVersionId) {
      const row = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ?`,
        )
        .get(NAMESPACE, `%:${workflowVersionId}`) as { value_json: string } | undefined;
      return row ? safeJsonParse<FridayWorkflowSpecVersionRecord>(row.value_json) ?? null : null;
    },

    listByWorkflow(db, workflowId) {
      const rows = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY created_at DESC`,
        )
        .all(NAMESPACE, `${workflowId}:%`) as Array<{ value_json: string }>;
      return rows.map((r) => safeJsonParse<FridayWorkflowSpecVersionRecord>(r.value_json)).filter((r): r is FridayWorkflowSpecVersionRecord => r !== undefined);
    },
  };
}
