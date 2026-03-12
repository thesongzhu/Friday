import type Database from "better-sqlite3";
import type {
  FridayRetryCircuitBreakerRecord,
  FridayRetryCircuitBreakerRow,
  FridayRetryCostDimensions,
  FridayRetryCostRecord,
  FridayRetryCostRecordRow,
  FridayRetryCostSummary,
  FridayRetryEscalation,
  FridayRetryEscalationRow,
  FridayRetryPolicy,
  FridayRetryPolicyRow,
  FridayRetryTrace,
  FridayRetryTraceRow,
} from "../model/friday-retry-engine.types.js";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function zeroCost(): FridayRetryCostDimensions {
  return {
    tokens: 0,
    apiCalls: 0,
    computeMs: 0,
  };
}

function rowToPolicy(row: FridayRetryPolicyRow): FridayRetryPolicy {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    version: row.version,
    priority: row.priority,
    enabled: row.enabled === 1,
    tags: parseJson<string[]>(row.tags_json, []),
    costBudget: parseJson(row.cost_budget_json, {
      maxTotalTokens: 0,
      maxTotalApiCalls: 0,
      maxTotalComputeMs: 0,
    }),
    strategies: parseJson(row.strategies_json, []),
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToTrace(
  row: FridayRetryTraceRow,
  attempts: FridayRetryTrace["attempts"],
  costSummary: FridayRetryCostSummary,
): FridayRetryTrace {
  return {
    id: row.id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    nodeId: row.node_id,
    status: row.status as FridayRetryTrace["status"],
    policyId: row.policy_id,
    originalFailureCategory: row.original_failure_category as FridayRetryTrace["originalFailureCategory"],
    originalErrorCode: row.original_error_code ?? undefined,
    originalErrorMessage: row.original_error_message ?? undefined,
    attempts,
    totalAttempts: row.total_attempts,
    costSummary,
    durationMs: row.duration_ms,
    firstFailureAt: row.first_failure_at,
    resolvedAt: row.resolved_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEscalation(row: FridayRetryEscalationRow): FridayRetryEscalation {
  return {
    id: row.id,
    traceId: row.trace_id,
    target: row.target as FridayRetryEscalation["target"],
    channel: row.channel,
    reason: row.reason,
    failureCategory: row.failure_category as FridayRetryEscalation["failureCategory"],
    attemptCount: row.attempt_count,
    totalCost: {
      tokens: row.total_cost_tokens,
      apiCalls: row.total_cost_api_calls,
      computeMs: row.total_cost_compute_ms,
    },
    acknowledged: row.acknowledged === 1,
    escalatedAt: row.escalated_at,
    acknowledgedAt: row.acknowledged_at ?? undefined,
  };
}

function rowToCircuitBreaker(row: FridayRetryCircuitBreakerRow): FridayRetryCircuitBreakerRecord {
  return {
    targetId: row.target_id,
    state: row.state as FridayRetryCircuitBreakerRecord["state"],
    consecutiveFailures: row.consecutive_failures,
    failureThreshold: row.failure_threshold,
    lastOpenedAt: row.last_opened_at ?? undefined,
    tripCount: row.trip_count,
    updatedAt: row.updated_at,
  };
}

function rowToCostRecord(row: FridayRetryCostRecordRow): FridayRetryCostRecord {
  return {
    id: row.id,
    traceId: row.trace_id,
    attemptNumber: row.attempt_number,
    runId: row.run_id,
    nodeId: row.node_id,
    cost: {
      tokens: row.cost_tokens,
      apiCalls: row.cost_api_calls,
      computeMs: row.cost_compute_ms,
    },
    cumulativeCost: {
      tokens: row.cumulative_tokens,
      apiCalls: row.cumulative_api_calls,
      computeMs: row.cumulative_compute_ms,
    },
    perAttemptBudgetExceeded: row.per_attempt_budget_exceeded === 1,
    totalBudgetExceeded: row.total_budget_exceeded === 1,
    recordedAt: row.recorded_at,
  };
}

export interface FridayRetryRepository {
  listPolicies(db: Database.Database, opts?: {
    enabled?: boolean;
    tag?: string;
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  }): FridayRetryPolicy[];
  getPolicyById(db: Database.Database, policyId: string): FridayRetryPolicy | null;
  insertPolicy(db: Database.Database, row: FridayRetryPolicyRow): void;
  updatePolicy(db: Database.Database, row: FridayRetryPolicyRow): void;
  softDeletePolicy(db: Database.Database, policyId: string, etag: string, nowIso: string): void;
  insertPolicyVersion(db: Database.Database, row: {
    id: string;
    policy_id: string;
    version: number;
    snapshot_json: string;
    changed_by: string | null;
    change_note: string | null;
    created_at: string;
  }): void;
  insertTrace(db: Database.Database, row: FridayRetryTraceRow): void;
  updateTrace(db: Database.Database, row: FridayRetryTraceRow): void;
  getTraceById(db: Database.Database, traceId: string): FridayRetryTrace | null;
  listTraces(db: Database.Database, opts?: {
    runId?: string;
    workflowId?: string;
    nodeId?: string;
    status?: string;
    failureCategory?: string;
    policyId?: string;
    after?: string;
    before?: string;
    limit?: number;
    offset?: number;
  }): FridayRetryTrace[];
  insertAttempt(db: Database.Database, row: {
    id: string;
    trace_id: string;
    attempt_number: number;
    classified_failure_json: string;
    decision_json: string;
    delay_ms: number;
    execution_id: string | null;
    outcome: string;
    cost_record_json: string | null;
    rules_result_json: string | null;
    error_code: string | null;
    error_message: string | null;
    started_at: string;
    completed_at: string;
    metadata_json: string | null;
  }): void;
  insertCostRecord(db: Database.Database, row: FridayRetryCostRecordRow): void;
  listCostRecordsForTrace(db: Database.Database, traceId: string): FridayRetryCostRecord[];
  insertEscalation(db: Database.Database, row: FridayRetryEscalationRow): void;
  listEscalations(db: Database.Database, opts?: {
    traceId?: string;
    acknowledged?: boolean;
    failureCategory?: string;
    after?: string;
    before?: string;
    limit?: number;
    offset?: number;
  }): FridayRetryEscalation[];
  acknowledgeEscalation(db: Database.Database, escalationId: string, nowIso: string): FridayRetryEscalation | null;
  upsertCircuitBreaker(db: Database.Database, row: FridayRetryCircuitBreakerRow): void;
  listCircuitBreakers(db: Database.Database): FridayRetryCircuitBreakerRecord[];
}

export function createFridayRetryRepository(): FridayRetryRepository {
  function buildTrace(
    db: Database.Database,
    row: FridayRetryTraceRow,
  ): FridayRetryTrace {
    const attemptsRows = db.prepare(
      `SELECT * FROM retry_attempts WHERE trace_id = ? ORDER BY attempt_number ASC`,
    ).all(row.id) as Array<{
      id: string;
      trace_id: string;
      attempt_number: number;
      classified_failure_json: string;
      decision_json: string;
      delay_ms: number;
      execution_id: string | null;
      outcome: string;
      cost_record_json: string | null;
      rules_result_json: string | null;
      error_code: string | null;
      error_message: string | null;
      started_at: string;
      completed_at: string;
      metadata_json: string | null;
    }>;
    const attempts = attemptsRows.map((attemptRow) => ({
      id: attemptRow.id,
      traceId: attemptRow.trace_id,
      attemptNumber: attemptRow.attempt_number,
      classifiedFailure: parseJson(attemptRow.classified_failure_json, {} as FridayRetryTrace["attempts"][number]["classifiedFailure"]),
      decision: parseJson(attemptRow.decision_json, {} as FridayRetryTrace["attempts"][number]["decision"]),
      delayMs: attemptRow.delay_ms,
      executionId: attemptRow.execution_id ?? undefined,
      outcome: attemptRow.outcome as FridayRetryTrace["attempts"][number]["outcome"],
      costRecord: attemptRow.cost_record_json
        ? parseJson(attemptRow.cost_record_json, undefined as FridayRetryTrace["attempts"][number]["costRecord"])
        : undefined,
      rulesResult: attemptRow.rules_result_json
        ? parseJson(attemptRow.rules_result_json, undefined as FridayRetryTrace["attempts"][number]["rulesResult"])
        : undefined,
      errorCode: attemptRow.error_code ?? undefined,
      errorMessage: attemptRow.error_message ?? undefined,
      startedAt: attemptRow.started_at,
      completedAt: attemptRow.completed_at,
      metadata: attemptRow.metadata_json
        ? parseJson(attemptRow.metadata_json, {} as FridayRetryTrace["attempts"][number]["metadata"])
        : undefined,
    }));

    const costRows = db.prepare(
      `SELECT * FROM retry_cost_records WHERE trace_id = ? ORDER BY attempt_number ASC`,
    ).all(row.id) as FridayRetryCostRecordRow[];
    const latestCost = costRows.length > 0 ? rowToCostRecord(costRows[costRows.length - 1]) : undefined;
    const originalOperationCost = zeroCost();
    const totalCost = latestCost?.cumulativeCost ?? zeroCost();
    const budget = parseJson(row.cost_summary_json, {
      budget: { maxTotalTokens: 0, maxTotalApiCalls: 0, maxTotalComputeMs: 0 },
    } as Partial<FridayRetryCostSummary>).budget ?? {
      maxTotalTokens: 0,
      maxTotalApiCalls: 0,
      maxTotalComputeMs: 0,
    };
    const safeDiv = (value: number, total: number) => (total <= 0 ? 0 : (value / total) * 100);
    const costSummary: FridayRetryCostSummary = {
      totalCost,
      originalOperationCost,
      overheadPercent: {
        tokensPercent: 0,
        apiCallsPercent: 0,
        computeMsPercent: 0,
      },
      budget,
      budgetExceeded: latestCost?.totalBudgetExceeded ?? false,
      budgetUtilization: {
        tokensPercent: safeDiv(totalCost.tokens, budget.maxTotalTokens),
        apiCallsPercent: safeDiv(totalCost.apiCalls, budget.maxTotalApiCalls),
        computeMsPercent: safeDiv(totalCost.computeMs, budget.maxTotalComputeMs),
      },
      recordCount: costRows.length,
    };

    return rowToTrace(row, attempts, costSummary);
  }

  return {
    listPolicies(db, opts = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (!opts.includeDeleted) {
        clauses.push("deleted_at IS NULL");
      }
      if (typeof opts.enabled === "boolean") {
        clauses.push("enabled = ?");
        params.push(opts.enabled ? 1 : 0);
      }
      if (opts.tag) {
        clauses.push("tags_json LIKE ?");
        params.push(`%\"${opts.tag}\"%`);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.prepare(
        `SELECT * FROM retry_policies ${where} ORDER BY priority ASC, updated_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, opts.limit ?? 100, opts.offset ?? 0) as FridayRetryPolicyRow[];
      return rows.map(rowToPolicy);
    },

    getPolicyById(db, policyId) {
      const row = db.prepare(`SELECT * FROM retry_policies WHERE id = ?`).get(policyId) as FridayRetryPolicyRow | undefined;
      return row ? rowToPolicy(row) : null;
    },

    insertPolicy(db, row) {
      db.prepare(
        `INSERT INTO retry_policies (
          id, name, description, version, priority, enabled, tags_json, cost_budget_json,
          strategies_json, etag, created_at, updated_at, deleted_at
        ) VALUES (
          @id, @name, @description, @version, @priority, @enabled, @tags_json, @cost_budget_json,
          @strategies_json, @etag, @created_at, @updated_at, @deleted_at
        )`,
      ).run(row);
    },

    updatePolicy(db, row) {
      db.prepare(
        `UPDATE retry_policies SET
          name = @name,
          description = @description,
          version = @version,
          priority = @priority,
          enabled = @enabled,
          tags_json = @tags_json,
          cost_budget_json = @cost_budget_json,
          strategies_json = @strategies_json,
          etag = @etag,
          updated_at = @updated_at,
          deleted_at = @deleted_at
        WHERE id = @id`,
      ).run(row);
    },

    softDeletePolicy(db, policyId, etag, nowIso) {
      db.prepare(
        `UPDATE retry_policies SET deleted_at = ?, etag = ?, updated_at = ? WHERE id = ?`,
      ).run(nowIso, etag, nowIso, policyId);
    },

    insertPolicyVersion(db, row) {
      db.prepare(
        `INSERT INTO retry_policy_versions (
          id, policy_id, version, snapshot_json, changed_by, change_note, created_at
        ) VALUES (
          @id, @policy_id, @version, @snapshot_json, @changed_by, @change_note, @created_at
        )`,
      ).run(row);
    },

    insertTrace(db, row) {
      db.prepare(
        `INSERT INTO retry_traces (
          id, run_id, workflow_id, node_id, status, policy_id, original_failure_category,
          original_error_code, original_error_message, attempts_json, total_attempts, cost_summary_json,
          duration_ms, first_failure_at, resolved_at, created_at, updated_at
        ) VALUES (
          @id, @run_id, @workflow_id, @node_id, @status, @policy_id, @original_failure_category,
          @original_error_code, @original_error_message, @attempts_json, @total_attempts, @cost_summary_json,
          @duration_ms, @first_failure_at, @resolved_at, @created_at, @updated_at
        )`,
      ).run(row);
    },

    updateTrace(db, row) {
      db.prepare(
        `UPDATE retry_traces SET
          run_id = @run_id,
          workflow_id = @workflow_id,
          node_id = @node_id,
          status = @status,
          policy_id = @policy_id,
          original_failure_category = @original_failure_category,
          original_error_code = @original_error_code,
          original_error_message = @original_error_message,
          attempts_json = @attempts_json,
          total_attempts = @total_attempts,
          cost_summary_json = @cost_summary_json,
          duration_ms = @duration_ms,
          first_failure_at = @first_failure_at,
          resolved_at = @resolved_at,
          created_at = @created_at,
          updated_at = @updated_at
        WHERE id = @id`,
      ).run(row);
    },

    getTraceById(db, traceId) {
      const row = db.prepare(`SELECT * FROM retry_traces WHERE id = ?`).get(traceId) as FridayRetryTraceRow | undefined;
      return row ? buildTrace(db, row) : null;
    },

    listTraces(db, opts = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (opts.runId) {
        clauses.push("run_id = ?");
        params.push(opts.runId);
      }
      if (opts.workflowId) {
        clauses.push("workflow_id = ?");
        params.push(opts.workflowId);
      }
      if (opts.nodeId) {
        clauses.push("node_id = ?");
        params.push(opts.nodeId);
      }
      if (opts.status) {
        clauses.push("status = ?");
        params.push(opts.status);
      }
      if (opts.failureCategory) {
        clauses.push("original_failure_category = ?");
        params.push(opts.failureCategory);
      }
      if (opts.policyId) {
        clauses.push("policy_id = ?");
        params.push(opts.policyId);
      }
      if (opts.after) {
        clauses.push("created_at >= ?");
        params.push(opts.after);
      }
      if (opts.before) {
        clauses.push("created_at < ?");
        params.push(opts.before);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.prepare(
        `SELECT * FROM retry_traces ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, opts.limit ?? 100, opts.offset ?? 0) as FridayRetryTraceRow[];
      return rows.map((row) => buildTrace(db, row));
    },

    insertAttempt(db, row) {
      db.prepare(
        `INSERT INTO retry_attempts (
          id, trace_id, attempt_number, classified_failure_json, decision_json, delay_ms,
          execution_id, outcome, cost_record_json, rules_result_json, error_code, error_message,
          started_at, completed_at, metadata_json
        ) VALUES (
          @id, @trace_id, @attempt_number, @classified_failure_json, @decision_json, @delay_ms,
          @execution_id, @outcome, @cost_record_json, @rules_result_json, @error_code, @error_message,
          @started_at, @completed_at, @metadata_json
        )`,
      ).run(row);
    },

    insertCostRecord(db, row) {
      db.prepare(
        `INSERT INTO retry_cost_records (
          id, trace_id, attempt_number, run_id, node_id, cost_tokens, cost_api_calls, cost_compute_ms,
          cumulative_tokens, cumulative_api_calls, cumulative_compute_ms, per_attempt_budget_exceeded,
          total_budget_exceeded, recorded_at
        ) VALUES (
          @id, @trace_id, @attempt_number, @run_id, @node_id, @cost_tokens, @cost_api_calls, @cost_compute_ms,
          @cumulative_tokens, @cumulative_api_calls, @cumulative_compute_ms, @per_attempt_budget_exceeded,
          @total_budget_exceeded, @recorded_at
        )`,
      ).run(row);
    },

    listCostRecordsForTrace(db, traceId) {
      const rows = db.prepare(
        `SELECT * FROM retry_cost_records WHERE trace_id = ? ORDER BY attempt_number ASC`,
      ).all(traceId) as FridayRetryCostRecordRow[];
      return rows.map(rowToCostRecord);
    },

    insertEscalation(db, row) {
      db.prepare(
        `INSERT INTO retry_escalations (
          id, trace_id, target, channel, reason, failure_category, attempt_count,
          total_cost_tokens, total_cost_api_calls, total_cost_compute_ms, acknowledged,
          escalated_at, acknowledged_at
        ) VALUES (
          @id, @trace_id, @target, @channel, @reason, @failure_category, @attempt_count,
          @total_cost_tokens, @total_cost_api_calls, @total_cost_compute_ms, @acknowledged,
          @escalated_at, @acknowledged_at
        )`,
      ).run(row);
    },

    listEscalations(db, opts = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (opts.traceId) {
        clauses.push("trace_id = ?");
        params.push(opts.traceId);
      }
      if (typeof opts.acknowledged === "boolean") {
        clauses.push("acknowledged = ?");
        params.push(opts.acknowledged ? 1 : 0);
      }
      if (opts.failureCategory) {
        clauses.push("failure_category = ?");
        params.push(opts.failureCategory);
      }
      if (opts.after) {
        clauses.push("escalated_at >= ?");
        params.push(opts.after);
      }
      if (opts.before) {
        clauses.push("escalated_at < ?");
        params.push(opts.before);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.prepare(
        `SELECT * FROM retry_escalations ${where} ORDER BY escalated_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, opts.limit ?? 100, opts.offset ?? 0) as FridayRetryEscalationRow[];
      return rows.map(rowToEscalation);
    },

    acknowledgeEscalation(db, escalationId, nowIso) {
      db.prepare(
        `UPDATE retry_escalations SET acknowledged = 1, acknowledged_at = ? WHERE id = ?`,
      ).run(nowIso, escalationId);
      const row = db.prepare(`SELECT * FROM retry_escalations WHERE id = ?`).get(escalationId) as FridayRetryEscalationRow | undefined;
      return row ? rowToEscalation(row) : null;
    },

    upsertCircuitBreaker(db, row) {
      db.prepare(
        `INSERT INTO retry_circuit_breakers (
          target_id, state, consecutive_failures, failure_threshold, last_opened_at, trip_count, updated_at
        ) VALUES (
          @target_id, @state, @consecutive_failures, @failure_threshold, @last_opened_at, @trip_count, @updated_at
        )
        ON CONFLICT(target_id) DO UPDATE SET
          state = excluded.state,
          consecutive_failures = excluded.consecutive_failures,
          failure_threshold = excluded.failure_threshold,
          last_opened_at = excluded.last_opened_at,
          trip_count = excluded.trip_count,
          updated_at = excluded.updated_at`,
      ).run(row);
    },

    listCircuitBreakers(db) {
      const rows = db.prepare(
        `SELECT * FROM retry_circuit_breakers ORDER BY updated_at DESC`,
      ).all() as FridayRetryCircuitBreakerRow[];
      return rows.map(rowToCircuitBreaker);
    },
  };
}
