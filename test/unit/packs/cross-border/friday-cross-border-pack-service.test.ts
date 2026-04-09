import { describe, expect, it, vi } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { createFridayUixUserPreferenceRepository } from "../../../../src/uix/persistence/friday-uix-user-preference-repository.js";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";
import { createFridayCrossBorderPackService } from "../../../../src/packs/cross-border/friday-cross-border-pack-service.js";
import type { FridayCrossBorderWorkflowId } from "../../../../src/packs/cross-border/friday-cross-border-pack.types.js";

function createWorkflowDeps() {
  const workflows = new Map<string, { id: string; slug: string; name: string; ownerUserId: string; isArchived?: boolean }>();
  const registrations = new Map<string, { id: string; enabled: boolean; trigger: { type: "schedule" }; nextFireAt?: string }[]>();
  let draftCounter = 0;
  let publishCounter = 0;

  const workflowRuntime = {
    crud: {
      getWorkflow: vi.fn((workflowId: string) => workflows.get(workflowId) ?? null),
      getWorkflowBySlug: vi.fn((slug: string) => Array.from(workflows.values()).find((workflow) => workflow.slug === slug) ?? null),
      createWorkflow: vi.fn((input: { slug: string; name: string; ownerUserId: string }) => {
        const workflow = {
          id: `wf-${workflows.size + 1}`,
          slug: input.slug,
          name: input.name,
          ownerUserId: input.ownerUserId,
          isArchived: false,
        };
        workflows.set(workflow.id, workflow);
        return workflow;
      }),
    },
    triggers: {
      listRegistrations: vi.fn((workflowId: string) => registrations.get(workflowId) ?? []),
      syncPublishedVersionTriggers: vi.fn(async (workflowId: string) => {
        registrations.set(workflowId, [{
          id: `reg-${workflowId}`,
          enabled: true,
          triggerType: "cron",
          nextFireAt: "2026-04-09T09:00:00.000Z",
        }]);
      }),
      setRegistrationEnabled: vi.fn(async (registrationId: string, enabled: boolean) => {
        for (const [workflowId, items] of registrations) {
          registrations.set(workflowId, items.map((item) => item.id === registrationId ? { ...item, enabled } : item));
        }
      }),
    },
  } as never;

  const workflowBuilderRuntime = {
    templates: {
      getTemplate: vi.fn((templateId: string) => ({
        templateId,
        spec: {
          schemaVersion: "1.0",
          workflowId: "template",
          name: "Template",
          description: "Template",
          startStepId: "step_one",
          trigger: { type: "manual" },
          inputs: [{ key: "performanceNotes", type: "string", required: true }],
          steps: [{ id: "step_one", type: "skill_call", ref: "skill", args: { performanceNotes: "$inputs.performanceNotes" } }],
          edges: [],
          outputs: [],
          errorPolicy: { onFailure: "fail_fast", notifyUser: true },
          tests: [],
        },
        visual: {
          schemaVersion: "1.0",
          workflowId: "template",
          viewport: { x: 0, y: 0, zoom: 1 },
          panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
          nodes: [],
          edges: [],
        },
      })),
    },
    drafts: {
      createDraft: vi.fn(() => ({
        draftId: `draft-${++draftCounter}`,
      })),
    },
  } as never;

  const workflowProductService = {
    deployDraft: vi.fn(async (input: { workflowId: string }) => {
      publishCounter += 1;
      registrations.set(input.workflowId, [{
        id: `reg-${input.workflowId}`,
        enabled: true,
        triggerType: "cron",
        nextFireAt: "2026-04-09T09:00:00.000Z",
      }]);
      return {
        workflowId: input.workflowId,
        workflowVersionId: `version-${publishCounter}`,
      };
    }),
  } as never;

  return {
    workflowRuntime,
    workflowBuilderRuntime,
    workflowProductService,
  };
}

