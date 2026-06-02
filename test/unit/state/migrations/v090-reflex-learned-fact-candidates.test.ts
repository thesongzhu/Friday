import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { V075_REFLEX_LOOP_ONBOARDING_MIGRATION } from "../../../../src/state/sqlite/migrations/v075-reflex-loop-onboarding.js";
import { V090_REFLEX_LEARNED_FACT_CANDIDATES_MIGRATION } from "../../../../src/state/sqlite/migrations/v090-reflex-learned-fact-candidates.js";

function makeMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(V075_REFLEX_LOOP_ONBOARDING_MIGRATION.sql);
  return db;
}

describe("v090 reflex learned-fact candidates migration", () => {
  it("preserves legacy candidates and permits dedicated learned_fact suggestions", () => {
    const db = makeMemoryDb();
    try {
      db.prepare(
        `INSERT INTO friday_reflex_candidates (
          id,
          user_id,
          kind,
          status,
          origin,
          title,
          summary,
          payload_json,
          evidence_json,
          confidence,
          risk_tier,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "candidate-memory",
        "user-1",
        "memory",
        "ready_for_review",
        "channel",
        "Remember default branch",
        "Legacy memory candidate",
        "{}",
        "{}",
        0.7,
        1,
        "2026-05-31T00:00:00.000Z",
        "2026-05-31T00:00:00.000Z",
      );

      db.exec(V090_REFLEX_LEARNED_FACT_CANDIDATES_MIGRATION.sql);

      const legacy = db
        .prepare("SELECT id, kind, title FROM friday_reflex_candidates WHERE id = ?")
        .get("candidate-memory") as Record<string, unknown>;
      expect(legacy).toMatchObject({
        id: "candidate-memory",
        kind: "memory",
        title: "Remember default branch",
      });

      db.prepare(
        `INSERT INTO friday_reflex_candidates (
          id,
          user_id,
          kind,
          status,
          origin,
          title,
          summary,
          payload_json,
          evidence_json,
          confidence,
          risk_tier,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "candidate-fact",
        "user-1",
        "learned_fact",
        "ready_for_review",
        "channel",
        "Learn branch policy",
        "Dedicated learned fact candidate",
        JSON.stringify({ key: "workspace.branch_policy", value: "trunk" }),
        "{}",
        0.9,
        1,
        "2026-05-31T00:00:00.000Z",
        "2026-05-31T00:00:00.000Z",
      );

      const learnedFact = db
        .prepare("SELECT kind, payload_json FROM friday_reflex_candidates WHERE id = ?")
        .get("candidate-fact") as Record<string, unknown>;
      expect(learnedFact.kind).toBe("learned_fact");
      expect(JSON.parse(String(learnedFact.payload_json))).toEqual({
        key: "workspace.branch_policy",
        value: "trunk",
      });
    } finally {
      db.close();
    }
  });

  it("migration metadata is well-formed", () => {
    expect(V090_REFLEX_LEARNED_FACT_CANDIDATES_MIGRATION.version).toBe(90);
    expect(V090_REFLEX_LEARNED_FACT_CANDIDATES_MIGRATION.name)
      .toBe("v090-reflex-learned-fact-candidates");
    expect(V090_REFLEX_LEARNED_FACT_CANDIDATES_MIGRATION.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(V090_REFLEX_LEARNED_FACT_CANDIDATES_MIGRATION.sql).toMatch(/learned_fact/);
  });
});
