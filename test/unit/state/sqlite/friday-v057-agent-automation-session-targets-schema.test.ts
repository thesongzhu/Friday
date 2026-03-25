import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V057 — agent automation session targets schema", () => {
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

  it("adds session target columns to friday_agent_automations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(friday_agent_automations)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    expect(names.has("session_target_kind")).toBe(true);
    expect(names.has("session_target_session_key")).toBe(true);
  });

  it("backfills existing automation rows to isolated session targets", () => {
    const db = freshDb();
    runFridayMigrations({
      db,
      migrations: FRIDAY_SQLITE_MIGRATIONS.filter((migration) => migration.version <= 56),
    });

    db.prepare(
      `INSERT INTO friday_agent_automations (
        id, name, task_template, enabled, run_count,
        estimated_time_saved_minutes, reuse_count, promotion_state, last_outcome_score,
        created_at, updated_at
      ) VALUES (
        'auto-v057', 'Legacy automation', 'task', 1, 0,
        15, 0, 'private', 0,
        '2026-03-25T00:00:00.000Z', '2026-03-25T00:00:00.000Z'
      )`,
    ).run();

    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare(
        "SELECT session_target_kind, session_target_session_key FROM friday_agent_automations WHERE id = 'auto-v057'",
      )
      .get() as { session_target_kind: string | null; session_target_session_key: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row?.session_target_kind).toBe("isolated");
    expect(row?.session_target_session_key).toBeNull();
  });

  it("records migration v057 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 57")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(57);
    expect(row?.name).toBe("v057-agent-automation-session-targets");
  });
});
