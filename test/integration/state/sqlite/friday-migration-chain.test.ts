import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";

describe("Friday Migration Chain (V001–V024)", () => {
  const dbs: Database.Database[] = [];

  function freshDb(): Database.Database {
    const db = new Database(":memory:");
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    dbs.length = 0;
  });

  // ─── All migrations run on fresh DB ───

  it(`applies all ${String(FRIDAY_SQLITE_MIGRATIONS.length)} migrations on a fresh in-memory database`, () => {
    const db = freshDb();
    const result = runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    expect(result.applied).toHaveLength(FRIDAY_SQLITE_MIGRATIONS.length);
    expect(result.skippedVersions).toHaveLength(0);

    // Verify version numbers
    const versions = result.applied.map((m) => m.version);
    const expectedVersions = FRIDAY_SQLITE_MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual(expectedVersions);
  });

  // ─── Idempotency ───

  it("is idempotent — running migrations twice produces no errors and no re-applies", () => {
    const db = freshDb();
    const first = runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
    expect(first.applied).toHaveLength(FRIDAY_SQLITE_MIGRATIONS.length);

    const second = runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
    expect(second.applied).toHaveLength(0);
    expect(second.skippedVersions).toHaveLength(FRIDAY_SQLITE_MIGRATIONS.length);
    const expectedVersions = FRIDAY_SQLITE_MIGRATIONS.map((m) => m.version);
    expect(second.skippedVersions).toEqual(expectedVersions);
  });

  // ─── Expected tables from V001 ───

  it("creates expected V001 tables", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    // Core V001 tables
    const v001Expected = [
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

    for (const table of v001Expected) {
      expect(tableNames).toContain(table);
    }
  });

  // ─── Expected tables from V002–V009 ───

  it("creates expected V002–V009 tables", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    // V002
    expect(tableNames).toContain("realtime_events");
    expect(tableNames).toContain("realtime_checkpoints");
    expect(tableNames).toContain("api_rate_limit_counters");
    expect(tableNames).toContain("workflow_conflicts");
    expect(tableNames).toContain("workflow_locks");
    expect(tableNames).toContain("workflow_builder_drafts");

    // V003
    expect(tableNames).toContain("llm_usage_records");

    // V004
    expect(tableNames).toContain("memory_embeddings");

    // V006
    expect(tableNames).toContain("session_memory_extraction_jobs");

    // V008
    expect(tableNames).toContain("plugins");
    expect(tableNames).toContain("plugin_dependencies");
    expect(tableNames).toContain("plugin_marketplace_sources");
    expect(tableNames).toContain("plugin_versions");
    expect(tableNames).toContain("plugin_marketplace_cache");

    // V009
    expect(tableNames).toContain("workflow_trigger_registrations");
    expect(tableNames).toContain("workflow_trigger_deliveries");
    expect(tableNames).toContain("workflow_run_checkpoints");
    expect(tableNames).toContain("workflow_approval_requests");

    // V010
    expect(tableNames).toContain("oauth_credentials");

    // V011
    expect(tableNames).toContain("revoked_access_tokens");

    // V012
    expect(tableNames).toContain("friday_agent_runs");
    expect(tableNames).toContain("friday_agent_automations");

    // V013
    expect(tableNames).toContain("friday_subagent_runs");
  });

  // ─── V017–V022 agent anti-pattern tables/columns ───

  it("creates V019 friday_agent_run_events table", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'friday_agent_run_events'",
      )
      .all() as { name: string }[];

    expect(tables).toHaveLength(1);
  });

  // ─── V023 memory file sync tables ───

  it("creates V023 memory_file_sync_dirty and memory_file_sync_state tables", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_file_sync%' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("memory_file_sync_dirty");
    expect(tableNames).toContain("memory_file_sync_state");
  });

  // ─── V024 unified job scheduler table ───

  it("creates V024 friday_scheduler_jobs table", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'friday_scheduler_jobs'",
      )
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it("creates V048 observability SLO and alert destination tables", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('obs_slo_definitions', 'obs_alert_channels') ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = tables.map((table) => table.name);

    expect(tableNames).toContain("obs_slo_definitions");
    expect(tableNames).toContain("obs_alert_channels");
  });

  it("adds V017-V022 columns to friday_agent_runs", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(friday_agent_runs)")
      .all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("plan_review_json");
    expect(columnNames).toContain("actual_execution_json");
    expect(columnNames).toContain("constraints_json");
    expect(columnNames).toContain("response_text");
    expect(columnNames).toContain("summary");
    expect(columnNames).toContain("artifact_dir");
  });

  // ─── schema_migrations records ───

  it("records all migrations in schema_migrations table", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const rows = db
      .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string; checksum: string }[];

    expect(rows).toHaveLength(FRIDAY_SQLITE_MIGRATIONS.length);
    for (const row of rows) {
      expect(row.version).toBeGreaterThan(0);
      expect(row.name).toBeTruthy();
      expect(row.checksum).toBeTruthy();
    }
  });

  // ─── V016 backfills cookies_json redaction ───

  it("v016 redacts existing xhs_sessions.cookies_json values", () => {
    const db = freshDb();

    // Apply migrations through v015 only (creates xhs_sessions table)
    const migrationsThrough15 = FRIDAY_SQLITE_MIGRATIONS.slice(0, 15);
    const pre = runFridayMigrations({ db, migrations: migrationsThrough15 });
    expect(pre.applied).toHaveLength(15);

    // Insert rows with plaintext cookies_json
    const insert = db.prepare(
      "INSERT INTO xhs_sessions (id, account_name, cookies_json, user_agent, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("sess-1", "alice", '{"token":"secret1"}', "Mozilla/5.0", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
    insert.run("sess-2", "bob", '{"token":"secret2"}', "Mozilla/5.0", "2025-01-02T00:00:00Z", "2025-01-02T00:00:00Z");
    insert.run("sess-3", "charlie", '{"token":"secret3"}', "Mozilla/5.0", "2025-01-03T00:00:00Z", "2025-01-03T00:00:00Z");

    // Now apply the full migration chain (v016 through v022 run)
    const post = runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
    const remainingCount = FRIDAY_SQLITE_MIGRATIONS.length - 15;
    expect(post.applied).toHaveLength(remainingCount);
    expect(post.applied[0]!.version).toBe(16);

    // Verify all existing rows have cookies_json redacted
    const rows = db
      .prepare("SELECT id, cookies_json, cookies_encrypted FROM xhs_sessions ORDER BY id")
      .all() as { id: string; cookies_json: string; cookies_encrypted: string | null }[];

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.cookies_json).toBe("[REDACTED]");
      expect(row.cookies_encrypted).toBeNull();
    }
  });

  // ─── Checksums are verified on re-run ───

  it("validates checksums on re-run (does not throw for matching checksums)", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    // Running again should succeed (checksums match)
    expect(() => {
      runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
    }).not.toThrow();
  });
});
