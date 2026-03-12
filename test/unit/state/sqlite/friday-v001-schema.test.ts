import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";

describe("v001-schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
  });

  afterEach(() => {
    db.close();
  });

  const expectedTables = [
    "schema_migrations",
    "hub_settings",
    "users",
    "config_revisions",
    "auth_sessions",
    "api_tokens",
    "satellites",
    "satellite_capabilities",
    "satellite_pairing_requests",
    "satellite_heartbeats",
    "outbox_messages",
    "sessions",
    "session_messages",
    "workflows",
    "workflow_versions",
    "workflow_runs",
    "workflow_run_nodes",
    "workflow_artifacts",
    "skills",
    "skill_versions",
    "skill_installations",
    "marketplace_sources",
    "marketplace_cache",
    "provider_profiles",
    "secrets",
    "memory_items",
    "learning_events",
    "preference_facts",
    "error_incidents",
    "diagnosis_records",
    "learned_lessons",
    "auto_fix_actions",
    "approval_requests",
    "learning_metrics",
    "audit_logs",
  ];

  it("creates all expected tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name).sort();

    for (const expected of expectedTables) {
      expect(tableNames).toContain(expected);
    }
  });

  const expectedIndexes = [
    "idx_config_revisions_revision",
    "idx_satellites_pairing_status",
    "idx_satellites_last_seen",
    "idx_pairing_status_expires",
    "idx_heartbeats_sat_ts",
    "idx_outbox_sat_status",
    "idx_outbox_sat_idempotency",
    "idx_sessions_owner_lease",
    "idx_session_messages_idempotency",
    "idx_session_messages_session_created",
    "idx_workflow_versions_workflow",
    "idx_workflow_runs_status_started",
    "idx_workflow_run_nodes_run_status",
    "idx_skill_installs_sat_status",
    "idx_memory_namespace_key",
    "idx_audit_ts",
    "idx_audit_actor",
    "idx_learning_events_user_ts",
    "idx_learning_events_kind",
    "idx_learning_events_run",
    "idx_preference_facts_user",
    "idx_error_incidents_signature",
    "idx_error_incidents_user",
    "idx_error_incidents_run",
    "idx_diagnosis_fingerprint",
    "idx_diagnosis_incident",
    "idx_lessons_last_seen",
    "idx_auto_fix_actions_incident",
    "idx_auto_fix_actions_user",
    "idx_auto_fix_actions_status",
    "idx_approval_requests_user_status",
    "idx_approval_requests_action",
  ];

  it("creates all expected indexes", () => {
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name).sort();

    for (const expected of expectedIndexes) {
      expect(indexNames).toContain(expected);
    }
  });

  const expectedTriggers = [
    "trg_session_messages_fts_insert",
    "trg_session_messages_fts_update",
    "trg_session_messages_fts_delete",
  ];

  it("creates FTS triggers", () => {
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    const triggerNames = triggers.map((t) => t.name);

    for (const expected of expectedTriggers) {
      expect(triggerNames).toContain(expected);
    }
  });

  it("creates FTS virtual table", () => {
    const fts = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_messages_fts'",
      )
      .all();
    expect(fts).toHaveLength(1);
  });
});
