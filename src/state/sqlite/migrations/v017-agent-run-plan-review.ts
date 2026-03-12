import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V017_AGENT_RUN_PLAN_REVIEW_SQL = `
-- V017: Persist agent plan + review decision state
ALTER TABLE friday_agent_runs
ADD COLUMN plan_review_json TEXT;
`;

const V017_CHECKSUM = computeFridayMigrationChecksum(V017_AGENT_RUN_PLAN_REVIEW_SQL);

export const V017_AGENT_RUN_PLAN_REVIEW_MIGRATION: FridaySqliteMigration = {
  version: 17,
  name: "v017-agent-run-plan-review",
  sql: V017_AGENT_RUN_PLAN_REVIEW_SQL,
  checksum: V017_CHECKSUM,
};
