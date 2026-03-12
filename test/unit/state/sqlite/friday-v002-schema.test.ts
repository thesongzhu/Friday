import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

describe("V002 Phase 8 API Foundation Schema", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function getTableNames(): string[] {
    const rows = db.writer
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  function getIndexNames(): string[] {
    const rows = db.writer
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  it("creates realtime_events table", () => {
    const tables = getTableNames();
    expect(tables).toContain("realtime_events");
  });

  it("creates realtime_checkpoints table", () => {
    const tables = getTableNames();
    expect(tables).toContain("realtime_checkpoints");
  });

  it("creates api_rate_limit_counters table", () => {
    const tables = getTableNames();
    expect(tables).toContain("api_rate_limit_counters");
  });

  it("creates workflow_conflicts table", () => {
    const tables = getTableNames();
    expect(tables).toContain("workflow_conflicts");
  });

  it("creates correct indexes for realtime_events", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_realtime_events_stream_seq");
    expect(indexes).toContain("idx_realtime_events_emitted");
  });

  it("creates correct indexes for rate limit counters", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_rate_limit_window");
  });

  it("creates correct indexes for workflow_conflicts", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_workflow_conflicts_workflow");
    expect(indexes).toContain("idx_workflow_conflicts_draft");
  });

  it("enforces unique stream_id + seq in realtime_events", () => {
    db.writer
      .prepare(
        "INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("e1", "stream:1", 1, "test", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    expect(() =>
      db.writer
        .prepare(
          "INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("e2", "stream:1", 1, "test", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"),
    ).toThrow();
  });

  it("enforces composite PK on realtime_checkpoints", () => {
    db.writer
      .prepare(
        "INSERT INTO realtime_checkpoints (principal_id, stream_id, last_acked_seq, epoch, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("p1", "stream:1", 5, 1, "2025-01-01T00:00:00Z");

    expect(() =>
      db.writer
        .prepare(
          "INSERT INTO realtime_checkpoints (principal_id, stream_id, last_acked_seq, epoch, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("p1", "stream:1", 10, 1, "2025-01-01T00:00:00Z"),
    ).toThrow();
  });

  it("enforces composite PK on api_rate_limit_counters", () => {
    db.writer
      .prepare(
        "INSERT INTO api_rate_limit_counters (bucket_key, window_start, hit_count, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("key1", "2025-01-01T00:00:00Z", 1, "2025-01-01T00:00:00Z");

    expect(() =>
      db.writer
        .prepare(
          "INSERT INTO api_rate_limit_counters (bucket_key, window_start, hit_count, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("key1", "2025-01-01T00:00:00Z", 2, "2025-01-01T00:00:00Z"),
    ).toThrow();
  });

  it("records v002 migration in schema_migrations", () => {
    const row = db.writer
      .prepare("SELECT * FROM schema_migrations WHERE version = 2")
      .get() as { version: number; name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("v002-phase8-api-foundation");
  });
});
