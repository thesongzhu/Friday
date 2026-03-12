import { FridayDomainError } from "#errors";
import type {
  MarketplaceActorContext,
} from "../../../marketplace/model/friday-marketplace.types.js";
import type {
  FridayHttpContext,
  FridayRouteDefinition,
} from "../../model/friday-api-common.types.js";
import type {
  FridayCreateMarketplaceRequestInput,
  FridayCreateMarketplaceRequestResponseInput,
  FridayMarketplaceRequestBoardService,
} from "../../../marketplace/services/friday-marketplace-request-board-service.js";

export interface FridayMarketplaceRequestRoutesDeps {
  service: FridayMarketplaceRequestBoardService;
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

function readQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseCreateRequestBody(body: unknown): FridayCreateMarketplaceRequestInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body is required", { httpStatus: 400 });
  }
  const payload = body as Record<string, unknown>;
  const assetKind = readQueryString(payload.assetKind);
  const title = readQueryString(payload.title);
  const goal = readQueryString(payload.goal);
  const desiredOutcome = readQueryString(payload.desiredOutcome);
  const privacy = readQueryString(payload.privacy);
  const publishability = readQueryString(payload.publishability);
  if (assetKind !== "skill" && assetKind !== "workflow" && assetKind !== "agent") {
    throw new FridayDomainError("VALIDATION_ERROR", "assetKind must be skill, workflow, or agent", {
      httpStatus: 400,
    });
  }
  if (!title || !goal || !desiredOutcome) {
    throw new FridayDomainError("VALIDATION_ERROR", "title, goal, and desiredOutcome are required", {
      httpStatus: 400,
    });
  }
  if (privacy !== "public" && privacy !== "private") {
    throw new FridayDomainError("VALIDATION_ERROR", "privacy must be public or private", { httpStatus: 400 });
  }
  if (publishability !== "private_only" && publishability !== "allow_publication") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "publishability must be private_only or allow_publication",
      { httpStatus: 400 },
    );
  }
  const constraintsRaw = payload.constraints;
  const constraints = Array.isArray(constraintsRaw)
    ? constraintsRaw.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
    : [];
  return {
    assetKind,
    title,
    goal,
    desiredOutcome,
    constraints,
    budgetSupportIntent: readQueryString(payload.budgetSupportIntent) ?? null,
    privacy,
    publishability,
    riskNotes: readQueryString(payload.riskNotes) ?? null,
  };
}

function parseCreateResponseBody(body: unknown): FridayCreateMarketplaceRequestResponseInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Response body is required", { httpStatus: 400 });
  }
  const payload = body as Record<string, unknown>;
  const message = readQueryString(payload.message);
  if (!message) {
    throw new FridayDomainError("VALIDATION_ERROR", "message is required", { httpStatus: 400 });
  }
  return {
    message,
    proposal: readQueryString(payload.proposal) ?? null,
    deliverableAssetId: readQueryString(payload.deliverableAssetId) ?? null,
  };
}

export function createFridayMarketplaceRequestRoutes(
  deps: FridayMarketplaceRequestRoutesDeps,
): Route[] {
  return [
    {
      operationId: "marketplace.requests.list",
      method: "GET",
      path: "/v1/marketplace/requests",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        return {
          items: await deps.service.listRequests(requireMarketplaceActor(ctx), {
            assetKind: readQueryString(ctx.query.assetKind) as FridayCreateMarketplaceRequestInput["assetKind"] | undefined,
            status: readQueryString(ctx.query.status) as never,
            privacy: readQueryString(ctx.query.privacy) as FridayCreateMarketplaceRequestInput["privacy"] | undefined,
          }),
        };
      },
    },
    {
      operationId: "marketplace.requests.create",
      method: "POST",
      path: "/v1/marketplace/requests",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        return deps.service.createRequest(
          parseCreateRequestBody(ctx.body),
          requireMarketplaceActor(ctx),
        );
      },
    },
    {
      operationId: "marketplace.requests.get",
      method: "GET",
      path: "/v1/marketplace/requests/:requestId",
      auth: { public: false, anyOfScopes: ["marketplace.read"] },
      async handler(ctx: Ctx) {
        const bundle = await deps.service.getRequest(ctx.params.requestId, requireMarketplaceActor(ctx));
        if (bundle === null) {
          throw new FridayDomainError(
            "MARKETPLACE_REQUEST_NOT_FOUND",
            `Marketplace request "${ctx.params.requestId}" not found`,
            { httpStatus: 404, details: { requestId: ctx.params.requestId } },
          );
        }
        return bundle;
      },
    },
    {
      operationId: "marketplace.requests.responses.create",
      method: "POST",
      path: "/v1/marketplace/requests/:requestId/responses",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        return deps.service.createResponse(
          ctx.params.requestId,
          parseCreateResponseBody(ctx.body),
          requireMarketplaceActor(ctx),
        );
      },
    },
    {
      operationId: "marketplace.requests.accept",
      method: "POST",
      path: "/v1/marketplace/requests/:requestId/accept",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        const responseId = body ? readQueryString(body.responseId) : undefined;
        if (!responseId) {
          throw new FridayDomainError("VALIDATION_ERROR", "responseId is required", { httpStatus: 400 });
        }
        return deps.service.acceptResponse(
          ctx.params.requestId,
          responseId,
          requireMarketplaceActor(ctx),
        );
      },
    },
    {
      operationId: "marketplace.requests.close",
      method: "POST",
      path: "/v1/marketplace/requests/:requestId/close",
      auth: { public: false, anyOfScopes: ["marketplace.write"] },
      async handler(ctx: Ctx) {
        return deps.service.closeRequest(ctx.params.requestId, requireMarketplaceActor(ctx));
      },
    },
  ];
}
