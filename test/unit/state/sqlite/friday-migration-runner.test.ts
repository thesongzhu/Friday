import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  FRIDAY_SQLITE_MIGRATIONS,
  runFridayMigrations,
  computeFridayMigrationChecksum,
  V001_INITIAL_MIGRATION,
} from "#state";
import type { FridaySqliteMigration } from "#state";

describe("friday-migration-runner", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("applies V001 once and records in schema_migrations", () => {
    const result = runFridayMigrations({ db, migrations: [V001_INITIAL_MIGRATION] });

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].version).toBe(1);
    expect(result.applied[0].name).toBe("v001-initial");
    expect(result.skippedVersions).toHaveLength(0);

    // Verify V001 tables were created (spot-check a few key tables)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .all();
    expect(tables).toHaveLength(1);

    const satelliteTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='satellites'")
      .all();
    expect(satelliteTables).toHaveLength(1);

    // Verify schema_migrations record
    const rows = db.prepare("SELECT * FROM schema_migrations").all() as Array<{
      version: number;
      name: string;
      checksum: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].name).toBe("v001-initial");
    expect(rows[0].checksum).toBe(V001_INITIAL_MIGRATION.checksum);
  });

  it("second run is no-op (skips already applied)", () => {
    runFridayMigrations({ db, migrations: [V001_INITIAL_MIGRATION] });
    const result = runFridayMigrations({ db, migrations: [V001_INITIAL_MIGRATION] });

    expect(result.applied).toHaveLength(0);
    expect(result.skippedVersions).toEqual([1]);
  });

  it("checksum mismatch for applied version throws", () => {
    runFridayMigrations({ db, migrations: [V001_INITIAL_MIGRATION] });

    const tamperedMigration: FridaySqliteMigration = {
      ...V001_INITIAL_MIGRATION,
      checksum: "tampered-checksum",
    };

    expect(() => runFridayMigrations({ db, migrations: [tamperedMigration] })).toThrow(
      /checksum mismatch/i,
    );
  });

  it("accepts a previously applied legacy checksum when migration allows it", () => {
    runFridayMigrations({ db, migrations: [V001_INITIAL_MIGRATION] });

    const legacyCompatibleMigration: FridaySqliteMigration = {
      ...V001_INITIAL_MIGRATION,
      checksum: "new-checksum",
      acceptedChecksums: [V001_INITIAL_MIGRATION.checksum],
    };

    const rerun = runFridayMigrations({ db, migrations: [legacyCompatibleMigration] });
    expect(rerun.applied).toHaveLength(0);
    expect(rerun.skippedVersions).toEqual([1]);
  });

  it("rejects mismatched checksum when it is not in acceptedChecksums", () => {
    runFridayMigrations({ db, migrations: [V001_INITIAL_MIGRATION] });

    const nonCompatibleMigration: FridaySqliteMigration = {
      ...V001_INITIAL_MIGRATION,
      checksum: "new-checksum",
      acceptedChecksums: ["some-other-legacy-checksum"],
    };

    expect(() => runFridayMigrations({ db, migrations: [nonCompatibleMigration] })).toThrow(
      /checksum mismatch/i,
    );
  });

  it("accepts legacy checksums for v031 and v032 in existing user databases", () => {
    const migrations = FRIDAY_SQLITE_MIGRATIONS.filter((m) => m.version === 31 || m.version === 32);
    expect(migrations).toHaveLength(2);

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    db.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `).run(31, "v031-rules-engine-persistence", "0e88f23db5b602a0aed6d774baf4fc2cdf1d451141e665ab8dee0ee622e2403d", "2026-02-25T21:24:40.388Z");
    db.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `).run(32, "v032-playbook-persistence", "f84814033692526f292897f8d0886a2eb6846688d8849e250a7fcbfa2aee0b57", "2026-02-25T21:25:40.388Z");

    const result = runFridayMigrations({ db, migrations });
    expect(result.applied).toHaveLength(0);
    expect(result.skippedVersions).toEqual([31, 32]);
  });

  it("rejects schema_migrations rows from a newer Friday build", () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    db.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `).run(999, "v999-future-build", "future-checksum", "2026-05-18T00:00:00.000Z");

    expect(() =>
      runFridayMigrations({ db, migrations: [V001_INITIAL_MIGRATION] }),
    ).toThrow(/newer than this Friday build/i);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .all();
    expect(tables).toHaveLength(0);
  });

  it("failed migration rolls back the entire pending migration batch", () => {
    const badMigration: FridaySqliteMigration = {
      version: 2,
      name: "bad-migration",
      sql: "CREATE TABLE good_table (id TEXT); THIS IS INVALID SQL;",
      checksum: computeFridayMigrationChecksum(
        "CREATE TABLE good_table (id TEXT); THIS IS INVALID SQL;",
      ),
    };

    expect(() =>
      runFridayMigrations({ db, migrations: [V001_INITIAL_MIGRATION, badMigration] }),
    ).toThrow();

    // The full pending migration batch is atomic under one IMMEDIATE transaction.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .all();
    expect(tables).toHaveLength(0);

    // Bad migration's table should not exist (rolled back)
    const badTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='good_table'")
      .all();
    expect(badTables).toHaveLength(0);
  });
});
