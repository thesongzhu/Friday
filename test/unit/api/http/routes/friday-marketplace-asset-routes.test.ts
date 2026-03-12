import { describe, expect, it, vi } from "vitest";

import type { FridayHttpContext } from "#api";
import {
  createFridayMarketplaceAssetRoutes,
  type FridayMarketplaceAssetRoutesDeps,
} from "#api";

function makeCtx(
  overrides: Partial<FridayHttpContext<Record<string, string>, Record<string, string>, unknown>> = {},
): FridayHttpContext<Record<string, string>, Record<string, string>, unknown> {
  return {
    requestId: "req-marketplace-assets-1",
    receivedAt: "2026-03-08T00:00:00.000Z",
    params: {},
    query: {},
    body: null,
    headers: {},
    principal: null,
    ...overrides,
  };
}

function makeDeps(): FridayMarketplaceAssetRoutesDeps {
  return {
    service: {
      listAssets: vi.fn(async () => [
        {
          assetId: "skill:skill.alpha",
          assetType: "skill",
          sourceKind: "skills_lifecycle",
          distributionMode: "declarative_public",
          publicEligible: true,
          creatorId: "publisher:friday",
          title: "Alpha Skill",
          slug: "skill.alpha",
          summary: "Primary asset",
          publisherName: "Friday",
          installable: true,
          installed: false,
          enabled: false,
          verificationStatus: "verified",
          trustScore: 95,
          latestVersion: "1.0.0",
          maturity: "validated_and_keep",
        },
      ]),
      getAsset: vi.fn(async (assetId: string) =>
        assetId === "skill:skill.alpha"
          ? {
            assetId,
            assetType: "skill",
            sourceKind: "skills_lifecycle",
            distributionMode: "declarative_public",
            publicEligible: true,
            creatorId: "publisher:friday",
            title: "Alpha Skill",
            slug: "skill.alpha",
            summary: "Primary asset",
            publisherName: "Friday",
            installable: true,
            installed: false,
            enabled: false,
            verificationStatus: "verified",
            trustScore: 95,
            latestVersion: "1.0.0",
            maturity: "validated_and_keep",
            description: "Alpha description",
            permissions: ["system.read"],
            sourceLabel: "Friday catalog",
            provenance: {
              kind: "skill" as const,
              skillId: "skill.alpha",
            },
          }
          : null,
      ),
    } as FridayMarketplaceAssetRoutesDeps["service"],
  };
}

describe("FridayMarketplaceAssetRoutes", () => {
  it("registers unified marketplace asset routes", () => {
    const routes = createFridayMarketplaceAssetRoutes(makeDeps());
    expect(routes.map((route) => route.operationId)).toEqual([
      "marketplace.assets.list",
      "marketplace.assets.get",
    ]);
  });

  it("lists skill, workflow, and agent asset summaries through the service", async () => {
    const deps = makeDeps();
    const route = createFridayMarketplaceAssetRoutes(deps).find((entry) => entry.operationId === "marketplace.assets.list")!;

    const result = await route.handler(makeCtx());

    expect(deps.service.listAssets).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      items: [
        expect.objectContaining({
          assetId: "skill:skill.alpha",
          assetType: "skill",
        }),
      ],
    });
  });

  it("returns a detailed asset payload for known asset ids", async () => {
    const deps = makeDeps();
    const route = createFridayMarketplaceAssetRoutes(deps).find((entry) => entry.operationId === "marketplace.assets.get")!;

    const result = await route.handler(makeCtx({ params: { assetId: "skill:skill.alpha" } }));

    expect(deps.service.getAsset).toHaveBeenCalledWith("skill:skill.alpha");
    expect(result).toEqual(
      expect.objectContaining({
        assetId: "skill:skill.alpha",
        provenance: {
          kind: "skill",
          skillId: "skill.alpha",
        },
      }),
    );
  });

  it("throws a 404 domain error when the asset is missing", async () => {
    const route = createFridayMarketplaceAssetRoutes(makeDeps()).find((entry) => entry.operationId === "marketplace.assets.get")!;

    await expect(
      route.handler(makeCtx({ params: { assetId: "listing:missing" } })),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_ASSET_NOT_FOUND",
    });
  });
});
