import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";

describe("V021 — agent run response_text + summary columns", () => {
  const dbs: Database.Database[] = [];

  function freshDb(): Database.Database {
    const db = new Database(":memory:");
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs) {
      try { db.close(); } catch { /* ok */ }
    }
    dbs.length = 0;
  });

  it("adds response_text and summary columns to friday_agent_runs", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(friday_agent_runs)")
      .all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("response_text");
    expect(columnNames).toContain("summary");
  });

  it("records migration v021 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 21")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(21);
    expect(row?.name).toBe("v021-agent-run-response-text-summary");
  });
});
