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

interface SpecVersionRow {
  workflow_id: string;
  workflow_version_id: string;
  spec_json: string;
  checksum: string;
  created_at: string;
}

function rowToSpecVersion(row: SpecVersionRow): FridayWorkflowSpecVersionRecord | null {
  const spec = safeJsonParse<FridayWorkflowSpecV1>(row.spec_json);
  if (!spec) return null;
  return {
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    spec,
    checksum: row.checksum,
    createdAt: row.created_at,
  };
}

function insertSpecVersionRow(
  db: Database.Database,
  record: FridayWorkflowSpecVersionRecord,
): void {
  db.prepare(
    `INSERT INTO workflow_builder_spec_versions (
      workflow_version_id, workflow_id, spec_json, checksum, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    record.workflowVersionId,
    record.workflowId,
    JSON.stringify(record.spec),
    record.checksum,
    record.createdAt,
  );
}

function readLegacySpecVersionByVersionId(
  db: Database.Database,
  workflowVersionId: UUID,
): FridayWorkflowSpecVersionRecord | null {
  const row = db
    .prepare(
      `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ?`,
    )
    .get(NAMESPACE, `%:${workflowVersionId}`) as { value_json: string } | undefined;
  return row ? safeJsonParse<FridayWorkflowSpecVersionRecord>(row.value_json) ?? null : null;
}

function readLegacySpecVersionsByWorkflow(
  db: Database.Database,
  workflowId: UUID,
): FridayWorkflowSpecVersionRecord[] {
  const rows = db
    .prepare(
      `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY created_at DESC`,
    )
    .all(NAMESPACE, `${workflowId}:%`) as Array<{ value_json: string }>;
  return rows
    .map((row) => safeJsonParse<FridayWorkflowSpecVersionRecord>(row.value_json))
    .filter((record): record is FridayWorkflowSpecVersionRecord => record !== undefined);
}

function mergeLegacySpecVersions(
  rows: FridayWorkflowSpecVersionRecord[],
  legacyRows: FridayWorkflowSpecVersionRecord[],
): FridayWorkflowSpecVersionRecord[] {
  const seen = new Set(rows.map((row) => row.workflowVersionId));
  return [
    ...rows,
    ...legacyRows.filter((row) => !seen.has(row.workflowVersionId)),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ─── Factory ───

export function createFridayWorkflowBuilderSpecVersionRepository(): FridayWorkflowBuilderSpecVersionRepository {
  return {
    create(db, record) {
      insertSpecVersionRow(db, record);
    },

    getByVersionId(db, workflowVersionId) {
      const row = db
        .prepare(
          `SELECT * FROM workflow_builder_spec_versions WHERE workflow_version_id = ?`,
        )
        .get(workflowVersionId) as SpecVersionRow | undefined;
      return (row ? rowToSpecVersion(row) : null)
        ?? readLegacySpecVersionByVersionId(db, workflowVersionId);
    },

    listByWorkflow(db, workflowId) {
      const rows = db
        .prepare(
          `SELECT * FROM workflow_builder_spec_versions WHERE workflow_id = ? ORDER BY created_at DESC`,
        )
        .all(workflowId) as SpecVersionRow[];
      const records = rows
        .map((row) => rowToSpecVersion(row))
        .filter((record): record is FridayWorkflowSpecVersionRecord => record !== null);
      return mergeLegacySpecVersions(records, readLegacySpecVersionsByWorkflow(db, workflowId));
    },
  };
}
