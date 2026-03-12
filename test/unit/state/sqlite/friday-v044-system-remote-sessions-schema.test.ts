import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V044 — system remote sessions schema", () => {
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
        // ignore
      }
    }
    dbs.length = 0;
  });

  it("creates the system remote sessions table", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db.prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name = 'friday_system_remote_sessions'`,
    ).get() as { name: string } | undefined;

    expect(row?.name).toBe("friday_system_remote_sessions");
  });

  it("records migration v044 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 44")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(44);
    expect(row?.name).toBe("v044-system-remote-sessions");
  });
});
