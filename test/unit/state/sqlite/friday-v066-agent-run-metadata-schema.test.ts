import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V066 — agent run metadata schema", () => {
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

  it("adds metadata_json to friday_agent_runs", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(friday_agent_runs)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));

    expect(names.has("metadata_json")).toBe(true);
  });

  it("records migration v066 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 66")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(66);
    expect(row?.name).toBe("v066-agent-run-metadata");
  });
});
