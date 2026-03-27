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

function templateKey(scope: FridayWorkflowTemplateScope, ownerUserId: UUID | undefined, templateId: string): string {
  return `${scope}:${ownerUserId ?? "global"}:${templateId}`;
}

// ─── Factory ───

export function createFridayWorkflowBuilderTemplateRepository(): FridayWorkflowBuilderTemplateRepository {
  return {
    create(db, template) {
      const key = templateKey(template.scope, template.ownerUserId, template.templateId);
      db.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        template.templateId,
        NAMESPACE,
        key,
        JSON.stringify(template),
        JSON.stringify(template.tags),
        template.createdAt,
        template.updatedAt,
      );
    },

    getById(db, templateId) {
      const row = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ?`,
        )
        .get(NAMESPACE, `%:${templateId}`) as { value_json: string } | undefined;
      return row ? safeJsonParse<FridayWorkflowTemplateEntity>(row.value_json) ?? null : null;
    },

    list(db, scope, ownerUserId) {
      let query: string;
      let params: unknown[];

      if (scope && ownerUserId) {
        query = `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY updated_at DESC`;
        params = [NAMESPACE, `${scope}:${ownerUserId}:%`];
      } else if (scope) {
        query = `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY updated_at DESC`;
        params = [NAMESPACE, `${scope}:%`];
      } else {
        query = `SELECT value_json FROM memory_items WHERE namespace = ? ORDER BY updated_at DESC`;
        params = [NAMESPACE];
      }

      const rows = db.prepare(query).all(...params) as Array<{ value_json: string }>;
      return rows.map((r) => safeJsonParse<FridayWorkflowTemplateEntity>(r.value_json)).filter((r): r is FridayWorkflowTemplateEntity => r !== undefined);
    },

    update(db, template) {
      const key = templateKey(template.scope, template.ownerUserId, template.templateId);
      const result = db
        .prepare(
          `UPDATE memory_items SET value_json = ?, tags_json = ?, updated_at = ?
           WHERE namespace = ? AND key = ?`,
        )
        .run(
          JSON.stringify(template),
          JSON.stringify(template.tags),
          template.updatedAt,
          NAMESPACE,
          key,
        );
      if (result.changes === 0) {
        throw new FridayDomainError("TEMPLATE_NOT_FOUND", "TEMPLATE_NOT_FOUND", { httpStatus: 404 });
      }
    },

    delete(db, templateId) {
      const result = db
        .prepare(`DELETE FROM memory_items WHERE namespace = ? AND key LIKE ?`)
        .run(NAMESPACE, `%:${templateId}`);
      if (result.changes === 0) {
        throw new FridayDomainError("TEMPLATE_NOT_FOUND", "TEMPLATE_NOT_FOUND", { httpStatus: 404 });
      }
    },
  };
}
