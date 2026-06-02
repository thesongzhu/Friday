import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { V001_INITIAL_MIGRATION } from "../../../../src/state/sqlite/migrations/v001-initial.js";
import { V091_PREFERENCE_FACT_METADATA_MIGRATION } from "../../../../src/state/sqlite/migrations/v091-preference-fact-metadata.js";

describe("v091 preference fact metadata migration", () => {
  it("adds nullable metadata_json to existing preference facts", () => {
    const db = new Database(":memory:");
    try {
      db.exec(V001_INITIAL_MIGRATION.sql);
      db.prepare(
        `INSERT INTO users (id, display_name, role, is_local_only, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "user-1",
        "Test User",
        "admin",
        1,
        "2026-06-01T00:00:00.000Z",
        "2026-06-01T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO preference_facts (
          fact_id,
          user_id,
          key,
          value_json,
          confidence,
          evidence_count,
          last_confirmed_at,
          source_event_ids_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "fact-1",
        "user-1",
        "learned.preferred_editor",
        JSON.stringify("Helix"),
        0.84,
        1,
        "2026-06-01T00:00:00.000Z",
        JSON.stringify(["event-1"]),
        "2026-06-01T00:00:00.000Z",
        "2026-06-01T00:00:00.000Z",
      );

      db.exec(V091_PREFERENCE_FACT_METADATA_MIGRATION.sql);

      const columns = db.prepare("PRAGMA table_info(preference_facts)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("metadata_json");
      const row = db
        .prepare("SELECT key, metadata_json FROM preference_facts WHERE fact_id = ?")
        .get("fact-1") as { key: string; metadata_json: string | null };
      expect(row).toEqual({
        key: "learned.preferred_editor",
        metadata_json: null,
      });
    } finally {
      db.close();
    }
  });

  it("migration metadata is well-formed", () => {
    expect(V091_PREFERENCE_FACT_METADATA_MIGRATION.version).toBe(91);
    expect(V091_PREFERENCE_FACT_METADATA_MIGRATION.name).toBe("v091-preference-fact-metadata");
    expect(V091_PREFERENCE_FACT_METADATA_MIGRATION.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(V091_PREFERENCE_FACT_METADATA_MIGRATION.sql).toMatch(/metadata_json/);
  });
});
