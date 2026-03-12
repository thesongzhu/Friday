import type Database from "better-sqlite3";
import type {
  FridayWorkflowRunNodeEntity,
  FridayWorkflowRunNodeRow,
  JsonValue,
  NodeAttemptStatus,
  UUID,
} from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowRunNodeRepository {
  insertNodeAttempt(
    db: Database.Database,
    entity: FridayWorkflowRunNodeEntity,
  ): void;

  getNodeAttemptById(
    db: Database.Database,
    id: UUID,
  ): FridayWorkflowRunNodeEntity | null;

  getNodeAttemptByAttemptId(
    db: Database.Database,
    attemptId: UUID,
  ): FridayWorkflowRunNodeEntity | null;

  getLatestAttempt(
    db: Database.Database,
    runId: UUID,
    nodeId: string,
  ): FridayWorkflowRunNodeEntity | null;

  listAttemptsByNode(
    db: Database.Database,
    runId: UUID,
    nodeId: string,
  ): FridayWorkflowRunNodeEntity[];

  listNodesByRun(
    db: Database.Database,
    runId: UUID,
    status?: NodeAttemptStatus,
  ): FridayWorkflowRunNodeEntity[];

  updateNodeAttempt(
    db: Database.Database,
    id: UUID,
    update: {
      status: NodeAttemptStatus;
      satelliteId?: UUID;
      leaseOwner?: string;
      leaseExpiresAt?: string;
      startedAt?: string;
      finishedAt?: string;
      output?: unknown;
      error?: {
        code: string;
        message: string;
        retryable: boolean;
        details?: unknown;
      };
      nowIso: string;
    },
  ): void;

  acquireLease(
    db: Database.Database,
    id: UUID,
    leaseOwner: string,
    leaseExpiresAt: string,
    nowIso: string,
  ): boolean;

  listExpiredLeases(
    db: Database.Database,
    nowIso: string,
  ): FridayWorkflowRunNodeEntity[];

  cancelAllPendingNodes(
    db: Database.Database,
    runId: UUID,
    nowIso: string,
  ): number;

  countByStatus(
    db: Database.Database,
    runId: UUID,
  ): Record<NodeAttemptStatus, number>;
}

// ─── Row mapper ───

