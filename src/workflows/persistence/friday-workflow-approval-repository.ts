import type {
  FridayWorkflowApprovalRequestEntity,
  FridayWorkflowApprovalRequestRow,
  FridayWorkflowApprovalStatus,
} from "../model/friday-workflow-engine.types.js";
import type { FridaySqliteLayer } from "#state";

// ─── Interface ───

export interface FridayWorkflowApprovalRepository {
  insert(
    request: FridayWorkflowApprovalRequestEntity,
  ): FridayWorkflowApprovalRequestEntity;

  getById(
    id: string,
  ): FridayWorkflowApprovalRequestEntity | null;

  getByRunNodeAttemptId(
    runNodeAttemptId: string,
  ): FridayWorkflowApprovalRequestEntity | null;

  listPending(
    input: { approverUserId?: string; limit?: number; cursor?: string },
  ): FridayWorkflowApprovalRequestEntity[];

  resolvePending(
    input: {
      id: string;
      status: "approved" | "rejected";
      decidedByUserId: string;
      comment?: string;
      nowIso: string;
    },
  ): FridayWorkflowApprovalRequestEntity | null;

  expirePending(
    nowIso: string,
    limit: number,
  ): FridayWorkflowApprovalRequestEntity[];
}

// ─── Row mapper ───

function mapApprovalRow(
  row: FridayWorkflowApprovalRequestRow,
): FridayWorkflowApprovalRequestEntity {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    runId: row.run_id,
    runNodeAttemptId: row.run_node_attempt_id,
    nodeId: row.node_id,
    approverUserId: row.approver_user_id ?? undefined,
    approverRole: row.approver_role ?? undefined,
    status: row.status as FridayWorkflowApprovalStatus,
    requestPayload: JSON.parse(row.request_payload_json) as Record<
      string,
      unknown
    >,
    timeoutAt: row.timeout_at ?? undefined,
    decidedAt: row.decided_at ?? undefined,
    decidedByUserId: row.decided_by_user_id ?? undefined,
    decisionComment: row.decision_comment ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export interface CreateFridayWorkflowApprovalRepositoryDeps {
  db: FridaySqliteLayer;
}

export function createFridayWorkflowApprovalRepository(
  deps: CreateFridayWorkflowApprovalRepositoryDeps,
): FridayWorkflowApprovalRepository {
  const { db } = deps;

  return {
    insert(request) {
      db.withWriteTransaction((conn) => {
        conn.prepare(
          `INSERT INTO workflow_approval_requests (
            id, workflow_id, workflow_version_id, run_id, run_node_attempt_id,
            node_id, approver_user_id, approver_role, status,
            request_payload_json, timeout_at, decided_at, decided_by_user_id,
            decision_comment, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          request.id,
          request.workflowId,
          request.workflowVersionId,
          request.runId,
          request.runNodeAttemptId,
          request.nodeId,
          request.approverUserId ?? null,
          request.approverRole ?? null,
          request.status,
          JSON.stringify(request.requestPayload),
          request.timeoutAt ?? null,
          request.decidedAt ?? null,
          request.decidedByUserId ?? null,
          request.decisionComment ?? null,
          request.createdAt,
          request.updatedAt,
        );
      });

      return request;
    },

    getById(id) {
      return db.withReadConnection((conn) => {
        const row = conn
          .prepare("SELECT * FROM workflow_approval_requests WHERE id = ?")
          .get(id) as FridayWorkflowApprovalRequestRow | undefined;
        return row ? mapApprovalRow(row) : null;
      });
    },

    getByRunNodeAttemptId(runNodeAttemptId) {
      return db.withReadConnection((conn) => {
        const row = conn
          .prepare(
            "SELECT * FROM workflow_approval_requests WHERE run_node_attempt_id = ?",
          )
          .get(runNodeAttemptId) as
          | FridayWorkflowApprovalRequestRow
          | undefined;
        return row ? mapApprovalRow(row) : null;
      });
    },

    listPending(input) {
      return db.withReadConnection((conn) => {
        const conditions = ["status = 'pending'"];
        const params: unknown[] = [];

        if (input.approverUserId) {
          conditions.push("(approver_user_id = ? OR approver_user_id IS NULL)");
          params.push(input.approverUserId);
        }

        if (input.cursor) {
          conditions.push("created_at < ?");
          params.push(input.cursor);
        }

        const limit = input.limit ?? 50;
        const sql = `SELECT * FROM workflow_approval_requests
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at DESC
          LIMIT ?`;
        params.push(limit);

        const rows = conn.prepare(sql).all(...params) as FridayWorkflowApprovalRequestRow[];
        return rows.map(mapApprovalRow);
      });
    },

    resolvePending(input) {
      return db.withWriteTransaction((conn) => {
        const result = conn
          .prepare(
            `UPDATE workflow_approval_requests
             SET status = ?, decided_at = ?, decided_by_user_id = ?,
                 decision_comment = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(
            input.status,
            input.nowIso,
            input.decidedByUserId,
            input.comment ?? null,
            input.nowIso,
            input.id,
          );

        if (result.changes === 0) {
          return null;
        }

        const row = conn
          .prepare("SELECT * FROM workflow_approval_requests WHERE id = ?")
          .get(input.id) as FridayWorkflowApprovalRequestRow;
        return mapApprovalRow(row);
      });
    },

    expirePending(nowIso, limit) {
      return db.withWriteTransaction((conn) => {
        const rows = conn
          .prepare(
            `SELECT * FROM workflow_approval_requests
             WHERE status = 'pending'
               AND timeout_at IS NOT NULL
               AND timeout_at <= ?
             ORDER BY timeout_at ASC
             LIMIT ?`,
          )
          .all(nowIso, limit) as FridayWorkflowApprovalRequestRow[];

        if (rows.length === 0) {
          return [];
        }

        const ids = rows.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");
        conn.prepare(
          `UPDATE workflow_approval_requests
           SET status = 'expired', updated_at = ?
           WHERE id IN (${placeholders}) AND status = 'pending'`,
        ).run(nowIso, ...ids);

        // Re-read the updated rows
        const updated = conn
          .prepare(
            `SELECT * FROM workflow_approval_requests WHERE id IN (${placeholders})`,
          )
          .all(...ids) as FridayWorkflowApprovalRequestRow[];
        return updated.map(mapApprovalRow);
      });
    },
  };
}
