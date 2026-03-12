import type {
  FridayHttpContext,
  FridayRouteDefinition,
} from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "#errors";
import type { FridayMarketplaceAssetCatalogService } from "../../../marketplace/services/friday-marketplace-asset-catalog-service.js";

export interface FridayMarketplaceAssetRoutesDeps {
  service: FridayMarketplaceAssetCatalogService;
}

type Ctx = FridayHttpContext<Record<string, string>, Record<string, string>, unknown>;
type Route = FridayRouteDefinition<Record<string, string>, Record<string, string>, unknown, unknown>;

export function createFridayMarketplaceAssetRoutes(
  deps: FridayMarketplaceAssetRoutesDeps,
): Route[] {
  return [
    {
      operationId: "marketplace.assets.list",
      method: "GET",
      path: "/v1/marketplace/assets",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(_ctx: Ctx) {
        return {
          items: await deps.service.listAssets(),
        };
      },
    },
    {
      operationId: "marketplace.assets.get",
      method: "GET",
      path: "/v1/marketplace/assets/:assetId",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const assetId = ctx.params.assetId;
        const asset = await deps.service.getAsset(assetId);
        if (asset === null) {
          throw new FridayDomainError(
            "MARKETPLACE_ASSET_NOT_FOUND",
            `Marketplace asset "${assetId}" not found`,
            { httpStatus: 404, details: { assetId } },
          );
        }
        return asset;
      },
    },
  ];
}
