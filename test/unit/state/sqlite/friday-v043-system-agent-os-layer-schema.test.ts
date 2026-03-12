import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { FRIDAY_SQLITE_MIGRATIONS, runFridayMigrations } from "#state";

describe("V043 — system agent OS layer schema", () => {
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

  it("creates the system approval, device, lease, and event journal tables", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const tables = db.prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'friday_system_approval_rules',
           'friday_system_remote_devices',
           'friday_system_control_leases',
           'friday_system_state_journal'
         )
       ORDER BY name`,
    ).all() as Array<{ name: string }>;

    expect(tables.map((row) => row.name)).toEqual([
      "friday_system_approval_rules",
      "friday_system_control_leases",
      "friday_system_remote_devices",
      "friday_system_state_journal",
    ]);
  });

  it("records migration v043 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 43")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(43);
    expect(row?.name).toBe("v043-system-agent-os-layer");
  });
});
