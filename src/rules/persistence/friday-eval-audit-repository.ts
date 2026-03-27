import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridayRuleEvaluationLogRow,
  ISODateTime,
  JsonObject,
  UUID,
} from "../model/index.js";
import type { AuditLogEntry } from "../engine/index.js";

// ─── Input types ───

export interface InsertEvalAuditInput {
  id: UUID;
  ruleId?: string;
  policyBundleId?: string;
  decision: string;
  resource: string;
  action: string;
  contextRedactedJson: string;
  redactionApplied: boolean;
  redactedFieldsJson: string;
  matchedRulesJson: string;
  durationMs: number;
  runId?: string;
  workflowId?: string;
  principalId?: string;
  contextHash?: string;
  createdAt: ISODateTime;
}

export interface ListEvalAuditQuery {
  decision?: string;
  resource?: string;
  action?: string;
  runId?: string;
  policyBundleId?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface EvalAuditRecord {
  id: string;
  ruleId?: string;
  policyBundleId?: string;
  decision: string;
  resource: string;
  action: string;
  contextRedacted: JsonObject;
  redactionApplied: boolean;
  redactedFields: string[];
  matchedRules: JsonObject[];
  durationMs: number;
  runId?: string;
  workflowId?: string;
  principalId?: string;
  contextHash?: string;
  createdAt: string;
}

// ─── Repository interface ───

export interface FridayEvalAuditRepository {
  insert(db: Database.Database, input: InsertEvalAuditInput): void;
  insertFromAuditLogEntry(db: Database.Database, entry: AuditLogEntry): void;
  getById(db: Database.Database, id: string): EvalAuditRecord | null;
  list(db: Database.Database, query?: ListEvalAuditQuery): EvalAuditRecord[];
  count(db: Database.Database, query?: ListEvalAuditQuery): number;
}

// ─── Row mapping ───

function rowToRecord(row: FridayRuleEvaluationLogRow): EvalAuditRecord {
  return {
    id: row.id,
    ruleId: row.rule_id ?? undefined,
    policyBundleId: row.policy_bundle_id ?? undefined,
    decision: row.decision,
    resource: row.resource,
    action: row.action,
    contextRedacted: safeJsonParse<JsonObject>(row.context_redacted_json) ?? {},
    redactionApplied: row.redaction_applied === 1,
    redactedFields: safeJsonParse<string[]>(row.redacted_fields_json) ?? [],
    matchedRules: safeJsonParse<JsonObject[]>(row.matched_rules_json) ?? [],
    durationMs: row.duration_ms,
    runId: row.run_id ?? undefined,
    workflowId: row.workflow_id ?? undefined,
    principalId: row.principal_id ?? undefined,
    contextHash: (row as unknown as Record<string, unknown>).context_hash as string | undefined,
    createdAt: row.created_at,
  };
}

function buildWhereClause(query?: ListEvalAuditQuery): { where: string; params: Record<string, unknown> } {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (query?.decision) {
    conditions.push("decision = @decision");
    params.decision = query.decision;
  }
  if (query?.resource) {
    conditions.push("resource = @resource");
    params.resource = query.resource;
  }
  if (query?.action) {
    conditions.push("action = @action");
    params.action = query.action;
  }
  if (query?.runId) {
    conditions.push("run_id = @runId");
    params.runId = query.runId;
  }
  if (query?.policyBundleId) {
    conditions.push("policy_bundle_id = @bundleId");
    params.bundleId = query.policyBundleId;
  }
  if (query?.since) {
    conditions.push("created_at >= @since");
    params.since = query.since;
  }
  if (query?.until) {
    conditions.push("created_at <= @until");
    params.until = query.until;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

// ─── Factory ───

export function createFridayEvalAuditRepository(): FridayEvalAuditRepository {
  return {
    insert(db, input) {
      db.prepare(`
        INSERT INTO rule_eval_audit (
          id, rule_id, policy_bundle_id, decision, resource, action,
          context_redacted_json, redaction_applied, redacted_fields_json,
          matched_rules_json, duration_ms, run_id, workflow_id,
          principal_id, context_hash, created_at
        ) VALUES (
          @id, @rule_id, @policy_bundle_id, @decision, @resource, @action,
          @context_redacted_json, @redaction_applied, @redacted_fields_json,
          @matched_rules_json, @duration_ms, @run_id, @workflow_id,
          @principal_id, @context_hash, @created_at
        )
      `).run({
        id: input.id,
        rule_id: input.ruleId ?? null,
        policy_bundle_id: input.policyBundleId ?? null,
        decision: input.decision,
        resource: input.resource,
        action: input.action,
        context_redacted_json: input.contextRedactedJson,
        redaction_applied: input.redactionApplied ? 1 : 0,
        redacted_fields_json: input.redactedFieldsJson,
        matched_rules_json: input.matchedRulesJson,
        duration_ms: input.durationMs,
        run_id: input.runId ?? null,
        workflow_id: input.workflowId ?? null,
        principal_id: input.principalId ?? null,
        context_hash: input.contextHash ?? null,
        created_at: input.createdAt,
      });
    },

    insertFromAuditLogEntry(db, entry) {
      const primaryRuleId = entry.matchedRuleIds.length > 0 ? entry.matchedRuleIds[0] : undefined;
      const primaryBundleId = entry.matchedRules.length > 0 ? entry.matchedRules[0].policyBundleId : undefined;

      const contextHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(entry.contextRedacted))
        .digest("hex");

      this.insert(db, {
        id: entry.evaluationId,
        ruleId: primaryRuleId,
        policyBundleId: primaryBundleId,
        decision: entry.decision,
        resource: entry.resource,
        action: entry.action,
        contextRedactedJson: JSON.stringify(entry.contextRedacted),
        redactionApplied: entry.contextRedacted.redactionApplied,
        redactedFieldsJson: JSON.stringify(entry.contextRedacted.redactedFields),
        matchedRulesJson: JSON.stringify(entry.matchedRules),
        durationMs: entry.durationMs,
        runId: entry.runId,
        workflowId: entry.workflowId,
        principalId: entry.principalId,
        contextHash,
        createdAt: entry.evaluatedAt,
      });
    },

    getById(db, id) {
      const row = db.prepare("SELECT * FROM rule_eval_audit WHERE id = ?").get(id) as FridayRuleEvaluationLogRow | undefined;
      return row ? rowToRecord(row) : null;
    },

    list(db, query) {
      const { where, params } = buildWhereClause(query);
      const limit = query?.limit ?? 100;
      const offset = query?.offset ?? 0;

      const rows = db.prepare(
        `SELECT * FROM rule_eval_audit ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
      ).all({ ...params, limit, offset }) as FridayRuleEvaluationLogRow[];

      return rows.map(rowToRecord);
    },

    count(db, query) {
      const { where, params } = buildWhereClause(query);
      const result = db.prepare(
        `SELECT COUNT(*) as cnt FROM rule_eval_audit ${where}`,
      ).get(params) as { cnt: number };
      return result.cnt;
    },
  };
}
