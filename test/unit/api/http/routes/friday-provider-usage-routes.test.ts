import { describe, expect, it, vi } from "vitest";

import { createFridayProviderUsageRoutes } from "../../../../../src/api/http/routes/friday-provider-usage-routes.js";
import type { FridayProviderService } from "#providers";
import type { FridayHttpContext } from "#api";
import { createFridayProviderSetupMutatingActionRequest } from "../../../../../src/api/http/routes/friday-provider-routes.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayCanonicalApprovalResolution,
} from "../../../../../src/security/friday-mutating-action-gate.js";

const NOW = "2026-05-27T10:15:00.000Z";
const PLAN_DIGEST = "provider-budget-plan-1";

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
    getBudgetStatus: vi.fn(async () => ({
      month: "2026-05",
      config: null,
      spentUsd: 0,
      remainingUsd: null,
      state: "ok" as const,
    })),
    setBudgetConfig: vi.fn(async (input) => input),
  } as unknown as FridayProviderService & {
    getUsageSummary: ReturnType<typeof vi.fn>;
    getBudgetStatus: ReturnType<typeof vi.fn>;
    setBudgetConfig: ReturnType<typeof vi.fn>;
  };
}

describe("FridayProviderUsageRoutes", () => {
  function makeCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
    return {
      requestId: "req-budget",
      receivedAt: NOW,
      params: {},
      query: {},
      body: undefined,
      headers: {},
      principal: null,
      ...overrides,
    };
  }

  function makeAdminCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
    return makeCtx({
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        role: "admin",
        scopes: ["hub.admin"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: NOW,
      },
      ...overrides,
    });
  }

  function makeBudgetApproval(monthlyLimitUsd: number): FridayCanonicalApprovalResolution {
    const request = createFridayProviderSetupMutatingActionRequest({
      action: "providers.budget.set",
      actor: {
        kind: "user",
        id: "user-1",
        principalId: "user-1",
      },
      surface: "api:/v1/providers/budget",
      resourceId: "llm.budget.v1",
      parameters: { monthlyLimitUsd },
      planDigest: PLAN_DIGEST,
    });
    return {
      decision: "approved",
      approvalId: "providers.budget.set-approval",
      decidedByPrincipalId: "user-1",
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt: "2026-05-27T11:15:00.000Z",
    };
  }

  function createBudgetRoutesWithGate(providerService: ReturnType<typeof makeProviderService>) {
    return createFridayProviderUsageRoutes({
      providerService,
      providerMutationGateRequired: true,
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => NOW,
        ticketIdGenerator: () => "ticket-budget-1",
      }),
    });
  }

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

  it("requires canonical approval before changing provider budget in gate-required profiles", async () => {
    const providerService = makeProviderService();
    const route = createBudgetRoutesWithGate(providerService)
      .find((entry) => entry.operationId === "providers.budget.set");

    if (!route) {
      throw new Error("providers.budget.set route not found");
    }

    await expect(route.handler(makeAdminCtx({
      body: { monthlyLimitUsd: 3 },
    }))).rejects.toMatchObject({
      code: "PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED",
    });

    expect(providerService.setBudgetConfig).not.toHaveBeenCalled();
  });

  it("accepts canonical approval and does not persist approval control fields as budget config", async () => {
    const providerService = makeProviderService();
    const route = createBudgetRoutesWithGate(providerService)
      .find((entry) => entry.operationId === "providers.budget.set");

    if (!route) {
      throw new Error("providers.budget.set route not found");
    }

    const result = await route.handler(makeAdminCtx({
      body: {
        monthlyLimitUsd: 3,
        planDigest: PLAN_DIGEST,
        canonicalApproval: makeBudgetApproval(3),
      },
    }));

    expect(providerService.setBudgetConfig).toHaveBeenCalledWith({ monthlyLimitUsd: 3 });
    expect(result).toMatchObject({
      budget: { monthlyLimitUsd: 3 },
      canonicalGate: {
        ticketId: "ticket-budget-1",
        approvalId: "providers.budget.set-approval",
        planDigest: PLAN_DIGEST,
      },
    });
  });
});
