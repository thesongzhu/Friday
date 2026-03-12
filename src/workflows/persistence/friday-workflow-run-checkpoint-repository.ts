import type {
  FridayWorkflowRunCheckpointEntity,
  FridayWorkflowRunCheckpointRow,
  FridayWorkflowRunStatus,
} from "../model/friday-workflow-engine.types.js";
import type { FridaySqliteLayer } from "#state";

// ─── Interface ───

export interface FridayWorkflowRunCheckpointRepository {
  upsert(checkpoint: FridayWorkflowRunCheckpointEntity): void;

  get(runId: string): FridayWorkflowRunCheckpointEntity | null;

  delete(runId: string): void;

  listRecoverableRuns(
    limit: number,
  ): FridayWorkflowRunCheckpointEntity[];
}

// ─── Row mapper ───

function mapCheckpointRow(
  row: FridayWorkflowRunCheckpointRow,
): FridayWorkflowRunCheckpointEntity {
  return {
    runId: row.run_id,
    checkpointSeq: row.checkpoint_seq,
    runStatus: row.run_status as FridayWorkflowRunStatus,
    activeNodeIds: JSON.parse(row.active_node_ids_json) as string[],
    completedNodeIds: JSON.parse(row.completed_node_ids_json) as string[],
    failedNodeIds: JSON.parse(row.failed_node_ids_json) as string[],
    waitingApprovalNodeIds: JSON.parse(
      row.waiting_approval_node_ids_json,
    ) as string[],
    context: JSON.parse(row.context_json) as Record<string, unknown>,
    lastNodeId: row.last_node_id ?? undefined,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export interface CreateFridayWorkflowRunCheckpointRepositoryDeps {
  db: FridaySqliteLayer;
}

export function createFridayWorkflowRunCheckpointRepository(
  deps: CreateFridayWorkflowRunCheckpointRepositoryDeps,
): FridayWorkflowRunCheckpointRepository {
  const { db } = deps;

  return {
    upsert(checkpoint) {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO workflow_run_checkpoints (
            run_id, checkpoint_seq, run_status, active_node_ids_json,
            completed_node_ids_json, failed_node_ids_json,
            waiting_approval_node_ids_json, context_json,
            last_node_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            checkpoint_seq = excluded.checkpoint_seq,
            run_status = excluded.run_status,
            active_node_ids_json = excluded.active_node_ids_json,
            completed_node_ids_json = excluded.completed_node_ids_json,
            failed_node_ids_json = excluded.failed_node_ids_json,
            waiting_approval_node_ids_json = excluded.waiting_approval_node_ids_json,
            context_json = excluded.context_json,
            last_node_id = excluded.last_node_id,
            updated_at = excluded.updated_at`,
        ).run(
          checkpoint.runId,
          checkpoint.checkpointSeq,
          checkpoint.runStatus,
          JSON.stringify(checkpoint.activeNodeIds),
          JSON.stringify(checkpoint.completedNodeIds),
          JSON.stringify(checkpoint.failedNodeIds),
          JSON.stringify(checkpoint.waitingApprovalNodeIds),
          JSON.stringify(checkpoint.context),
          checkpoint.lastNodeId ?? null,
          checkpoint.updatedAt,
        );
      });
    },

    get(runId) {
      return db.withReadConnection((conn) => {
        const row = conn
          .prepare("SELECT * FROM workflow_run_checkpoints WHERE run_id = ?")
          .get(runId) as FridayWorkflowRunCheckpointRow | undefined;
        return row ? mapCheckpointRow(row) : null;
      });
    },

    delete(runId) {
      db.withWriteTransaction((conn) => {
        conn.prepare("DELETE FROM workflow_run_checkpoints WHERE run_id = ?").run(
          runId,
        );
      });
    },

    listRecoverableRuns(limit) {
      return db.withReadConnection((conn) => {
        const rows = conn
          .prepare(
            `SELECT * FROM workflow_run_checkpoints
             WHERE run_status IN ('pending', 'running', 'paused')
             ORDER BY updated_at ASC
             LIMIT ?`,
          )
          .all(limit) as FridayWorkflowRunCheckpointRow[];
        return rows.map(mapCheckpointRow);
      });
    },
  };
}
