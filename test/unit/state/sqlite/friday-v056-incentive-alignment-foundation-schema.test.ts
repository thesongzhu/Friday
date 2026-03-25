import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V056 — incentive alignment foundation schema", () => {
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
        // no-op
      }
    }
    dbs.length = 0;
  });

  it("adds leverage fields to friday_agent_automations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(friday_agent_automations)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    expect(names.has("estimated_time_saved_minutes")).toBe(true);
    expect(names.has("reuse_count")).toBe(true);
    expect(names.has("promotion_state")).toBe(true);
    expect(names.has("last_outcome_score")).toBe(true);
  });

  it("adds expanded daily conversion metrics", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(learning_metrics)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    expect(names.has("activation_rate")).toBe(true);
    expect(names.has("save_rate")).toBe(true);
    expect(names.has("reuse_rate")).toBe(true);
    expect(names.has("promotion_rate")).toBe(true);
    expect(names.has("support_conversion_rate")).toBe(true);
    expect(names.has("request_fulfillment_rate")).toBe(true);
  });

  it("extends learning_events kind constraint with incentive-alignment kinds", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
    db.prepare(
      `INSERT INTO users (id, display_name, role, is_local_only, created_at, updated_at)
       VALUES ('user-v056', 'Schema User', 'admin', 1, '2026-03-24T00:00:00.000Z', '2026-03-24T00:00:00.000Z')`,
    ).run();

    expect(() =>
      db.prepare(
        `INSERT INTO learning_events (event_id, ts, user_id, kind, payload_json, created_at)
         VALUES ('evt-v056', '2026-03-24T00:00:00.000Z', 'user-v056', 'automation_saved', '{}', '2026-03-24T00:00:00.000Z')`,
      ).run(),
    ).not.toThrow();
  });

  it("records migration v056 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 56")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(56);
    expect(row?.name).toBe("v056-incentive-alignment-foundation");
  });

  it("repairs a partially applied v056 when the migration row is missing", () => {
    const db = freshDb();
    const throughV055 = FRIDAY_SQLITE_MIGRATIONS.filter((migration) => migration.version <= 55);
    runFridayMigrations({ db, migrations: throughV055 });

    db.exec(`
      ALTER TABLE friday_agent_automations
        ADD COLUMN estimated_time_saved_minutes INTEGER NOT NULL DEFAULT 15;
    `);

    expect(() =>
      runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS }),
    ).not.toThrow();

    const automationColumns = db
      .prepare("PRAGMA table_info(friday_agent_automations)")
      .all() as Array<{ name: string }>;
    const automationNames = new Set(automationColumns.map((column) => column.name));
    expect(automationNames.has("estimated_time_saved_minutes")).toBe(true);
    expect(automationNames.has("reuse_count")).toBe(true);
    expect(automationNames.has("promotion_state")).toBe(true);
    expect(automationNames.has("last_outcome_score")).toBe(true);

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 56")
      .get() as { version: number; name: string } | undefined;
    expect(row?.version).toBe(56);
    expect(row?.name).toBe("v056-incentive-alignment-foundation");
  });
});
