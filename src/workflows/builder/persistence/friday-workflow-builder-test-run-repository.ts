import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
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

interface TestRunRow {
  run_id: string;
  workflow_id: string;
  draft_id: string | null;
  started_at: string;
  finished_at: string;
  passed: number;
  case_results_json: string;
}

function rowToTestRun(row: TestRunRow): FridayWorkflowTestRunResult | null {
  const caseResults = safeJsonParse<FridayWorkflowTestRunResult["caseResults"]>(
    row.case_results_json,
  );
  if (!caseResults) return null;
  return {
    runId: row.run_id,
    workflowId: row.workflow_id,
    draftId: row.draft_id ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    passed: row.passed === 1,
    caseResults,
  };
}

function insertTestRunRow(
  db: Database.Database,
  result: FridayWorkflowTestRunResult,
): void {
  db.prepare(
    `INSERT INTO workflow_builder_test_runs (
      run_id, workflow_id, draft_id, started_at, finished_at, passed,
      case_results_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.runId,
    result.workflowId,
    result.draftId ?? null,
    result.startedAt,
    result.finishedAt,
    result.passed ? 1 : 0,
    JSON.stringify(result.caseResults),
  );
}

function readLegacyTestRunById(
  db: Database.Database,
  runId: UUID,
): FridayWorkflowTestRunResult | null {
  const row = db
    .prepare(
      `SELECT value_json FROM memory_items WHERE namespace = ? AND id = ?`,
    )
    .get(NAMESPACE, runId) as { value_json: string } | undefined;
  return row ? safeJsonParse<FridayWorkflowTestRunResult>(row.value_json) ?? null : null;
}

function readLegacyTestRunsByDraft(
  db: Database.Database,
  draftId: UUID,
  limit: number,
): FridayWorkflowTestRunResult[] {
  const rows = db
    .prepare(
      `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(NAMESPACE, `${draftId}:%`, limit) as Array<{ value_json: string }>;
  return rows
    .map((row) => safeJsonParse<FridayWorkflowTestRunResult>(row.value_json))
    .filter((result): result is FridayWorkflowTestRunResult => result !== undefined);
}

function mergeLegacyTestRuns(
  rows: FridayWorkflowTestRunResult[],
  legacyRows: FridayWorkflowTestRunResult[],
  limit: number,
): FridayWorkflowTestRunResult[] {
  const seen = new Set(rows.map((row) => row.runId));
  return [
    ...rows,
    ...legacyRows.filter((row) => !seen.has(row.runId)),
  ].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

// ─── Factory ───

export function createFridayWorkflowBuilderTestRunRepository(): FridayWorkflowBuilderTestRunRepository {
  return {
    create(db, result) {
      insertTestRunRow(db, result);
    },

    getById(db, runId) {
      const row = db
        .prepare(
          `SELECT * FROM workflow_builder_test_runs WHERE run_id = ?`,
        )
        .get(runId) as TestRunRow | undefined;
      return (row ? rowToTestRun(row) : null) ?? readLegacyTestRunById(db, runId);
    },

    listByDraft(db, draftId, limit) {
      const resolvedLimit = limit ?? 50;
      const rows = db
        .prepare(
          `SELECT * FROM workflow_builder_test_runs WHERE draft_id = ? ORDER BY started_at DESC LIMIT ?`,
        )
        .all(draftId, resolvedLimit) as TestRunRow[];
      const results = rows
        .map((row) => rowToTestRun(row))
        .filter((result): result is FridayWorkflowTestRunResult => result !== null);
      return mergeLegacyTestRuns(
        results,
        readLegacyTestRunsByDraft(db, draftId, resolvedLimit),
        resolvedLimit,
      );
    },
  };
}
