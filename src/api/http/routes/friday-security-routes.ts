import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "#workflows";
import type { FridaySecurityCenterResponse } from "../../model/friday-api-fleet.types.js";
import type {
  FridayRevokeSatelliteRequest,
  FridayRevokeSatelliteResponse,
  FridayRevokeTokenRequest,
  FridayRevokeTokenResponse,
} from "../../model/friday-api-security.types.js";
import type { FridayFleetDashboardService } from "../../fleet/friday-fleet-dashboard-service.types.js";
import { FridayDomainError } from "#errors";

export interface FridaySecurityRoutesDeps {
  fleetService: FridayFleetDashboardService;
  revokeToken: (tokenId: UUID) => FridayRevokeTokenResponse;
  revokeSatellite: (satelliteId: UUID, reason?: string) => FridayRevokeSatelliteResponse;
}

export function createFridaySecurityRoutes(
  deps: FridaySecurityRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "security.center",
      method: "GET",
      path: "/v1/security/center",
      auth: { public: false, anyOfScopes: ["security.read"] },
      async handler() {
        return deps.fleetService.getSecurityCenter();
      },
    },
    {
      operationId: "security.revoke.token",
      method: "POST",
      path: "/v1/security/tokens/revoke",
      auth: { public: false, anyOfScopes: ["security.write"] },
      async handler(ctx) {
        const body = ctx.body as FridayRevokeTokenRequest | undefined;
        if (!body || typeof body.tokenId !== "string" || body.tokenId.trim().length === 0) {
          throw new FridayDomainError("VALIDATION_ERROR", "Request body must include a non-empty 'tokenId' string", { httpStatus: 400 });
        }
        return deps.revokeToken(body.tokenId);
      },
    },
    {
      operationId: "security.revoke.satellite",
      method: "POST",
      path: "/v1/security/satellites/:satelliteId/revoke",
      auth: { public: false, anyOfScopes: ["security.write"] },
      async handler(ctx) {
        const { satelliteId } = ctx.params as { satelliteId: UUID };
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        if (body.reason !== undefined && typeof body.reason !== "string") {
          throw new FridayDomainError("VALIDATION_ERROR", "'reason' must be a string when provided", { httpStatus: 400 });
        }
        const reason = body.reason as string | undefined;
        return deps.revokeSatellite(satelliteId, reason);
      },
    },
  ];
}
