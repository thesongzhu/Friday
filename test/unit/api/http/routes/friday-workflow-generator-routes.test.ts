import { describe, it, expect, vi } from "vitest";

import { createFridayWorkflowGeneratorRoutes } from "#api";
import type { FridayAuthPrincipal } from "#api";
import type { FridayWorkflowGeneratorService } from "#workflows";
import { createFridayDefaultPublicHttpPrincipal } from "../../../../../src/api/http/friday-default-public-principal.js";
import type { FridayRustHubWorkflowCatalogBridgeService } from "../../../../../src/api/mission-spine/friday-rust-hub-workflow-catalog-bridge-service.js";

const NOW = "2026-01-01T00:00:00.000Z";

function makePrincipal(overrides: Partial<FridayAuthPrincipal> = {}): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "u-1",
    userId: "u-1",
    role: "operator",
    scopes: ["workflow.write"],
    tokenId: "token-1",
    tokenKind: "access",
    issuedAt: NOW,
    ...overrides,
  };
}

// ─── Mock service ───

function makeMockService(): FridayWorkflowGeneratorService {
  return {
    startSession: vi.fn(async (input) => ({
      session: {
        sessionId: "s-1",
        userId: input.userId,
        channel: input.channel,
        status: "needs_clarification" as const,
        goal: input.goal,
        requirementsSummary: "",
        openQuestions: ["Q1"],
        decisions: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
      mode: "clarification_required" as const,
      questions: ["Q1"],
    })),
    submitTurn: vi.fn(async () => ({
      session: {
        sessionId: "s-1",
        userId: "u-1",
        channel: "test",
        status: "needs_clarification" as const,
        goal: "test",
        requirementsSummary: "",
        openQuestions: [],
        decisions: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
      mode: "clarification_required" as const,
    })),
    getSession: vi.fn(async (sessionId: string) => {
      if (sessionId === "not-found") return null;
      return {
        session: {
          sessionId,
          userId: "u-1",
          channel: "test",
          status: "ready_for_review" as const,
          goal: "test",
          requirementsSummary: "",
          openQuestions: [],
          decisions: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
        turns: [],
        draft: {
          spec: {} as never,
          visual: {} as never,
          tests: [],
          compiledGraph: {} as never,
          validation: { ok: true, issues: [], repaired: false, repairAttempts: 0 },
        },
      };
    }),
    generateDraft: vi.fn(async () => ({
      spec: {} as never,
      visual: {} as never,
      tests: [],
      compiledGraph: {} as never,
      validation: { ok: true, issues: [], repaired: false, repairAttempts: 0 },
    })),
    approveAndSave: vi.fn(async () => ({
      sessionId: "s-1",
      workflowId: "wf-1",
      workflowVersionId: "wv-1",
      versionNumber: 1,
      slug: "test-workflow",
      published: true,
      publicationBoundary: {
        stage: "published_version",
        lifecyclePromotion: "not_lifecycle_promoted",
        proofBoundary: "crud_publish_only",
        summary: "Published through Workflow CRUD only; lifecycle promotion is not claimed.",
      },
    })),
    getQaVerdict: vi.fn(async () => null),
    getHarnessSummary: vi.fn(async () => null),
    cancelSession: vi.fn(async () => undefined),
  };
}

function makeMockRustCatalogBridge(): FridayRustHubWorkflowCatalogBridgeService {
  return {
    mutateCatalog: vi.fn(async (input) => ({
      truthLabel: "rust_wired_dev" as const,
      proofOnly: true,
      op: input.op,
      workflowId: input.workflowId,
      slugSha256: "slug-sha",
      slugLen: "slug" in input ? input.slug.length : 12,
      nameSha256: "name-sha",
      nameLen: "name" in input ? input.name.length : 18,
      descriptionSha256: null,
      descriptionLen: null,
      tagsJsonSha256: "tags-sha",
      tagsJsonLen: 2,
      isArchived: false,
      revision: input.op === "publish" ? 2 : 1,
      etag: "etag-sha",
      deployedVersion: null,
      createdAtMs: 1_767_225_600_000,
      updatedAtMs: 1_767_225_600_000,
      ...(input.op === "publish" ? { publishedVersion: input.version } : {}),
    })),
  };
}

// ─── Route helper ───

function makeCtx(overrides: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  principal?: unknown;
}) {
  return {
    requestId: "req-1",
    receivedAt: NOW,
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: overrides.body ?? {},
    headers: overrides.headers ?? {},
    principal: overrides.principal ?? makePrincipal(),
  };
}

// ─── Tests ───

describe("FridayWorkflowGeneratorRoutes", () => {
  const service = makeMockService();
  const routes = createFridayWorkflowGeneratorRoutes({
    workflowGenerator: service,
    allowTestOnlyWorkflowGeneratorExecution: true,
  });

  it.each([
    ["workflows.generator.sessions.create", { body: { goal: "Build workflow", userId: "u-1", channel: "test" } }],
    ["workflows.generator.sessions.get", { params: { sessionId: "s-1" } }],
    [
      "workflows.generator.sessions.messages.create",
      { params: { sessionId: "s-1" }, body: { message: "Use manual trigger" } },
    ],
    ["workflows.generator.sessions.generate", { params: { sessionId: "s-1" }, body: {} }],
    ["workflows.generator.sessions.evidence.get", { params: { sessionId: "s-1" } }],
    ["workflows.generator.sessions.approve", { params: { sessionId: "s-1" }, body: {} }],
    ["workflows.generator.sessions.cancel", { params: { sessionId: "s-1" } }],
  ])("%s fail-closes by default without invoking the TypeScript generator", async (operationId, ctxOverrides) => {
    const localService = makeMockService();
    const localRoutes = createFridayWorkflowGeneratorRoutes({
      workflowGenerator: localService,
    });
    const route = localRoutes.find((r) => r.operationId === operationId)!;

    await expect(
      route.handler(makeCtx(ctxOverrides) as never),
    ).rejects.toMatchObject({
      code: "TS_RUNTIME_WORKFLOW_GENERATOR_RETIRED",
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_generator_entrypoint_required",
      },
    });
    expect(localService.startSession).not.toHaveBeenCalled();
    expect(localService.getSession).not.toHaveBeenCalled();
    expect(localService.submitTurn).not.toHaveBeenCalled();
    expect(localService.generateDraft).not.toHaveBeenCalled();
    expect(localService.approveAndSave).not.toHaveBeenCalled();
    expect(localService.cancelSession).not.toHaveBeenCalled();
  });

  it("creates exactly 7 routes", () => {
    expect(routes).toHaveLength(7);
  });

  it("has correct operation IDs", () => {
    const opIds = routes.map((r) => r.operationId).sort();
    expect(opIds).toEqual([
      "workflows.generator.sessions.approve",
      "workflows.generator.sessions.cancel",
      "workflows.generator.sessions.create",
      "workflows.generator.sessions.evidence.get",
      "workflows.generator.sessions.generate",
      "workflows.generator.sessions.get",
      "workflows.generator.sessions.messages.create",
    ]);
  });

  it("has correct HTTP methods", () => {
    const methods = new Map(routes.map((r) => [r.operationId, r.method]));
    expect(methods.get("workflows.generator.sessions.create")).toBe("POST");
    expect(methods.get("workflows.generator.sessions.get")).toBe("GET");
    expect(methods.get("workflows.generator.sessions.messages.create")).toBe("POST");
    expect(methods.get("workflows.generator.sessions.generate")).toBe("POST");
    expect(methods.get("workflows.generator.sessions.evidence.get")).toBe("GET");
    expect(methods.get("workflows.generator.sessions.approve")).toBe("POST");
    expect(methods.get("workflows.generator.sessions.cancel")).toBe("DELETE");
  });

  it("has correct paths", () => {
    const paths = new Map(routes.map((r) => [r.operationId, r.path]));
    expect(paths.get("workflows.generator.sessions.create")).toBe("/v1/workflows/generator/sessions");
    expect(paths.get("workflows.generator.sessions.get")).toBe("/v1/workflows/generator/sessions/:sessionId");
    expect(paths.get("workflows.generator.sessions.messages.create")).toBe("/v1/workflows/generator/sessions/:sessionId/messages");
    expect(paths.get("workflows.generator.sessions.generate")).toBe("/v1/workflows/generator/sessions/:sessionId/generate");
    expect(paths.get("workflows.generator.sessions.evidence.get")).toBe("/v1/workflows/generator/sessions/:sessionId/evidence");
    expect(paths.get("workflows.generator.sessions.approve")).toBe("/v1/workflows/generator/sessions/:sessionId/approve");
    expect(paths.get("workflows.generator.sessions.cancel")).toBe("/v1/workflows/generator/sessions/:sessionId");
  });

  it("all routes require auth", () => {
    for (const route of routes) {
      expect(route.auth).toEqual({ public: true });
    }
  });

  it("create session delegates to service", async () => {
    const createRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.create")!;
    const result = await createRoute.handler(
      makeCtx({
        body: { goal: "Build workflow", userId: "u-1", channel: "test" },
      }) as never,
    );
    expect(service.startSession).toHaveBeenCalledWith({
      goal: "Build workflow",
      userId: "u-1",
      channel: "test",
      requestedModel: undefined,
      tenantContext: {
        hubId: "u-1",
        userId: "u-1",
        channelKind: "test",
      },
    });
    expect(result).toBeDefined();
  });

  it("routes workflow generator create and approve through the Rust catalog bridge when the Rust route is enabled", async () => {
    const localService = makeMockService();
    const rustBridge = makeMockRustCatalogBridge();
    const localRoutes = createFridayWorkflowGeneratorRoutes({
      workflowGenerator: localService,
      routeWorkflowGeneratorViaRust: true,
      rustWorkflowCatalogBridge: rustBridge,
      idGenerator: vi.fn()
        .mockReturnValueOnce("session-rust-1")
        .mockReturnValueOnce("workflow-rust-1")
        .mockReturnValueOnce("version-rust-1")
        .mockReturnValueOnce("edge-rust-1"),
      nowIso: () => NOW,
      computeChecksum: () => "checksum-rust-1",
    } as never);
    const createRoute = localRoutes.find((r) => r.operationId === "workflows.generator.sessions.create")!;
    const approveRoute = localRoutes.find((r) => r.operationId === "workflows.generator.sessions.approve")!;

    const started = await createRoute.handler(
      makeCtx({
        body: { goal: "Build workflow", userId: "u-1", channel: "test" },
      }) as never,
    );
    expect(started).toHaveProperty("session.sessionId", "session-rust-1");
    expect(started).toHaveProperty("mode", "preview_ready");
    expect(started).toHaveProperty("draft.validation.ok", true);

    const approved = await approveRoute.handler(
      makeCtx({ params: { sessionId: "session-rust-1" } }) as never,
    );
    expect(approved).toHaveProperty("workflowId", "workflow-rust-1");
    expect(approved).toHaveProperty("workflowVersionId", "version-rust-1");
    expect(approved).toHaveProperty("publicationBoundary.proofBoundary", "crud_publish_only");
    expect(rustBridge.mutateCatalog).toHaveBeenCalledTimes(2);
    const createInput = vi.mocked(rustBridge.mutateCatalog).mock.calls[0]?.[0] as { defJson?: string };
    expect(createInput.defJson).toBeDefined();
    const rustDefinition = JSON.parse(createInput.defJson!);
    expect(rustDefinition).toMatchObject({
      schema_version: 1,
      name: "Build workflow",
      steps: [
        expect.objectContaining({
          id: "emit_hello_world",
          action: "read_file",
          params: [["path", "README.md"]],
          force_checkpoint: false,
          evidence_required: false,
        }),
      ],
    });
    expect(rustDefinition).not.toHaveProperty("schemaVersion");
    expect(rustDefinition).not.toHaveProperty("graph");
    expect(rustBridge.mutateCatalog).toHaveBeenNthCalledWith(1, expect.objectContaining({
      op: "create",
      workflowId: "workflow-rust-1",
    }));
    expect(rustBridge.mutateCatalog).toHaveBeenNthCalledWith(2, {
      op: "publish",
      workflowId: "workflow-rust-1",
      version: 1,
    });
    expect(localService.startSession).not.toHaveBeenCalled();
    expect(localService.generateDraft).not.toHaveBeenCalled();
    expect(localService.approveAndSave).not.toHaveBeenCalled();
  });

  it.each([
    ["workflows.generator.sessions.create", { body: { goal: "Build workflow", userId: "u-1", channel: "test" } }],
    ["workflows.generator.sessions.messages.create", { params: { sessionId: "s-1" }, body: { message: "Use manual trigger" } }],
    ["workflows.generator.sessions.generate", { params: { sessionId: "s-1" }, body: {} }],
    ["workflows.generator.sessions.approve", { params: { sessionId: "s-1" }, body: {} }],
    ["workflows.generator.sessions.cancel", { params: { sessionId: "s-1" }, body: {} }],
  ])("%s rejects synthetic public principals from generator mutations", async (operationId, ctxOverrides) => {
    const localService = makeMockService();
    const localRoutes = createFridayWorkflowGeneratorRoutes({
      workflowGenerator: localService,
      allowTestOnlyWorkflowGeneratorExecution: true,
    });
    const route = localRoutes.find((r) => r.operationId === operationId)!;
    await expect(
      route.handler(makeCtx({
        ...ctxOverrides,
        principal: createFridayDefaultPublicHttpPrincipal(),
      }) as never),
    ).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      httpStatus: 401,
    });
    expect(localService.startSession).not.toHaveBeenCalled();
    expect(localService.submitTurn).not.toHaveBeenCalled();
    expect(localService.generateDraft).not.toHaveBeenCalled();
    expect(localService.approveAndSave).not.toHaveBeenCalled();
    expect(localService.cancelSession).not.toHaveBeenCalled();
  });

  it("rejects a create-session userId that does not match the bound principal", async () => {
    const createRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.create")!;
    await expect(
      createRoute.handler(makeCtx({
        body: { goal: "Build workflow", userId: "other-user", channel: "test" },
      }) as never),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      httpStatus: 400,
    });
  });

  it("create session validates required fields", async () => {
    const createRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.create")!;

    await expect(
      createRoute.handler(makeCtx({ body: { userId: "u-1", channel: "test" } }) as never),
    ).rejects.toThrow("goal");

    await expect(
      createRoute.handler(makeCtx({ body: { goal: "test", channel: "test" } }) as never),
    ).rejects.toThrow("userId");

    await expect(
      createRoute.handler(makeCtx({ body: { goal: "test", userId: "u-1" } }) as never),
    ).rejects.toThrow("channel");
  });

  it("get session returns 404 for unknown session", async () => {
    const getRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.get")!;
    await expect(
      getRoute.handler(makeCtx({ params: { sessionId: "not-found" } }) as never),
    ).rejects.toThrow("Generation session not found");
  });

  it("submit message delegates to service", async () => {
    const messageRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.messages.create")!;
    await messageRoute.handler(
      makeCtx({
        params: { sessionId: "s-1" },
        body: { message: "Use manual trigger" },
      }) as never,
    );
    expect(service.submitTurn).toHaveBeenCalledWith("s-1", {
      message: "Use manual trigger",
      requestedModel: undefined,
    });
  });

  it("submit message validates required fields", async () => {
    const messageRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.messages.create")!;
    await expect(
      messageRoute.handler(makeCtx({ params: { sessionId: "s-1" }, body: {} }) as never),
    ).rejects.toThrow("message");
  });

  it("generate delegates to service", async () => {
    const genRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.generate")!;
    const result = await genRoute.handler(
      makeCtx({ params: { sessionId: "s-1" }, body: {} }) as never,
    );
    expect(service.generateDraft).toHaveBeenCalledWith("s-1", undefined);
    expect(result).toHaveProperty("draft");
  });

  it("does not claim publication in evidence before approve publishes", async () => {
    const evidenceRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.evidence.get")!;
    const result = await evidenceRoute.handler(
      makeCtx({ params: { sessionId: "s-1" } }) as never,
    );

    expect(result).not.toHaveProperty("evidence.publicationBoundary");
    expect(result).toHaveProperty(
      "evidence.approvalReadiness.reason",
      "Draft passed generator validation and is ready for QA review.",
    );
  });

  it("keeps publication boundary in evidence after approve removes the draft", async () => {
    const evidenceRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.evidence.get")!;
    vi.mocked(service.getSession).mockResolvedValueOnce({
      session: {
        sessionId: "s-saved",
        userId: "u-1",
        channel: "test",
        status: "saved",
        goal: "test",
        requirementsSummary: "",
        openQuestions: [],
        decisions: [],
        workflowId: "wf-1",
        workflowVersionId: "wv-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      turns: [],
    });

    const result = await evidenceRoute.handler(
      makeCtx({ params: { sessionId: "s-saved" } }) as never,
    );

    expect(result).toHaveProperty("evidence.publicationBoundary.proofBoundary", "crud_publish_only");
    expect(result).toHaveProperty("evidence.publicationBoundary.lifecyclePromotion", "not_lifecycle_promoted");
    expect(result).toHaveProperty(
      "evidence.approvalReadiness.reason",
      "Generated workflow version published through Workflow CRUD; lifecycle promotion is not claimed.",
    );
  });

  it("approve delegates to service", async () => {
    const approveRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.approve")!;
    const result = await approveRoute.handler(
      makeCtx({ params: { sessionId: "s-1" } }) as never,
    );
    expect(service.approveAndSave).toHaveBeenCalledWith("s-1");
    expect(result).toHaveProperty("workflowId");
    expect(result).toHaveProperty("publicationBoundary.lifecyclePromotion", "not_lifecycle_promoted");
    expect(result).toHaveProperty("evidence.publicationBoundary.proofBoundary", "crud_publish_only");
    expect(result).toHaveProperty(
      "evidence.approvalReadiness.reason",
      "Generated workflow version published through Workflow CRUD; lifecycle promotion is not claimed.",
    );
  });

  it("cancel delegates to service", async () => {
    const cancelRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.cancel")!;
    const result = await cancelRoute.handler(
      makeCtx({ params: { sessionId: "s-1" } }) as never,
    );
    expect(service.cancelSession).toHaveBeenCalledWith("s-1");
    expect(result).toEqual({ cancelled: true });
  });

  it("approve route has rate limit policy", () => {
    const approveRoute = routes.find((r) => r.operationId === "workflows.generator.sessions.approve")!;
    expect(approveRoute.rateLimitPolicyId).toBe("workflow.publish");
  });
});
