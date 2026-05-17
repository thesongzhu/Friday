import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { V086_WORKFLOW_EVIDENCE_FAIL_CLOSED_MIGRATION } from "../../../../src/state/sqlite/migrations/v086-workflow-evidence-fail-closed.js";
import { V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_MIGRATION } from "../../../../src/state/sqlite/migrations/v087-rollback-matrix-closeout-receipt.js";

function makeMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // Minimum prerequisite tables the v086 + v087 ALTER TABLEs touch. The
  // workflow_runs table is the v086 target; task_workflow_closeout_receipts
  // is the v086 + v087 target.
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE task_workflow_closeout_receipts (
      id TEXT PRIMARY KEY NOT NULL,
      workflow_id TEXT NOT NULL,
      spec_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      claim_summary_json TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      gate_outcomes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("v087 rollback matrix closeout receipt migration", () => {
  it("adds rollback_class, compensating_action, non_reversible_reason columns as nullable text", () => {
    const db = makeMemoryDb();
    try {
      db.exec(V086_WORKFLOW_EVIDENCE_FAIL_CLOSED_MIGRATION.sql);
      db.exec(V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_MIGRATION.sql);
      const columns = db
        .prepare(`PRAGMA table_info(task_workflow_closeout_receipts)`)
        .all() as Array<{ name: string; type: string; notnull: number }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain("rollback_class");
      expect(names).toContain("compensating_action");
      expect(names).toContain("non_reversible_reason");
      for (const colName of [
        "rollback_class",
        "compensating_action",
        "non_reversible_reason",
      ]) {
        const col = columns.find((c) => c.name === colName);
        expect(col).toBeDefined();
        expect(col?.type.toUpperCase()).toBe("TEXT");
        expect(col?.notnull).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("preserves legacy closeout rows (additive migration; existing rows continue to work)", () => {
    const db = makeMemoryDb();
    try {
      db.exec(V086_WORKFLOW_EVIDENCE_FAIL_CLOSED_MIGRATION.sql);
      // Insert a legacy row before v087 lands.
      db.prepare(
        `INSERT INTO task_workflow_closeout_receipts (
           id, workflow_id, spec_hash, status,
           claim_summary_json, blockers_json, gate_outcomes_json, created_at
         ) VALUES (
           @id, @workflowId, @specHash, @status,
           @claimSummaryJson, @blockersJson, @gateOutcomesJson, @createdAt
         )`,
      ).run({
        id: "legacy-1",
        workflowId: "wf-legacy",
        specHash: "x".repeat(64),
        status: "complete",
        claimSummaryJson: "{}",
        blockersJson: "[]",
        gateOutcomesJson: "[]",
        createdAt: "2026-05-17T00:00:00.000Z",
      });
      // Apply v087 — the legacy row must survive.
      db.exec(V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_MIGRATION.sql);
      const row = db
        .prepare(
          `SELECT id, rollback_class, compensating_action, non_reversible_reason
           FROM task_workflow_closeout_receipts WHERE id = ?`,
        )
        .get("legacy-1") as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.id).toBe("legacy-1");
      expect(row.rollback_class).toBeNull();
      expect(row.compensating_action).toBeNull();
      expect(row.non_reversible_reason).toBeNull();
    } finally {
      db.close();
    }
  });

  it("accepts post-migration writes with rollback fields populated", () => {
    const db = makeMemoryDb();
    try {
      db.exec(V086_WORKFLOW_EVIDENCE_FAIL_CLOSED_MIGRATION.sql);
      db.exec(V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_MIGRATION.sql);
      db.prepare(
        `INSERT INTO task_workflow_closeout_receipts (
           id, workflow_id, spec_hash, status,
           claim_summary_json, blockers_json, gate_outcomes_json, created_at,
           rollback_class, compensating_action, non_reversible_reason
         ) VALUES (
           @id, @workflowId, @specHash, @status,
           @claimSummaryJson, @blockersJson, @gateOutcomesJson, @createdAt,
           @rollbackClass, @compensatingAction, @nonReversibleReason
         )`,
      ).run({
        id: "new-1",
        workflowId: "wf-new",
        specHash: "y".repeat(64),
        status: "complete",
        claimSummaryJson: "{}",
        blockersJson: "[]",
        gateOutcomesJson: "[]",
        createdAt: "2026-05-17T00:01:00.000Z",
        rollbackClass: "non_reversible_external",
        compensatingAction: null,
        nonReversibleReason: "channel_event sent to discord",
      });
      const row = db
        .prepare(
          `SELECT rollback_class, compensating_action, non_reversible_reason
           FROM task_workflow_closeout_receipts WHERE id = ?`,
        )
        .get("new-1") as Record<string, unknown>;
      expect(row.rollback_class).toBe("non_reversible_external");
      expect(row.compensating_action).toBeNull();
      expect(row.non_reversible_reason).toBe("channel_event sent to discord");
    } finally {
      db.close();
    }
  });

  it("v087 migration metadata is well-formed", () => {
    expect(V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_MIGRATION.version).toBe(87);
    expect(V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_MIGRATION.name).toBe(
      "v087-rollback-matrix-closeout-receipt",
    );
    expect(V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_MIGRATION.checksum).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(V087_ROLLBACK_MATRIX_CLOSEOUT_RECEIPT_MIGRATION.sql).toMatch(
      /ADD COLUMN rollback_class/,
    );
  });
});
