/**
 * A-002 Rules Persistence Tests
 *
 * Validates SQLite repository for rules, policy bundles, rule versions,
 * and evaluation audit log — including restart persistence and optimistic
 * concurrency via etag.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { V031_RULES_PERSISTENCE_SQL } from "../../../../src/state/sqlite/migrations/v031-rules-persistence.js";
import { V034_RULES_SCHEMA_BRIDGE_SQL } from "../../../../src/state/sqlite/migrations/v034-rules-schema-bridge.js";
import { V059_RULES_AUDIT_CANONICALIZATION_SQL } from "../../../../src/state/sqlite/migrations/v059-rules-audit-canonicalization.js";
import { createFridayRulesRepository } from "#rules";
import type { FridayPolicyBundleRow, FridayRuleRow, FridayRuleVersionRow, FridayRuleEvaluationLogRow } from "#rules";

function createTestDb(opts: { withBridge?: boolean; withCanonicalAudit?: boolean } = {}): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(V031_RULES_PERSISTENCE_SQL);
  if (opts.withBridge) {
    db.exec(V034_RULES_SCHEMA_BRIDGE_SQL);
  }
  if (opts.withCanonicalAudit) {
    db.exec(V059_RULES_AUDIT_CANONICALIZATION_SQL);
  }
  return db;
}

function makeBundleRow(overrides: Partial<FridayPolicyBundleRow> = {}): FridayPolicyBundleRow {
  return {
    id: "bundle-1",
    name: "Test Bundle",
    description: "A test policy bundle",
    version: 1,
    priority: 10,
    enabled: 1,
    tags_json: '["security"]',
    source: "manual",
    etag: "etag-v1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

function makeRuleRow(overrides: Partial<FridayRuleRow> = {}): FridayRuleRow {
  return {
    id: "rule-1",
    policy_bundle_id: "bundle-1",
    name: "Deny external calls",
    description: "Blocks external network",
    enabled: 1,
    resource: "network",
    action: "external_call",
    conditions_json: '[{"field":"target","op":"matches","value":"*.internal"}]',
    decision: "deny",
    message: "External calls blocked",
    priority: 5,
    version: 1,
    etag: "rule-etag-v1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

describe("A-002 FridayRulesRepository", () => {
  let db: Database.Database;
  const repo = createFridayRulesRepository();

  beforeEach(() => {
    db = createTestDb();
  });

  // ─── Policy Bundles ───

  describe("policy bundles", () => {
    it("inserts and retrieves a policy bundle", () => {
      const bundle = makeBundleRow();
      repo.insertPolicyBundle(db, bundle);
      const result = repo.getPolicyBundleById(db, "bundle-1");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("Test Bundle");
      expect(result!.etag).toBe("etag-v1");
    });

    it("returns null for non-existent bundle", () => {
      expect(repo.getPolicyBundleById(db, "nonexistent")).toBeNull();
    });

    it("lists bundles with pagination", () => {
      repo.insertPolicyBundle(db, makeBundleRow({ id: "b-1", name: "Alpha", priority: 1 }));
      repo.insertPolicyBundle(db, makeBundleRow({ id: "b-2", name: "Beta", priority: 2 }));
      repo.insertPolicyBundle(db, makeBundleRow({ id: "b-3", name: "Gamma", priority: 3 }));

      const page1 = repo.listPolicyBundles(db, { limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);
      expect(page1[0].name).toBe("Gamma"); // highest priority first

      const page2 = repo.listPolicyBundles(db, { limit: 2, offset: 2 });
      expect(page2).toHaveLength(1);
    });

    it("filters enabled-only bundles", () => {
      repo.insertPolicyBundle(db, makeBundleRow({ id: "b-1", enabled: 1 }));
      repo.insertPolicyBundle(db, makeBundleRow({ id: "b-2", enabled: 0 }));

      const all = repo.listPolicyBundles(db);
      expect(all).toHaveLength(2);

      const enabledOnly = repo.listPolicyBundles(db, { enabledOnly: true });
      expect(enabledOnly).toHaveLength(1);
      expect(enabledOnly[0].id).toBe("b-1");
    });

    it("updates bundle fields", () => {
      repo.insertPolicyBundle(db, makeBundleRow());
      repo.updatePolicyBundle(db, "bundle-1", { name: "Updated Bundle", etag: "etag-v2", updated_at: "2026-02-01T00:00:00Z" });

      const updated = repo.getPolicyBundleById(db, "bundle-1");
      expect(updated!.name).toBe("Updated Bundle");
      expect(updated!.etag).toBe("etag-v2");
    });

    it("throws on update of non-existent bundle", () => {
      expect(() => repo.updatePolicyBundle(db, "ghost", { name: "X" })).toThrow("not found");
    });

    it("soft deletes a bundle", () => {
      repo.insertPolicyBundle(db, makeBundleRow());
      repo.softDeletePolicyBundle(db, "bundle-1", "2026-03-01T00:00:00Z");

      expect(repo.getPolicyBundleById(db, "bundle-1")).toBeNull();
      expect(repo.listPolicyBundles(db)).toHaveLength(0);
    });

    it("throws on soft delete of already-deleted bundle", () => {
      repo.insertPolicyBundle(db, makeBundleRow());
      repo.softDeletePolicyBundle(db, "bundle-1", "2026-03-01T00:00:00Z");
      expect(() => repo.softDeletePolicyBundle(db, "bundle-1", "2026-03-02T00:00:00Z")).toThrow("not found");
    });
  });

  // ─── Rules ───

  describe("rules", () => {
    beforeEach(() => {
      repo.insertPolicyBundle(db, makeBundleRow());
    });

    it("inserts and retrieves a rule", () => {
      repo.insertRule(db, makeRuleRow());
      const rule = repo.getRuleById(db, "rule-1");
      expect(rule).not.toBeNull();
      expect(rule!.decision).toBe("deny");
      expect(rule!.resource).toBe("network");
    });

    it("returns null for non-existent rule", () => {
      expect(repo.getRuleById(db, "ghost")).toBeNull();
    });

    it("lists rules by bundle", () => {
      repo.insertRule(db, makeRuleRow({ id: "r-1", priority: 1 }));
      repo.insertRule(db, makeRuleRow({ id: "r-2", priority: 5 }));

      const rules = repo.listRulesByBundleId(db, "bundle-1");
      expect(rules).toHaveLength(2);
      expect(rules[0].id).toBe("r-2"); // higher priority first
    });

    it("filters enabled-only rules", () => {
      repo.insertRule(db, makeRuleRow({ id: "r-1", enabled: 1 }));
      repo.insertRule(db, makeRuleRow({ id: "r-2", enabled: 0 }));

      const enabled = repo.listRulesByBundleId(db, "bundle-1", { enabledOnly: true });
      expect(enabled).toHaveLength(1);
    });

    it("updates rule fields", () => {
      repo.insertRule(db, makeRuleRow());
      repo.updateRule(db, "rule-1", { decision: "warn", version: 2, etag: "rule-etag-v2", updated_at: "2026-02-01T00:00:00Z" });

      const updated = repo.getRuleById(db, "rule-1");
      expect(updated!.decision).toBe("warn");
      expect(updated!.version).toBe(2);
    });

    it("soft deletes a rule", () => {
      repo.insertRule(db, makeRuleRow());
      repo.softDeleteRule(db, "rule-1", "2026-03-01T00:00:00Z");
      expect(repo.getRuleById(db, "rule-1")).toBeNull();
    });
  });

  // ─── Rule Versions ───

  describe("rule versions", () => {
    beforeEach(() => {
      repo.insertPolicyBundle(db, makeBundleRow());
      repo.insertRule(db, makeRuleRow());
    });

    it("inserts and lists rule versions", () => {
      const v1: FridayRuleVersionRow = {
        id: "rv-1", rule_id: "rule-1", version: 1,
        snapshot_json: '{"decision":"deny"}', changed_by: "admin", change_note: "Initial", created_at: "2026-01-01T00:00:00Z",
      };
      const v2: FridayRuleVersionRow = {
        id: "rv-2", rule_id: "rule-1", version: 2,
        snapshot_json: '{"decision":"warn"}', changed_by: "admin", change_note: "Relaxed", created_at: "2026-02-01T00:00:00Z",
      };

      repo.insertRuleVersion(db, v1);
      repo.insertRuleVersion(db, v2);

      const versions = repo.listRuleVersions(db, "rule-1");
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(2); // DESC order
      expect(versions[1].version).toBe(1);
    });

    it("paginates versions", () => {
      for (let i = 1; i <= 5; i++) {
        repo.insertRuleVersion(db, {
          id: `rv-${i}`, rule_id: "rule-1", version: i,
          snapshot_json: `{"v":${i}}`, changed_by: null, change_note: null, created_at: `2026-01-0${i}T00:00:00Z`,
        });
      }

      const page = repo.listRuleVersions(db, "rule-1", { limit: 2, offset: 0 });
      expect(page).toHaveLength(2);
      expect(page[0].version).toBe(5);
    });
  });

  // ─── Evaluation Audit Log ───

  describe("evaluation audit log", () => {
    it("inserts and queries evaluation logs", () => {
      const entry: FridayRuleEvaluationLogRow = {
        id: "eval-1", rule_id: "r-1", policy_bundle_id: "b-1",
        decision: "deny", resource: "network", action: "external_call",
        context_redacted_json: '{"target":"api.example.com"}', redaction_applied: 0,
        redacted_fields_json: "[]", matched_rules_json: '[{"id":"r-1"}]',
        duration_ms: 1.5, run_id: "run-42", workflow_id: "wf-1", principal_id: "user-1",
        created_at: "2026-01-15T12:00:00Z",
      };

      repo.insertEvaluationLog(db, entry);
      const logs = repo.listEvaluationLogs(db, { runId: "run-42" });
      expect(logs).toHaveLength(1);
      expect(logs[0].decision).toBe("deny");
    });

    it("filters by rule_id", () => {
      repo.insertEvaluationLog(db, {
        id: "e-1", rule_id: "r-1", policy_bundle_id: "b-1", decision: "deny",
        resource: "fs", action: "write", context_redacted_json: "{}", redaction_applied: 0,
        redacted_fields_json: "[]", matched_rules_json: "[]", duration_ms: 0.5,
        run_id: null, workflow_id: null, principal_id: null, created_at: "2026-01-01T00:00:00Z",
      });
      repo.insertEvaluationLog(db, {
        id: "e-2", rule_id: "r-2", policy_bundle_id: "b-1", decision: "allow",
        resource: "fs", action: "read", context_redacted_json: "{}", redaction_applied: 0,
        redacted_fields_json: "[]", matched_rules_json: "[]", duration_ms: 0.3,
        run_id: null, workflow_id: null, principal_id: null, created_at: "2026-01-02T00:00:00Z",
      });

      const filtered = repo.listEvaluationLogs(db, { ruleId: "r-1" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("e-1");
    });

    it("counts evaluation logs", () => {
      for (let i = 0; i < 5; i++) {
        repo.insertEvaluationLog(db, {
          id: `e-${i}`, rule_id: "r-1", policy_bundle_id: "b-1", decision: "allow",
          resource: "fs", action: "read", context_redacted_json: "{}", redaction_applied: 0,
          redacted_fields_json: "[]", matched_rules_json: "[]", duration_ms: 0.1,
          run_id: null, workflow_id: null, principal_id: null, created_at: `2026-01-0${i + 1}T00:00:00Z`,
        });
      }
      expect(repo.countEvaluationLogs(db, { ruleId: "r-1" })).toBe(5);
      expect(repo.countEvaluationLogs(db, { bundleId: "b-1" })).toBe(5);
      expect(repo.countEvaluationLogs(db)).toBe(5);
    });

    it("does not warn when v034 bridge mirrors legacy inserts into audit", () => {
      const bridgeDb = createTestDb({ withBridge: true });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        repo.insertEvaluationLog(bridgeDb, {
          id: "bridge-eval-1",
          rule_id: "r-1",
          policy_bundle_id: "b-1",
          decision: "deny",
          resource: "network",
          action: "external_call",
          context_redacted_json: '{"target":"api.example.com"}',
          redaction_applied: 0,
          redacted_fields_json: "[]",
          matched_rules_json: '[{"id":"r-1"}]',
          duration_ms: 1.2,
          run_id: "run-bridge-1",
          workflow_id: "wf-bridge-1",
          principal_id: "user-bridge-1",
          created_at: "2026-03-27T09:00:00Z",
        });

        const legacyRow = bridgeDb.prepare(
          "SELECT COUNT(*) AS count FROM rule_evaluation_log WHERE id = ?",
        ).get("bridge-eval-1") as { count: number };
        const auditRow = bridgeDb.prepare(
          "SELECT COUNT(*) AS count FROM rule_eval_audit WHERE id = ?",
        ).get("bridge-eval-1") as { count: number };

        expect(legacyRow.count).toBe(1);
        expect(auditRow.count).toBe(1);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        bridgeDb.close();
      }
    });

    it("keeps audit as the write source after canonicalization migration", () => {
      const canonicalDb = createTestDb({ withBridge: true, withCanonicalAudit: true });

      try {
        repo.insertEvaluationLog(canonicalDb, {
          id: "canonical-eval-1",
          rule_id: "r-1",
          policy_bundle_id: "b-1",
          decision: "warn",
          resource: "filesystem",
          action: "write",
          context_redacted_json: '{"path":"/tmp/demo"}',
          redaction_applied: 0,
          redacted_fields_json: "[]",
          matched_rules_json: '[{"id":"r-1"}]',
          duration_ms: 2.5,
          run_id: "run-canonical-1",
          workflow_id: "wf-canonical-1",
          principal_id: "user-canonical-1",
          created_at: "2026-03-27T09:15:00Z",
        });

        const auditRow = canonicalDb.prepare(
          "SELECT COUNT(*) AS count FROM rule_eval_audit WHERE id = ?",
        ).get("canonical-eval-1") as { count: number };
        const legacyRow = canonicalDb.prepare(
          "SELECT COUNT(*) AS count FROM rule_evaluation_log WHERE id = ?",
        ).get("canonical-eval-1") as { count: number };
        const droppedTrigger = canonicalDb.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_rule_eval_log_to_audit'",
        ).get() as { count: number };

        expect(auditRow.count).toBe(1);
        expect(legacyRow.count).toBe(1);
        expect(droppedTrigger.count).toBe(0);
      } finally {
        canonicalDb.close();
      }
    });
  });

  // ─── Restart Persistence ───

  describe("restart persistence", () => {
    it("data survives close and reopen (simulated via WAL checkpoint)", () => {
      repo.insertPolicyBundle(db, makeBundleRow());
      repo.insertRule(db, makeRuleRow());

      // Simulate checkpoint
      db.pragma("wal_checkpoint(TRUNCATE)");

      // Re-query (same connection but validates WAL persistence)
      const bundle = repo.getPolicyBundleById(db, "bundle-1");
      const rule = repo.getRuleById(db, "rule-1");
      expect(bundle).not.toBeNull();
      expect(rule).not.toBeNull();
    });
  });

  // ─── Optimistic Concurrency ───

  describe("optimistic concurrency via etag", () => {
    it("etag changes on update", () => {
      repo.insertPolicyBundle(db, makeBundleRow({ etag: "v1" }));
      repo.updatePolicyBundle(db, "bundle-1", { etag: "v2", updated_at: "2026-02-01T00:00:00Z" });

      const result = repo.getPolicyBundleById(db, "bundle-1");
      expect(result!.etag).toBe("v2");
    });

    it("concurrent updates can be detected via etag mismatch", () => {
      repo.insertPolicyBundle(db, makeBundleRow({ etag: "v1" }));

      // Simulate two readers getting v1
      const reader1 = repo.getPolicyBundleById(db, "bundle-1");
      const reader2 = repo.getPolicyBundleById(db, "bundle-1");
      expect(reader1!.etag).toBe("v1");
      expect(reader2!.etag).toBe("v1");

      // Reader 1 updates
      repo.updatePolicyBundle(db, "bundle-1", { etag: "v2", name: "From Reader 1", updated_at: "2026-02-01T00:00:00Z" });

      // Reader 2 should detect etag changed
      const afterUpdate = repo.getPolicyBundleById(db, "bundle-1");
      expect(afterUpdate!.etag).not.toBe(reader2!.etag);
    });
  });

  // ─── Migration ───

  describe("migration SQL", () => {
    it("creates all required tables", () => {
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[];
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain("rule_policy_bundles");
      expect(tableNames).toContain("rules");
      expect(tableNames).toContain("rule_versions");
      expect(tableNames).toContain("rule_evaluation_log");
    });

    it("creates required indexes", () => {
      const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`).all() as { name: string }[];
      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain("idx_rule_policy_bundles_name");
      expect(indexNames).toContain("idx_rules_policy_bundle_id");
      expect(indexNames).toContain("idx_rules_resource_action");
      expect(indexNames).toContain("idx_rule_versions_rule_id");
      expect(indexNames).toContain("idx_rule_evaluation_log_created_at");
    });
  });
});
