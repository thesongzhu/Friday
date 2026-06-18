import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowBuilderTemplateRepository } from "#workflows";
import type { FridayWorkflowTemplateEntity } from "#workflows";
import { createTestDb } from "../_helpers/create-test-db.helper.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.helper.js";

describe("FridayWorkflowBuilderTemplateRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function makeTemplate(overrides?: Partial<FridayWorkflowTemplateEntity>): FridayWorkflowTemplateEntity {
    return {
      templateId: "tmpl-1",
      kind: "user",
      scope: "user",
      ownerUserId: "test-user",
      name: "My Template",
      description: "A test template",
      tags: ["test"],
      spec: createTestSpec(),
      visual: createTestVisual(),
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function insertLegacyTemplate(template: FridayWorkflowTemplateEntity): void {
    db.writer
      .prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        template.templateId,
        "workflow_builder_templates",
        `${template.scope}:${template.ownerUserId ?? "global"}:${template.templateId}`,
        JSON.stringify(template),
        template.createdAt,
        template.updatedAt,
      );
  }

  it("creates and retrieves a template", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();
    const template = makeTemplate();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, template);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "tmpl-1"));
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("My Template");
    expect(fetched!.kind).toBe("user");
  });

  it("returns null for missing template", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();
    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "nonexistent"));
    expect(fetched).toBeNull();
  });

  it("lists templates by scope", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, makeTemplate({ templateId: "tmpl-1", scope: "user", ownerUserId: "test-user" }));
      repo.create(writerDb, makeTemplate({ templateId: "tmpl-2", scope: "global", ownerUserId: undefined }));
    });

    const userTemplates = db.withReadConnection((readerDb) => repo.list(readerDb, "user"));
    expect(userTemplates).toHaveLength(1);

    const globalTemplates = db.withReadConnection((readerDb) => repo.list(readerDb, "global"));
    expect(globalTemplates).toHaveLength(1);

    const allTemplates = db.withReadConnection((readerDb) => repo.list(readerDb));
    expect(allTemplates).toHaveLength(2);
  });

  it("updates a template", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();
    const template = makeTemplate();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, template);
    });

    const updated = { ...template, name: "Updated Name", updatedAt: "2025-06-15T11:00:00.000Z" };
    db.withWriteTransaction((writerDb) => {
      repo.update(writerDb, updated);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "tmpl-1"));
    expect(fetched!.name).toBe("Updated Name");
  });

  it("deletes a template", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, makeTemplate());
    });

    db.withWriteTransaction((writerDb) => {
      repo.delete(writerDb, "tmpl-1");
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "tmpl-1"));
    expect(fetched).toBeNull();
  });

  it("throws on delete of missing template", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();

    expect(() =>
      db.withWriteTransaction((writerDb) => repo.delete(writerDb, "nonexistent")),
    ).toThrow("TEMPLATE_NOT_FOUND");
  });

  it("stores templates in the dedicated table and writes zero memory_items rows", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, makeTemplate());
    });

    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT template_id, scope, owner_user_id FROM workflow_builder_templates WHERE template_id = ?")
        .get("tmpl-1"),
    ) as { template_id: string; scope: string; owner_user_id: string };

    const memoryRows = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT COUNT(*) AS count FROM memory_items WHERE namespace = ?")
        .get("workflow_builder_templates"),
    ) as { count: number };

    expect(row.template_id).toBe("tmpl-1");
    expect(row.scope).toBe("user");
    expect(row.owner_user_id).toBe("test-user");
    expect(memoryRows.count).toBe(0);
  });

  it("round-trips JSON correctly", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();
    const template = makeTemplate();
    template.tags = ["tag1", "tag2", "tag3"];

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, template);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "tmpl-1"));
    expect(fetched!.tags).toEqual(["tag1", "tag2", "tag3"]);
    expect(fetched!.spec.schemaVersion).toBe("1.0");
  });

  it("reads legacy memory_items templates without writing back to memory_items", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();
    insertLegacyTemplate(makeTemplate({ templateId: "legacy-tmpl" }));

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "legacy-tmpl"));
    expect(fetched).not.toBeNull();
    expect(fetched!.templateId).toBe("legacy-tmpl");

    const listed = db.withReadConnection((readerDb) => repo.list(readerDb, "user"));
    expect(listed.map((template) => template.templateId)).toContain("legacy-tmpl");
  });
});
