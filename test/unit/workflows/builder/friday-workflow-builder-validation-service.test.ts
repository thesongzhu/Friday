import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowBuilderValidationService } from "#workflows";
import { createFridayWorkflowCompiler } from "#workflows";
import { createFridayWorkflowValidator } from "#workflows";
import { createFridaySkillRepository } from "#skills";
import type { FridayWorkflowDraftEntity } from "#workflows";
import { createTestSpec, createTestSpecWithEdge, createTestVisual } from "./_helpers/create-test-spec.helper.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.helper.js";

describe("FridayWorkflowBuilderValidationService", () => {
  const NOW = "2025-06-15T10:00:00.000Z";
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    const idGen = createTestIdGenerator();
    const compiler = createFridayWorkflowCompiler({
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
      idGenerator: idGen,
    });
    const validator = createFridayWorkflowValidator();

    return createFridayWorkflowBuilderValidationService({
      compiler,
      validator,
      nowIso: () => NOW,
      idGenerator: idGen,
    });
  }

  function makeDraft(overrides?: Partial<FridayWorkflowDraftEntity>): FridayWorkflowDraftEntity {
    return {
      draftId: "draft-1",
      workflowId: "wf-1",
      title: "Test Draft",
      status: "active",
      revision: 1,
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      createdAt: NOW,
      updatedAt: NOW,
      autosave: { enabled: true, intervalMs: 30000 },
      ...overrides,
    };
  }

  it("validates a valid spec", () => {
    const service = createService();
    const report = service.validateSpec(createTestSpec());

    expect(report.valid).toBe(true);
    expect(report.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    expect(report.compiledGraphPreview).toBeDefined();
  });

  it("reports error for missing name", () => {
    const service = createService();
    const spec = createTestSpec({ name: "" });
    const report = service.validateSpec(spec);

    expect(report.valid).toBe(false);
    const nameIssue = report.issues.find((i) => i.code === "SPEC_MISSING_NAME");
    expect(nameIssue).toBeDefined();
    expect(nameIssue!.stage).toBe("spec_schema");
    expect(nameIssue!.severity).toBe("error");
  });

  it("reports error for missing startStepId", () => {
    const service = createService();
    const spec = createTestSpec({ startStepId: "" });
    const report = service.validateSpec(spec);

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "SPEC_MISSING_START_STEP")).toBe(true);
  });

  it("reports error for empty steps", () => {
    const service = createService();
    const spec = createTestSpec({ steps: [] });
    const report = service.validateSpec(spec);

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "SPEC_NO_STEPS")).toBe(true);
  });

  it("reports error for startStepId not in steps", () => {
    const service = createService();
    const spec = createTestSpec({ startStepId: "nonexistent" });
    const report = service.validateSpec(spec);

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "SPEC_START_STEP_NOT_FOUND")).toBe(true);
  });

  it("reports duplicate step IDs", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "a" },
        { id: "step-1", type: "skill_call", ref: "b" },
      ],
    });
    const report = service.validateSpec(spec);

    expect(report.issues.some((i) => i.code === "SPEC_DUPLICATE_STEP_ID")).toBe(true);
  });

  it("reports edge referencing missing source step", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [{ id: "step-1", type: "skill_call", ref: "a" }],
      edges: [{ from: "nonexistent", to: "step-1" }],
    });
    const report = service.validateSpec(spec);

    expect(report.issues.some((i) => i.code === "SPEC_EDGE_MISSING_SOURCE")).toBe(true);
  });

  it("reports output referencing missing step", () => {
    const service = createService();
    const spec = createTestSpec({
      outputs: [{ key: "result", fromStep: "nonexistent", path: "data" }],
    });
    const report = service.validateSpec(spec);

    expect(report.issues.some((i) => i.code === "SPEC_OUTPUT_MISSING_STEP")).toBe(true);
  });

  it("validates a draft with visual model", () => {
    const service = createService();
    const draft = makeDraft();
    const report = service.validateDraft(draft);

    expect(report.valid).toBe(true);
  });

  it("reports canvas warning for orphan visual node", () => {
    const service = createService();
    const visual = createTestVisual("wf-1");
    visual.nodes.push({ nodeId: "orphan-node", x: 500, y: 500 });

    const draft = makeDraft({ visual });
    const report = service.validateDraft(draft);

    expect(report.issues.some((i) => i.code === "CANVAS_ORPHAN_NODE")).toBe(true);
    // Warnings don't block validity
    expect(report.valid).toBe(true);
  });

  it("reports canvas warning for invalid zoom", () => {
    const service = createService();
    const visual = createTestVisual("wf-1");
    visual.viewport.zoom = 0.01;

    const draft = makeDraft({ visual });
    const report = service.validateDraft(draft);

    expect(report.issues.some((i) => i.code === "CANVAS_INVALID_ZOOM")).toBe(true);
  });

  it("validates tests with invalid operator", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "bad test",
          inputs: {},
          assertions: [
            { path: "x", operator: "invalid" as never, expected: 1 },
          ],
        },
      ],
    });
    const report = service.validateSpec(spec);

    expect(report.issues.some((i) => i.code === "TEST_INVALID_OPERATOR")).toBe(true);
  });

  it("validates tests with mock referencing unknown step", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "mock test",
          inputs: {},
          mocks: { "nonexistent-step": { output: {} } },
          assertions: [],
        },
      ],
    });
    const report = service.validateSpec(spec);

    expect(report.issues.some((i) => i.code === "TEST_MOCK_UNKNOWN_STEP")).toBe(true);
  });

  it("validateForPublish blocks on errors", () => {
    const service = createService();
    const draft = makeDraft({
      spec: createTestSpec({ name: "", workflowId: "wf-1" }),
    });
    const report = service.validateForPublish(draft);

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "PUBLISH_BLOCKED_BY_ERRORS")).toBe(true);
  });

  it("validateForPublish passes with valid draft", () => {
    const service = createService();
    const draft = makeDraft();
    const report = service.validateForPublish(draft);

    expect(report.valid).toBe(true);
  });

  it("includes compiled graph preview on valid spec", () => {
    const service = createService();
    const report = service.validateSpec(createTestSpecWithEdge());

    expect(report.compiledGraphPreview).toBeDefined();
    expect(report.compiledGraphPreview!.schemaVersion).toBe("2.0");
    expect(report.compiledGraphPreview!.graph.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("does not include compiled graph preview when schema invalid", () => {
    const service = createService();
    const spec = createTestSpec({ steps: [] });
    const report = service.validateSpec(spec);

    expect(report.compiledGraphPreview).toBeUndefined();
  });

  // ─── skill_refs validation tests ───

  function createServiceWithSkills() {
    const idGen = createTestIdGenerator();
    const skillRepo = createFridaySkillRepository();
    const compiler = createFridayWorkflowCompiler({
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
      idGenerator: idGen,
    });
    const validator = createFridayWorkflowValidator();

    return {
      service: createFridayWorkflowBuilderValidationService({
        compiler,
        validator,
        db,
        skillRepo,
        nowIso: () => NOW,
        idGenerator: idGen,
      }),
      skillRepo,
    };
  }

  it("skill_refs reports unknown skillId", () => {
    const { service } = createServiceWithSkills();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "nonexistent-skill" },
      ],
    });

    const report = service.validateSpec(spec);
    const skillIssue = report.issues.find((i) => i.code === "SKILL_REF_NOT_FOUND");
    expect(skillIssue).toBeDefined();
    expect(skillIssue!.stage).toBe("skill_refs");
    expect(skillIssue!.severity).toBe("error");
    expect(skillIssue!.stepId).toBe("step-1");
  });

  it("skill_refs passes for installed skill", () => {
    const { service, skillRepo } = createServiceWithSkills();

    // Install the referenced skill
    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromMarketplace(writerDb, {
        id: "test-skill",
        name: "Test Skill",
        source: "marketplace",
        origin: "marketplace",
        status: "installed",
        nowIso: NOW,
      });
    });

    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "test-skill" },
      ],
    });

    const report = service.validateSpec(spec);
    const skillIssues = report.issues.filter((i) => i.stage === "skill_refs");
    expect(skillIssues).toHaveLength(0);
  });

  it("skill_refs checks tool_call refs too", () => {
    const { service } = createServiceWithSkills();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "tool_call", ref: "missing-tool" },
      ],
    });

    const report = service.validateSpec(spec);
    expect(report.issues.some((i) => i.code === "SKILL_REF_NOT_FOUND" && i.stepId === "step-1")).toBe(true);
  });
});
