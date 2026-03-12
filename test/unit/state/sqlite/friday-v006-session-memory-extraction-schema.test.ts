import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("V006 session_memory_extraction_jobs schema", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("creates the session_memory_extraction_jobs table", () => {
    const tables = db.withReadConnection((d) =>
      d.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_memory_extraction_jobs'",
      ).all(),
    ) as Array<{ name: string }>;

    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("session_memory_extraction_jobs");
  });

  it("table has all required columns", () => {
    const cols = db.withReadConnection((d) =>
      d.prepare("PRAGMA table_info(session_memory_extraction_jobs)").all(),
    ) as Array<{ name: string; type: string; notnull: number }>;

    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("session_key");
    expect(colNames).toContain("trigger");
    expect(colNames).toContain("status");
    expect(colNames).toContain("requested_message_ids_json");
    expect(colNames).toContain("batch_size");
    expect(colNames).toContain("max_batches");
    expect(colNames).toContain("attempts");
    expect(colNames).toContain("max_attempts");
    expect(colNames).toContain("next_attempt_at");
    expect(colNames).toContain("started_at");
    expect(colNames).toContain("completed_at");
    expect(colNames).toContain("failed_at");
    expect(colNames).toContain("last_error_code");
    expect(colNames).toContain("last_error_message");
    expect(colNames).toContain("result_json");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
  });

  it("enforces trigger CHECK constraint", () => {
    expect(() =>
      db.withWriteTransaction((d) =>
        d.prepare(
          `INSERT INTO session_memory_extraction_jobs
           (id, session_key, trigger, status, batch_size, max_batches, max_attempts, created_at, updated_at)
           VALUES ('j1', 'sk1', 'invalid', 'queued', 24, 8, 3, '2026-01-01', '2026-01-01')`,
        ).run(),
      ),
    ).toThrow();
  });

  it("enforces status CHECK constraint", () => {
    expect(() =>
      db.withWriteTransaction((d) =>
        d.prepare(
          `INSERT INTO session_memory_extraction_jobs
           (id, session_key, trigger, status, batch_size, max_batches, max_attempts, created_at, updated_at)
           VALUES ('j1', 'sk1', 'auto', 'invalid', 24, 8, 3, '2026-01-01', '2026-01-01')`,
        ).run(),
      ),
    ).toThrow();
  });

  it("enforces unique auto-open constraint (one open auto per session)", () => {
    db.withWriteTransaction((d) => {
      d.prepare(
        `INSERT INTO session_memory_extraction_jobs
         (id, session_key, trigger, status, batch_size, max_batches, max_attempts, created_at, updated_at)
         VALUES ('j1', 'sk1', 'auto', 'queued', 24, 8, 3, '2026-01-01', '2026-01-01')`,
      ).run();
    });

    expect(() =>
      db.withWriteTransaction((d) =>
        d.prepare(
          `INSERT INTO session_memory_extraction_jobs
           (id, session_key, trigger, status, batch_size, max_batches, max_attempts, created_at, updated_at)
           VALUES ('j2', 'sk1', 'auto', 'queued', 24, 8, 3, '2026-01-01', '2026-01-01')`,
        ).run(),
      ),
    ).toThrow(/UNIQUE constraint/);
  });

  it("allows multiple manual jobs for same session", () => {
    db.withWriteTransaction((d) => {
      d.prepare(
        `INSERT INTO session_memory_extraction_jobs
         (id, session_key, trigger, status, batch_size, max_batches, max_attempts, created_at, updated_at)
         VALUES ('j1', 'sk1', 'manual', 'queued', 24, 8, 3, '2026-01-01', '2026-01-01')`,
      ).run();
      d.prepare(
        `INSERT INTO session_memory_extraction_jobs
         (id, session_key, trigger, status, batch_size, max_batches, max_attempts, created_at, updated_at)
         VALUES ('j2', 'sk1', 'manual', 'queued', 24, 8, 3, '2026-01-01', '2026-01-01')`,
      ).run();
    });

    const count = db.withReadConnection((d) =>
      d.prepare("SELECT COUNT(*) AS cnt FROM session_memory_extraction_jobs WHERE session_key = 'sk1'").get(),
    ) as { cnt: number };

    expect(count.cnt).toBe(2);
  });

  it("allows a new auto job after prior auto is completed", () => {
    db.withWriteTransaction((d) => {
      d.prepare(
        `INSERT INTO session_memory_extraction_jobs
         (id, session_key, trigger, status, batch_size, max_batches, max_attempts, created_at, updated_at)
         VALUES ('j1', 'sk1', 'auto', 'completed', 24, 8, 3, '2026-01-01', '2026-01-01')`,
      ).run();
      d.prepare(
        `INSERT INTO session_memory_extraction_jobs
         (id, session_key, trigger, status, batch_size, max_batches, max_attempts, created_at, updated_at)
         VALUES ('j2', 'sk1', 'auto', 'queued', 24, 8, 3, '2026-01-01', '2026-01-01')`,
      ).run();
    });

    const count = db.withReadConnection((d) =>
      d.prepare("SELECT COUNT(*) AS cnt FROM session_memory_extraction_jobs WHERE session_key = 'sk1'").get(),
    ) as { cnt: number };

    expect(count.cnt).toBe(2);
  });

  it("creates expected indexes", () => {
    const indexes = db.withReadConnection((d) =>
      d.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_memory_extraction_jobs'",
      ).all(),
    ) as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_session_mem_extract_jobs_status_next");
    expect(indexNames).toContain("idx_session_mem_extract_jobs_session_created");
    expect(indexNames).toContain("idx_session_mem_extract_jobs_auto_open");
  });
});
