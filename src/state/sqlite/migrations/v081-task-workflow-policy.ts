import { computeFridayMigrationChecksum } from "./friday-migration.types.js";
import type { FridaySqliteMigration } from "./friday-migration.types.js";

export const V081_TASK_WORKFLOW_POLICY_SQL = `
-- V081: Phase 13.5A core task workflow policy persistence.
--
-- Adds the additive task_workflow_* tables required to record charter, spec
-- hash, revision lineage, claim matrix entries, evidence refs (refs only —
-- raw payloads stay in existing evidence stores), required gate plan,
-- context package, supervisor cursor, and closeout receipt. Existing
-- agent_runs / workflow run evidence / channel tables are NOT modified;
-- task workflow rows reference them by id/hash through evidence ref rows.

CREATE TABLE IF NOT EXISTS task_workflows (
  id                 TEXT PRIMARY KEY NOT NULL,
  charter            TEXT NOT NULL,
  spec_hash          TEXT NOT NULL,
  parent_spec_hash   TEXT,
  task_kind          TEXT NOT NULL,
  risk               TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  supervisor_mode    TEXT NOT NULL CHECK (supervisor_mode IN ('off','light','standard','strict')),
  budget             INTEGER NOT NULL,
  stage              TEXT NOT NULL CHECK (stage IN ('intake','charter','plan','execute','verify','review','closeout','revised')),
  context_package_json TEXT NOT NULL,
  gate_plan_json     TEXT NOT NULL,
  boundary_refs_json TEXT NOT NULL,
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_workflows_spec_hash
  ON task_workflows (spec_hash);
CREATE INDEX IF NOT EXISTS idx_task_workflows_parent_spec_hash
  ON task_workflows (parent_spec_hash);
CREATE INDEX IF NOT EXISTS idx_task_workflows_stage
  ON task_workflows (stage, created_at DESC);

CREATE TABLE IF NOT EXISTS task_workflow_revisions (
  id                 TEXT PRIMARY KEY NOT NULL,
  workflow_id        TEXT NOT NULL REFERENCES task_workflows(id) ON DELETE CASCADE,
  spec_hash          TEXT NOT NULL,
  parent_spec_hash   TEXT,
  charter            TEXT NOT NULL,
  reason             TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_workflow_revisions_workflow
  ON task_workflow_revisions (workflow_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_workflow_revisions_workflow_spec
  ON task_workflow_revisions (workflow_id, spec_hash);

CREATE TABLE IF NOT EXISTS task_workflow_claims (
  id                 TEXT PRIMARY KEY NOT NULL,
  workflow_id        TEXT NOT NULL REFERENCES task_workflows(id) ON DELETE CASCADE,
  spec_hash          TEXT NOT NULL,
  claim_text         TEXT NOT NULL,
  claim_kind         TEXT NOT NULL CHECK (claim_kind IN (
    'docs_intent','summary_replay','cli_self_report','provider_fallback',
    'runtime_evidence','code_evidence','api_evidence','artifact_evidence'
  )),
  status             TEXT NOT NULL CHECK (status IN ('draft','unverified','verified','blocked')),
  reason             TEXT,
  verifier_verdict   TEXT,
  evidence_ref_count INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_workflow_claims_workflow
  ON task_workflow_claims (workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_workflow_claims_status
  ON task_workflow_claims (workflow_id, status);

CREATE TABLE IF NOT EXISTS task_workflow_evidence_refs (
  id                 TEXT PRIMARY KEY NOT NULL,
  workflow_id        TEXT NOT NULL REFERENCES task_workflows(id) ON DELETE CASCADE,
  claim_id           TEXT NOT NULL REFERENCES task_workflow_claims(id) ON DELETE CASCADE,
  ref_kind           TEXT NOT NULL,
  ref_id             TEXT NOT NULL,
  ref_hash           TEXT,
  ref_source         TEXT NOT NULL CHECK (ref_source IN (
    'agent_run_event','workflow_run_evidence','provider_route_trace',
    'context_replay','self_heal_event','channel_event','session_event',
    'observability_audit','manual_external','docs_intent_reference'
  )),
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_workflow_evidence_refs_claim
  ON task_workflow_evidence_refs (claim_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_workflow_evidence_refs_workflow
  ON task_workflow_evidence_refs (workflow_id, ref_kind);

CREATE TABLE IF NOT EXISTS task_workflow_supervisor_cursor (
  workflow_id        TEXT PRIMARY KEY NOT NULL REFERENCES task_workflows(id) ON DELETE CASCADE,
  current_stage      TEXT NOT NULL,
  blockers_json      TEXT NOT NULL DEFAULT '[]',
  last_event_ref     TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_workflow_closeout_receipts (
  id                 TEXT PRIMARY KEY NOT NULL,
  workflow_id        TEXT NOT NULL REFERENCES task_workflows(id) ON DELETE CASCADE,
  spec_hash          TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('complete','partial','blocked')),
  claim_summary_json TEXT NOT NULL,
  blockers_json      TEXT NOT NULL DEFAULT '[]',
  gate_outcomes_json TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_workflow_closeout_receipts_workflow
  ON task_workflow_closeout_receipts (workflow_id, created_at DESC);
`;

const V081_CHECKSUM = computeFridayMigrationChecksum(V081_TASK_WORKFLOW_POLICY_SQL);

export const V081_TASK_WORKFLOW_POLICY_MIGRATION: FridaySqliteMigration = {
  version: 81,
  name: "v081-task-workflow-policy",
  sql: V081_TASK_WORKFLOW_POLICY_SQL,
  checksum: V081_CHECKSUM,
};
