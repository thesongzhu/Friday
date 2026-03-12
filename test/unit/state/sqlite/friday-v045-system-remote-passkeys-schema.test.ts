import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V045 — system remote passkeys schema", () => {
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

  it("creates the remote passkey and auth tables", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const names = db.prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'friday_system_remote_passkeys',
           'friday_system_remote_auth_challenges',
           'friday_system_remote_assertion_grants'
         )`,
    ).all() as Array<{ name: string }>;

    expect(names.map((row) => row.name).sort()).toEqual([
      "friday_system_remote_assertion_grants",
      "friday_system_remote_auth_challenges",
      "friday_system_remote_passkeys",
    ]);
  });

  it("records migration v045 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 45")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(45);
    expect(row?.name).toBe("v045-system-remote-passkeys");
  });
});
