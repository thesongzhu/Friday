import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import type { FridayProviderKind, FridayResolvedProviderRoute } from "#providers";
import {
  createFridayProviderBudgetService,
  createFridayProviderCostRouter,
  createFridayProviderPricingCatalog,
  createFridayProviderUsageRepository,
} from "#providers";

import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";

const NOW = "2026-05-23T10:00:00.000Z";

function providerApiFor(kind: FridayProviderKind) {
  switch (kind) {
    case "anthropic":
      return "anthropic-messages" as const;
    case "google":
      return "google-generative-ai" as const;
    case "ollama":
      return "ollama" as const;
    default:
      return "openai-responses" as const;
  }
}

function route(id: string, kind: FridayProviderKind, model: string): FridayResolvedProviderRoute {
  return {
    provider: {
      id,
      kind,
      name: id,
      baseUrl: "",
      enabled: true,
      defaultModel: model,
      config: {
        api: providerApiFor(kind),
        authMode: "none",
        keySource: { kind: "none" },
        supportedModels: [model],
        validation: { status: "never" },
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    model,
  };
}

describe("Friday provider cost controls", () => {
  describe("pricing catalog", () => {
    it("uses the longest matching model pattern before the generic fallback", () => {
      const catalog = createFridayProviderPricingCatalog();

      expect(catalog.getPricing("openai", "gpt-4.1-mini").inputPer1MUsd).toBe(0.4);
      expect(catalog.getPricing("openai", "gpt-4.1").inputPer1MUsd).toBe(2);
      expect(catalog.getPricing("ollama", "llama3.1").inputPer1MUsd).toBe(0);
      expect(catalog.getPricing("openai", "unknown-model")).toMatchObject({
        inputPer1MUsd: 1,
        outputPer1MUsd: 4,
        qualityTier: "balanced",
      });
    });
  });

  describe("cost router", () => {
    const catalog = createFridayProviderPricingCatalog();
    const router = createFridayProviderCostRouter({ pricingCatalog: catalog });
    const expensive = route("openai-best", "openai", "gpt-4.1");
    const cheap = route("openai-cheap", "openai", "gpt-4.1-nano");
    const local = route("local", "ollama", "llama3.1");

    it("preserves configured order while the budget is healthy in standard mode", () => {
      const decision = router.planRoutes({
        candidates: [expensive, cheap, local],
        estimatedInputTokens: 2000,
        complexity: "medium",
        budget: {
          month: "2026-05",
          config: { monthlyLimitUsd: 100 },
          spentUsd: 25,
          remainingUsd: 75,
          state: "ok",
        },
      });

      expect(decision.strategy).toBe("configured");
      expect(decision.orderedCandidates.map((candidate) => candidate.provider.id)).toEqual([
        "openai-best",
        "openai-cheap",
        "local",
      ]);
    });

    it("downgrades to cheaper candidates near the budget limit", () => {
      const decision = router.planRoutes({
        candidates: [expensive, cheap, local],
        estimatedInputTokens: 2000,
        complexity: "medium",
        budget: {
          month: "2026-05",
          config: { monthlyLimitUsd: 100 },
          spentUsd: 81,
          remainingUsd: 19,
          state: "near_limit",
        },
      });

      expect(decision.strategy).toBe("budget_downgrade");
      expect(decision.orderedCandidates.map((candidate) => candidate.provider.id)).toEqual([
        "local",
        "openai-cheap",
        "openai-best",
      ]);
    });

    it("restricts over-limit routes to local providers only", () => {
      const decision = router.planRoutes({
        candidates: [expensive, cheap, local],
        estimatedInputTokens: 2000,
        complexity: "simple",
        budget: {
          month: "2026-05",
          config: { monthlyLimitUsd: 100 },
          spentUsd: 101,
          remainingUsd: 0,
          state: "over_limit",
        },
      });

      expect(decision.strategy).toBe("budget_local_only");
      expect(decision.orderedCandidates).toEqual([local]);
    });
  });

  describe("budget service", () => {
    let db: FridaySqliteLayer;

    beforeEach(() => {
      db = createTestDb();
    });

    afterEach(() => {
      db.close();
    });

    it("classifies budget status from persisted monthly usage", async () => {
      const usageRepo = createFridayProviderUsageRepository();
      const budgetService = createFridayProviderBudgetService({
        db,
        usageRepo,
        nowIso: () => NOW,
      });

      db.withWriteTransaction((conn) => {
        usageRepo.insert(conn, {
          id: "usage-1",
          occurredAt: "2026-05-10T10:00:00.000Z",
          usageDay: "2026-05-10",
          usageMonth: "2026-05",
          providerId: "openai-best",
          providerKind: "openai",
          providerApi: "openai-responses",
          model: "gpt-4.1",
          routeStrategy: "configured",
          taskComplexity: "medium",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1500,
          costUsd: 80,
          currency: "USD",
          metadata: {},
          createdAt: NOW,
        });
      });

      await budgetService.setBudgetConfig({ monthlyLimitUsd: 100 });
      await expect(budgetService.getBudgetConfig()).resolves.toEqual({ monthlyLimitUsd: 100 });

      const nearLimit = await budgetService.getBudgetStatus("2026-05-23T12:00:00.000Z");
      expect(nearLimit).toMatchObject({
        month: "2026-05",
        spentUsd: 80,
        remainingUsd: 20,
        state: "near_limit",
      });

      db.withWriteTransaction((conn) => {
        usageRepo.insert(conn, {
          id: "usage-2",
          occurredAt: "2026-05-11T10:00:00.000Z",
          usageDay: "2026-05-11",
          usageMonth: "2026-05",
          providerId: "openai-best",
          providerKind: "openai",
          providerApi: "openai-responses",
          model: "gpt-4.1",
          routeStrategy: "configured",
          taskComplexity: "medium",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 1500,
          costUsd: 25,
          currency: "USD",
          metadata: {},
          createdAt: NOW,
        });
      });

      const overLimit = await budgetService.getBudgetStatus("2026-05-23T12:00:00.000Z");
      expect(overLimit).toMatchObject({
        month: "2026-05",
        spentUsd: 105,
        remainingUsd: 0,
        state: "over_limit",
      });
    });
  });
});
