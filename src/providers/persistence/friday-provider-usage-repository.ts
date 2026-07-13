import type Database from "better-sqlite3";

import type {
  FridayLlmUsageRecord,
  FridayProviderUsageSummary,
  FridayProviderUsageSummaryRow,
} from "../model/friday-provider-cost.types.js";

// ─── DB row shape ───

interface UsageRecordRow {
  id: string;
  occurred_at: string;
  usage_day: string;
  usage_month: string;
  provider_id: string;
  provider_kind: string;
  provider_api: string;
  model: string;
  route_strategy: string;
  task_complexity: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
  currency: string;
  request_id: string | null;
  run_id: string | null;
  turn_id: string | null;
  receipt: string | null;
  metadata_json: string;
  created_at: string;
}

// ─── Aggregate row from GROUP BY queries ───

interface AggregateRow {
  group_key: string;
  call_count: number;
  sum_input: number;
  sum_output: number;
  sum_cache_read: number;
  sum_cache_write: number;
  sum_total: number;
  sum_cost: number;
}

// ─── Table DDL (applied lazily on first write) ───

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS llm_usage_records (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  usage_day TEXT NOT NULL,
  usage_month TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  provider_api TEXT NOT NULL,
  model TEXT NOT NULL,
  route_strategy TEXT NOT NULL CHECK (
    route_strategy IN ('configured', 'cost_auto', 'budget_downgrade', 'budget_local_only')
  ),
  task_complexity TEXT NOT NULL CHECK (
    task_complexity IN ('simple', 'medium', 'complex')
  ),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  -- V102: provider request-id (idempotency key), run/turn linkage, receipt hash.
  -- Nullable so legacy/local calls that never surfaced a request-id keep prior
  -- behavior. Kept in sync with migration v102-provider-call-receipt for the
  -- fresh-table path (this DDL) vs. the ALTER path (existing prod DBs).
  request_id TEXT,
  run_id TEXT,
  turn_id TEXT,
  receipt TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
`;

const CREATE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_llm_usage_day ON llm_usage_records(usage_day);
CREATE INDEX IF NOT EXISTS idx_llm_usage_month ON llm_usage_records(usage_month);
CREATE INDEX IF NOT EXISTS idx_llm_usage_provider_day ON llm_usage_records(provider_id, usage_day);
CREATE INDEX IF NOT EXISTS idx_llm_usage_model_day ON llm_usage_records(model, usage_day);
-- Partial unique index = the exactly-once identity for request-id-bound calls.
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_usage_request_id
  ON llm_usage_records(request_id) WHERE request_id IS NOT NULL;
`;

// ─── Repository interface ───

export interface FridayProviderUsageRepository {
  /** Ensures the llm_usage_records table and indexes exist. */
  ensureTable(db: Database.Database): void;
  /**
   * Persists a usage record. When record.requestId is present the write is
   * idempotent on that request-id (ON CONFLICT DO NOTHING via the partial
   * unique index) — recording the same call twice yields one row / one charge.
   * Returns whether a new row was actually inserted.
   */
  insert(db: Database.Database, record: FridayLlmUsageRecord): { inserted: boolean };
  /** Reads a single record back by the provider request-id, or null. */
  getByRequestId(db: Database.Database, requestId: string): FridayLlmUsageRecord | null;
  sumCostForMonth(db: Database.Database, usageMonth: string): number;
  querySummary(db: Database.Database, params: {
    from: string;
    to: string;
    groupBy: "day" | "provider" | "model";
    providerId?: string;
    model?: string;
  }): FridayProviderUsageSummary;
}

// ─── Factory ───

export function createFridayProviderUsageRepository(): FridayProviderUsageRepository {
  let tableEnsured = false;

  function ensureTable(db: Database.Database): void {
    if (tableEnsured) return;
    db.exec(CREATE_TABLE_SQL);
    db.exec(CREATE_INDEXES_SQL);
    tableEnsured = true;
  }

  return {
    ensureTable(db) {
      ensureTable(db);
    },
    insert(db, record) {
      ensureTable(db);
      const requestId = record.requestId ?? null;
      // When a request-id is present, the write is idempotent: a duplicate
      // request-id collides on the partial unique index and DO NOTHING makes it
      // a no-op (no double-count). NULL request-ids are outside the index and
      // insert normally, preserving legacy/local-call behavior.
      const conflictClause = requestId !== null
        ? " ON CONFLICT(request_id) WHERE request_id IS NOT NULL DO NOTHING"
        : "";
      const result = db.prepare(
        `INSERT INTO llm_usage_records
         (id, occurred_at, usage_day, usage_month, provider_id, provider_kind,
          provider_api, model, route_strategy, task_complexity,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          total_tokens, cost_usd, currency, request_id, run_id, turn_id, receipt,
          metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${conflictClause}`,
      ).run(
        record.id,
        record.occurredAt,
        record.usageDay,
        record.usageMonth,
        record.providerId,
        record.providerKind,
        record.providerApi,
        record.model,
        record.routeStrategy,
        record.taskComplexity,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.totalTokens,
        record.costUsd,
        record.currency,
        requestId,
        record.runId ?? null,
        record.turnId ?? null,
        record.receipt ?? null,
        JSON.stringify(record.metadata),
        record.createdAt,
      );
      return { inserted: result.changes > 0 };
    },

    getByRequestId(db, requestId) {
      ensureTable(db);
      const row = db
        .prepare(
          `SELECT * FROM llm_usage_records WHERE request_id = ? LIMIT 1`,
        )
        .get(requestId) as UsageRecordRow | undefined;
      if (!row) return null;
      return {
        id: row.id,
        occurredAt: row.occurred_at,
        usageDay: row.usage_day,
        usageMonth: row.usage_month,
        providerId: row.provider_id,
        providerKind: row.provider_kind as FridayLlmUsageRecord["providerKind"],
        providerApi: row.provider_api as FridayLlmUsageRecord["providerApi"],
        model: row.model,
        routeStrategy: row.route_strategy as FridayLlmUsageRecord["routeStrategy"],
        taskComplexity: row.task_complexity as FridayLlmUsageRecord["taskComplexity"],
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        totalTokens: row.total_tokens,
        costUsd: row.cost_usd,
        currency: row.currency as "USD",
        requestId: row.request_id,
        runId: row.run_id,
        turnId: row.turn_id,
        receipt: row.receipt,
        metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
        createdAt: row.created_at,
      };
    },

    sumCostForMonth(db, usageMonth) {
      ensureTable(db);
      const row = db
        .prepare(
          "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_usage_records WHERE usage_month = ?",
        )
        .get(usageMonth) as { total: number };
      return row.total;
    },

    querySummary(db, params) {
      ensureTable(db);
      const { from, to, groupBy, providerId, model } = params;

      // Build group column expression
      let groupColumn: string;
      switch (groupBy) {
        case "day":
          groupColumn = "usage_day";
          break;
        case "provider":
          groupColumn = "provider_id";
          break;
        case "model":
          groupColumn = "model";
          break;
      }

      // Build WHERE conditions
      const conditions: string[] = ["usage_day >= ? AND usage_day <= ?"];
      const bindValues: (string | number)[] = [from, to];

      if (providerId) {
        conditions.push("provider_id = ?");
        bindValues.push(providerId);
      }
      if (model) {
        conditions.push("model = ?");
        bindValues.push(model);
      }

      const whereClause = conditions.join(" AND ");

      const sql = `
        SELECT
          ${groupColumn} AS group_key,
          COUNT(*) AS call_count,
          SUM(input_tokens) AS sum_input,
          SUM(output_tokens) AS sum_output,
          SUM(cache_read_tokens) AS sum_cache_read,
          SUM(cache_write_tokens) AS sum_cache_write,
          SUM(total_tokens) AS sum_total,
          SUM(cost_usd) AS sum_cost
        FROM llm_usage_records
        WHERE ${whereClause}
        GROUP BY ${groupColumn}
        ORDER BY ${groupColumn}
      `;

      const rows = db.prepare(sql).all(...bindValues) as AggregateRow[];

      // Map rows to summary shape
      const summaryRows: FridayProviderUsageSummaryRow[] = rows.map((r) => {
        const base: FridayProviderUsageSummaryRow = {
          callCount: r.call_count,
          inputTokens: r.sum_input,
          outputTokens: r.sum_output,
          cacheReadTokens: r.sum_cache_read,
          cacheWriteTokens: r.sum_cache_write,
          totalTokens: r.sum_total,
          costUsd: r.sum_cost,
        };

        switch (groupBy) {
          case "day":
            base.day = r.group_key;
            break;
          case "provider":
            base.providerId = r.group_key;
            break;
          case "model":
            base.model = r.group_key;
            break;
        }

        return base;
      });

      // Compute totals
      const totals = summaryRows.reduce(
        (acc, row) => ({
          callCount: acc.callCount + row.callCount,
          inputTokens: acc.inputTokens + row.inputTokens,
          outputTokens: acc.outputTokens + row.outputTokens,
          cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
          cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
          totalTokens: acc.totalTokens + row.totalTokens,
          costUsd: acc.costUsd + row.costUsd,
        }),
        {
          callCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
      );

      return {
        from,
        to,
        groupBy,
        rows: summaryRows,
        totals,
      };
    },
  };
}
