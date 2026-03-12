import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

/**
 * V027: Job scheduler — multi-schedule support.
 *
 * Adds schedule-kind columns to friday_scheduler_jobs so the scheduler
 * can handle at/every/cron/interval schedules instead of interval-only.
 * Legacy rows are mapped to 'every' (which is semantically equivalent
 * to the previous intervalMs behavior).
 */
export const V027_JOB_SCHEDULER_MULTI_SCHEDULE_SQL = `
-- V027: Multi-schedule support for job scheduler

ALTER TABLE friday_scheduler_jobs ADD COLUMN schedule_kind TEXT NOT NULL DEFAULT 'every' CHECK (schedule_kind IN ('at', 'every', 'cron', 'interval'));
ALTER TABLE friday_scheduler_jobs ADD COLUMN schedule_at TEXT;
ALTER TABLE friday_scheduler_jobs ADD COLUMN schedule_every_ms INTEGER;
ALTER TABLE friday_scheduler_jobs ADD COLUMN schedule_anchor_ms INTEGER;
ALTER TABLE friday_scheduler_jobs ADD COLUMN schedule_cron_expr TEXT;
ALTER TABLE friday_scheduler_jobs ADD COLUMN schedule_tz TEXT;

-- Backfill: copy interval_ms into schedule_every_ms for legacy rows
UPDATE friday_scheduler_jobs SET schedule_every_ms = interval_ms WHERE schedule_kind = 'every';
`;

const V027_CHECKSUM = computeFridayMigrationChecksum(V027_JOB_SCHEDULER_MULTI_SCHEDULE_SQL);

export const V027_JOB_SCHEDULER_MULTI_SCHEDULE_MIGRATION: FridaySqliteMigration = {
  version: 27,
  name: "v027-job-scheduler-multi-schedule",
  sql: V027_JOB_SCHEDULER_MULTI_SCHEDULE_SQL,
  checksum: V027_CHECKSUM,
};
