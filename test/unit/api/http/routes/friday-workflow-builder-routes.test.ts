import { describe, it, expect } from "vitest";
import {
  createFridayWorkflowBuilderRoutes,
  createFridayWorkflowBuilderTemplateRoutes,
} from "#api";
import type {
  FridayWorkflowBuilderRoutesDeps,
  FridayWorkflowBuilderTemplateRoutesDeps,
} from "#api";
import type {
  FridayWorkflowDraftEntity,
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowBuilderValidationReport,
} from "#api";

/** Handlers are never invoked; stubs only satisfy the type signature. */
const stubDraft = {} as unknown as FridayWorkflowDraftEntity;
const stubCompiled = {} as unknown as FridayCompiledWorkflowGraphV2;
const stubValidation = {} as unknown as FridayWorkflowBuilderValidationReport;

describe("FridayWorkflowBuilderRoutes", () => {
  const stubDeps: FridayWorkflowBuilderRoutesDeps = {
    createDraft: () => ({ draft: stubDraft }),
    listDrafts: () => ({ items: [] }),
    getDraft: () => ({ draft: stubDraft }),
    exportDraftBundle: () => ({ bundle: {} as never }),
    importWorkflowBundle: () => ({ result: {} as never }),
    saveDraft: () => ({ draft: stubDraft }),
    autosaveDraft: () => ({ draft: null }),
    compileDraft: () => ({ compiled: stubCompiled, validation: stubValidation }),
    publishDraft: () => ({
      workflowId: "",
      workflowVersionId: "",
      versionNumber: 1,
      published: true,
      checksum: "",
      validation: stubValidation,
    }),
    acquireLock: () => ({ acquired: true }),
    renewLock: () => ({ lock: null }),
    releaseLock: () => ({ released: true as const }),
  };
  const stubTemplateDeps: FridayWorkflowBuilderTemplateRoutesDeps = {
    listTemplates: () => ({ items: [] }),
    getTemplate: () => ({ template: {} as never }),
    instantiateTemplate: () => ({ draft: stubDraft }),
  };

  const routes = createFridayWorkflowBuilderRoutes(stubDeps);
  const templateRoutes = createFridayWorkflowBuilderTemplateRoutes(stubTemplateDeps);

  it("registers 12 builder routes (9 draft/workflow IO + 3 lock)", () => {
    expect(routes).toHaveLength(12);
  });

  it("registers 3 template routes", () => {
    expect(templateRoutes).toHaveLength(3);
  });

  it("GET /v1/workflows/:workflowId/drafts requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "drafts.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });
  });

  it("POST /v1/workflows/:workflowId/drafts/:draftId/publish has rate limit", () => {
    const route = routes.find((r) => r.operationId === "drafts.publish");
    expect(route).toBeDefined();
    expect(route!.rateLimitPolicyId).toBe("workflow.publish");
  });

  it("POST /v1/workflows/:workflowId/locks/acquire requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "locks.acquire");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.write"] });
  });

  it("GET /v1/workflows/:workflowId/drafts/:draftId/export requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "drafts.export");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });
  });

  it("POST /v1/workflows/:workflowId/import requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "workflows.bundles.import");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.write"] });
  });

  it("GET /v1/workflow-builder/templates requires workflow.read", () => {
    const route = templateRoutes.find((r) => r.operationId === "templates.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/workflow-builder/templates");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });
  });

  it("POST /v1/workflow-builder/templates/:templateId/instantiate requires workflow.write", () => {
    const route = templateRoutes.find((r) => r.operationId === "templates.instantiate");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.path).toBe("/v1/workflow-builder/templates/:templateId/instantiate");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.write"] });
  });
});
