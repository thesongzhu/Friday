import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";

import { FRIDAY_AGENT_ACTIVE_STATUSES, FRIDAY_AGENT_ERROR_CODES } from "../friday-agent.constants.js";
import type {
  FridayAgentActualExecution,
  FridayAgentArtifact,
  FridayAgentPlanReviewPayload,
  FridayAgentRunConstraints,
  FridayAgentRunRecord,
  FridayAgentRunStatus,
  FridayAgentTestResult,
} from "../model/friday-agent.types.js";
import type { FridayAgentContextCostSummary } from "../runtime/friday-agent-runtime.types.js";
import type { FridayResolvedAgentTaskProfile } from "../runtime/friday-agent-task-profile.js";

// ─── Row shape from SQLite ───

interface FridayAgentRunRow {
  id: string;
  task: string;
  status: string;
  session_key: string;
  provider_id: string | null;
  model: string | null;
  attempt: number;
  max_attempts: number;
  artifacts: string | null;
  test_results: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  usage_input: number | null;
  usage_output: number | null;
  cost_usd: number | null;
  plan_review_json: string | null;
  actual_execution_json: string | null;
  constraints_json: string | null;
  response_text: string | null;
  summary: string | null;
  artifact_dir: string | null;
  context_cost_summary_json: string | null;
  task_profile_json: string | null;
}

function rowToRecord(row: FridayAgentRunRow): FridayAgentRunRecord {
  return {
    id: row.id,
    task: row.task,
    status: row.status as FridayAgentRunStatus,
    sessionKey: row.session_key,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    artifacts: row.artifacts
      ? (JSON.parse(row.artifacts) as FridayAgentArtifact[])
      : undefined,
    testResults: row.test_results
      ? (JSON.parse(row.test_results) as FridayAgentTestResult[])
      : undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    usageInput: row.usage_input ?? undefined,
    usageOutput: row.usage_output ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    planReview: row.plan_review_json
      ? (JSON.parse(row.plan_review_json) as FridayAgentPlanReviewPayload)
      : undefined,
    actualExecution: row.actual_execution_json
      ? (JSON.parse(row.actual_execution_json) as FridayAgentActualExecution)
      : undefined,
    constraints: row.constraints_json && row.constraints_json !== "{}"
      ? (JSON.parse(row.constraints_json) as FridayAgentRunConstraints)
      : undefined,
    responseText: row.response_text ?? undefined,
    summary: row.summary ?? undefined,
    artifactDir: row.artifact_dir ?? undefined,
    contextCostSummary: row.context_cost_summary_json
      ? (JSON.parse(row.context_cost_summary_json) as FridayAgentContextCostSummary)
      : undefined,
    taskProfile: row.task_profile_json
      ? (JSON.parse(row.task_profile_json) as FridayResolvedAgentTaskProfile)
      : undefined,
  };
}

// ─── Repository interface ───

export interface FridayAgentRunRepository {
  create(
    db: Database.Database,
    input: {
      id: string;
      task: string;
      sessionKey: string;
      providerId?: string;
      model?: string;
      maxAttempts: number;
      nowIso: string;
      constraints?: FridayAgentRunConstraints;
    },
  ): FridayAgentRunRecord;

  getById(
    db: Database.Database,
    id: string,
  ): FridayAgentRunRecord | null;

  update(
    db: Database.Database,
    input: {
      id: string;
      status?: FridayAgentRunStatus;
      attempt?: number;
      artifacts?: FridayAgentArtifact[];
      testResults?: FridayAgentTestResult[];
      errorCode?: string;
      errorMessage?: string;
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
      usageInput?: number;
      usageOutput?: number;
      costUsd?: number;
      planReview?: FridayAgentPlanReviewPayload;
      actualExecution?: FridayAgentActualExecution;
      constraints?: FridayAgentRunConstraints;
      responseText?: string;
      summary?: string;
      artifactDir?: string;
      contextCostSummary?: FridayAgentContextCostSummary;
      taskProfile?: FridayResolvedAgentTaskProfile;
    },
  ): FridayAgentRunRecord | null;

  list(
    db: Database.Database,
    input?: {
      status?: FridayAgentRunStatus;
      limit?: number;
      cursor?: string;
    },
  ): FridayAgentRunRecord[];

  /** List all runs in an active (non-terminal) status for boot recovery. */
  listActive(db: Database.Database): FridayAgentRunRecord[];
}

// ─── Factory ───

