import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { V075_REFLEX_LOOP_ONBOARDING_MIGRATION } from "../../../../src/state/sqlite/migrations/v075-reflex-loop-onboarding.js";
import { V090_REFLEX_LEARNED_FACT_CANDIDATES_MIGRATION } from "../../../../src/state/sqlite/migrations/v090-reflex-learned-fact-candidates.js";
import { V092_REFLEX_SECURE_FACT_CANDIDATES_MIGRATION } from "../../../../src/state/sqlite/migrations/v092-reflex-secure-fact-candidates.js";

function makeMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(V075_REFLEX_LOOP_ONBOARDING_MIGRATION.sql);
  db.exec(V090_REFLEX_LEARNED_FACT_CANDIDATES_MIGRATION.sql);
  return db;
}

describe("v092 reflex secure-fact candidates migration", () => {
  it("preserves existing candidates and permits encrypted secure_fact suggestions", () => {
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

      db.exec(V092_REFLEX_SECURE_FACT_CANDIDATES_MIGRATION.sql);

      const legacy = db
        .prepare("SELECT id, kind, title FROM friday_reflex_candidates WHERE id = ?")
        .get("candidate-fact") as Record<string, unknown>;
      expect(legacy).toMatchObject({
        id: "candidate-fact",
        kind: "learned_fact",
        title: "Learn branch policy",
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
        "candidate-secure",
        "user-1",
        "secure_fact",
        "ready_for_review",
        "channel",
        "Review encrypted fact",
        "Sensitive value is staged in encrypted secret storage",
        JSON.stringify({
          key: "secure.medical_diagnosis",
          valueRedacted: true,
          secretId: "secret-1", // pragma: allowlist secret
          secretScope: "learned_fact", // pragma: allowlist secret
          secretRefKey: "user-1:candidate-secure", // pragma: allowlist secret
        }),
        JSON.stringify({ valueRedacted: true }),
        0.84,
        3,
        "2026-05-31T00:00:00.000Z",
        "2026-05-31T00:00:00.000Z",
      );

      const secureFact = db
        .prepare("SELECT kind, payload_json FROM friday_reflex_candidates WHERE id = ?")
        .get("candidate-secure") as Record<string, unknown>;
      expect(secureFact.kind).toBe("secure_fact");
      expect(JSON.parse(String(secureFact.payload_json))).toMatchObject({
        key: "secure.medical_diagnosis",
        valueRedacted: true,
        secretId: "secret-1", // pragma: allowlist secret
      });
    } finally {
      db.close();
    }
  });

  it("migration metadata is well-formed", () => {
    expect(V092_REFLEX_SECURE_FACT_CANDIDATES_MIGRATION.version).toBe(92);
    expect(V092_REFLEX_SECURE_FACT_CANDIDATES_MIGRATION.name)
      .toBe("v092-reflex-secure-fact-candidates");
    expect(V092_REFLEX_SECURE_FACT_CANDIDATES_MIGRATION.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(V092_REFLEX_SECURE_FACT_CANDIDATES_MIGRATION.sql).toMatch(/secure_fact/);
  });
});
