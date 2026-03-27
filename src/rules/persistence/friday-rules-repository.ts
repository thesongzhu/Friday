/**
 * Rules Engine Persistence — SQLite repository for rules, policy bundles,
 * rule versions, and evaluation audit log.
 *
 * @module rules/persistence
 */
import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import { FridayDomainError } from "#errors";
import { safeJsonParse } from "#utilities";
import type {
  FridayPolicyBundleRow,
  FridayRule,
  FridayRuleEvaluationLogRow,
  FridayRuleRow,
  FridayRuleVersion,
  FridayRuleVersionRow,
  ISODateTime,
  JsonValue,
  UUID,
} from "../model/friday-rules-engine.types.js";

export interface CreateRuleInput {
  id: UUID;
  policyBundleId: UUID;
  name: string;
  description?: string;
  enabled: boolean;
  resource: string;
  action: string;
  conditions: Record<string, unknown>;
  decision: string;
  message?: string;
  priority: number;
  nowIso: ISODateTime;
  changedBy?: string;
}

export interface UpdateRuleInput {
  id: UUID;
  name?: string;
  description?: string;
  enabled?: boolean;
  conditions?: Record<string, unknown>;
  decision?: string;
  message?: string;
  priority?: number;
  etag: string;
  nowIso: ISODateTime;
  changedBy?: string;
  changeNote?: string;
}

