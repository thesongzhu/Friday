import { describe, expect, it, vi } from "vitest";

import { createFridayProviderUsageRoutes } from "../../../../../src/api/http/routes/friday-provider-usage-routes.js";
import type { FridayProviderService } from "#providers";

function makeProviderService() {
  return {
    getUsageSummary: vi.fn(async (input) => ({
      from: input.from,
      to: input.to,
      groupBy: input.groupBy,
      rows: [],
      totals: {
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      },
    })),
  } as unknown as FridayProviderService & {
    getUsageSummary: ReturnType<typeof vi.fn>;
  };
}

describe("FridayProviderUsageRoutes", () => {
  it("defaults usage date range to UTC to match llm_usage_records.usage_day", async () => {
    const providerService = makeProviderService();
    const route = createFridayProviderUsageRoutes({ providerService })
      .find((entry) => entry.operationId === "providers.usage.get");

    if (!route) {
      throw new Error("providers.usage.get route not found");
    }

    await route.handler({
      requestId: "req-usage",
      // 2026-04-22 evening in US Pacific is already 2026-04-23 in UTC.
      receivedAt: "2026-04-23T05:18:06.000Z",
      params: {},
      query: {},
      body: undefined,
      headers: {},
      principal: null,
    });

    expect(providerService.getUsageSummary).toHaveBeenCalledWith({
      from: "2026-04-01",
      to: "2026-04-23",
      groupBy: "day",
      providerId: undefined,
      model: undefined,
    });
  });
});
