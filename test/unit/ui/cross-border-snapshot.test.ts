import { afterEach, describe, expect, it } from "vitest";
import type { FridayCrossBorderSnapshot } from "../../../src/packs/cross-border/friday-cross-border-pack.types";
import {
  buildCrossBorderAssistantNavigationSnapshot,
  buildCrossBorderAssistantNavigationState,
  mergeCrossBorderSnapshots,
  persistCrossBorderAssistantNavigationSnapshot,
  readNavigationCrossBorderSnapshot,
} from "../../../ui/src/lib/packs/cross-border-snapshot";

function installSessionStorageMock() {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem(key: string) {
          return storage.has(key) ? storage.get(key)! : null;
        },
        setItem(key: string, value: string) {
          storage.set(key, value);
        },
        removeItem(key: string) {
          storage.delete(key);
        },
        clear() {
          storage.clear();
        },
      },
    },
  });
}

function buildSnapshot(overrides?: Partial<FridayCrossBorderSnapshot>): FridayCrossBorderSnapshot {
  return {
    generatedAt: "2026-04-08T00:00:00.000Z",
    profile: {
      packId: "industry-cross-border-ecommerce",
      regionFocus: "sea_tiktok",
      platformPrimary: "tiktok_shop",
      platformSecondary: null,
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
      workflowPreset: ["daily-store-health-check"],
      adaptationState: {
        firstReviewDueAt: "2026-04-15T00:00:00.000Z",
        thirtyDayReviewDueAt: "2026-05-08T00:00:00.000Z",
      },
    },
    storeHealth: null,
    categoryWatch: null,
    spikingProducts: null,
    priceGapBoard: null,
    listingQualityBoard: null,
    customerServiceBoard: null,
    workflowRecommendations: [{
      id: "daily-store-health-check",
      templateId: "builtin-cross-border-daily-store-health-check",
      cadence: "daily",
      enabledByDefault: true,
      rationale: "test rationale",
      policy: {
        cadence: {
          cron: "0 9 * * *",
          timezoneMode: "user_local",
          summary: { zh: "每天", en: "Daily" },
        },
        pauseConditions: [],
        approvalBoundaries: [],
        currentGuidance: {
          status: "enable_now",
          summary: { zh: "现在启用", en: "Enable now" },
        },
      },
      automation: null,
    }],
    riskClusters: [],
    nextActions: [],
    importSummary: {
      lastImportedAt: null,
      totalImports: 0,
      sourceTypes: [],
    },
    ...overrides,
  };
}

describe("cross-border snapshot helpers", () => {
  installSessionStorageMock();

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("preserves seeded automation when the live snapshot drops it", () => {
    const seeded = buildSnapshot({
      workflowRecommendations: [{
        ...buildSnapshot().workflowRecommendations[0],
        automation: {
          workflowId: "daily-store-health-check",
          templateId: "builtin-cross-border-daily-store-health-check",
          managedWorkflowId: "mwf_123",
          managedWorkflowSlug: "daily-store-health-check",
          managedWorkflowName: "Daily Store Health Check",
          status: "active",
          schedule: {
            cron: "0 9 * * *",
            timezone: "America/Los_Angeles",
          },
          nextRunAt: "2026-04-09T16:00:00.000Z",
          lastPublishedAt: "2026-04-08T00:00:00.000Z",
          lastSyncedAt: "2026-04-08T00:00:00.000Z",
        },
      }],
    });
    const live = buildSnapshot();

    const merged = mergeCrossBorderSnapshots(seeded, live);

    expect(merged?.workflowRecommendations[0]?.automation?.managedWorkflowId).toBe("mwf_123");
  });

  it("preserves seeded workflow entries when the live snapshot omits them", () => {
    const seeded = buildSnapshot();
    const live = buildSnapshot({
      workflowRecommendations: [],
    });

    const merged = mergeCrossBorderSnapshots(seeded, live);

    expect(merged?.workflowRecommendations).toHaveLength(1);
    expect(merged?.workflowRecommendations[0]?.id).toBe("daily-store-health-check");
  });

  it("builds and reads navigation state only for profiled snapshots", () => {
    const snapshot = buildSnapshot();

    const state = buildCrossBorderAssistantNavigationState(snapshot);

    expect(readNavigationCrossBorderSnapshot(state)).toEqual(snapshot);
    expect(buildCrossBorderAssistantNavigationState(buildSnapshot({ profile: null }))).toBeUndefined();
  });

  it("falls back to a stored assistant snapshot when navigation state is missing", () => {
    const snapshot = buildSnapshot();

    persistCrossBorderAssistantNavigationSnapshot(snapshot);

    expect(readNavigationCrossBorderSnapshot(undefined)).toEqual(snapshot);
  });

  it("merges a stored automation snapshot into navigation state that dropped automation", () => {
    const storedSnapshot = buildSnapshot({
      workflowRecommendations: [{
        ...buildSnapshot().workflowRecommendations[0],
        automation: {
          workflowId: "daily-store-health-check",
          templateId: "builtin-cross-border-daily-store-health-check",
          managedWorkflowId: "mwf_123",
          managedWorkflowSlug: "daily-store-health-check",
          managedWorkflowName: "Daily Store Health Check",
          status: "active",
          schedule: {
            cron: "0 9 * * *",
            timezone: "America/Los_Angeles",
          },
          nextRunAt: "2026-04-09T16:00:00.000Z",
          lastPublishedAt: "2026-04-08T00:00:00.000Z",
          lastSyncedAt: "2026-04-08T00:00:00.000Z",
        },
      }],
    });
    const navigationSnapshot = buildSnapshot({
      workflowRecommendations: [{
        ...buildSnapshot().workflowRecommendations[0],
        automation: null,
      }],
    });

    persistCrossBorderAssistantNavigationSnapshot(storedSnapshot);

    const restored = readNavigationCrossBorderSnapshot(
      buildCrossBorderAssistantNavigationState(navigationSnapshot),
    );

    expect(restored?.workflowRecommendations[0]?.automation?.managedWorkflowId).toBe("mwf_123");
  });

  it("uses the stored assistant snapshot as a seed when building a new navigation snapshot", () => {
    const storedSnapshot = buildSnapshot({
      workflowRecommendations: [{
        ...buildSnapshot().workflowRecommendations[0],
        automation: {
          workflowId: "daily-store-health-check",
          templateId: "builtin-cross-border-daily-store-health-check",
          managedWorkflowId: "mwf_123",
          managedWorkflowSlug: "daily-store-health-check",
          managedWorkflowName: "Daily Store Health Check",
          status: "active",
          schedule: {
            cron: "0 9 * * *",
            timezone: "America/Los_Angeles",
          },
          nextRunAt: "2026-04-09T16:00:00.000Z",
          lastPublishedAt: "2026-04-08T00:00:00.000Z",
          lastSyncedAt: "2026-04-08T00:00:00.000Z",
        },
      }],
    });
    const latestSnapshot = buildSnapshot({
      workflowRecommendations: [{
        ...buildSnapshot().workflowRecommendations[0],
        automation: null,
      }],
    });

    persistCrossBorderAssistantNavigationSnapshot(storedSnapshot);

    const merged = buildCrossBorderAssistantNavigationSnapshot(undefined, latestSnapshot);

    expect(merged?.workflowRecommendations[0]?.automation?.managedWorkflowId).toBe("mwf_123");
  });
});
