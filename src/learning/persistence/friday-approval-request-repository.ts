import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridayApprovalRequestEntity,
  FridayApprovalRequestRow,
  FridayAutoFixPlan,
} from "../model/friday-auto-fix.types.js";

export interface FridayApprovalRequestRepository {
  insert(
    db: Database.Database,
    request: FridayApprovalRequestEntity,
  ): FridayApprovalRequestEntity;

  getById(
    db: Database.Database,
    requestId: string,
  ): FridayApprovalRequestEntity | null;

  getByActionId(
    db: Database.Database,
    actionId: string,
  ): FridayApprovalRequestEntity | null;
  listByActionIds(
    db: Database.Database,
    actionIds: string[],
  ): FridayApprovalRequestEntity[];

  listPending(
    db: Database.Database,
    input?: { userId?: string; limit?: number },
  ): FridayApprovalRequestEntity[];

  listByUser(
    db: Database.Database,
    input: {
      userId: string;
      status?: FridayApprovalRequestEntity["status"];
      limit?: number;
    },
  ): FridayApprovalRequestEntity[];

  resolvePending(
    db: Database.Database,
    requestId: string,
    status: "approved" | "rejected",
    respondedBy: string,
    reason: string | undefined,
    nowIso: string,
  ): FridayApprovalRequestEntity | null;

  expirePending(
    db: Database.Database,
    nowIso: string,
    limit?: number,
  ): FridayApprovalRequestEntity[];
}

function rowToEntity(row: FridayApprovalRequestRow): FridayApprovalRequestEntity {
  return {
    requestId: row.request_id,
    actionId: row.action_id,
    runId: row.run_id ?? undefined,
    userId: row.user_id,
    description: row.description,
    riskTier: row.risk_tier,
    plan: safeJsonParse<FridayAutoFixPlan>(row.plan_json) ?? ({} as FridayAutoFixPlan),
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    status: row.status,
    responseReason: row.response_reason ?? undefined,
    respondedAt: row.responded_at ?? undefined,
    respondedBy: row.responded_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFridayApprovalRequestRepository(): FridayApprovalRequestRepository {
  return {
    insert(db, request) {
      db.prepare(
        `INSERT INTO approval_requests
         (request_id, action_id, run_id, user_id, description, risk_tier,
          plan_json, requested_at, expires_at, status, response_reason,
          responded_at, responded_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        request.requestId,
        request.actionId,
        request.runId ?? null,
        request.userId,
        request.description,
        request.riskTier,
        JSON.stringify(request.plan),
        request.requestedAt,
        request.expiresAt,
        request.status,
        request.responseReason ?? null,
        request.respondedAt ?? null,
        request.respondedBy ?? null,
        request.createdAt,
        request.updatedAt,
      );
      return request;
    },

    getById(db, requestId) {
      const row = db
        .prepare("SELECT * FROM approval_requests WHERE request_id = ?")
        .get(requestId) as FridayApprovalRequestRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    getByActionId(db, actionId) {
      const row = db
        .prepare("SELECT * FROM approval_requests WHERE action_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(actionId) as FridayApprovalRequestRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listByActionIds(db, actionIds) {
      if (actionIds.length === 0) {
        return [];
      }
      const uniqueActionIds = [...new Set(actionIds)];
      const placeholders = uniqueActionIds.map(() => "?").join(", ");
      const rows = db
        .prepare(
          `SELECT * FROM approval_requests
           WHERE action_id IN (${placeholders})
           ORDER BY created_at DESC`,
        )
        .all(...uniqueActionIds) as FridayApprovalRequestRow[];
      const latestByActionId = new Map<string, FridayApprovalRequestEntity>();
      for (const row of rows) {
        if (!latestByActionId.has(row.action_id)) {
          latestByActionId.set(row.action_id, rowToEntity(row));
        }
      }
      return uniqueActionIds
        .map((actionId) => latestByActionId.get(actionId))
        .filter((request): request is FridayApprovalRequestEntity => request != null);
    },

    listPending(db, input) {
      let sql = "SELECT * FROM approval_requests WHERE status = 'pending'";
      const params: unknown[] = [];

      if (input?.userId) {
        sql += " AND user_id = ?";
        params.push(input.userId);
      }

      sql += " ORDER BY requested_at ASC";

      if (input?.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      const rows = db.prepare(sql).all(...params) as FridayApprovalRequestRow[];
      return rows.map(rowToEntity);
    },

    listByUser(db, input) {
      let sql = "SELECT * FROM approval_requests WHERE user_id = ?";
      const params: unknown[] = [input.userId];

      if (input.status) {
        sql += " AND status = ?";
        params.push(input.status);
      }

      sql += " ORDER BY requested_at DESC";

      if (input.limit) {
        sql += " LIMIT ?";
        params.push(input.limit);
      }

      const rows = db.prepare(sql).all(...params) as FridayApprovalRequestRow[];
      return rows.map(rowToEntity);
    },

    resolvePending(db, requestId, status, respondedBy, reason, nowIso) {
      const changes = db
        .prepare(
          `UPDATE approval_requests
           SET status = ?, response_reason = ?, responded_at = ?,
               responded_by = ?, updated_at = ?
           WHERE request_id = ? AND status = 'pending'`,
        )
        .run(status, reason ?? null, nowIso, respondedBy, nowIso, requestId).changes;

      if (changes === 0) return null;
      return this.getById(db, requestId);
    },

    expirePending(db, nowIso, limit = 100) {
      const rows = db
        .prepare(
          `SELECT * FROM approval_requests
           WHERE status = 'pending' AND expires_at <= ?
           ORDER BY expires_at ASC
           LIMIT ?`,
        )
        .all(nowIso, limit) as FridayApprovalRequestRow[];

      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.request_id);
      const placeholders = ids.map(() => "?").join(",");

      db.prepare(
        `UPDATE approval_requests
         SET status = 'expired', updated_at = ?
         WHERE request_id IN (${placeholders}) AND status = 'pending'`,
      ).run(nowIso, ...ids);

      return ids
        .map((id) => this.getById(db, id))
        .filter((e): e is FridayApprovalRequestEntity => e !== null);
    },
  };
}
