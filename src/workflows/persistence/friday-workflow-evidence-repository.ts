import type Database from "better-sqlite3";
import type { UUID } from "../model/friday-workflow.types.js";

export interface FridayWorkflowPipelineEventRow {
  event_id: string;
  run_id: UUID;
  workflow_id: UUID | null;
  node_id: string | null;
  attempt: number | null;
  module: string;
  event_name: string;
  payload_json: string;
  trace_id: string | null;
  span_id: string | null;
  redacted: number;
  emitted_at: string;
}

export interface FridayWorkflowRetryTraceRow {
  id: string;
  run_id: UUID;
  node_id: string;
  attempt: number;
  category: string;
  error_code: string;
  error_message: string | null;
  decision_json: string;
  timestamp: string;
}

export interface FridayWorkflowPlaybookTraceRow {
  id: string;
  run_id: UUID;
  workflow_id: UUID;
  phase: "intake" | "feedback";
  intake_json: string | null;
  feedback_json: string | null;
  timestamp: string;
}

export interface FridayWorkflowEvidenceExportRow {
  id: string;
  run_id: UUID;
  artifact_id: UUID;
  uri: string;
  checksum: string;
  query_json: string;
  summary_json: string;
  payload_json: string;
  created_at: string;
}

export interface FridayWorkflowEvidenceRepository {
  insertPipelineEvent(
    db: Database.Database,
    row: FridayWorkflowPipelineEventRow,
  ): void;
  listPipelineEventsByRun(
    db: Database.Database,
    runId: UUID,
  ): FridayWorkflowPipelineEventRow[];

  insertRetryTrace(
    db: Database.Database,
    row: FridayWorkflowRetryTraceRow,
  ): void;
  listRetryTracesByRun(
    db: Database.Database,
    runId: UUID,
  ): FridayWorkflowRetryTraceRow[];

  insertPlaybookTrace(
    db: Database.Database,
    row: FridayWorkflowPlaybookTraceRow,
  ): void;
  listPlaybookTracesByRun(
    db: Database.Database,
    runId: UUID,
  ): FridayWorkflowPlaybookTraceRow[];

  insertEvidenceExport(
    db: Database.Database,
    row: FridayWorkflowEvidenceExportRow,
  ): void;
  getEvidenceExportById(
    db: Database.Database,
    runId: UUID,
    exportId: string,
  ): FridayWorkflowEvidenceExportRow | null;
  listEvidenceExportsByRun(
    db: Database.Database,
    runId: UUID,
    limit: number,
  ): FridayWorkflowEvidenceExportRow[];
}

export function createFridayWorkflowEvidenceRepository(): FridayWorkflowEvidenceRepository {
  return {
    insertPipelineEvent(db, row) {
      db.prepare(
        `INSERT OR IGNORE INTO workflow_run_pipeline_events (
           event_id, run_id, workflow_id, node_id, attempt, module, event_name,
           payload_json, trace_id, span_id, redacted, emitted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.event_id,
        row.run_id,
        row.workflow_id,
        row.node_id,
        row.attempt,
        row.module,
        row.event_name,
        row.payload_json,
        row.trace_id,
        row.span_id,
        row.redacted,
        row.emitted_at,
      );
    },

    listPipelineEventsByRun(db, runId) {
      return db
        .prepare(
          `SELECT * FROM workflow_run_pipeline_events
           WHERE run_id = ?
           ORDER BY emitted_at ASC, event_id ASC`,
        )
        .all(runId) as FridayWorkflowPipelineEventRow[];
    },

    insertRetryTrace(db, row) {
      db.prepare(
        `INSERT OR IGNORE INTO workflow_run_retry_traces (
           id, run_id, node_id, attempt, category, error_code, error_message, decision_json, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.run_id,
        row.node_id,
        row.attempt,
        row.category,
        row.error_code,
        row.error_message,
        row.decision_json,
        row.timestamp,
      );
    },

    listRetryTracesByRun(db, runId) {
      return db
        .prepare(
          `SELECT * FROM workflow_run_retry_traces
           WHERE run_id = ?
           ORDER BY timestamp ASC, id ASC`,
        )
        .all(runId) as FridayWorkflowRetryTraceRow[];
    },

    insertPlaybookTrace(db, row) {
      db.prepare(
        `INSERT OR IGNORE INTO workflow_run_playbook_traces (
           id, run_id, workflow_id, phase, intake_json, feedback_json, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.run_id,
        row.workflow_id,
        row.phase,
        row.intake_json,
        row.feedback_json,
        row.timestamp,
      );
    },

    listPlaybookTracesByRun(db, runId) {
      return db
        .prepare(
          `SELECT * FROM workflow_run_playbook_traces
           WHERE run_id = ?
           ORDER BY timestamp ASC, id ASC`,
        )
        .all(runId) as FridayWorkflowPlaybookTraceRow[];
    },

    insertEvidenceExport(db, row) {
      db.prepare(
        `INSERT INTO workflow_run_evidence_exports (
           id, run_id, artifact_id, uri, checksum, query_json, summary_json, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.run_id,
        row.artifact_id,
        row.uri,
        row.checksum,
        row.query_json,
        row.summary_json,
        row.payload_json,
        row.created_at,
      );
    },

    getEvidenceExportById(db, runId, exportId) {
      const row = db
        .prepare(
          `SELECT * FROM workflow_run_evidence_exports
           WHERE run_id = ? AND id = ?`,
        )
        .get(runId, exportId) as FridayWorkflowEvidenceExportRow | undefined;
      return row ?? null;
    },

    listEvidenceExportsByRun(db, runId, limit) {
      return db
        .prepare(
          `SELECT * FROM workflow_run_evidence_exports
           WHERE run_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(runId, limit) as FridayWorkflowEvidenceExportRow[];
    },
  };
}
