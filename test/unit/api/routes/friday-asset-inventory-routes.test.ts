import { describe, it, expect } from "vitest";
import {
  createFridayAssetInventoryRoutes,
  type FridayAssetInventoryRoutesDeps,
} from "../../../../src/api/http/routes/friday-asset-inventory-routes.js";
import type { FridayAutonomySubjectRecord } from "../../../../src/autonomy/model/friday-autonomy-subject.types.js";
import type { FridayAgentAutomationRecord } from "../../../../src/agent/services/friday-agent-automation-service.types.js";

function makeSubject(overrides: Partial<FridayAutonomySubjectRecord> = {}): FridayAutonomySubjectRecord {
  return {
    kind: "skill",
    id: "skill-1",
    displayName: "Test Skill",
    status: "active",
    details: { source: "manual", origin: "user", entrypoint: "main.ts" },
    acquiredAt: new Date().toISOString(),
    ...overrides,
  } as FridayAutonomySubjectRecord;
}

function makeAutomation(overrides: Partial<FridayAgentAutomationRecord> = {}): FridayAgentAutomationRecord {
  return {
    id: "auto-1",
    name: "Daily Report",
    taskTemplate: "generate-daily-report",
    enabled: true,
    reuseCount: 5,
    runCount: 10,
    lastRunAt: "2026-01-01T00:00:00Z",
    promotionState: "promoted",
    estimatedTimeSavedMinutes: 30,
    ...overrides,
  } as FridayAgentAutomationRecord;
}

