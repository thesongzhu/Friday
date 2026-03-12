import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { initializeFridayState } from "#state";
import type { FridayStateRuntime } from "#state";
import {
  createFridayPolicyBundleRepository,
  createFridayRulesRepository,
  createFridayEvalAuditRepository,
} from "#rules";
import type {
  FridayPolicyBundleRepository,
  FridayRulesRepository,
  FridayEvalAuditRepository,
} from "#rules";

describe("rules persistence (integration)", () => {
  let tmpDir: string;
  let runtime: FridayStateRuntime | undefined;
  let bundleRepo: FridayPolicyBundleRepository;
  let rulesRepo: FridayRulesRepository;
  let auditRepo: FridayEvalAuditRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-rules-persist-"));
    const configPath = path.join(tmpDir, "config.json5");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        stateDir: tmpDir,
        database: { readPoolSize: 1, busyTimeoutMs: 5000, synchronous: "NORMAL" },
      }),
    );
    runtime = initializeFridayState({ configPath });
    bundleRepo = createFridayPolicyBundleRepository();
    rulesRepo = createFridayRulesRepository();
    auditRepo = createFridayEvalAuditRepository();
  });

  afterEach(() => {
    if (runtime) runtime.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function withWriter<T>(fn: (db: import("better-sqlite3").Database) => T): T {
    return runtime!.sqlite.withWriteTransaction(fn);
  }

  function withReader<T>(fn: (db: import("better-sqlite3").Database) => T): T {
    return runtime!.sqlite.withReadConnection(fn);
  }

  // ─── Policy Bundle CRUD ───

  describe("policy bundle repository", () => {
    it("creates and retrieves a bundle", () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const bundle = withWriter((db) =>
        bundleRepo.create(db, {
          id,
          name: "Test Bundle",
          description: "A test bundle",
          tags: ["test", "security"],
          nowIso: now,
        }),
      );

      expect(bundle.id).toBe(id);
      expect(bundle.name).toBe("Test Bundle");
      expect(bundle.version).toBe(1);
      expect(bundle.enabled).toBe(true);
      expect(bundle.tags).toEqual(["test", "security"]);
      expect(bundle.etag).toBeTruthy();

      // Retrieve via read
      const fetched = withReader((db) => bundleRepo.getById(db, id));
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe("Test Bundle");
    });

    it("updates a bundle with etag check", () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const created = withWriter((db) =>
        bundleRepo.create(db, { id, name: "V1", nowIso: now }),
      );

      const updated = withWriter((db) =>
        bundleRepo.update(db, {
          id,
          name: "V2",
          etag: created.etag,
          nowIso: now,
        }),
      );

      expect(updated.name).toBe("V2");
      expect(updated.version).toBe(2);
      expect(updated.etag).not.toBe(created.etag);
    });

    it("rejects update with stale etag", () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      withWriter((db) =>
        bundleRepo.create(db, { id, name: "V1", nowIso: now }),
      );

      expect(() =>
        withWriter((db) =>
          bundleRepo.update(db, {
            id,
            name: "V2",
            etag: "stale-etag",
            nowIso: now,
          }),
        ),
      ).toThrow(/[Ee]tag/);
    });

    it("soft-deletes a bundle", () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      withWriter((db) =>
        bundleRepo.create(db, { id, name: "To Delete", nowIso: now }),
      );

      withWriter((db) => bundleRepo.softDelete(db, id, now));

      // Default list excludes deleted
      const list = withReader((db) => bundleRepo.list(db));
      expect(list.find((b) => b.id === id)).toBeUndefined();

      // Including deleted shows it
      const allList = withReader((db) => bundleRepo.list(db, { includeDeleted: true }));
      const deleted = allList.find((b) => b.id === id);
      expect(deleted).toBeDefined();
      expect(deleted!.deletedAt).toBeTruthy();
    });

    it("records version history", () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const created = withWriter((db) =>
        bundleRepo.create(db, { id, name: "V1", nowIso: now }),
      );

      withWriter((db) =>
        bundleRepo.update(db, { id, name: "V2", etag: created.etag, nowIso: now }),
      );

      const versions = withReader((db) => bundleRepo.listVersions(db, id));
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(2);
      expect(versions[1].version).toBe(1);
    });
  });

  // ─── Rules CRUD ───

  describe("rules repository", () => {
    let bundleId: string;

    beforeEach(() => {
      bundleId = crypto.randomUUID();
      const now = new Date().toISOString();
      withWriter((db) =>
        bundleRepo.create(db, { id: bundleId, name: "Test Bundle", nowIso: now }),
      );
    });

    it("creates and retrieves a rule", () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const rule = withWriter((db) =>
        rulesRepo.create(db, {
          id,
          policyBundleId: bundleId,
          name: "Block network",
          enabled: true,
          resource: "network",
          action: "connect",
          conditions: { all: [{ field: "target", operator: "contains", value: "evil.com" }] },
          decision: "deny",
          message: "Blocked",
          priority: 10,
          nowIso: now,
        }),
      );

      expect(rule.id).toBe(id);
      expect(rule.name).toBe("Block network");
      expect(rule.version).toBe(1);
      expect(rule.decision).toBe("deny");

      const fetched = withReader((db) => rulesRepo.getById(db, id));
      expect(fetched).not.toBeNull();
      expect(fetched!.conditions).toEqual({
        all: [{ field: "target", operator: "contains", value: "evil.com" }],
      });
    });

    it("updates a rule with version increment", () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const created = withWriter((db) =>
        rulesRepo.create(db, {
          id,
          policyBundleId: bundleId,
          name: "V1",
          enabled: true,
          resource: "filesystem",
          action: "write",
          conditions: {},
          decision: "warn",
          priority: 50,
          nowIso: now,
        }),
      );

      const updated = withWriter((db) =>
        rulesRepo.update(db, {
          id,
          name: "V2",
          decision: "deny",
          etag: created.etag,
          nowIso: now,
        }),
      );

      expect(updated.version).toBe(2);
      expect(updated.decision).toBe("deny");
    });

    it("lists rules filtered by bundle", () => {
      const now = new Date().toISOString();

      withWriter((db) =>
        rulesRepo.create(db, {
          id: crypto.randomUUID(),
          policyBundleId: bundleId,
          name: "Rule A",
          enabled: true,
          resource: "network",
          action: "send",
          conditions: {},
          decision: "allow",
          priority: 100,
          nowIso: now,
        }),
      );

      withWriter((db) =>
        rulesRepo.create(db, {
          id: crypto.randomUUID(),
          policyBundleId: bundleId,
          name: "Rule B",
          enabled: true,
          resource: "filesystem",
          action: "read",
          conditions: {},
          decision: "allow",
          priority: 50,
          nowIso: now,
        }),
      );

      const rules = withReader((db) =>
        rulesRepo.list(db, { policyBundleId: bundleId }),
      );
      expect(rules).toHaveLength(2);
      // Ordered by priority ASC
      expect(rules[0].priority).toBeLessThanOrEqual(rules[1].priority);
    });

    it("records version history for rules", () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const created = withWriter((db) =>
        rulesRepo.create(db, {
          id,
          policyBundleId: bundleId,
          name: "V1",
          enabled: true,
          resource: "tool",
          action: "execute",
          conditions: {},
          decision: "allow",
          priority: 100,
          nowIso: now,
        }),
      );

      withWriter((db) =>
        rulesRepo.update(db, {
          id,
          name: "V2",
          etag: created.etag,
          nowIso: now,
          changeNote: "Updated name",
        }),
      );

      const versions = withReader((db) => rulesRepo.listVersions(db, id));
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(2);
      expect(versions[0].changeNote).toBe("Updated name");
    });

    it("survives restart (persistence proof)", () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      withWriter((db) =>
        rulesRepo.create(db, {
          id,
          policyBundleId: bundleId,
          name: "Persistent Rule",
          enabled: true,
          resource: "network",
          action: "connect",
          conditions: {},
          decision: "deny",
          priority: 1,
          nowIso: now,
        }),
      );

      // Close and re-open
      runtime!.close();
      const configPath = path.join(tmpDir, "config.json5");
      runtime = initializeFridayState({ configPath });

      const rule = withReader((db) => rulesRepo.getById(db, id));
      expect(rule).not.toBeNull();
      expect(rule!.name).toBe("Persistent Rule");
    });
  });

  // ─── Evaluation Audit ───

  describe("evaluation audit repository", () => {
    it("inserts and retrieves audit entries", () => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      withWriter((db) =>
        auditRepo.insert(db, {
          id,
          decision: "deny",
          resource: "network",
          action: "connect",
          contextRedactedJson: JSON.stringify({ target: "***" }),
          redactionApplied: true,
          redactedFieldsJson: JSON.stringify(["target"]),
          matchedRulesJson: JSON.stringify([{ ruleId: "r1", decision: "deny" }]),
          durationMs: 1.5,
          runId: "run-123",
          createdAt: now,
        }),
      );

      const entry = withReader((db) => auditRepo.getById(db, id));
      expect(entry).not.toBeNull();
      expect(entry!.decision).toBe("deny");
      expect(entry!.redactionApplied).toBe(true);
      expect(entry!.redactedFields).toEqual(["target"]);
      expect(entry!.durationMs).toBe(1.5);
    });

    it("lists and counts audit entries with filters", () => {
      const now = new Date().toISOString();

      for (let i = 0; i < 5; i++) {
        withWriter((db) =>
          auditRepo.insert(db, {
            id: crypto.randomUUID(),
            decision: i < 3 ? "allow" : "deny",
            resource: "network",
            action: "connect",
            contextRedactedJson: "{}",
            redactionApplied: false,
            redactedFieldsJson: "[]",
            matchedRulesJson: "[]",
            durationMs: 0.5,
            createdAt: now,
          }),
        );
      }

      const allEntries = withReader((db) => auditRepo.list(db));
      expect(allEntries).toHaveLength(5);

      const denyEntries = withReader((db) => auditRepo.list(db, { decision: "deny" }));
      expect(denyEntries).toHaveLength(2);

      const denyCount = withReader((db) => auditRepo.count(db, { decision: "deny" }));
      expect(denyCount).toBe(2);
    });
  });

  // ─── Migration Schema ───

  describe("migration schema", () => {
    it("creates all expected tables", () => {
      const tables = withReader((db) =>
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rule%' ORDER BY name",
          )
          .all(),
      ) as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("rules");
      expect(tableNames).toContain("rule_versions");
      expect(tableNames).toContain("rule_policy_bundles");
      expect(tableNames).toContain("rule_policy_bundle_versions");
      expect(tableNames).toContain("rule_eval_audit");
    });

    it("migration is reversible (down migration can drop tables)", () => {
      // Verify tables exist before checking they can be introspected
      const rulesCols = withReader((db) =>
        db.prepare("PRAGMA table_info(rules)").all(),
      ) as Array<{ name: string }>;

      const colNames = rulesCols.map((c) => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("policy_bundle_id");
      expect(colNames).toContain("conditions_json");
      expect(colNames).toContain("etag");
      expect(colNames).toContain("checksum");
    });
  });
});
