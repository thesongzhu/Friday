import type Database from "better-sqlite3";

import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";

export const FRIDAY_WORKFLOW_GENERATION_APPROVAL_NAMESPACE = "workflow-generator-approval";

export interface FridayWorkflowGenerationApprovalRecord {
  sessionId: string;
  workflowId: string;
  workflowVersionId: string;
  savedAt: string;
}

export interface FridayWorkflowGenerationApprovalRepository {
  save(record: FridayWorkflowGenerationApprovalRecord): void;
  get(sessionId: string): FridayWorkflowGenerationApprovalRecord | null;
}

export interface CreateFridayWorkflowGenerationApprovalRepositoryDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}

interface MemoryItemRow {
  id: string;
  value_json: string;
}

interface WorkflowGenerationApprovalRow {
  session_id: string;
  value_json: string;
}

function upsertWorkflowGenerationApproval(
  db: Database.Database,
  record: FridayWorkflowGenerationApprovalRecord,
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO workflow_generation_approvals (
       session_id, workflow_id, workflow_version_id, saved_at, updated_at, value_json, tags_json
     )
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       workflow_id = excluded.workflow_id,
       workflow_version_id = excluded.workflow_version_id,
       saved_at = excluded.saved_at,
       updated_at = excluded.updated_at,
       value_json = excluded.value_json,
       tags_json = excluded.tags_json`,
  ).run(
    record.sessionId,
    record.workflowId,
    record.workflowVersionId,
    record.savedAt,
    nowIso,
    JSON.stringify(record),
    JSON.stringify(["approval", "workflow"]),
  );
}

function getWorkflowGenerationApproval(
  db: Database.Database,
  sessionId: string,
): WorkflowGenerationApprovalRow | undefined {
  return db
    .prepare("SELECT session_id, value_json FROM workflow_generation_approvals WHERE session_id = ?")
    .get(sessionId) as WorkflowGenerationApprovalRow | undefined;
}

function getMemoryItem(
  db: Database.Database,
  namespace: string,
  key: string,
): MemoryItemRow | undefined {
  return db
    .prepare("SELECT id, value_json FROM memory_items WHERE namespace = ? AND key = ?")
    .get(namespace, key) as MemoryItemRow | undefined;
}

export function createFridayWorkflowGenerationApprovalRepository(
  deps: CreateFridayWorkflowGenerationApprovalRepositoryDeps,
): FridayWorkflowGenerationApprovalRepository {
  return {
    save(record) {
      deps.db.withWriteTransaction((writer) => {
        upsertWorkflowGenerationApproval(writer, record, deps.nowIso());
      });
    },

    get(sessionId) {
      return deps.db.withReadConnection((reader) => {
        const row = getWorkflowGenerationApproval(reader, sessionId)
          ?? getMemoryItem(
          reader,
          FRIDAY_WORKFLOW_GENERATION_APPROVAL_NAMESPACE,
          sessionId,
        );
        if (!row) {
          return null;
        }
        return safeJsonParse<FridayWorkflowGenerationApprovalRecord>(row.value_json) ?? null;
      });
    },
  };
}
