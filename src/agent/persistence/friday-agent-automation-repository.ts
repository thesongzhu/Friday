import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";
import { safeJsonParse } from "#utilities";

import { FRIDAY_AGENT_ERROR_CODES } from "../friday-agent.constants.js";
import type {
  FridayAgentAutomationListFilters,
  FridayAgentAutomationRecord,
  FridayAgentAutomationRepository,
  FridayAgentAutomationSessionTarget,
} from "../services/friday-agent-automation-service.types.js";

// ─── Row shape from SQLite ───

interface FridayAgentAutomationRow {
  id: string;
  name: string;
  description: string | null;
  source_run_id: string | null;
  task_template: string;
  variables: string | null;
  skill_ids: string | null;
  workflow_ids: string | null;
  trigger_id: string | null;
  schedule_cron_expr: string | null;
  schedule_tz: string | null;
  session_target_kind: "isolated" | "named" | "current" | null;
  session_target_session_key: string | null;
  enabled: number;
  last_run_id: string | null;
  last_run_at: string | null;
  run_count: number;
  estimated_time_saved_minutes: number;
  reuse_count: number;
  promotion_state: "private" | "team" | "public_boost_eligible" | "public";
  last_outcome_score: number;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: FridayAgentAutomationRow): FridayAgentAutomationRecord {
  let sessionTarget: FridayAgentAutomationSessionTarget | undefined;
  if (row.session_target_kind === "isolated") {
    sessionTarget = { type: "isolated" };
  } else if (row.session_target_kind === "named" && row.session_target_session_key) {
    sessionTarget = { type: "named", sessionKey: row.session_target_session_key };
  } else if (row.session_target_kind === "current") {
    sessionTarget = {
      type: "current",
      ...(row.session_target_session_key ? { sessionKey: row.session_target_session_key } : {}),
    };
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    sourceRunId: row.source_run_id ?? undefined,
    taskTemplate: row.task_template,
    variables: safeJsonParse<Record<string, string>>(row.variables),
    skillIds: safeJsonParse<string[]>(row.skill_ids),
    workflowIds: safeJsonParse<string[]>(row.workflow_ids),
    triggerId: row.trigger_id ?? undefined,
    schedule: row.schedule_cron_expr
      ? {
          type: "cron",
          cron: row.schedule_cron_expr,
          timezone: row.schedule_tz ?? undefined,
        }
      : undefined,
    sessionTarget,
    enabled: row.enabled === 1,
    lastRunId: row.last_run_id ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    runCount: row.run_count,
    estimatedTimeSavedMinutes: row.estimated_time_saved_minutes,
    reuseCount: row.reuse_count,
    promotionState: row.promotion_state,
    lastOutcomeScore: row.last_outcome_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeSessionTarget(
  sessionTarget: FridayAgentAutomationSessionTarget | undefined,
): {
  kind: FridayAgentAutomationRow["session_target_kind"];
  sessionKey: string | null;
} {
  if (!sessionTarget || sessionTarget.type === "isolated") {
    return { kind: "isolated", sessionKey: null };
  }
  if (sessionTarget.type === "named") {
    return { kind: "named", sessionKey: sessionTarget.sessionKey };
  }
  return {
    kind: "current",
    sessionKey: sessionTarget.sessionKey ?? null,
  };
}

// ─── Factory ───

export function createFridayAgentAutomationRepository(): FridayAgentAutomationRepository {
  return {
    insert(db, record) {
      const encodedSessionTarget = encodeSessionTarget(record.sessionTarget);
      db.prepare(
        `INSERT INTO friday_agent_automations (
          id, name, description, source_run_id, task_template,
          variables, skill_ids, workflow_ids, trigger_id, schedule_cron_expr, schedule_tz,
          session_target_kind, session_target_session_key,
          enabled, last_run_id, last_run_at, run_count,
          estimated_time_saved_minutes, reuse_count, promotion_state, last_outcome_score,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.name,
        record.description ?? null,
        record.sourceRunId ?? null,
        record.taskTemplate,
        record.variables ? JSON.stringify(record.variables) : null,
        record.skillIds ? JSON.stringify(record.skillIds) : null,
        record.workflowIds ? JSON.stringify(record.workflowIds) : null,
        record.triggerId ?? null,
        record.schedule?.cron ?? null,
        record.schedule?.timezone ?? null,
        encodedSessionTarget.kind,
        encodedSessionTarget.sessionKey,
        record.enabled ? 1 : 0,
        record.lastRunId ?? null,
        record.lastRunAt ?? null,
        record.runCount,
        record.estimatedTimeSavedMinutes,
        record.reuseCount,
        record.promotionState,
        record.lastOutcomeScore,
        record.createdAt,
        record.updatedAt,
      );

      const row = db.prepare(
        "SELECT * FROM friday_agent_automations WHERE id = ?",
      ).get(record.id) as FridayAgentAutomationRow | undefined;

      if (!row) {
        throw new FridayDomainError(
          FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
          "Automation insert failed — row not found after insert",
          { httpStatus: 500 },
        );
      }

      return rowToRecord(row);
    },

    findById(db, id) {
      const row = db.prepare(
        "SELECT * FROM friday_agent_automations WHERE id = ?",
      ).get(id) as FridayAgentAutomationRow | undefined;

      return row ? rowToRecord(row) : null;
    },

    findMany(db, filters) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filters?.enabled !== undefined) {
        conditions.push("enabled = ?");
        params.push(filters.enabled ? 1 : 0);
      }
      if (filters?.cursor) {
        conditions.push("created_at < ?");
        params.push(filters.cursor);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.min(filters?.limit ?? 50, 500);
      params.push(limit);

      const rows = db.prepare(
        `SELECT * FROM friday_agent_automations ${where} ORDER BY created_at DESC LIMIT ?`,
      ).all(...params) as FridayAgentAutomationRow[];

      return rows.map(rowToRecord);
    },

    update(db, id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];

      if (patch.name !== undefined) {
        sets.push("name = ?");
        params.push(patch.name);
      }
      if (patch.description !== undefined) {
        sets.push("description = ?");
        params.push(patch.description);
      }
      if (patch.sourceRunId !== undefined) {
        sets.push("source_run_id = ?");
        params.push(patch.sourceRunId);
      }
      if (patch.taskTemplate !== undefined) {
        sets.push("task_template = ?");
        params.push(patch.taskTemplate);
      }
      if (patch.variables !== undefined) {
        sets.push("variables = ?");
        params.push(JSON.stringify(patch.variables));
      }
      if (patch.skillIds !== undefined) {
        sets.push("skill_ids = ?");
        params.push(JSON.stringify(patch.skillIds));
      }
      if (patch.workflowIds !== undefined) {
        sets.push("workflow_ids = ?");
        params.push(JSON.stringify(patch.workflowIds));
      }
      if (patch.triggerId !== undefined) {
        sets.push("trigger_id = ?");
        params.push(patch.triggerId);
      }
      if (patch.schedule !== undefined) {
        sets.push("schedule_cron_expr = ?");
        sets.push("schedule_tz = ?");
        params.push(patch.schedule?.cron ?? null);
        params.push(patch.schedule?.timezone ?? null);
      }
      if (patch.sessionTarget !== undefined) {
        const encoded = patch.sessionTarget === null
          ? encodeSessionTarget({ type: "isolated" })
          : encodeSessionTarget(patch.sessionTarget);
        sets.push("session_target_kind = ?");
        sets.push("session_target_session_key = ?");
        params.push(encoded.kind);
        params.push(encoded.sessionKey);
      }
      if (patch.enabled !== undefined) {
        sets.push("enabled = ?");
        params.push(patch.enabled ? 1 : 0);
      }
      if (patch.lastRunId !== undefined) {
        sets.push("last_run_id = ?");
        params.push(patch.lastRunId);
      }
      if (patch.lastRunAt !== undefined) {
        sets.push("last_run_at = ?");
        params.push(patch.lastRunAt);
      }
      if (patch.runCount !== undefined) {
        sets.push("run_count = ?");
        params.push(patch.runCount);
      }
      if (patch.estimatedTimeSavedMinutes !== undefined) {
        sets.push("estimated_time_saved_minutes = ?");
        params.push(patch.estimatedTimeSavedMinutes);
      }
      if (patch.reuseCount !== undefined) {
        sets.push("reuse_count = ?");
        params.push(patch.reuseCount);
      }
      if (patch.promotionState !== undefined) {
        sets.push("promotion_state = ?");
        params.push(patch.promotionState);
      }
      if (patch.lastOutcomeScore !== undefined) {
        sets.push("last_outcome_score = ?");
        params.push(patch.lastOutcomeScore);
      }
      if (patch.updatedAt !== undefined) {
        sets.push("updated_at = ?");
        params.push(patch.updatedAt);
      }

      if (sets.length === 0) {
        return this.findById(db, id);
      }

      params.push(id);
      db.prepare(
        `UPDATE friday_agent_automations SET ${sets.join(", ")} WHERE id = ?`,
      ).run(...params);

      return this.findById(db, id);
    },

    remove(db, id) {
      const result = db.prepare(
        "DELETE FROM friday_agent_automations WHERE id = ?",
      ).run(id);

      return result.changes > 0;
    },
  };
}
