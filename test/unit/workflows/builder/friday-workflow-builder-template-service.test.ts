import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowBuilderTemplateRepository } from "#workflows";
import { createFridayWorkflowBuilderDraftRepository } from "#workflows";
import { createFridayWorkflowBuilderLockRepository } from "#workflows";
import { createFridayWorkflowBuilderTemplateService } from "#workflows";
import { createFridayWorkflowBuilderDraftService } from "#workflows";
import { createFridayWorkflowBuilderCollaborationService } from "#workflows";
import { getFridayBuiltinWorkflowTemplates } from "#workflows";
import { createFridaySkillRepository } from "#skills";
import type { FridayRegisteredSkill, FridaySkillRegistry } from "#skills";
import type { SkillManifestV2 } from "#skills";
import { listFridayCrossBorderWorkflowTemplateIds } from "../../../../src/packs/cross-border/friday-cross-border-workflow-catalog";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.helper.js";

describe("FridayWorkflowBuilderTemplateService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    seedWorkflow("wf-new");
    seedWorkflow("wf-cross-border");
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const collaborationService = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    const draftService = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    });

    return createFridayWorkflowBuilderTemplateService({
      db,
      templateRepo: createFridayWorkflowBuilderTemplateRepository(),
      draftService,
      builtinTemplates: getFridayBuiltinWorkflowTemplates(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  }

  function seedWorkflow(workflowId: string): void {
    db.writer
      .prepare(
        `INSERT INTO workflows (id, slug, name, latest_version_number, is_archived, revision, etag, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, 1, ?, ?, ?)`,
      )
      .run(
        workflowId,
        `test-${workflowId}`,
        `Test ${workflowId}`,
        `etag-${workflowId}`,
        NOW,
        NOW,
      );
  }

  it("lists builtin templates", () => {
    const service = createService();
    const templates = service.listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(9);
    expect(templates.some((t) => t.kind === "builtin")).toBe(true);
  });

  it("includes the cross-border builtin workflow templates", () => {
    const service = createService();
    const templateIds = new Set(service.listTemplates().map((template) => template.templateId));

    for (const templateId of listFridayCrossBorderWorkflowTemplateIds()) {
      expect(templateIds.has(templateId)).toBe(true);
    }
  });

  it("gets a builtin template by id", () => {
    const service = createService();
    const template = service.getTemplate("builtin-blank");
    expect(template).not.toBeNull();
    expect(template!.name).toBe("Blank Workflow");
  });

  it("creates a user template", () => {
    const service = createService();
    const template = service.createUserTemplate({
      name: "My Custom Template",
      tags: ["custom"],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    expect(template.kind).toBe("user");
    expect(template.scope).toBe("user");
    expect(template.name).toBe("My Custom Template");
  });

  it("user templates appear in list with builtins", () => {
    const service = createService();
    service.createUserTemplate({
      name: "Custom",
      tags: [],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    const all = service.listTemplates();
    expect(all.some((t) => t.name === "Custom")).toBe(true);
    expect(all.some((t) => t.kind === "builtin")).toBe(true);
  });

  it("user template with same name overrides builtin", () => {
    const service = createService();
    service.createUserTemplate({
      name: "Blank Workflow",
      tags: [],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    const templates = service.listTemplates();
    const blanks = templates.filter((t) => t.name === "Blank Workflow");
    expect(blanks).toHaveLength(1);
    expect(blanks[0]!.kind).toBe("user");
  });

  it("updates a user template", () => {
    const service = createService();
    const created = service.createUserTemplate({
      name: "Original",
      tags: ["v1"],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    const updated = service.updateUserTemplate(created.templateId, {
      name: "Updated",
      tags: ["v2"],
    });

    expect(updated.name).toBe("Updated");
    expect(updated.tags).toEqual(["v2"]);
  });

  it("cannot update builtin template", () => {
    const service = createService();
    expect(() =>
      service.updateUserTemplate("builtin-blank", { name: "Hacked" }),
    ).toThrow();
  });

  it("deletes a user template", () => {
    const service = createService();
    const created = service.createUserTemplate({
      name: "Temporary",
      tags: [],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    service.deleteUserTemplate(created.templateId);

    const fetched = service.getTemplate(created.templateId);
    expect(fetched).toBeNull();
  });

  it("instantiates a template into a draft", () => {
    const service = createService();
    const draft = service.instantiateTemplate(
      "builtin-simple-action",
      "wf-new",
      "My New Workflow",
      "test-user",
    );

    expect(draft.workflowId).toBe("wf-new");
    expect(draft.title).toBe("My New Workflow");
    expect(draft.spec.workflowId).toBe("wf-new");
    expect(draft.visual.workflowId).toBe("wf-new");
    expect(draft.status).toBe("active");
  });

  it("instantiates the weekly hot-product cross-border template into a multi-step draft", () => {
    const service = createService();
    const draft = service.instantiateTemplate(
      "builtin-cross-border-weekly-hot-product-review",
      "wf-cross-border",
      "Cross-border Hot Product Review",
      "test-user",
    );

    expect(draft.spec.steps.map((step) => step.id)).toEqual([
      "detect_spikes",
      "screen_followups",
    ]);
    expect(draft.spec.edges).toEqual([
      {
        from: "detect_spikes",
        to: "screen_followups",
        when: "success",
      },
    ]);
  });

  it("throws when instantiating nonexistent template", () => {
    const service = createService();
    expect(() =>
      service.instantiateTemplate("nonexistent", "wf-1", "Title"),
    ).toThrow("Template not found");
  });

  // ─── Skill-derived template tests ───

  function createMinimalManifest(overrides?: Partial<SkillManifestV2>): SkillManifestV2 {
    return {
      schemaVersion: "2.0",
      id: "test-wf-skill",
      name: "Workflow Skill",
      description: "A skill that supports workflow mode",
      version: "1.0.0",
      kind: "workflow",
      category: "automation",
      author: { name: "test" },
      tags: ["workflow"],
      runtime: {
        kind: "builtin",
        entrypoint: "skill.ts",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30000,
      },
      triggers: { intents: [], phrases: [], channels: [] },
      invocation: {
        userInvocable: true,
        modelInvocable: false,
        priority: 1,
        modes: ["workflow"],
      },
      requirements: { bins: [], env: [], config: [], os: ["darwin"] },
      inputs: [
        { key: "data", type: "string", required: true, label: "Data" },
      ],
      outputs: [
        { key: "result", type: "string", description: "Result" },
      ],
      permissions: { allowed: [], denied: [] },
      executionTargets: { allowedSatelliteTypes: [], requiredCapabilities: [] },
      ...overrides,
    } as SkillManifestV2;
  }

  function createServiceWithSkills(skillRegistry?: FridaySkillRegistry) {
    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const skillRepo = createFridaySkillRepository();
    const collaborationService = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    const draftService = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    });

    return {
      service: createFridayWorkflowBuilderTemplateService({
        db,
        templateRepo: createFridayWorkflowBuilderTemplateRepository(),
        draftService,
        builtinTemplates: getFridayBuiltinWorkflowTemplates(),
        skillRepo,
        skillRegistry,
        idGenerator: idGen,
        nowIso: () => NOW,
      }),
      skillRepo,
    };
  }

  it("lists skill-derived templates from installed skills", () => {
    const { service, skillRepo } = createServiceWithSkills();

    // Install a workflow-capable skill
    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromCatalog(writerDb, {
        id: "test-wf-skill",
        name: "Workflow Skill",
        source: "local",
        origin: "workspace",
        status: "installed",
        currentManifest: createMinimalManifest(),
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(
        writerDb,
        "test-wf-skill",
        "1.0.0",
        createMinimalManifest(),
        NOW,
      );
    });

    const templates = service.listTemplates();
    const skillTemplate = templates.find((t) => t.kind === "skill");
    expect(skillTemplate).toBeDefined();
    expect(skillTemplate!.sourceSkillId).toBe("test-wf-skill");
    expect(skillTemplate!.name).toBe("Workflow Skill");
  });

  it("skill templates have lower precedence than user templates", () => {
    const { service, skillRepo } = createServiceWithSkills();

    // Install skill
    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromCatalog(writerDb, {
        id: "test-wf-skill",
        name: "Workflow Skill",
        source: "local",
        origin: "workspace",
        status: "installed",
        currentManifest: createMinimalManifest(),
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(
        writerDb,
        "test-wf-skill",
        "1.0.0",
        createMinimalManifest(),
        NOW,
      );
    });

    // Create user template with same name
    service.createUserTemplate({
      name: "Workflow Skill",
      tags: ["override"],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    const templates = service.listTemplates();
    const matches = templates.filter((t) => t.name === "Workflow Skill");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.kind).toBe("user");
  });

  it("skill templates have higher precedence than builtin templates", () => {
    const { service, skillRepo } = createServiceWithSkills();

    // Install skill with same name as a builtin
    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromCatalog(writerDb, {
        id: "test-wf-skill",
        name: "Blank Workflow", // same as builtin
        source: "local",
        origin: "workspace",
        status: "installed",
        currentManifest: createMinimalManifest({ name: "Blank Workflow" }),
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(
        writerDb,
        "test-wf-skill",
        "1.0.0",
        createMinimalManifest({ name: "Blank Workflow" }),
        NOW,
      );
    });

    const templates = service.listTemplates();
    const blanks = templates.filter((t) => t.name === "Blank Workflow");
    expect(blanks).toHaveLength(1);
    expect(blanks[0]!.kind).toBe("skill");
  });

  it("skill templates with non-workflow mode are excluded", () => {
    const { service, skillRepo } = createServiceWithSkills();

    // Install skill that only supports 'intent' mode (not 'workflow')
    const intentManifest = createMinimalManifest({
      invocation: {
        userInvocable: true,
        modelInvocable: false,
        priority: 1,
        modes: ["intent"],
      },
    });
    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromCatalog(writerDb, {
        id: "intent-only-skill",
        name: "Intent Only",
        source: "local",
        origin: "workspace",
        status: "installed",
        currentManifest: intentManifest,
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(writerDb, "intent-only-skill", "1.0.0", intentManifest, NOW);
    });

    const templates = service.listTemplates();
    expect(templates.find((t) => t.name === "Intent Only")).toBeUndefined();
  });

  it("excludes repo skills that are no longer installed", () => {
    const { service, skillRepo } = createServiceWithSkills();
    const manifest = createMinimalManifest({
      id: "disabled-wf-skill",
      name: "Disabled Workflow Skill",
    });

    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromCatalog(writerDb, {
        id: "disabled-wf-skill",
        name: "Disabled Workflow Skill",
        source: "local",
        origin: "workspace",
        status: "installed",
        currentManifest: manifest,
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(writerDb, "disabled-wf-skill", "1.0.0", manifest, NOW);
      skillRepo.updateLifecycleStatus(writerDb, "disabled-wf-skill", "disabled", NOW);
    });

    const templates = service.listTemplates();
    expect(templates.find((t) => t.sourceSkillId === "disabled-wf-skill")).toBeUndefined();
  });

  it("excludes registry skills that are not installed", () => {
    const candidateManifest = createMinimalManifest({
      id: "candidate-wf-skill",
      name: "Candidate Workflow Skill",
    });
    const candidateSkill = {
      manifest: candidateManifest,
      skillDir: "/tmp/candidate-wf-skill",
      source: "local",
      origin: "managed",
      status: "not_installed",
      loaded: {} as FridayRegisteredSkill["loaded"],
      validation: { ok: true, issues: [] },
      trust: {} as FridayRegisteredSkill["trust"],
    } as FridayRegisteredSkill;
    const skillRegistry = {
      list: () => [candidateSkill],
    } as FridaySkillRegistry;
    const { service } = createServiceWithSkills(skillRegistry);

    const templates = service.listTemplates();
    expect(templates.find((t) => t.sourceSkillId === "candidate-wf-skill")).toBeUndefined();
  });

  it("keeps persisted unavailable status authoritative over registry templates", () => {
    const manifest = createMinimalManifest({
      id: "candidate-wf-skill",
      name: "Candidate Workflow Skill",
    });
    const registrySkill = {
      manifest,
      skillDir: "/tmp/candidate-wf-skill",
      source: "local",
      origin: "managed",
      status: "installed",
      loaded: {} as FridayRegisteredSkill["loaded"],
      validation: { ok: true, issues: [] },
      trust: {} as FridayRegisteredSkill["trust"],
    } as FridayRegisteredSkill;
    const skillRegistry = {
      list: () => [registrySkill],
    } as FridaySkillRegistry;
    const { service, skillRepo } = createServiceWithSkills(skillRegistry);

    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromCatalog(writerDb, {
        id: "candidate-wf-skill",
        name: "Candidate Workflow Skill",
        source: "local",
        origin: "managed",
        status: "not_installed",
        currentManifest: manifest,
        nowIso: NOW,
      });
    });

    const templates = service.listTemplates();
    expect(templates.find((t) => t.sourceSkillId === "candidate-wf-skill")).toBeUndefined();
  });

  it("getTemplate finds skill-derived template by id", () => {
    const { service, skillRepo } = createServiceWithSkills();

    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromCatalog(writerDb, {
        id: "test-wf-skill",
        name: "Workflow Skill",
        source: "local",
        origin: "workspace",
        status: "installed",
        currentManifest: createMinimalManifest(),
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(writerDb, "test-wf-skill", "1.0.0", createMinimalManifest(), NOW);
    });

    const template = service.getTemplate("skill-test-wf-skill");
    expect(template).not.toBeNull();
    expect(template!.kind).toBe("skill");
  });
});
