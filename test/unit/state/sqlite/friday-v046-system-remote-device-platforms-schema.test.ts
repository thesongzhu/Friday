import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V046 — system remote device platforms schema", () => {
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

  it("adds the trusted-device platform column with a browser default", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db.prepare("PRAGMA table_info(friday_system_remote_devices)").all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;

    expect(columns.some((column) => column.name === "platform")).toBe(true);
    expect(columns.find((column) => column.name === "platform")?.dflt_value).toBe("'browser'");
  });

  it("records migration v046 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 46")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(46);
    expect(row?.name).toBe("v046-system-remote-device-platforms");
  });
});
