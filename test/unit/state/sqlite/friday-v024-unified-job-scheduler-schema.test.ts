import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";

describe("V024 — unified job scheduler schema", () => {
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

  it("creates friday_scheduler_jobs table", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'friday_scheduler_jobs'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it("has expected columns on friday_scheduler_jobs", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const columns = db
      .prepare("PRAGMA table_info(friday_scheduler_jobs)")
      .all() as { name: string }[];
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain("id");
    expect(colNames).toContain("interval_ms");
    expect(colNames).toContain("timeout_ms");
    expect(colNames).toContain("catch_up_runs");
    expect(colNames).toContain("enabled");
    expect(colNames).toContain("next_run_at");
    expect(colNames).toContain("running_at");
    expect(colNames).toContain("last_run_at");
    expect(colNames).toContain("last_status");
    expect(colNames).toContain("last_error");
    expect(colNames).toContain("last_duration_ms");
    expect(colNames).toContain("consecutive_failures");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
  });

  it("creates due index on friday_scheduler_jobs", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_friday_scheduler_jobs_due'")
      .all() as { name: string }[];
    expect(indexes).toHaveLength(1);
  });

  it("row lifecycle works — insert, update, delete", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const now = "2025-01-01T00:00:00Z";

    // Insert
    db.prepare(
      `INSERT INTO friday_scheduler_jobs (id, interval_ms, timeout_ms, catch_up_runs, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("test-job", 60000, 600000, 1, 1, now, now);

    const row = db
      .prepare("SELECT * FROM friday_scheduler_jobs WHERE id = ?")
      .get("test-job") as { id: string; interval_ms: number; consecutive_failures: number };
    expect(row).toBeDefined();
    expect(row.interval_ms).toBe(60000);
    expect(row.consecutive_failures).toBe(0);

    // Update
    db.prepare(
      "UPDATE friday_scheduler_jobs SET last_status = 'ok', consecutive_failures = 0, updated_at = ? WHERE id = ?",
    ).run(now, "test-job");

    const updated = db
      .prepare("SELECT last_status FROM friday_scheduler_jobs WHERE id = ?")
      .get("test-job") as { last_status: string };
    expect(updated.last_status).toBe("ok");

    // Delete
    db.prepare("DELETE FROM friday_scheduler_jobs WHERE id = ?").run("test-job");
    const deleted = db
      .prepare("SELECT * FROM friday_scheduler_jobs WHERE id = ?")
      .get("test-job");
    expect(deleted).toBeUndefined();
  });

  it("records migration v024 in schema_migrations", () => {
    const db = freshDb();
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });

    const row = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version = 24")
      .get() as { version: number; name: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.version).toBe(24);
    expect(row?.name).toBe("v024-unified-job-scheduler");
  });
});
