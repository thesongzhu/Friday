import { FridayDomainError } from "#errors";
import type {
  FridayMarketplaceCreatorService,
  FridayRecordSupportInput,
} from "../../../marketplace/services/friday-marketplace-creator-service.js";
import type { MarketplaceActorContext } from "../../../marketplace/model/friday-marketplace.types.js";
import type {
  FridayHttpContext,
  FridayRouteDefinition,
} from "../../model/friday-api-common.types.js";

export interface FridayMarketplaceCreatorRoutesDeps {
  service: FridayMarketplaceCreatorService;
}

type Ctx = FridayHttpContext<Record<string, string>, Record<string, string>, unknown>;
type Route = FridayRouteDefinition<Record<string, string>, Record<string, string>, unknown, unknown>;

function requireMarketplaceActor(ctx: Ctx): MarketplaceActorContext {
  const principal = ctx.principal;
  const principalId = principal?.principalId;
  if (!principalId) {
    throw new FridayDomainError("UNAUTHORIZED", "Authentication required", { httpStatus: 401 });
  }
  const tenantId = typeof principal?.tenantId === "string" && principal.tenantId.trim().length > 0
    ? principal.tenantId.trim()
    : principalId;
  return { tenantId, principalId };
}

function readSupportBody(body: unknown): Pick<FridayRecordSupportInput, "amount" | "message"> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Support body is required", { httpStatus: 400 });
  }
  const amount = (body as { amount?: unknown }).amount;
  if (!amount || typeof amount !== "object" || Array.isArray(amount)) {
    throw new FridayDomainError("VALIDATION_ERROR", "amount is required", { httpStatus: 400 });
  }
  const amountValue = (amount as { amount?: unknown }).amount;
  const currency = (amount as { currency?: unknown }).currency;
  if (!Number.isInteger(amountValue) || (amountValue as number) <= 0) {
    throw new FridayDomainError("VALIDATION_ERROR", "amount.amount must be a positive integer", { httpStatus: 400 });
  }
  if (typeof currency !== "string" || currency.trim().length !== 3) {
    throw new FridayDomainError("VALIDATION_ERROR", "amount.currency must be a 3-letter currency code", { httpStatus: 400 });
  }
  const message = (body as { message?: unknown }).message;
  if (message !== undefined && message !== null && typeof message !== "string") {
    throw new FridayDomainError("VALIDATION_ERROR", "message must be a string", { httpStatus: 400 });
  }
  return {
    amount: {
      amount: amountValue as number,
      currency: currency.trim().toUpperCase(),
    },
    message: typeof message === "string" ? message.trim() || null : null,
  };
}

export function createFridayMarketplaceCreatorRoutes(
  deps: FridayMarketplaceCreatorRoutesDeps,
): Route[] {
  return [
    {
      operationId: "marketplace.creators.list",
      method: "GET",
      path: "/v1/marketplace/creators",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler() {
        return { items: await deps.service.listCreators() };
      },
    },
    {
      operationId: "marketplace.creators.get",
      method: "GET",
      path: "/v1/marketplace/creators/:creatorId",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const creatorId = ctx.params.creatorId;
        const creator = await deps.service.getCreator(creatorId);
        if (creator === null) {
          throw new FridayDomainError(
            "MARKETPLACE_CREATOR_NOT_FOUND",
            `Marketplace creator "${creatorId}" not found`,
            { httpStatus: 404, details: { creatorId } },
          );
        }
        return creator;
      },
    },
    {
      operationId: "marketplace.assets.support",
      method: "POST",
      path: "/v1/marketplace/assets/:assetId/support",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        const body = readSupportBody(ctx.body);
        return deps.service.recordSupport({
          assetId: ctx.params.assetId,
          actor: requireMarketplaceActor(ctx),
          ...body,
        });
      },
    },
  ];
}
