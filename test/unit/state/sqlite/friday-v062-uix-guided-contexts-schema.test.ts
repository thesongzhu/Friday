import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V062 — uix guided contexts schema", () => {
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

  it("creates the uix_guided_contexts table with the expected columns", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(uix_guided_contexts)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    expect(names.has("id")).toBe(true);
    expect(names.has("workflow_id")).toBe(true);
    expect(names.has("principal_id")).toBe(true);
    expect(names.has("channel_id")).toBe(true);
    expect(names.has("status")).toBe(true);
    expect(names.has("current_step_index")).toBe(true);
    expect(names.has("completed_steps_json")).toBe(true);
    expect(names.has("session_data_json")).toBe(true);
    expect(names.has("started_at")).toBe(true);
    expect(names.has("updated_at")).toBe(true);
    expect(names.has("expires_at")).toBe(true);
    expect(names.has("finished_at")).toBe(true);
  });

  it("creates the guided-context lookup indexes", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const indexes = db
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'uix_guided_contexts'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `)
      .all() as Array<{ name: string }>;
    const names = indexes.map((index) => index.name);

    expect(names).toContain("idx_uix_guided_contexts_principal_updated");
    expect(names).toContain("idx_uix_guided_contexts_workflow_status");
  });

  it("records migration v062 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 62")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(62);
    expect(row?.name).toBe("v062-uix-guided-contexts");
  });
});
