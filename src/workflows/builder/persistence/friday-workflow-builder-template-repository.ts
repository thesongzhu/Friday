import type Database from "better-sqlite3";
import type { UUID } from "../../model/friday-workflow.types.js";
import { FridayDomainError } from "#errors";
import { safeJsonParse } from "#utilities";
import type {
  FridayWorkflowTemplateEntity,
  FridayWorkflowTemplateScope,
} from "../model/friday-workflow-builder-template.types.js";

// ─── Interface ───

export interface FridayWorkflowBuilderTemplateRepository {
  create(db: Database.Database, template: FridayWorkflowTemplateEntity): void;
  getById(db: Database.Database, templateId: string): FridayWorkflowTemplateEntity | null;
  list(db: Database.Database, scope?: FridayWorkflowTemplateScope, ownerUserId?: UUID): FridayWorkflowTemplateEntity[];
  update(db: Database.Database, template: FridayWorkflowTemplateEntity): void;
  delete(db: Database.Database, templateId: string): void;
}

// ─── Constants ───

const NAMESPACE = "workflow_builder_templates";

interface TemplateRow {
  template_id: string;
  kind: string;
  scope: string;
  owner_user_id: string | null;
  name: string;
  description: string | null;
  tags_json: string;
  source_skill_id: string | null;
  spec_json: string;
  visual_json: string;
  created_at: string;
  updated_at: string;
}

