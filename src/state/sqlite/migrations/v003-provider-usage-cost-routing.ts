import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V003_PROVIDER_USAGE_COST_ROUTING_SQL = `
-- ============================================================
-- V003: Provider usage tracking + cost routing
-- ============================================================

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
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_day
  ON llm_usage_records(usage_day);

CREATE INDEX IF NOT EXISTS idx_llm_usage_month
  ON llm_usage_records(usage_month);

CREATE INDEX IF NOT EXISTS idx_llm_usage_provider_day
  ON llm_usage_records(provider_id, usage_day);

CREATE INDEX IF NOT EXISTS idx_llm_usage_model_day
  ON llm_usage_records(model, usage_day);
`;

const V003_CHECKSUM = computeFridayMigrationChecksum(V003_PROVIDER_USAGE_COST_ROUTING_SQL);

export const V003_PROVIDER_USAGE_COST_ROUTING_MIGRATION: FridaySqliteMigration = {
  version: 3,
  name: "v003-provider-usage-cost-routing",
  sql: V003_PROVIDER_USAGE_COST_ROUTING_SQL,
  checksum: V003_CHECKSUM,
};