export interface ListRulesQuery {
  policyBundleId?: string;
  resource?: string;
  action?: string;
  decision?: string;
  enabled?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface FridayRulesRepository {
  // Legacy bundle APIs
  insertPolicyBundle(db: Database.Database, bundle: FridayPolicyBundleRow): void;
  getPolicyBundleById(db: Database.Database, id: string): FridayPolicyBundleRow | null;
  listPolicyBundles(db: Database.Database, opts?: { enabledOnly?: boolean; limit?: number; offset?: number }): FridayPolicyBundleRow[];
  updatePolicyBundle(db: Database.Database, id: string, fields: Partial<Pick<FridayPolicyBundleRow, "name" | "description" | "priority" | "enabled" | "tags_json" | "source" | "etag" | "updated_at" | "version">>): void;
  softDeletePolicyBundle(db: Database.Database, id: string, nowIso: string): void;

  // Legacy rule APIs
  insertRule(db: Database.Database, rule: FridayRuleRow): void;
  getRuleById(db: Database.Database, id: string): FridayRuleRow | null;
  listRulesByBundleId(db: Database.Database, bundleId: string, opts?: { enabledOnly?: boolean }): FridayRuleRow[];
  updateRule(db: Database.Database, id: string, fields: Partial<Pick<FridayRuleRow, "name" | "description" | "enabled" | "resource" | "action" | "conditions_json" | "decision" | "message" | "priority" | "version" | "etag" | "updated_at">>): void;
  softDeleteRule(db: Database.Database, id: string, nowIso: string): void;

  // Legacy versions + audits
  insertRuleVersion(db: Database.Database, version: FridayRuleVersionRow): void;
  listRuleVersions(db: Database.Database, ruleId: string, opts?: { limit?: number; offset?: number }): FridayRuleVersionRow[];
  insertEvaluationLog(db: Database.Database, entry: FridayRuleEvaluationLogRow): void;
  listEvaluationLogs(db: Database.Database, opts?: { ruleId?: string; bundleId?: string; runId?: string; limit?: number; offset?: number }): FridayRuleEvaluationLogRow[];
  countEvaluationLogs(db: Database.Database, opts?: { ruleId?: string; bundleId?: string }): number;

  // New CRUD facade APIs used by integration tests and rule services
  create(db: Database.Database, input: CreateRuleInput): FridayRule;
  getById(db: Database.Database, id: string): FridayRule | null;
  list(db: Database.Database, query?: ListRulesQuery): FridayRule[];
  update(db: Database.Database, input: UpdateRuleInput): FridayRule;
  softDelete(db: Database.Database, id: string, nowIso: string): void;
  listVersions(db: Database.Database, ruleId: string, limit?: number, offset?: number): FridayRuleVersion[];
}

function generateEtag(): string {
  return crypto.randomBytes(16).toString("hex");
}

function rowToRule(row: FridayRuleRow): FridayRule {
  const parsed = safeJsonParse<FridayRule["conditions"]>(row.conditions_json);
  const conditions = typeof parsed === "object" && parsed !== null ? parsed : {};

  return {
    id: row.id,
    policyBundleId: row.policy_bundle_id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled === 1,
    resource: row.resource as FridayRule["resource"],
    action: row.action as FridayRule["action"],
    conditions,
    decision: row.decision as FridayRule["decision"],
    message: row.message ?? undefined,
    priority: row.priority,
    version: row.version,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToRuleVersion(row: FridayRuleVersionRow): FridayRuleVersion {
  const snapshotParsed = safeJsonParse<FridayRuleVersion["snapshot"]>(row.snapshot_json);
  const snapshot = typeof snapshotParsed === "object" && snapshotParsed !== null
    ? snapshotParsed
    : {} as FridayRuleVersion["snapshot"];

  return {
    id: row.id,
    ruleId: row.rule_id,
    version: row.version,
    snapshot,
    changedBy: row.changed_by ?? undefined,
    changeNote: row.change_note ?? undefined,
    createdAt: row.created_at,
  };
}

// ─── Column whitelists (defense-in-depth against dynamic SQL injection) ───

const POLICY_BUNDLE_UPDATABLE_COLUMNS = new Set([
  "name", "description", "priority", "enabled", "tags_json",
  "source", "etag", "updated_at", "version",
]);

const RULE_UPDATABLE_COLUMNS = new Set([
  "name", "description", "enabled", "resource", "action",
  "conditions_json", "decision", "message", "priority",
  "version", "etag", "updated_at",
]);

function assertAllowedColumns(fields: Record<string, unknown>, allowlist: Set<string>, entity: string): void {
  for (const key of Object.keys(fields)) {
    if (!allowlist.has(key)) {
      throw new FridayDomainError(
        "RULES_INVALID_COLUMN",
        `Column '${key}' is not an allowed updatable column for ${entity}`,
        { httpStatus: 400 },
      );
    }
  }
}

// ─── Factory ───

export function createFridayRulesRepository(): FridayRulesRepository {
  const repo: FridayRulesRepository = {
    // ─── Policy Bundles ───

    insertPolicyBundle(db, bundle) {
      db.prepare(`
        INSERT INTO rule_policy_bundles (id, name, description, version, priority, enabled, tags_json, source, etag, created_at, updated_at, deleted_at)
        VALUES (@id, @name, @description, @version, @priority, @enabled, @tags_json, @source, @etag, @created_at, @updated_at, @deleted_at)
      `).run(bundle);
    },

    getPolicyBundleById(db, id) {
      return db.prepare(`SELECT * FROM rule_policy_bundles WHERE id = ? AND deleted_at IS NULL`).get(id) as FridayPolicyBundleRow | undefined ?? null;
    },

    listPolicyBundles(db, opts = {}) {
      const { enabledOnly = false, limit = 100, offset = 0 } = opts;
      const where = enabledOnly ? `WHERE deleted_at IS NULL AND enabled = 1` : `WHERE deleted_at IS NULL`;
      return db.prepare(`SELECT * FROM rule_policy_bundles ${where} ORDER BY priority DESC, name ASC LIMIT ? OFFSET ?`).all(limit, offset) as FridayPolicyBundleRow[];
    },

    updatePolicyBundle(db, id, fields) {
      assertAllowedColumns(fields, POLICY_BUNDLE_UPDATABLE_COLUMNS, "rule_policy_bundles");
      const setClauses: string[] = [];
      const params: Record<string, unknown> = { id };
      for (const [key, value] of Object.entries(fields)) {
        setClauses.push(`${key} = @${key}`);
        params[key] = value;
      }
      if (setClauses.length === 0) return;
      const result = db.prepare(`UPDATE rule_policy_bundles SET ${setClauses.join(", ")} WHERE id = @id AND deleted_at IS NULL`).run(params);
      if (result.changes === 0) {
        throw new FridayDomainError("RULES_BUNDLE_NOT_FOUND", `Policy bundle '${id}' not found or deleted`, { httpStatus: 404 });
      }
    },

    softDeletePolicyBundle(db, id, nowIso) {
      const result = db.prepare(`UPDATE rule_policy_bundles SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).run(nowIso, id);
      if (result.changes === 0) {
        throw new FridayDomainError("RULES_BUNDLE_NOT_FOUND", `Policy bundle '${id}' not found or already deleted`, { httpStatus: 404 });
      }
    },

    // ─── Rules ───

    insertRule(db, rule) {
      db.prepare(`
        INSERT INTO rules (id, policy_bundle_id, name, description, enabled, resource, action, conditions_json, decision, message, priority, version, etag, created_at, updated_at, deleted_at)
        VALUES (@id, @policy_bundle_id, @name, @description, @enabled, @resource, @action, @conditions_json, @decision, @message, @priority, @version, @etag, @created_at, @updated_at, @deleted_at)
      `).run(rule);
    },

    getRuleById(db, id) {
      return db.prepare(`SELECT * FROM rules WHERE id = ? AND deleted_at IS NULL`).get(id) as FridayRuleRow | undefined ?? null;
    },

    listRulesByBundleId(db, bundleId, opts = {}) {
      const { enabledOnly = false } = opts;
      const where = enabledOnly
        ? `WHERE policy_bundle_id = ? AND deleted_at IS NULL AND enabled = 1`
        : `WHERE policy_bundle_id = ? AND deleted_at IS NULL`;
      return db.prepare(`SELECT * FROM rules ${where} ORDER BY priority DESC, name ASC`).all(bundleId) as FridayRuleRow[];
    },

    updateRule(db, id, fields) {
      assertAllowedColumns(fields, RULE_UPDATABLE_COLUMNS, "rules");
      const setClauses: string[] = [];
      const params: Record<string, unknown> = { id };
      for (const [key, value] of Object.entries(fields)) {
        setClauses.push(`${key} = @${key}`);
        params[key] = value;
      }
      if (setClauses.length === 0) return;
      const result = db.prepare(`UPDATE rules SET ${setClauses.join(", ")} WHERE id = @id AND deleted_at IS NULL`).run(params);
      if (result.changes === 0) {
        throw new FridayDomainError("RULES_RULE_NOT_FOUND", `Rule '${id}' not found or deleted`, { httpStatus: 404 });
      }
    },

    softDeleteRule(db, id, nowIso) {
      const result = db.prepare(`UPDATE rules SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`).run(nowIso, id);
      if (result.changes === 0) {
        throw new FridayDomainError("RULES_RULE_NOT_FOUND", `Rule '${id}' not found or already deleted`, { httpStatus: 404 });
      }
    },

    // ─── Rule Versions ───

    insertRuleVersion(db, version) {
      db.prepare(`
        INSERT INTO rule_versions (id, rule_id, version, snapshot_json, changed_by, change_note, created_at)
        VALUES (@id, @rule_id, @version, @snapshot_json, @changed_by, @change_note, @created_at)
      `).run(version);
    },

    listRuleVersions(db, ruleId, opts = {}) {
      const { limit = 50, offset = 0 } = opts;
      return db.prepare(`SELECT * FROM rule_versions WHERE rule_id = ? ORDER BY version DESC LIMIT ? OFFSET ?`).all(ruleId, limit, offset) as FridayRuleVersionRow[];
    },

    // ─── Evaluation Audit Log ───

    insertEvaluationLog(db, entry) {
      db.prepare(`
        INSERT INTO rule_evaluation_log (id, rule_id, policy_bundle_id, decision, resource, action, context_redacted_json, redaction_applied, redacted_fields_json, matched_rules_json, duration_ms, run_id, workflow_id, principal_id, created_at)
        VALUES (@id, @rule_id, @policy_bundle_id, @decision, @resource, @action, @context_redacted_json, @redaction_applied, @redacted_fields_json, @matched_rules_json, @duration_ms, @run_id, @workflow_id, @principal_id, @created_at)
      `).run(entry);

      // Bridge for newer audit queries if v034+ schema is available.
      try {
        db.prepare(`
          INSERT INTO rule_eval_audit (id, rule_id, policy_bundle_id, decision, resource, action, context_redacted_json, redaction_applied, redacted_fields_json, matched_rules_json, duration_ms, run_id, workflow_id, principal_id, context_hash, created_at)
          VALUES (@id, @rule_id, @policy_bundle_id, @decision, @resource, @action, @context_redacted_json, @redaction_applied, @redacted_fields_json, @matched_rules_json, @duration_ms, @run_id, @workflow_id, @principal_id, NULL, @created_at)
        `).run(entry);
      } catch (err) {
        // table may not exist on legacy schemas
        console.warn("[friday][rules-repository] audit log insert failed:", err instanceof Error ? err.message : String(err));
      }
    },

    listEvaluationLogs(db, opts = {}) {
      const { ruleId, bundleId, runId, limit = 100, offset = 0 } = opts;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (ruleId) { conditions.push("rule_id = ?"); params.push(ruleId); }
      if (bundleId) { conditions.push("policy_bundle_id = ?"); params.push(bundleId); }
      if (runId) { conditions.push("run_id = ?"); params.push(runId); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit, offset);
      return db.prepare(`SELECT * FROM rule_evaluation_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params) as FridayRuleEvaluationLogRow[];
    },

    countEvaluationLogs(db, opts = {}) {
      const { ruleId, bundleId } = opts;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (ruleId) { conditions.push("rule_id = ?"); params.push(ruleId); }
      if (bundleId) { conditions.push("policy_bundle_id = ?"); params.push(bundleId); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const row = db.prepare(`SELECT COUNT(*) as cnt FROM rule_evaluation_log ${where}`).get(...params) as { cnt: number };
      return row.cnt;
    },

    // ─── New CRUD facade APIs ───

    create(db, input) {
      const nowIso = input.nowIso;
      const ruleRow: FridayRuleRow = {
        id: input.id,
        policy_bundle_id: input.policyBundleId,
        name: input.name,
        description: input.description ?? null,
        enabled: input.enabled ? 1 : 0,
        resource: input.resource,
        action: input.action,
        conditions_json: JSON.stringify(input.conditions ?? {}),
        decision: input.decision,
        message: input.message ?? null,
        priority: input.priority,
        version: 1,
        etag: generateEtag(),
        created_at: nowIso,
        updated_at: nowIso,
        deleted_at: null,
      };

      repo.insertRule(db, ruleRow);

      const entity = rowToRule(ruleRow);
      repo.insertRuleVersion(db, {
        id: crypto.randomUUID(),
        rule_id: input.id,
        version: 1,
        snapshot_json: JSON.stringify(entity),
        changed_by: input.changedBy ?? null,
        change_note: "Initial creation",
        created_at: nowIso,
      });

      const inserted = repo.getById(db, input.id);
      if (!inserted) {
        throw new FridayDomainError("RULES_RULE_NOT_FOUND", `Rule '${input.id}' was not found after create`, { httpStatus: 500 });
      }
      return inserted;
    },

    getById(db, id) {
      const row = repo.getRuleById(db, id);
      return row ? rowToRule(row) : null;
    },

    list(db, query = {}) {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {
        limit: query.limit ?? 100,
        offset: query.offset ?? 0,
      };

      if (!query.includeDeleted) {
        conditions.push("deleted_at IS NULL");
      }
      if (query.policyBundleId) {
        conditions.push("policy_bundle_id = @policyBundleId");
        params.policyBundleId = query.policyBundleId;
      }
      if (query.resource) {
        conditions.push("resource = @resource");
        params.resource = query.resource;
      }
      if (query.action) {
        conditions.push("action = @action");
        params.action = query.action;
      }
      if (query.decision) {
        conditions.push("decision = @decision");
        params.decision = query.decision;
      }
      if (query.enabled !== undefined) {
        conditions.push("enabled = @enabled");
        params.enabled = query.enabled ? 1 : 0;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db.prepare(
        `SELECT * FROM rules ${where} ORDER BY priority ASC, created_at ASC LIMIT @limit OFFSET @offset`,
      ).all(params) as FridayRuleRow[];

      return rows.map((row) => rowToRule(row));
    },

    update(db, input) {
      const current = repo.getRuleById(db, input.id);
      if (!current) {
        throw new FridayDomainError("RULES_RULE_NOT_FOUND", `Rule '${input.id}' not found`, { httpStatus: 404 });
      }
      if (current.etag !== input.etag) {
        throw new FridayDomainError("RULE_ETAG_MISMATCH", `Etag mismatch for rule '${input.id}'`, { httpStatus: 409 });
      }

      const version = current.version + 1;
      const nowIso = input.nowIso;
      const updatedFields: Partial<Pick<FridayRuleRow, "name" | "description" | "enabled" | "conditions_json" | "decision" | "message" | "priority" | "version" | "etag" | "updated_at">> = {
        name: input.name ?? current.name,
        description: input.description !== undefined ? (input.description ?? null) : current.description,
        enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : current.enabled,
        conditions_json: input.conditions !== undefined
          ? JSON.stringify(input.conditions)
          : current.conditions_json,
        decision: input.decision ?? current.decision,
        message: input.message !== undefined ? (input.message ?? null) : current.message,
        priority: input.priority ?? current.priority,
        version,
        etag: generateEtag(),
        updated_at: nowIso,
      };

      repo.updateRule(db, input.id, updatedFields);

      const updated = repo.getRuleById(db, input.id);
      if (!updated) {
        throw new FridayDomainError("RULES_RULE_NOT_FOUND", `Rule '${input.id}' missing after update`, { httpStatus: 500 });
      }
      const entity = rowToRule(updated);

      repo.insertRuleVersion(db, {
        id: crypto.randomUUID(),
        rule_id: input.id,
        version,
        snapshot_json: JSON.stringify(entity),
        changed_by: input.changedBy ?? null,
        change_note: input.changeNote ?? null,
        created_at: nowIso,
      });

      return entity;
    },

    softDelete(db, id, nowIso) {
      repo.softDeleteRule(db, id, nowIso);
    },

    listVersions(db, ruleId, limit = 50, offset = 0) {
      return repo.listRuleVersions(db, ruleId, { limit, offset }).map((row) => rowToRuleVersion(row));
    },
  };

  return repo;
}
