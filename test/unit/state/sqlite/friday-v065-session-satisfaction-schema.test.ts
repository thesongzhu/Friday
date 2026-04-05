import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V065 — session satisfaction schema", () => {
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

  it("creates the friday_session_satisfaction table with expected columns", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(friday_session_satisfaction)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));

    expect(names.has("session_id")).toBe(true);
    expect(names.has("user_id")).toBe(true);
    expect(names.has("score")).toBe(true);
    expect(names.has("signal_count")).toBe(true);
    expect(names.has("positive_count")).toBe(true);
    expect(names.has("negative_count")).toBe(true);
    expect(names.has("neutral_count")).toBe(true);
    expect(names.has("computed_at")).toBe(true);
    expect(names.has("created_at")).toBe(true);
    expect(names.has("updated_at")).toBe(true);
  });

  it("creates the satisfaction user index", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const indexes = db
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'friday_session_satisfaction'
          AND name NOT LIKE 'sqlite_%'
      `)
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);

    expect(names).toContain("idx_session_satisfaction_user");
  });

  it("creates the friday_individuation_state table with expected columns", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(friday_individuation_state)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));

    expect(names.has("user_id")).toBe(true);
    expect(names.has("stage")).toBe(true);
    expect(names.has("fact_count")).toBe(true);
    expect(names.has("session_count")).toBe(true);
    expect(names.has("average_satisfaction")).toBe(true);
    expect(names.has("learned_persona_dimensions")).toBe(true);
    expect(names.has("stage_entered_at")).toBe(true);
    expect(names.has("previous_stage")).toBe(true);
    expect(names.has("computed_at")).toBe(true);
  });

  it("records migration v065 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 65")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(65);
    expect(row?.name).toBe("v065-session-satisfaction");
  });
});
