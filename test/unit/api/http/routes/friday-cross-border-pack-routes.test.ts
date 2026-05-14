import { describe, expect, it, vi } from "vitest";

import { FridayDomainError } from "#errors";
import { createFridayCrossBorderPackRoutes } from "../../../../../src/api/http/routes/friday-cross-border-pack-routes.js";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: { userId: "test-user", scopes: ["agent.run"] },
    requestId: "req-1",
    receivedAt: "2026-04-08T12:00:00.000Z",
    ...overrides,
  } as never;
}

function makeEmptySnapshot() {
  return {
    generatedAt: "2026-04-08T12:00:00.000Z",
    profile: null,
    storeHealth: null,
    categoryWatch: null,
    spikingProducts: null,
    priceGapBoard: null,
    listingQualityBoard: null,
    customerServiceBoard: null,
    workflowRecommendations: [],
    riskClusters: [],
    nextActions: [],
    importSummary: {
      lastImportedAt: null,
      totalImports: 0,
      sourceTypes: [],
    },
    runEvidenceLog: [],
  };
}

function makeService() {
  return {
    getProfile: vi.fn(() => null),
    upsertProfile: vi.fn(() => ({
      packId: "industry-cross-border-ecommerce",
      regionFocus: "sea_tiktok",
      platformPrimary: "tiktok_shop",
      platformSecondary: "public_web",
      storeStage: "scaling",
      categoryL1: "Beauty",
      categoryL2: "Hair Dryers",
      fulfillmentMode: "platform_fulfilled",
      priceBand: "US$19-29",
      adUsage: "active",
      customerServiceMode: "solo_inbox",
      monitoringDepth: "standard",
      watchTargets: [],
      competitorTargets: [],
      workflowPreset: [
        "daily-store-health-check",
        "daily-category-top10-watch",
        "daily-price-gap-watch",
        "daily-customer-service-sweep",
        "weekly-hot-product-review",
        "weekly-operating-profile-tune",
      ],
      adaptationState: {
        status: "tracking",
        firstReviewDueAt: "2026-04-15T12:00:00.000Z",
        stableReviewDueAt: "2026-05-08T12:00:00.000Z",
      },
      createdAt: "2026-04-08T12:00:00.000Z",
      updatedAt: "2026-04-08T12:00:00.000Z",
    })),
    importBatch: vi.fn(() => ({
      id: "import-1",
      kind: "store_report",
      source: "paste",
      title: "Store report",
      rawText: "refund pressure increasing",
      publicLinks: [],
      fileNames: [],
      createdAt: "2026-04-08T12:00:00.000Z",
    })),
    getSnapshot: vi.fn(() => makeEmptySnapshot()),
    applyWorkflowPreset: vi.fn(async () => makeEmptySnapshot()),
    setWorkflowPresetEnabled: vi.fn(async () => makeEmptySnapshot()),
    buildWorkflowInputContext: vi.fn(() => null),
    captureRunEvidence: vi.fn(() => ({
      id: "ev-1",
      workflowId: "daily-store-health-check",
      managedWorkflowId: "wf-1",
      status: "completed",
      summary: "Health check passed",
      capturedAt: "2026-04-08T12:00:00.000Z",
    })),
    markImportStale: vi.fn(() => makeEmptySnapshot()),
    disableAllWorkflows: vi.fn(async () => makeEmptySnapshot()),
  };
}

