import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V048_OBSERVABILITY_SLO_ALERT_DESTINATIONS_SQL = `
-- V048: persistent observability SLO definitions and alert destinations.

CREATE TABLE IF NOT EXISTS obs_slo_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  sli_metric_json TEXT NOT NULL,
  target REAL NOT NULL,
  compliance_window_days INTEGER NOT NULL,
  status TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  tags_json TEXT NOT NULL DEFAULT '[]',
  alert_rule_ids_json TEXT NOT NULL DEFAULT '[]',
  error_budget_json TEXT,
  burn_rates_json TEXT NOT NULL DEFAULT '[]',
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_slo_definitions_enabled_updated
  ON obs_slo_definitions (enabled, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_obs_slo_definitions_status_updated
  ON obs_slo_definitions (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS obs_alert_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_alert_channels_type_enabled
  ON obs_alert_channels (type, enabled, updated_at DESC);
`;

const V048_CHECKSUM = computeFridayMigrationChecksum(
  V048_OBSERVABILITY_SLO_ALERT_DESTINATIONS_SQL,
);

export const V048_OBSERVABILITY_SLO_ALERT_DESTINATIONS_MIGRATION: FridaySqliteMigration = {
  version: 48,
  name: "v048-observability-slo-alert-destinations",
  sql: V048_OBSERVABILITY_SLO_ALERT_DESTINATIONS_SQL,
  checksum: V048_CHECKSUM,
};
