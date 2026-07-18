import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import { FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB } from "#jobs";
import { V108_RETENTION_RECEIPT_CREATED_AT_CHECK_SQL } from "../../../../src/state/sqlite/migrations/v108-retention-receipt-created-at-check.js";

/**
 * RETENTION-R3d ROUND-10 — v108 storage-boundary guard for the receipt `created_at`.
 *
 * The migration recreates `retention_recovery_receipts` with a CHECK approximating a
 * canonical ISO-8601 UTC instant via a GLOB. Because a migration is a FROZEN
 * artifact it INLINES the GLOB literal; this guard ties the inlined literal to the
 * exported `FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB` the runtime (repository decode
 * + reaper quarantine) consumes, so the storage bound and the runtime bound can
 * never silently diverge — and proves the CHECK is LIVE on a migrated database.
 */
describe("v108 — retention receipt created_at storage CHECK", () => {
  const dbs: Database.Database[] = [];
  function freshMigratedDb(): Database.Database {
    const db = new Database(":memory:");
    dbs.push(db);
    runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
    return db;
  }
  afterEach(() => {
    for (const db of dbs) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    dbs.length = 0;
  });

  it("is registered in the chain at version 108", () => {
    const v108 = FRIDAY_SQLITE_MIGRATIONS.find((m) => m.version === 108);
    expect(v108).toBeDefined();
    expect(v108!.name).toBe("v108-retention-receipt-created-at-check");
    // 108 is the maximum (latest forward-only) version.
    expect(Math.max(...FRIDAY_SQLITE_MIGRATIONS.map((m) => m.version))).toBe(108);
  });

  it("the migration INLINES exactly the exported GLOB constant (storage bound == runtime bound)", () => {
    expect(V108_RETENTION_RECEIPT_CREATED_AT_CHECK_SQL).toContain(
      FRIDAY_RETENTION_RECEIPT_CREATED_AT_GLOB,
    );
  });

  function insertReceipt(db: Database.Database, createdAt: string): void {
    const fullPolicy = JSON.stringify({
      learningEvents: { mode: "permanent" },
      heartbeats: { mode: "permanent" },
      skillRunTerminal: { mode: "permanent" },
      auditLogs: { mode: "permanent" },
      agentRuns: { mode: "permanent" },
      llmUsageRecords: { mode: "permanent" },
      errorIncidents: { mode: "permanent" },
    });
    db.prepare(
      `INSERT INTO retention_recovery_receipts
         (receipt_id, principal_id, tenant_id, correlation_id, audit_id,
          recovery_key_hash, payload_digest, before_json, after_json,
          changed_categories_json, applied_updates_json, created_at)
       VALUES (?, 'admin-001', NULL, ?, 'aud-1', NULL, NULL, ?, ?, '[]', '{}', ?)`,
    ).run(
      `retention-receipt:admin-001:${createdAt}`,
      "retention-policy-update:admin-001:op-1",
      fullPolicy,
      fullPolicy,
      createdAt,
    );
  }

  it("ACCEPTS a canonical created_at at the storage boundary", () => {
    const db = freshMigratedDb();
    expect(() => insertReceipt(db, "2026-07-16T10:00:00.000Z")).not.toThrow();
  });

  it.each([
    ["zzzz garbage", "zzzz"],
    ["empty string", ""],
    ["non-Z offset", "2026-07-16T10:00:00.000+00:00"],
    ["impossible components 9999-99-99", "9999-99-99T99:99:99.999Z"],
    ["missing millis", "2026-07-16T10:00:00Z"],
  ])("REJECTS a non-canonical created_at [%s] with a CHECK violation", (_label, value) => {
    const db = freshMigratedDb();
    expect(() => insertReceipt(db, value)).toThrow(/CHECK/i);
  });

  it("the CHECK is enforced on UPDATE too (blocks a direct-DB tamper)", () => {
    const db = freshMigratedDb();
    insertReceipt(db, "2026-07-16T10:00:00.000Z");
    expect(() =>
      db.prepare("UPDATE retention_recovery_receipts SET created_at = 'zzzz'").run(),
    ).toThrow(/CHECK/i);
  });
});
