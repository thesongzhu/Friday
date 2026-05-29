import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V089_WORKFLOW_COMPLETION_VERIFICATION_SQL = `
-- V089: Audit C Stage 2(B) — durable workflow run completion-verification label.
--
-- Stage 1 (PR #398) tracks a RUN-LEVEL completion-verification truth (the worst
-- node label observed: verified / model_assessed_unverified / proof_pending /
-- recovery_needed / blocked) ORTHOGONAL to evidence-persistence health
-- (evidenceStatus). That aggregate was process-lifetime in-memory only, so a
-- side-effect run that settled \`proof_pending\` would read \`verified\` after a
-- hub restart (unknown -> verified default) — the same amnesia evidenceStatus
-- historically had. This persists the label so the truth survives restarts.
--
--   * workflow_runs.completion_verification — nullable TEXT; NULL means "no
--     non-verified node was ever recorded" (a clean verified run). A
--     non-verified run persists its worst label here. Legacy rows stay NULL
--     and rehydrate as verified, which is correct for runs that predate the
--     column. This does NOT change whether a node ran, only the orthogonal
--     completion-verification truth; the verifier reads it fail-closed.

ALTER TABLE workflow_runs
  ADD COLUMN completion_verification TEXT;
`;

const V089_CHECKSUM = computeFridayMigrationChecksum(
  V089_WORKFLOW_COMPLETION_VERIFICATION_SQL,
);

export const V089_WORKFLOW_COMPLETION_VERIFICATION_MIGRATION: FridaySqliteMigration = {
  version: 89,
  name: "v089-workflow-completion-verification",
  sql: V089_WORKFLOW_COMPLETION_VERIFICATION_SQL,
  checksum: V089_CHECKSUM,
};
