import type Database from "better-sqlite3";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowTestRunResult } from "../model/friday-workflow-builder-test.types.js";

// ─── Interface ───

export interface FridayWorkflowBuilderTestRunRepository {
  create(db: Database.Database, result: FridayWorkflowTestRunResult): void;
  getById(db: Database.Database, runId: UUID): FridayWorkflowTestRunResult | null;
  listByDraft(db: Database.Database, draftId: UUID, limit?: number): FridayWorkflowTestRunResult[];
}

// ─── Constants ───

const NAMESPACE = "workflow_builder_test_runs";

function testRunKey(draftId: UUID, runId: UUID): string {
  return `${draftId}:${runId}`;
}

// ─── Factory ───

export function createFridayWorkflowBuilderTestRunRepository(): FridayWorkflowBuilderTestRunRepository {
  return {
    create(db, result) {
      db.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        result.runId,
        NAMESPACE,
        testRunKey(result.draftId ?? result.workflowId, result.runId),
        JSON.stringify(result),
        JSON.stringify([result.passed ? "passed" : "failed"]),
        result.startedAt,
        result.finishedAt,
      );
    },

    getById(db, runId) {
      const row = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND id = ?`,
        )
        .get(NAMESPACE, runId) as { value_json: string } | undefined;
      return row ? (JSON.parse(row.value_json) as FridayWorkflowTestRunResult) : null;
    },

    listByDraft(db, draftId, limit) {
      const rows = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(NAMESPACE, `${draftId}:%`, limit ?? 50) as Array<{ value_json: string }>;
      return rows.map((r) => JSON.parse(r.value_json) as FridayWorkflowTestRunResult);
    },
  };
}
