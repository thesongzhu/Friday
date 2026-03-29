import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";
import type { FridaySqliteLayer } from "#state";

describe("V061 World Model Readiness Migration", () => {
  let db: FridaySqliteLayer;

  afterEach(() => {
    db?.close();
  });

  it("creates the friday_episodes table with correct schema", () => {
    db = createTestDb();
    const columns = db.withReadConnection((conn) =>
      conn.prepare("PRAGMA table_info(friday_episodes)").all() as Array<{ name: string; type: string; notnull: number }>,
    );

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("run_id");
    expect(colNames).toContain("task_intent");
    expect(colNames).toContain("task_profile");
    expect(colNames).toContain("outcome");
    expect(colNames).toContain("steps_json");
    expect(colNames).toContain("tool_sequence_json");
    expect(colNames).toContain("duration_ms");
    expect(colNames).toContain("context_files_json");
    expect(colNames).toContain("created_at");
  });

  it("creates the friday_world_entities table", () => {
    db = createTestDb();
    const columns = db.withReadConnection((conn) =>
      conn.prepare("PRAGMA table_info(friday_world_entities)").all() as Array<{ name: string }>,
    );

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("type");
    expect(colNames).toContain("name");
    expect(colNames).toContain("attributes_json");
    expect(colNames).toContain("relations_json");
    expect(colNames).toContain("last_mentioned");
    expect(colNames).toContain("mention_count");
  });

  it("creates the friday_world_state_snapshots table", () => {
    db = createTestDb();
    const columns = db.withReadConnection((conn) =>
      conn.prepare("PRAGMA table_info(friday_world_state_snapshots)").all() as Array<{ name: string }>,
    );

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("state_json");
    expect(colNames).toContain("created_at");
  });

  it("creates the friday_learned_patterns table", () => {
    db = createTestDb();
    const columns = db.withReadConnection((conn) =>
      conn.prepare("PRAGMA table_info(friday_learned_patterns)").all() as Array<{ name: string }>,
    );

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("kind");
    expect(colNames).toContain("description");
    expect(colNames).toContain("pattern_json");
    expect(colNames).toContain("confidence");
    expect(colNames).toContain("sample_count");
  });

  it("enforces CHECK constraint on episodes outcome", () => {
    db = createTestDb();

    expect(() => {
      db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `INSERT INTO friday_episodes
               (id, user_id, run_id, task_intent, outcome, steps_json,
                tool_sequence_json, duration_ms, context_files_json, created_at)
             VALUES ('ep-1', 'u1', 'r1', 'test', 'invalid_outcome', '[]', '[]', 0, '[]', datetime('now'))`,
          )
          .run();
      });
    }).toThrow();
  });

  it("enforces CHECK constraint on learned_patterns kind", () => {
    db = createTestDb();

    expect(() => {
      db.withWriteTransaction((conn) => {
        conn
          .prepare(
            `INSERT INTO friday_learned_patterns
               (id, user_id, kind, description, pattern_json, confidence, sample_count)
             VALUES ('lp-1', 'u1', 'invalid_kind', 'test', '{}', 0.5, 1)`,
          )
          .run();
      });
    }).toThrow();
  });

  it("allows valid inserts into all four tables", () => {
    db = createTestDb();

    db.withWriteTransaction((conn) => {
      conn
        .prepare(
          `INSERT INTO friday_episodes
             (id, user_id, run_id, task_intent, outcome, steps_json,
              tool_sequence_json, duration_ms, context_files_json, created_at)
           VALUES ('ep-1', 'u1', 'r1', 'test task', 'success', '[]', '[]', 100, '[]', datetime('now'))`,
        )
        .run();

      conn
        .prepare(
          `INSERT INTO friday_world_entities
             (id, user_id, type, name, attributes_json, relations_json)
           VALUES ('we-1', 'u1', 'project', 'MyApp', '{}', '[]')`,
        )
        .run();

      conn
        .prepare(
          `INSERT INTO friday_world_state_snapshots
             (id, user_id, state_json)
           VALUES ('ws-1', 'u1', '{"userId":"u1"}')`,
        )
        .run();

      conn
        .prepare(
          `INSERT INTO friday_learned_patterns
             (id, user_id, kind, description, pattern_json, confidence, sample_count)
           VALUES ('lp-1', 'u1', 'tool_sequence', 'common pattern', '{}', 0.8, 5)`,
        )
        .run();
    });

    // Verify all inserts
    const epCount = db.withReadConnection((conn) =>
      (conn.prepare("SELECT COUNT(*) as c FROM friday_episodes").get() as { c: number }).c,
    );
    const weCount = db.withReadConnection((conn) =>
      (conn.prepare("SELECT COUNT(*) as c FROM friday_world_entities").get() as { c: number }).c,
    );
    const wsCount = db.withReadConnection((conn) =>
      (conn.prepare("SELECT COUNT(*) as c FROM friday_world_state_snapshots").get() as { c: number }).c,
    );
    const lpCount = db.withReadConnection((conn) =>
      (conn.prepare("SELECT COUNT(*) as c FROM friday_learned_patterns").get() as { c: number }).c,
    );

    expect(epCount).toBe(1);
    expect(weCount).toBe(1);
    expect(wsCount).toBe(1);
    expect(lpCount).toBe(1);
  });
});