describe("createFridayCrossBorderPackService", () => {
  it("persists the operating profile and turns imports into a structured snapshot", () => {
    const db = createTestDb();
    const workflowDeps = createWorkflowDeps();
    const service = createFridayCrossBorderPackService({
      db,
      preferenceRepo: createFridayUixUserPreferenceRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-04-08T12:00:00.000Z",
      ...workflowDeps,
    });

    const profile = service.upsertProfile({
      userId: "test-user",
      profile: {
        regionFocus: "sea_tiktok",
        storeStage: "scaling",
        categoryL1: "Beauty",
        categoryL2: "Hair Dryers",
        fulfillmentMode: "platform_fulfilled",
        priceBand: "US$19-29",
        adUsage: "active",
        customerServiceMode: "solo_inbox",
        monitoringDepth: "standard",
        watchTargets: [],
        competitorTargets: [
          {
            id: "competitor-1",
            sellerName: "Seller A",
            platform: "tiktok_shop",
            productName: "Nano Dryer",
          },
        ],
      },
    });

    expect(profile.packId).toBe("industry-cross-border-ecommerce");
    expect(profile.workflowPreset).toEqual([
      "daily-store-health-check",
      "daily-category-top10-watch",
      "daily-price-gap-watch",
      "daily-customer-service-sweep",
      "weekly-hot-product-review",
      "weekly-operating-profile-tune",
    ]);
    expect(profile.watchTargets[0]?.label).toContain("Beauty / Hair Dryers");

    service.importBatch({
      userId: "test-user",
      batch: {
        kind: "store_report",
        source: "paste",
        title: "Morning check",
        rawText: "Awaiting collection backlog rising\n客服响应慢\nrefund pressure increasing",
      },
    });
    service.importBatch({
      userId: "test-user",
      batch: {
        kind: "price_check_seed",
        source: "public_link",
        title: "Price watch",
        rawText: "Competitor price dropped with coupon and free shipping",
        publicLinks: ["https://example.com/public/product-1"],
      },
    });

    const snapshot = service.getSnapshot({ userId: "test-user" });

    expect(snapshot.profile?.regionFocus).toBe("sea_tiktok");
    expect(snapshot.storeHealth?.title).toBe("SEA 店铺健康");
    expect(snapshot.workflowRecommendations).toHaveLength(6);
    expect(snapshot.riskClusters.length).toBeGreaterThan(0);
    expect(snapshot.nextActions[0]?.title).toContain("TikTok Shop");
    expect(snapshot.importSummary.totalImports).toBe(2);

    db.close();
  });

  it("uses the writer transaction for profile and import writes", () => {
    let writeCalls = 0;
    const preferenceRepo = {
      listByPrincipal: vi.fn(() => []),
      upsert: vi.fn(() => ({
        id: "pref-1",
        principalId: "user-1",
        category: "uix",
        key: "packs.cross_border.profile",
        value: {},
        source: "explicit",
        confidence: 1,
        createdAt: "2026-04-08T12:00:00.000Z",
        updatedAt: "2026-04-08T12:00:00.000Z",
      })),
      getById: vi.fn(),
      deleteById: vi.fn(),
    };
    const db = {
      dbPath: ":memory:",
      writer: {} as never,
      reads: {
        size: 1,
        withReadConnection<T>(fn: (db: never) => T): T {
          return fn({} as never);
        },
        close() {},
      },
      withWriteTransaction<T>(fn: (db: never) => T): T {
        writeCalls += 1;
        return fn({} as never);
      },
      withReadConnection<T>(fn: (db: never) => T): T {
        return fn({} as never);
      },
      checkpoint() {},
      optimize() {},
      close() {},
    } satisfies FridaySqliteLayer;
    const workflowDeps = createWorkflowDeps();

    const service = createFridayCrossBorderPackService({
      db,
      preferenceRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-04-08T12:00:00.000Z",
      ...workflowDeps,
    });

    service.upsertProfile({
      userId: "user-1",
      profile: {
        regionFocus: "na_amazon",
        storeStage: "new_store",
        categoryL1: "Home",
        categoryL2: "Kitchen",
        fulfillmentMode: "platform_fulfilled",
        priceBand: "US$29-39",
        adUsage: "light",
        customerServiceMode: "solo_inbox",
        monitoringDepth: "lean",
        watchTargets: [],
        competitorTargets: [],
      },
    });
    service.importBatch({
      userId: "user-1",
      batch: {
        kind: "public_link_seed",
        source: "public_link",
        title: "Public seed",
        publicLinks: ["https://example.com/watch"],
      },
    });

    expect(writeCalls).toBe(2);
    expect(preferenceRepo.upsert).toHaveBeenCalledTimes(2);
  });

  it("creates managed workflows for the default preset and can pause them", async () => {
    const db = createTestDb();
    const workflowDeps = createWorkflowDeps();
    const service = createFridayCrossBorderPackService({
      db,
      preferenceRepo: createFridayUixUserPreferenceRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-04-08T12:00:00.000Z",
      ...workflowDeps,
    });

    service.upsertProfile({
      userId: "test-user",
      profile: {
        regionFocus: "sea_tiktok",
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
      },
    });

    const applied = await service.applyWorkflowPreset({
      userId: "test-user",
      preset: {
        timezone: "America/Los_Angeles",
      },
    });

    expect(applied.workflowRecommendations).toHaveLength(6);
    expect(
      applied.workflowRecommendations.find((item) => item.id === "daily-store-health-check")?.automation?.status,
    ).toBe("active");
    expect(
      applied.workflowRecommendations.find((item) => item.id === "daily-price-gap-watch")?.automation?.status,
    ).toBe("paused");
    expect(
      applied.workflowRecommendations.find((item) => item.id === "weekly-operating-profile-tune")?.automation?.status,
    ).toBe("paused");
    expect(
      applied.workflowRecommendations.find((item) => item.id === "daily-price-gap-watch")?.policy.currentGuidance.state,
    ).toBe("pause_recommended");
    expect(
      applied.workflowRecommendations.find((item) => item.id === "weekly-operating-profile-tune")?.policy.currentGuidance.state,
    ).toBe("hold_until_ready");

    const paused = await service.setWorkflowPresetEnabled({
      userId: "test-user",
      preset: {
        workflowId: "daily-store-health-check",
        enabled: false,
      },
    });

    expect(
      paused.workflowRecommendations.find((item) => item.id === "daily-store-health-check")?.automation?.status,
    ).toBe("paused");

    db.close();
  });

  it("lets an explicit enable override the default paused recommendation", async () => {
    const db = createTestDb();
    const workflowDeps = createWorkflowDeps();
    const service = createFridayCrossBorderPackService({
      db,
      preferenceRepo: createFridayUixUserPreferenceRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-04-08T12:00:00.000Z",
      ...workflowDeps,
    });

    service.upsertProfile({
      userId: "test-user",
      profile: {
        regionFocus: "sea_tiktok",
        storeStage: "new_store",
        categoryL1: "Beauty",
        categoryL2: "Hair Dryers",
        fulfillmentMode: "platform_fulfilled",
        priceBand: "US$19-29",
        adUsage: "light",
        customerServiceMode: "solo_inbox",
        monitoringDepth: "standard",
        watchTargets: [],
        competitorTargets: [],
      },
    });

    const snapshot = await service.setWorkflowPresetEnabled({
      userId: "test-user",
      preset: {
        workflowId: "daily-price-gap-watch",
        enabled: true,
        timezone: "America/Los_Angeles",
      },
    });

    expect(
      snapshot.workflowRecommendations.find((item) => item.id === "daily-price-gap-watch")?.automation?.status,
    ).toBe("active");

    db.close();
  });

  it("builds workflow input context from the latest cross-border snapshot", async () => {
    const db = createTestDb();
    const workflowDeps = createWorkflowDeps();
    const service = createFridayCrossBorderPackService({
      db,
      preferenceRepo: createFridayUixUserPreferenceRepository(),
      idGenerator: createTestIdGenerator(),
      nowIso: () => "2026-04-08T12:00:00.000Z",
      ...workflowDeps,
    });

    service.upsertProfile({
      userId: "test-user",
      profile: {
        regionFocus: "na_amazon",
        storeStage: "scaling",
        categoryL1: "Home",
        categoryL2: "Kitchen",
        fulfillmentMode: "platform_fulfilled",
        priceBand: "US$29-39",
        adUsage: "active",
        customerServiceMode: "solo_inbox",
        monitoringDepth: "standard",
        watchTargets: [],
        competitorTargets: [],
      },
    });
    service.importBatch({
      userId: "test-user",
      batch: {
        kind: "price_check_seed",
        source: "paste",
        title: "Price notes",
        rawText: "Competitor price dropped with coupon and free shipping",
      },
    });

    const snapshot = await service.applyWorkflowPreset({
      userId: "test-user",
      preset: {
        workflowIds: ["daily-price-gap-watch" satisfies FridayCrossBorderWorkflowId],
        timezone: "America/Los_Angeles",
      },
    });
    const managedWorkflowId = snapshot.workflowRecommendations.find((item) => item.id === "daily-price-gap-watch")?.automation?.managedWorkflowId;

    const payload = service.buildWorkflowInputContext({
      userId: "test-user",
      managedWorkflowId: managedWorkflowId!,
    });

    expect(payload).toMatchObject({
      priceSignals: expect.stringContaining("Competitor price dropped"),
    });

    db.close();
  });
});
