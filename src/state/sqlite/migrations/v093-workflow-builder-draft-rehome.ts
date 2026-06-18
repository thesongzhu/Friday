import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V093_WORKFLOW_BUILDER_DRAFT_REHOME_SQL = `
-- V093: Rehome workflow-builder draft metadata out of memory_items.
--
-- The dedicated workflow_builder_drafts table predates this migration, but the
-- repository still used memory_items as an operational KV store. These columns
-- let the repository preserve the full draft entity while new writes stay out
-- of the legacy durable-memory table.

ALTER TABLE workflow_builder_drafts
  ADD COLUMN published_workflow_version_id TEXT;

ALTER TABLE workflow_builder_drafts
  ADD COLUMN autosave_last_saved_at TEXT;

ALTER TABLE workflow_builder_drafts
  ADD COLUMN source_review_json TEXT;
`;

const V093_CHECKSUM = computeFridayMigrationChecksum(
  V093_WORKFLOW_BUILDER_DRAFT_REHOME_SQL,
);

export const V093_WORKFLOW_BUILDER_DRAFT_REHOME_MIGRATION: FridaySqliteMigration = {
  version: 93,
  name: "v093-workflow-builder-draft-rehome",
  sql: V093_WORKFLOW_BUILDER_DRAFT_REHOME_SQL,
  checksum: V093_CHECKSUM,
};
