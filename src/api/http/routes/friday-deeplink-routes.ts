import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "#errors";
import {
  parseFridayDeepLinkJson,
  parseFridayDeepLinkUri,
  validateFridayDeepLink,
} from "../../../deeplink/index.js";
import type {
  FridayDeepLinkApplyResult,
  FridayDeepLinkPreviewResult,
} from "../../../deeplink/index.js";

import type { FridayDeepLinkPayload } from "../../../deeplink/index.js";

export interface FridayDeepLinkRoutesDeps {
  applyDeepLink?: (payload: FridayDeepLinkPayload) => Promise<FridayDeepLinkApplyResult>;
}

interface FridayDeepLinkPreviewRequest {
  uri?: string;
  payload?: unknown;
}

interface FridayDeepLinkPreviewResponse {
  preview: FridayDeepLinkPreviewResult;
}

interface FridayDeepLinkApplyRequest {
  uri?: string;
  payload?: unknown;
  confirmed: boolean;
}

interface FridayDeepLinkApplyResponse {
  result: FridayDeepLinkApplyResult;
}

export function createFridayDeepLinkRoutes(
  deps: FridayDeepLinkRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "deeplink.preview",
      method: "POST",
      path: "/v1/deeplink/preview",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx: { body: unknown }): Promise<FridayDeepLinkPreviewResponse> {
        const body = ctx.body as FridayDeepLinkPreviewRequest;

        let parsed;
        if (body.uri) {
          parsed = parseFridayDeepLinkUri(body.uri);
        } else if (body.payload) {
          parsed = parseFridayDeepLinkJson(body.payload);
        } else {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            "Either 'uri' or 'payload' must be provided",
            { httpStatus: 400 },
          );
        }

        if (!parsed.ok) {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            parsed.error,
            { httpStatus: 400 },
          );
        }

        const preview = validateFridayDeepLink(parsed.payload);
        return { preview };
      },
    },

    {
      operationId: "deeplink.apply",
      method: "POST",
      path: "/v1/deeplink/apply",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx: { body: unknown }): Promise<FridayDeepLinkApplyResponse> {
        const body = ctx.body as FridayDeepLinkApplyRequest;

        if (!body.confirmed) {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            "Deep link apply requires explicit confirmation (confirmed: true)",
            { httpStatus: 400 },
          );
        }

        let parsed;
        if (body.uri) {
          parsed = parseFridayDeepLinkUri(body.uri);
        } else if (body.payload) {
          parsed = parseFridayDeepLinkJson(body.payload);
        } else {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            "Either 'uri' or 'payload' must be provided",
            { httpStatus: 400 },
          );
        }

        if (!parsed.ok) {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            parsed.error,
            { httpStatus: 400 },
          );
        }

        const preview = validateFridayDeepLink(parsed.payload);
        if (preview.verdict === "blocked") {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            "Deep link payload has blocking issues and cannot be applied",
            { httpStatus: 422 },
          );
        }

        if (!deps.applyDeepLink) {
          // Fallback: return a "not yet wired" result for resource types
          // that don't have an apply handler yet.
          return {
            result: {
              applied: false,
              resourceType: parsed.payload.type,
              message: `Deep link apply for ${parsed.payload.type} is not yet wired in hub bootstrap.`,
            },
          };
        }

        const result = await deps.applyDeepLink(parsed.payload);
        return { result };
      },
    },
  ];
}
