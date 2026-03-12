import { describe, expect, it, vi } from "vitest";

import type { FridayHttpContext } from "#api";
import {
  createFridayMarketplaceCreatorRoutes,
  type FridayMarketplaceCreatorRoutesDeps,
} from "#api";

function makeCtx(
  overrides: Partial<FridayHttpContext<Record<string, string>, Record<string, string>, unknown>> = {},
): FridayHttpContext<Record<string, string>, Record<string, string>, unknown> {
  return {
    requestId: "req-marketplace-creator-1",
    receivedAt: "2026-03-08T00:00:00.000Z",
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: null,
    ...overrides,
  };
}

function makeDeps(): FridayMarketplaceCreatorRoutesDeps {
  return {
    service: {
      listCreators: vi.fn(async () => [
        {
          id: "publisher:friday",
          displayName: "Friday",
          bio: null,
          avatarUrl: null,
          websiteUrl: null,
          assetIds: ["skill:skill.alpha"],
          verifiedPublisher: true,
          reputation: {
            overallScore: 88,
            ratingAverage: null,
            ratingCount: 0,
            supportCount: 2,
            supportTotal: { amount: 1500, currency: "USD" },
            installCount: 4,
            verifiedAssetCount: 1,
            verificationSuccessRate: 1,
            permissionRestraintScore: 92,
            fulfilledRequestCount: 0,
          },
        },
      ]),
      getCreator: vi.fn(async (creatorId: string) =>
        creatorId === "publisher:friday"
          ? {
            id: "publisher:friday",
            displayName: "Friday",
            bio: null,
            avatarUrl: null,
            websiteUrl: null,
            assetIds: ["skill:skill.alpha"],
            verifiedPublisher: true,
            reputation: {
              overallScore: 88,
              ratingAverage: null,
              ratingCount: 0,
              supportCount: 2,
              supportTotal: { amount: 1500, currency: "USD" },
              installCount: 4,
              verifiedAssetCount: 1,
              verificationSuccessRate: 1,
              permissionRestraintScore: 92,
              fulfilledRequestCount: 0,
            },
          }
          : null,
      ),
      recordSupport: vi.fn(async (input) => ({
        supportEvent: {
          id: "support-1",
          creatorId: "publisher:friday",
          assetId: input.assetId,
          assetType: "skill",
          supporterTenantId: input.actor.tenantId,
          supporterPrincipalId: input.actor.principalId,
          amount: input.amount,
          message: input.message ?? null,
          createdAt: "2026-03-08T00:00:00.000Z",
        },
        creator: {
          id: "publisher:friday",
          displayName: "Friday",
          bio: null,
          avatarUrl: null,
          websiteUrl: null,
          assetIds: ["skill:skill.alpha"],
          verifiedPublisher: true,
          reputation: {
            overallScore: 90,
            ratingAverage: null,
            ratingCount: 0,
            supportCount: 3,
            supportTotal: { amount: 2500, currency: "USD" },
            installCount: 4,
            verifiedAssetCount: 1,
            verificationSuccessRate: 1,
            permissionRestraintScore: 92,
            fulfilledRequestCount: 0,
          },
        },
      })),
    } as FridayMarketplaceCreatorRoutesDeps["service"],
  };
}

describe("FridayMarketplaceCreatorRoutes", () => {
  it("registers creator and support routes", () => {
    const routes = createFridayMarketplaceCreatorRoutes(makeDeps());
    expect(routes.map((route) => route.operationId)).toEqual([
      "marketplace.creators.list",
      "marketplace.creators.get",
      "marketplace.assets.support",
    ]);
  });

  it("lists creators", async () => {
    const deps = makeDeps();
    const route = createFridayMarketplaceCreatorRoutes(deps).find((entry) => entry.operationId === "marketplace.creators.list")!;

    const result = await route.handler(makeCtx());

    expect(deps.service.listCreators).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      items: [expect.objectContaining({ id: "publisher:friday" })],
    });
  });

  it("returns a creator by id", async () => {
    const deps = makeDeps();
    const route = createFridayMarketplaceCreatorRoutes(deps).find((entry) => entry.operationId === "marketplace.creators.get")!;

    const result = await route.handler(makeCtx({ params: { creatorId: "publisher:friday" } }));

    expect(deps.service.getCreator).toHaveBeenCalledWith("publisher:friday");
    expect(result).toEqual(expect.objectContaining({ id: "publisher:friday" }));
  });

  it("throws not found when creator is missing", async () => {
    const route = createFridayMarketplaceCreatorRoutes(makeDeps()).find((entry) => entry.operationId === "marketplace.creators.get")!;

    await expect(
      route.handler(makeCtx({ params: { creatorId: "publisher:missing" } })),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_CREATOR_NOT_FOUND",
    });
  });

  it("requires authentication to support an asset", async () => {
    const route = createFridayMarketplaceCreatorRoutes(makeDeps()).find((entry) => entry.operationId === "marketplace.assets.support")!;

    await expect(
      route.handler(makeCtx({
        params: { assetId: "skill:skill.alpha" },
        body: { amount: { amount: 500, currency: "usd" } },
      })),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("validates support body", async () => {
    const route = createFridayMarketplaceCreatorRoutes(makeDeps()).find((entry) => entry.operationId === "marketplace.assets.support")!;

    await expect(
      route.handler(makeCtx({
        params: { assetId: "skill:skill.alpha" },
        principal: { principalId: "tenant-1" } as never,
        body: { amount: { amount: 0, currency: "usd" } },
      })),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("normalizes currency and forwards principal identifiers to support recording", async () => {
    const deps = makeDeps();
    const route = createFridayMarketplaceCreatorRoutes(deps).find((entry) => entry.operationId === "marketplace.assets.support")!;

    const result = await route.handler(makeCtx({
      params: { assetId: "skill:skill.alpha" },
      principal: { principalId: "principal-1", tenantId: "tenant-1" } as never,
      body: {
        amount: { amount: 500, currency: "usd" },
        message: " Thanks! ",
      },
    }));

    expect(deps.service.recordSupport).toHaveBeenCalledWith({
      assetId: "skill:skill.alpha",
      actor: { tenantId: "tenant-1", principalId: "principal-1" },
      amount: { amount: 500, currency: "USD" },
      message: "Thanks!",
    });
    expect(result).toEqual(expect.objectContaining({
      supportEvent: expect.objectContaining({ assetId: "skill:skill.alpha" }),
    }));
  });
});