function makeFact(overrides: Record<string, unknown> = {}) {
  return {
    key: "pref:verbosity",
    value: "concise",
    confidence: 0.85,
    evidenceCount: 3,
    lastConfirmedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

async function callHandler(deps: FridayAssetInventoryRoutesDeps, principal: unknown = null) {
  const routes = createFridayAssetInventoryRoutes(deps);
  const route = routes[0];
  return route.handler({ principal, body: undefined, query: undefined, params: undefined } as never);
}

describe("friday-asset-inventory-routes", () => {
  describe("route registration", () => {
    it("registers one route with correct metadata", () => {
      const routes = createFridayAssetInventoryRoutes({
        subjectInventory: { list: () => [] },
      });
      expect(routes).toHaveLength(1);
      expect(routes[0].operationId).toBe("assets.inventory.list");
      expect(routes[0].method).toBe("GET");
      expect(routes[0].path).toBe("/v1/assets/inventory");
      expect(routes[0].auth).toEqual({ public: true });
    });
  });

  describe("aggregation", () => {
    it("returns all 3 categories when principal + all deps present", async () => {
      const result = await callHandler(
        {
          subjectInventory: { list: () => [makeSubject()] },
          listLearnedFacts: () => [makeFact()],
          deleteLearnedFact: () => true,
          listAutomations: () => [makeAutomation()],
        },
        { userId: "user-1" },
      ) as { items: unknown[]; categories: string[] };

      expect(result.categories).toEqual(["runtime", "knowledge", "automation"]);
      expect(result.items).toHaveLength(3);
    });

    it("returns runtime-only when no principal", async () => {
      const result = await callHandler(
        {
          subjectInventory: { list: () => [makeSubject()] },
          listLearnedFacts: () => [makeFact()],
          listAutomations: () => [makeAutomation()],
        },
        null,
      ) as { items: unknown[]; categories: string[] };

      expect(result.categories).toEqual(["runtime"]);
      expect(result.items).toHaveLength(1);
    });

    it("returns runtime-only when principal has no userId", async () => {
      const result = await callHandler(
        {
          subjectInventory: { list: () => [makeSubject()] },
          listLearnedFacts: () => [makeFact()],
          listAutomations: () => [makeAutomation()],
        },
        { role: "admin" },
      ) as { items: unknown[]; categories: string[] };

      expect(result.categories).toEqual(["runtime"]);
      expect(result.items).toHaveLength(1);
    });
  });

  describe("optional deps", () => {
    it("omits knowledge when listLearnedFacts absent", async () => {
      const result = await callHandler(
        {
          subjectInventory: { list: () => [makeSubject()] },
          listAutomations: () => [makeAutomation()],
        },
        { userId: "user-1" },
      ) as { items: unknown[]; categories: string[] };

      expect(result.categories).toEqual(["runtime", "automation"]);
      expect(result.items).toHaveLength(2);
    });

    it("omits automation when listAutomations absent", async () => {
      const result = await callHandler(
        {
          subjectInventory: { list: () => [makeSubject()] },
          listLearnedFacts: () => [makeFact()],
          deleteLearnedFact: () => true,
        },
        { userId: "user-1" },
      ) as { items: unknown[]; categories: string[] };

      expect(result.categories).toEqual(["runtime", "knowledge"]);
      expect(result.items).toHaveLength(2);
    });

    it("returns empty items when all sources empty", async () => {
      const result = await callHandler(
        {
          subjectInventory: { list: () => [] },
          listLearnedFacts: () => [],
          listAutomations: () => [],
        },
        { userId: "user-1" },
      ) as { items: unknown[]; categories: string[] };

      expect(result.categories).toEqual(["runtime", "knowledge", "automation"]);
      expect(result.items).toHaveLength(0);
    });
  });

  describe("details projection", () => {
    it("projects only allowed fields for skill kind", async () => {
      const subject = makeSubject({
        kind: "skill",
        details: {
          source: "manual",
          origin: "user",
          entrypoint: "main.ts",
          secretField: "should-not-appear",
        },
      });
      const result = await callHandler(
        { subjectInventory: { list: () => [subject] } },
        null,
      ) as { items: Array<{ details: Record<string, unknown> }> };

      expect(result.items[0].details).toEqual({
        source: "manual",
        origin: "user",
        entrypoint: "main.ts",
      });
      expect(result.items[0].details).not.toHaveProperty("secretField");
    });

    it("projects only allowed fields for provider_profile kind", async () => {
      const subject = makeSubject({
        kind: "provider_profile",
        details: {
          providerKind: "openai",
          validationStatus: "valid",
          supportedModels: ["gpt-4"],
          baseUrl: "https://secret.example.com",
          authMode: "api_key",
          keySourceKind: "env",
          api: { key: "secret" },
        },
      });
      const result = await callHandler(
        { subjectInventory: { list: () => [subject] } },
        null,
      ) as { items: Array<{ details: Record<string, unknown> }> };

      expect(result.items[0].details).toEqual({
        providerKind: "openai",
        validationStatus: "valid",
        supportedModels: ["gpt-4"],
      });
      expect(result.items[0].details).not.toHaveProperty("baseUrl");
      expect(result.items[0].details).not.toHaveProperty("authMode");
      expect(result.items[0].details).not.toHaveProperty("keySourceKind");
      expect(result.items[0].details).not.toHaveProperty("api");
    });

    it("returns empty details for unknown kind", async () => {
      const subject = makeSubject({
        kind: "unknown_thing",
        details: { foo: "bar", secret: "oops" },
      });
      const result = await callHandler(
        { subjectInventory: { list: () => [subject] } },
        null,
      ) as { items: Array<{ details: Record<string, unknown> }> };

      expect(result.items[0].details).toEqual({});
    });
  });

  describe("item mapping", () => {
    it("maps learned fact with confidence status", async () => {
      const result = await callHandler(
        {
          subjectInventory: { list: () => [] },
          listLearnedFacts: () => [makeFact({ confidence: 0.85 })],
          deleteLearnedFact: () => true,
        },
        { userId: "user-1" },
      ) as { items: Array<{ category: string; status: string; controls: { canDelete: boolean } }> };

      const factItem = result.items.find((i) => i.category === "knowledge");
      expect(factItem).toBeDefined();
      expect(factItem!.status).toBe("high_confidence");
      expect(factItem!.controls.canDelete).toBe(true);
    });

    it("maps learned fact without deleteLearnedFact as canDelete false", async () => {
      const result = await callHandler(
        {
          subjectInventory: { list: () => [] },
          listLearnedFacts: () => [makeFact()],
        },
        { userId: "user-1" },
      ) as { items: Array<{ category: string; controls: { canDelete?: boolean } }> };

      const factItem = result.items.find((i) => i.category === "knowledge");
      expect(factItem!.controls.canDelete).toBe(false);
    });

    it("maps automation with correct controls", async () => {
      const result = await callHandler(
        {
          subjectInventory: { list: () => [] },
          listAutomations: () => [makeAutomation({ enabled: true })],
        },
        { userId: "user-1" },
      ) as { items: Array<{ category: string; status: string; controls: { canDelete: boolean; canDisable: boolean; viewUrl: string } }> };

      const autoItem = result.items.find((i) => i.category === "automation");
      expect(autoItem).toBeDefined();
      expect(autoItem!.status).toBe("enabled");
      expect(autoItem!.controls.canDelete).toBe(true);
      expect(autoItem!.controls.canDisable).toBe(true);
      expect(autoItem!.controls.viewUrl).toBe("/automations");
    });

    it("maps runtime subject with view URL", async () => {
      const result = await callHandler(
        { subjectInventory: { list: () => [makeSubject({ kind: "workflow" })] } },
        null,
      ) as { items: Array<{ controls: { viewUrl?: string } }> };

      expect(result.items[0].controls.viewUrl).toBe("/workflows");
    });

    it("classifies medium confidence correctly", async () => {
      const result = await callHandler(
        {
          subjectInventory: { list: () => [] },
          listLearnedFacts: () => [makeFact({ confidence: 0.5 })],
        },
        { userId: "user-1" },
      ) as { items: Array<{ status: string }> };

      expect(result.items[0].status).toBe("medium_confidence");
    });

    it("classifies low confidence correctly", async () => {
      const result = await callHandler(
        {
          subjectInventory: { list: () => [] },
          listLearnedFacts: () => [makeFact({ confidence: 0.2 })],
        },
        { userId: "user-1" },
      ) as { items: Array<{ status: string }> };

      expect(result.items[0].status).toBe("low_confidence");
    });
  });
});