function rowToTemplate(row: TemplateRow): FridayWorkflowTemplateEntity | null {
  const tags = safeJsonParse<string[]>(row.tags_json);
  const spec = safeJsonParse<FridayWorkflowTemplateEntity["spec"]>(row.spec_json);
  const visual = safeJsonParse<FridayWorkflowTemplateEntity["visual"]>(row.visual_json);
  if (!tags || !spec || !visual) return null;
  return {
    templateId: row.template_id,
    kind: row.kind as FridayWorkflowTemplateEntity["kind"],
    scope: row.scope as FridayWorkflowTemplateScope,
    ownerUserId: row.owner_user_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    tags,
    sourceSkillId: row.source_skill_id ?? undefined,
    spec,
    visual,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertTemplateRow(db: Database.Database, template: FridayWorkflowTemplateEntity): void {
  db.prepare(
    `INSERT INTO workflow_builder_templates (
      template_id, kind, scope, owner_user_id, name, description, tags_json,
      source_skill_id, spec_json, visual_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    template.templateId,
    template.kind,
    template.scope,
    template.ownerUserId ?? null,
    template.name,
    template.description ?? null,
    JSON.stringify(template.tags),
    template.sourceSkillId ?? null,
    JSON.stringify(template.spec),
    JSON.stringify(template.visual),
    template.createdAt,
    template.updatedAt,
  );
}

function upsertTemplateRow(db: Database.Database, template: FridayWorkflowTemplateEntity): void {
  db.prepare(
    `INSERT INTO workflow_builder_templates (
      template_id, kind, scope, owner_user_id, name, description, tags_json,
      source_skill_id, spec_json, visual_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(template_id) DO UPDATE SET
      kind = excluded.kind,
      scope = excluded.scope,
      owner_user_id = excluded.owner_user_id,
      name = excluded.name,
      description = excluded.description,
      tags_json = excluded.tags_json,
      source_skill_id = excluded.source_skill_id,
      spec_json = excluded.spec_json,
      visual_json = excluded.visual_json,
      updated_at = excluded.updated_at`,
  ).run(
    template.templateId,
    template.kind,
    template.scope,
    template.ownerUserId ?? null,
    template.name,
    template.description ?? null,
    JSON.stringify(template.tags),
    template.sourceSkillId ?? null,
    JSON.stringify(template.spec),
    JSON.stringify(template.visual),
    template.createdAt,
    template.updatedAt,
  );
}

function readTemplateRowById(
  db: Database.Database,
  templateId: string,
): FridayWorkflowTemplateEntity | null {
  const row = db
    .prepare("SELECT * FROM workflow_builder_templates WHERE template_id = ?")
    .get(templateId) as TemplateRow | undefined;
  return row ? rowToTemplate(row) : null;
}

function readLegacyTemplateById(
  db: Database.Database,
  templateId: string,
): FridayWorkflowTemplateEntity | null {
  const row = db
    .prepare("SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ?")
    .get(NAMESPACE, `%:${templateId}`) as { value_json: string } | undefined;
  return row ? safeJsonParse<FridayWorkflowTemplateEntity>(row.value_json) ?? null : null;
}

function readLegacyTemplates(
  db: Database.Database,
  scope?: FridayWorkflowTemplateScope,
  ownerUserId?: UUID,
): FridayWorkflowTemplateEntity[] {
  let query = "SELECT value_json FROM memory_items WHERE namespace = ?";
  const params: unknown[] = [NAMESPACE];
  if (scope && ownerUserId) {
    query += " AND key LIKE ?";
    params.push(`${scope}:${ownerUserId}:%`);
  } else if (scope) {
    query += " AND key LIKE ?";
    params.push(`${scope}:%`);
  }
  query += " ORDER BY updated_at DESC";
  const rows = db.prepare(query).all(...params) as Array<{ value_json: string }>;
  return rows
    .map((row) => safeJsonParse<FridayWorkflowTemplateEntity>(row.value_json))
    .filter((template): template is FridayWorkflowTemplateEntity => template !== undefined);
}

function mergeLegacyTemplates(
  rows: FridayWorkflowTemplateEntity[],
  legacyRows: FridayWorkflowTemplateEntity[],
): FridayWorkflowTemplateEntity[] {
  const seen = new Set(rows.map((row) => row.templateId));
  return [
    ...rows,
    ...legacyRows.filter((row) => !seen.has(row.templateId)),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ─── Factory ───

export function createFridayWorkflowBuilderTemplateRepository(): FridayWorkflowBuilderTemplateRepository {
  return {
    create(db, template) {
      insertTemplateRow(db, template);
    },

    getById(db, templateId) {
      return readTemplateRowById(db, templateId) ?? readLegacyTemplateById(db, templateId);
    },

    list(db, scope, ownerUserId) {
      let query: string;
      let params: unknown[];

      if (scope && ownerUserId) {
        query = `SELECT * FROM workflow_builder_templates WHERE scope = ? AND owner_user_id = ? ORDER BY updated_at DESC`;
        params = [scope, ownerUserId];
      } else if (scope) {
        query = `SELECT * FROM workflow_builder_templates WHERE scope = ? ORDER BY updated_at DESC`;
        params = [scope];
      } else {
        query = `SELECT * FROM workflow_builder_templates ORDER BY updated_at DESC`;
        params = [];
      }

      const rows = db.prepare(query).all(...params) as TemplateRow[];
      const templates = rows
        .map((row) => rowToTemplate(row))
        .filter((template): template is FridayWorkflowTemplateEntity => template !== null);
      return mergeLegacyTemplates(templates, readLegacyTemplates(db, scope, ownerUserId));
    },

    update(db, template) {
      if (!this.getById(db, template.templateId)) {
        throw new FridayDomainError("TEMPLATE_NOT_FOUND", "TEMPLATE_NOT_FOUND", { httpStatus: 404 });
      }
      upsertTemplateRow(db, template);
    },

    delete(db, templateId) {
      const result = db
        .prepare("DELETE FROM workflow_builder_templates WHERE template_id = ?")
        .run(templateId);
      if (result.changes === 0) {
        if (readLegacyTemplateById(db, templateId)) {
          throw new FridayDomainError(
            "TEMPLATE_LEGACY_ROW_REQUIRES_REHOME",
            "Legacy workflow-builder template rows must be migrated before delete; refusing to write memory_items.",
            { httpStatus: 503 },
          );
        }
        throw new FridayDomainError("TEMPLATE_NOT_FOUND", "TEMPLATE_NOT_FOUND", { httpStatus: 404 });
      }
    },
  };
}