function findRoute(operationId: string) {
  const service = makeService();
  const route = createFridayCrossBorderPackRoutes({ service }).find((entry) => entry.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return { route, service };
}

describe("createFridayCrossBorderPackRoutes", () => {
  it("registers the cross-border pack routes", () => {
    const routes = createFridayCrossBorderPackRoutes({ service: makeService() });
    expect(routes.map((route) => route.operationId)).toEqual([
      "packs.cross.border.profile.get",
      "packs.cross.border.profile.put",
      "packs.cross.border.snapshot.get",
      "packs.cross.border.import.post",
      "packs.cross.border.workflow.presets.apply",
      "packs.cross.border.workflow.presets.toggle",
      "packs.cross.border.run.evidence.capture",
      "packs.cross.border.import.stale",
      "packs.cross.border.workflows.disable.all",
    ]);
  });

  it("requires a user-scoped principal", async () => {
    const { route } = findRoute("packs.cross.border.profile.get");
    await expect(route.handler(makeCtx({ principal: null }))).rejects.toBeInstanceOf(FridayDomainError);
  });

  it("forwards profile updates and snapshot reads to the service", async () => {
    const { route: putRoute, service } = findRoute("packs.cross.border.profile.put");
    const result = await putRoute.handler(makeCtx({
      body: {
        regionFocus: "sea_tiktok",
        storeStage: "scaling",
        categoryL1: "Beauty",
        categoryL2: "Hair Dryers",
        fulfillmentMode: "platform_fulfilled",
        priceBand: "US$19-29",
        adUsage: "active",
        customerServiceMode: "solo_inbox",
        monitoringDepth: "standard",
        watchTargets: [{ id: "watch-1", type: "keyword", label: "travel dryer", platform: "tiktok_shop" }],
        competitorTargets: [{ id: "comp-1", sellerName: "Seller A", platform: "tiktok_shop" }],
      },
    }));

    expect(service.upsertProfile).toHaveBeenCalledWith({
      userId: "test-user",
      profile: expect.objectContaining({
        regionFocus: "sea_tiktok",
        categoryL1: "Beauty",
        categoryL2: "Hair Dryers",
      }),
    });
    expect(result.profile?.packId).toBe("industry-cross-border-ecommerce");

    const { route: snapshotRoute, service: snapshotService } = findRoute("packs.cross.border.snapshot.get");
    await snapshotRoute.handler(makeCtx());
    expect(snapshotService.getSnapshot).toHaveBeenCalledWith({ userId: "test-user" });
  });

  it("returns the imported batch together with the refreshed snapshot", async () => {
    const { route, service } = findRoute("packs.cross.border.import.post");
    const result = await route.handler(makeCtx({
      body: {
        kind: "store_report",
        source: "paste",
        title: "Morning notes",
        rawText: "refund pressure increasing",
        publicLinks: ["https://example.com/public/listing"],
        fileNames: ["report.csv"],
      },
    }));

    expect(service.importBatch).toHaveBeenCalledWith({
      userId: "test-user",
      batch: {
        kind: "store_report",
        source: "paste",
        title: "Morning notes",
        rawText: "refund pressure increasing",
        publicLinks: ["https://example.com/public/listing"],
        fileNames: ["report.csv"],
      },
    });
    expect(service.getSnapshot).toHaveBeenCalledWith({ userId: "test-user" });
    expect(result.importBatch.id).toBe("import-1");
    expect(result.snapshot.generatedAt).toBe("2026-04-08T12:00:00.000Z");
  });

  it("applies workflow presets for the current user", async () => {
    const { route, service } = findRoute("packs.cross.border.workflow.presets.apply");
    const result = await route.handler(makeCtx({
      body: {
        workflowIds: ["daily-store-health-check", "weekly-hot-product-review"],
        timezone: "America/Los_Angeles",
      },
    }));

    expect(service.applyWorkflowPreset).toHaveBeenCalledWith({
      userId: "test-user",
      preset: {
        workflowIds: ["daily-store-health-check", "weekly-hot-product-review"],
        timezone: "America/Los_Angeles",
      },
    });
    expect(result.snapshot.generatedAt).toBe("2026-04-08T12:00:00.000Z");
  });

  it("toggles one managed workflow preset", async () => {
    const { route, service } = findRoute("packs.cross.border.workflow.presets.toggle");
    const result = await route.handler(makeCtx({
      params: {
        workflowId: "daily-price-gap-watch",
      },
      body: {
        enabled: false,
      },
    }));

    expect(service.setWorkflowPresetEnabled).toHaveBeenCalledWith({
      userId: "test-user",
      preset: {
        workflowId: "daily-price-gap-watch",
        enabled: false,
      },
    });
    expect(result.snapshot.generatedAt).toBe("2026-04-08T12:00:00.000Z");
  });

  it("captures run evidence and returns updated snapshot", async () => {
    const { route, service } = findRoute("packs.cross.border.run.evidence.capture");
    const result = await route.handler(makeCtx({
      body: {
        workflowId: "daily-store-health-check",
        managedWorkflowId: "wf-1",
        status: "completed",
        summary: "Health check completed",
      },
    }));

    expect(service.captureRunEvidence).toHaveBeenCalledWith({
      userId: "test-user",
      evidence: {
        workflowId: "daily-store-health-check",
        managedWorkflowId: "wf-1",
        status: "completed",
        summary: "Health check completed",
      },
    });
    expect(result.evidence.id).toBe("ev-1");
    expect(result.snapshot.generatedAt).toBe("2026-04-08T12:00:00.000Z");
  });

  it("marks an import batch as stale", async () => {
    const { route, service } = findRoute("packs.cross.border.import.stale");
    const result = await route.handler(makeCtx({
      params: { importBatchId: "import-1" },
    }));

    expect(service.markImportStale).toHaveBeenCalledWith({
      userId: "test-user",
      importBatchId: "import-1",
    });
    expect(result.snapshot.generatedAt).toBe("2026-04-08T12:00:00.000Z");
  });

  it("disables all managed workflows", async () => {
    const { route, service } = findRoute("packs.cross.border.workflows.disable.all");
    const result = await route.handler(makeCtx());

    expect(service.disableAllWorkflows).toHaveBeenCalledWith({
      userId: "test-user",
    });
    expect(result.snapshot.generatedAt).toBe("2026-04-08T12:00:00.000Z");
  });
});
