import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V058 — agent run context/profile schema", () => {
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

  it("adds context cost summary and task profile columns to friday_agent_runs", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(friday_agent_runs)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    expect(names.has("context_cost_summary_json")).toBe(true);
    expect(names.has("task_profile_json")).toBe(true);
  });

  it("records migration v058 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 58")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(58);
    expect(row?.name).toBe("v058-agent-run-context-profile");
  });
});
