import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V030_AGENT_AUTOMATION_SCHEDULE_LINK_SQL = `
-- V030: Agent automations schedule linkage metadata

ALTER TABLE friday_agent_automations ADD COLUMN schedule_cron_expr TEXT;
ALTER TABLE friday_agent_automations ADD COLUMN schedule_tz TEXT;

CREATE INDEX IF NOT EXISTS idx_friday_agent_automations_schedule_cron
  ON friday_agent_automations (schedule_cron_expr);
`;

const V030_CHECKSUM = computeFridayMigrationChecksum(V030_AGENT_AUTOMATION_SCHEDULE_LINK_SQL);

export const V030_AGENT_AUTOMATION_SCHEDULE_LINK_MIGRATION: FridaySqliteMigration = {
  version: 30,
  name: "v030-agent-automation-schedule-link",
  sql: V030_AGENT_AUTOMATION_SCHEDULE_LINK_SQL,
  checksum: V030_CHECKSUM,
};

