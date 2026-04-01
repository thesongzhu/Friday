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
        const existing = getMemoryItem(
          writer,
          FRIDAY_WORKFLOW_GENERATION_APPROVAL_NAMESPACE,
          record.sessionId,
        );
        writer.prepare(
          `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value_json = excluded.value_json,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        ).run(
          existing?.id ?? deps.idGenerator(),
          FRIDAY_WORKFLOW_GENERATION_APPROVAL_NAMESPACE,
          record.sessionId,
          JSON.stringify(record),
          JSON.stringify(["approval", "workflow"]),
          existing ? deps.nowIso() : record.savedAt,
          deps.nowIso(),
        );
      });
    },

    get(sessionId) {
      return deps.db.withReadConnection((reader) => {
        const row = getMemoryItem(
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
