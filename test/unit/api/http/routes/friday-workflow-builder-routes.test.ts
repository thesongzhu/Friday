import { describe, it, expect, vi } from "vitest";
import {
  createFridayWorkflowBuilderRoutes,
  createFridayWorkflowBuilderTemplateRoutes,
} from "#api";
import type {
  FridayAuthPrincipal,
  FridayHttpContext,
  FridayWorkflowBuilderRoutesDeps,
  FridayWorkflowBuilderTemplateRoutesDeps,
} from "#api";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";
import type {
  FridayWorkflowDraftEntity,
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowBuilderValidationReport,
} from "#api";

/** Handlers are never invoked; stubs only satisfy the type signature. */
const stubDraft = {} as unknown as FridayWorkflowDraftEntity;
const stubCompiled = {} as unknown as FridayCompiledWorkflowGraphV2;
const stubValidation = {} as unknown as FridayWorkflowBuilderValidationReport;
const NOW = "2026-05-22T00:00:00.000Z";

function makePrincipal(overrides: Partial<FridayAuthPrincipal> = {}): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "user-1",
    userId: "user-1",
    role: "operator",
    scopes: ["workflow.write"],
    tokenId: "token-1",
    tokenKind: "access",
    issuedAt: NOW,
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {},
): FridayHttpContext<unknown, unknown, unknown> {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: { workflowId: "wf-1", draftId: "draft-1", templateId: "template-1" },
    query: {},
    body: {},
    headers: {},
    principal: makePrincipal(),
    ...overrides,
  };
}

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
    // Opt isolated builder route tests into the legacy import oracle so the
    // shared `routes` fixture still exercises the principal-authority path.
    // Default/live runtime leaves this unset (proven below).
    allowTestOnlyWorkflowBundleImportExecution: true,
    allowTestOnlyWorkflowBuilderDraftExecution: true,
  };
  const stubTemplateDeps: FridayWorkflowBuilderTemplateRoutesDeps = {
    listTemplates: () => ({ items: [] }),
    getTemplate: () => ({ template: {} as never }),
    instantiateTemplate: () => ({ draft: stubDraft }),
    allowTestOnlyWorkflowBuilderDraftExecution: true,
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
    expect(route!.auth).toEqual({ public: true });
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
    expect(route!.auth).toEqual({ public: true });
  });

  it("GET /v1/workflows/:workflowId/drafts/:draftId/export requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "drafts.export");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: true });
  });

  it("POST /v1/workflows/:workflowId/import requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "workflows.bundles.import");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: true });
  });

  it("GET /v1/workflow-builder/templates requires workflow.read", () => {
    const route = templateRoutes.find((r) => r.operationId === "templates.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/workflow-builder/templates");
    expect(route!.auth).toEqual({ public: true });
  });

  it("POST /v1/workflow-builder/templates/:templateId/instantiate requires workflow.write", () => {
    const route = templateRoutes.find((r) => r.operationId === "templates.instantiate");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.path).toBe("/v1/workflow-builder/templates/:templateId/instantiate");
    expect(route!.auth).toEqual({ public: true });
  });

  it.each([
    [templateRoutes, "templates.instantiate"],
    [routes, "drafts.create"],
    [routes, "workflows.bundles.import"],
    [routes, "drafts.save"],
    [routes, "drafts.autosave"],
    [routes, "drafts.compile"],
    [routes, "drafts.publish"],
    [routes, "locks.acquire"],
    [routes, "locks.renew"],
    [routes, "locks.release"],
  ])("%s rejects a bound principal without workflow write authority", async (routeSet, operationId) => {
    const route = routeSet.find((r) => r.operationId === operationId)!;
    await expect(
      route.handler(makeCtx({
        principal: makePrincipal({ role: "viewer", scopes: ["workflow.read"] }),
      })),
    ).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_AUTHORITY_REQUIRED",
      httpStatus: 403,
    });
  });

  it("rejects the synthetic public principal before template instantiation", async () => {
    const route = templateRoutes.find((r) => r.operationId === "templates.instantiate")!;
    await expect(
      route.handler(makeCtx({ principal: createFridayDefaultPublicHttpPrincipal() })),
    ).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      httpStatus: 401,
    });
  });

  it("allows a bound workflow writer to create a draft", async () => {
    const route = routes.find((r) => r.operationId === "drafts.create")!;
    await expect(route.handler(makeCtx({ body: { title: "Draft" } }))).resolves.toEqual({
      draft: stubDraft,
    });
  });

  it("fail-closes workflows.bundles.import by default and never calls importWorkflowBundle", async () => {
    const importSpy = vi.fn(() => ({ result: {} as never }));
    const failClosedRoutes = createFridayWorkflowBuilderRoutes({
      ...stubDeps,
      allowTestOnlyWorkflowBundleImportExecution: false,
      importWorkflowBundle: importSpy,
    });
    const route = failClosedRoutes.find((r) => r.operationId === "workflows.bundles.import")!;

    // Guard fires before the principal check, so even a bound workflow writer
    // is fail-closed in default/live runtime.
    await expect(
      route.handler(makeCtx({ body: { bundle: { schemaVersion: "1.0" } } })),
    ).rejects.toMatchObject({
      code: "TS_RUNTIME_WORKFLOW_BUNDLE_IMPORT_RETIRED",
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_bundle_import_entrypoint_required",
      },
    });
    expect(importSpy).not.toHaveBeenCalled();
  });

  it("fail-closes workflow builder draft/lock mutations by default", async () => {
    const createSpy = vi.fn(() => ({ draft: stubDraft }));
    const saveSpy = vi.fn(() => ({ draft: stubDraft }));
    const autosaveSpy = vi.fn(() => ({ draft: null }));
    const compileSpy = vi.fn(() => ({ compiled: stubCompiled, validation: stubValidation }));
    const publishSpy = vi.fn(() => ({
      workflowId: "",
      workflowVersionId: "",
      versionNumber: 1,
      published: true,
      checksum: "",
      validation: stubValidation,
    }));
    const acquireSpy = vi.fn(() => ({ acquired: true }));
    const renewSpy = vi.fn(() => ({ lock: null }));
    const releaseSpy = vi.fn(() => ({ released: true as const }));
    const failClosedRoutes = createFridayWorkflowBuilderRoutes({
      ...stubDeps,
      allowTestOnlyWorkflowBuilderDraftExecution: false,
      createDraft: createSpy,
      saveDraft: saveSpy,
      autosaveDraft: autosaveSpy,
      compileDraft: compileSpy,
      publishDraft: publishSpy,
      acquireLock: acquireSpy,
      renewLock: renewSpy,
      releaseLock: releaseSpy,
    });
    const cases: Array<[string, Partial<FridayHttpContext<unknown, unknown, unknown>>]> = [
      ["drafts.create", { body: { title: "D" } }],
      ["drafts.save", { body: { title: "D2" } }],
      ["drafts.autosave", { body: { title: "D3" } }],
      ["drafts.compile", { body: {} }],
      ["drafts.publish", { body: {} }],
      ["locks.acquire", { body: {} }],
      ["locks.renew", { body: {} }],
      ["locks.release", { body: {} }],
    ];
    for (const [operationId, ctx] of cases) {
      await expect(
        failClosedRoutes.find((r) => r.operationId === operationId)!.handler(makeCtx(ctx)),
      ).rejects.toMatchObject({
        code: "TS_RUNTIME_WORKFLOW_BUILDER_DRAFT_RETIRED",
        httpStatus: 503,
        details: { classification: "fail_closed" },
      });
    }
    for (const mutation of [createSpy, saveSpy, autosaveSpy, compileSpy, publishSpy, acquireSpy, renewSpy, releaseSpy]) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it("fail-closes templates.instantiate by default", async () => {
    const instSpy = vi.fn(() => ({ draft: stubDraft }));
    const failClosedTemplateRoutes = createFridayWorkflowBuilderTemplateRoutes({
      ...stubTemplateDeps,
      allowTestOnlyWorkflowBuilderDraftExecution: false,
      instantiateTemplate: instSpy,
    });
    await expect(
      failClosedTemplateRoutes.find((r) => r.operationId === "templates.instantiate")!.handler(makeCtx({ body: {} })),
    ).rejects.toMatchObject({ code: "TS_RUNTIME_WORKFLOW_BUILDER_DRAFT_RETIRED", httpStatus: 503 });
    expect(instSpy).not.toHaveBeenCalled();
  });
});