export function createFridayAgentRunRepository(): FridayAgentRunRepository {
  return {
    create(db, input) {
      db.prepare(
        `INSERT INTO friday_agent_runs (
          id, task, status, session_key, provider_id, model,
          attempt, max_attempts, created_at, constraints_json
        ) VALUES (?, ?, 'pending', ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        input.id,
        input.task,
        input.sessionKey,
        input.providerId ?? null,
        input.model ?? null,
        input.maxAttempts,
        input.nowIso,
        input.constraints ? JSON.stringify(input.constraints) : "{}",
      );

      const row = db.prepare(
        "SELECT * FROM friday_agent_runs WHERE id = ?",
      ).get(input.id) as FridayAgentRunRow | undefined;

      if (!row) {
        throw new FridayDomainError(
          FRIDAY_AGENT_ERROR_CODES.VALIDATION_ERROR,
          "Agent run insert failed — row not found after insert",
          { httpStatus: 500 },
        );
      }

      return rowToRecord(row);
    },

    getById(db, id) {
      const row = db.prepare(
        "SELECT * FROM friday_agent_runs WHERE id = ?",
      ).get(id) as FridayAgentRunRow | undefined;

      return row ? rowToRecord(row) : null;
    },

    update(db, input) {
      const sets: string[] = [];
      const params: unknown[] = [];

      if (input.status !== undefined) {
        sets.push("status = ?");
        params.push(input.status);
      }
      if (input.attempt !== undefined) {
        sets.push("attempt = ?");
        params.push(input.attempt);
      }
      if (input.artifacts !== undefined) {
        sets.push("artifacts = ?");
        params.push(JSON.stringify(input.artifacts));
      }
      if (input.testResults !== undefined) {
        sets.push("test_results = ?");
        params.push(JSON.stringify(input.testResults));
      }
      if (input.errorCode !== undefined) {
        sets.push("error_code = ?");
        params.push(input.errorCode);
      }
      if (input.errorMessage !== undefined) {
        sets.push("error_message = ?");
        params.push(input.errorMessage);
      }
      if (input.startedAt !== undefined) {
        sets.push("started_at = ?");
        params.push(input.startedAt);
      }
      if (input.completedAt !== undefined) {
        sets.push("completed_at = ?");
        params.push(input.completedAt);
      }
      if (input.durationMs !== undefined) {
        sets.push("duration_ms = ?");
        params.push(input.durationMs);
      }
      if (input.usageInput !== undefined) {
        sets.push("usage_input = ?");
        params.push(input.usageInput);
      }
      if (input.usageOutput !== undefined) {
        sets.push("usage_output = ?");
        params.push(input.usageOutput);
      }
      if (input.costUsd !== undefined) {
        sets.push("cost_usd = ?");
        params.push(input.costUsd);
      }
      if (input.planReview !== undefined) {
        sets.push("plan_review_json = ?");
        params.push(JSON.stringify(input.planReview));
      }
      if (input.actualExecution !== undefined) {
        sets.push("actual_execution_json = ?");
        params.push(JSON.stringify(input.actualExecution));
      }
      if (input.constraints !== undefined) {
        sets.push("constraints_json = ?");
        params.push(JSON.stringify(input.constraints));
      }
      if (input.responseText !== undefined) {
        sets.push("response_text = ?");
        params.push(input.responseText);
      }
      if (input.summary !== undefined) {
        sets.push("summary = ?");
        params.push(input.summary);
      }
      if (input.artifactDir !== undefined) {
        sets.push("artifact_dir = ?");
        params.push(input.artifactDir);
      }
      if (input.contextCostSummary !== undefined) {
        sets.push("context_cost_summary_json = ?");
        params.push(JSON.stringify(input.contextCostSummary));
      }
      if (input.taskProfile !== undefined) {
        sets.push("task_profile_json = ?");
        params.push(JSON.stringify(input.taskProfile));
      }

      if (sets.length === 0) {
        return this.getById(db, input.id);
      }

      params.push(input.id);
      db.prepare(
        `UPDATE friday_agent_runs SET ${sets.join(", ")} WHERE id = ?`,
      ).run(...params);

      return this.getById(db, input.id);
    },

    list(db, input) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (input?.status) {
        conditions.push("status = ?");
        params.push(input.status);
      }
      if (input?.cursor) {
        conditions.push("created_at < ?");
        params.push(input.cursor);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.min(input?.limit ?? 50, 500);
      params.push(limit);

      const rows = db.prepare(
        `SELECT * FROM friday_agent_runs ${where} ORDER BY created_at DESC LIMIT ?`,
      ).all(...params) as FridayAgentRunRow[];

      return rows.map(rowToRecord);
    },

    listActive(db) {
      const placeholders = FRIDAY_AGENT_ACTIVE_STATUSES.map(() => "?").join(", ");
      const rows = db.prepare(
        `SELECT * FROM friday_agent_runs WHERE status IN (${placeholders}) ORDER BY created_at ASC`,
      ).all(...FRIDAY_AGENT_ACTIVE_STATUSES) as FridayAgentRunRow[];

      return rows.map(rowToRecord);
    },
  };
}