function mapNodeRow(row: FridayWorkflowRunNodeRow): FridayWorkflowRunNodeEntity {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    attempt: row.attempt,
    attemptId: row.attempt_id,
    status: row.status as NodeAttemptStatus,
    satelliteId: row.satellite_id ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    input: row.input_json ? (JSON.parse(row.input_json) as JsonValue) : undefined,
    output: row.output_json ? (JSON.parse(row.output_json) as JsonValue) : undefined,
    error: row.error_json
      ? (JSON.parse(row.error_json) as {
          code: string;
          message: string;
          retryable: boolean;
          details?: JsonValue;
        })
      : undefined,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayWorkflowRunNodeRepository(): FridayWorkflowRunNodeRepository {
  return {
    insertNodeAttempt(db, entity) {
      db.prepare(
        `INSERT INTO workflow_run_nodes (id, run_id, node_id, attempt, attempt_id, status,
         satellite_id, lease_owner, lease_expires_at, started_at, finished_at,
         input_json, output_json, error_json, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entity.id,
        entity.runId,
        entity.nodeId,
        entity.attempt,
        entity.attemptId,
        entity.status,
        entity.satelliteId ?? null,
        entity.leaseOwner ?? null,
        entity.leaseExpiresAt ?? null,
        entity.startedAt ?? null,
        entity.finishedAt ?? null,
        entity.input !== undefined ? JSON.stringify(entity.input) : null,
        entity.output !== undefined ? JSON.stringify(entity.output) : null,
        entity.error ? JSON.stringify(entity.error) : null,
        entity.idempotencyKey,
        entity.createdAt,
        entity.updatedAt,
      );
    },

    getNodeAttemptById(db, id) {
      const row = db
        .prepare("SELECT * FROM workflow_run_nodes WHERE id = ?")
        .get(id) as FridayWorkflowRunNodeRow | undefined;
      return row ? mapNodeRow(row) : null;
    },

    getNodeAttemptByAttemptId(db, attemptId) {
      const row = db
        .prepare("SELECT * FROM workflow_run_nodes WHERE attempt_id = ?")
        .get(attemptId) as FridayWorkflowRunNodeRow | undefined;
      return row ? mapNodeRow(row) : null;
    },

    getLatestAttempt(db, runId, nodeId) {
      const row = db
        .prepare(
          "SELECT * FROM workflow_run_nodes WHERE run_id = ? AND node_id = ? ORDER BY attempt DESC LIMIT 1",
        )
        .get(runId, nodeId) as FridayWorkflowRunNodeRow | undefined;
      return row ? mapNodeRow(row) : null;
    },

    listAttemptsByNode(db, runId, nodeId) {
      return (
        db
          .prepare(
            "SELECT * FROM workflow_run_nodes WHERE run_id = ? AND node_id = ? ORDER BY attempt ASC",
          )
          .all(runId, nodeId) as FridayWorkflowRunNodeRow[]
      ).map(mapNodeRow);
    },

    listNodesByRun(db, runId, status) {
      if (status) {
        return (
          db
            .prepare(
              "SELECT * FROM workflow_run_nodes WHERE run_id = ? AND status = ? ORDER BY created_at ASC",
            )
            .all(runId, status) as FridayWorkflowRunNodeRow[]
        ).map(mapNodeRow);
      }
      return (
        db
          .prepare(
            "SELECT * FROM workflow_run_nodes WHERE run_id = ? ORDER BY created_at ASC",
          )
          .all(runId) as FridayWorkflowRunNodeRow[]
      ).map(mapNodeRow);
    },

    updateNodeAttempt(db, id, update) {
      db.prepare(
        `UPDATE workflow_run_nodes SET
         status = ?,
         satellite_id = COALESCE(?, satellite_id),
         lease_owner = ?,
         lease_expires_at = ?,
         started_at = COALESCE(?, started_at),
         finished_at = ?,
         output_json = ?,
         error_json = ?,
         updated_at = ?
         WHERE id = ?`,
      ).run(
        update.status,
        update.satelliteId ?? null,
        update.leaseOwner ?? null,
        update.leaseExpiresAt ?? null,
        update.startedAt ?? null,
        update.finishedAt ?? null,
        update.output !== undefined ? JSON.stringify(update.output) : null,
        update.error ? JSON.stringify(update.error) : null,
        update.nowIso,
        id,
      );
    },

    acquireLease(db, id, leaseOwner, leaseExpiresAt, nowIso) {
      const result = db
        .prepare(
          `UPDATE workflow_run_nodes SET
           lease_owner = ?, lease_expires_at = ?, status = 'running',
           started_at = COALESCE(started_at, ?), updated_at = ?
           WHERE id = ? AND status IN ('queued', 'retrying')
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
        )
        .run(leaseOwner, leaseExpiresAt, nowIso, nowIso, id, nowIso);
      return result.changes > 0;
    },

    listExpiredLeases(db, nowIso) {
      return (
        db
          .prepare(
            `SELECT * FROM workflow_run_nodes
             WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
          )
          .all(nowIso) as FridayWorkflowRunNodeRow[]
      ).map(mapNodeRow);
    },

    cancelAllPendingNodes(db, runId, nowIso) {
      const result = db
        .prepare(
          `UPDATE workflow_run_nodes SET status = 'cancelled', finished_at = ?, updated_at = ?
           WHERE run_id = ? AND status IN ('queued', 'running', 'retrying', 'blocked_offline')`,
        )
        .run(nowIso, nowIso, runId);
      return result.changes;
    },

    countByStatus(db, runId) {
      // Count using latest attempt per node only
      const rows = db
        .prepare(
          `SELECT status, COUNT(*) as cnt FROM workflow_run_nodes
           WHERE (run_id, node_id, attempt) IN (
             SELECT run_id, node_id, MAX(attempt) FROM workflow_run_nodes
             WHERE run_id = ? GROUP BY run_id, node_id
           )
           GROUP BY status`,
        )
        .all(runId) as Array<{ status: string; cnt: number }>;

      const counts = {
        queued: 0,
        running: 0,
        retrying: 0,
        completed: 0,
        failed: 0,
        blocked_offline: 0,
        cancelled: 0,
      } as Record<NodeAttemptStatus, number>;

      for (const row of rows) {
        counts[row.status as NodeAttemptStatus] = row.cnt;
      }
      return counts;
    },
  };
}
