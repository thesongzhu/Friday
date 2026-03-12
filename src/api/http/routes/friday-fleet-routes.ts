import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "#workflows";
import type {
  FridayListFleetSatellitesQuery,
} from "../../model/friday-api-fleet.types.js";
import type { FridayFleetDashboardService } from "../../fleet/friday-fleet-dashboard-service.types.js";
import { FridayDomainError } from "#errors";

// ─── Constants ───

const FLEET_MAX_LIST_LIMIT = 100;

export interface FridayFleetRoutesDeps {
  fleetService: FridayFleetDashboardService;
}

export function createFridayFleetRoutes(
  deps: FridayFleetRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "fleet.overview",
      method: "GET",
      path: "/v1/fleet/overview",
      auth: { public: false, anyOfScopes: ["fleet.read"] },
      async handler() {
        return deps.fleetService.getOverview();
      },
    },
    {
      operationId: "fleet.list.satellites",
      method: "GET",
      path: "/v1/fleet/satellites",
      auth: { public: false, anyOfScopes: ["fleet.read"] },
      async handler(ctx) {
        const query = ctx.query as Record<string, string | undefined>;
        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "limit must be a positive integer",
              { httpStatus: 400 },
            );
          }
          limit = Math.min(parsed, FLEET_MAX_LIST_LIMIT);
        }
        const sanitised: FridayListFleetSatellitesQuery = {
          ...query,
          limit,
          cursor: query.cursor,
        };
        return deps.fleetService.listSatellites(sanitised);
      },
    },
    {
      operationId: "fleet.get.satellite.detail",
      method: "GET",
      path: "/v1/fleet/satellites/:satelliteId",
      auth: { public: false, anyOfScopes: ["fleet.read"] },
      async handler(ctx) {
        const { satelliteId } = ctx.params as { satelliteId: UUID };
        const detail = deps.fleetService.getSatelliteDetail(satelliteId);
        if (!detail) {
          throw new FridayDomainError(
            "SATELLITE_NOT_FOUND",
            `Satellite '${satelliteId}' not found`,
            { httpStatus: 404 },
          );
        }
        return detail;
      },
    },
    {
      operationId: "fleet.get.satellite.remediation",
      method: "GET",
      path: "/v1/fleet/satellites/:satelliteId/remediation",
      auth: { public: false, anyOfScopes: ["fleet.read"] },
      async handler(ctx) {
        const { satelliteId } = ctx.params as { satelliteId: UUID };
        const remediation = deps.fleetService.getSatelliteRemediationPlan(satelliteId);
        if (!remediation) {
          throw new FridayDomainError(
            "SATELLITE_NOT_FOUND",
            `Satellite '${satelliteId}' not found`,
            { httpStatus: 404 },
          );
        }
        return remediation;
      },
    },
    {
      operationId: "fleet.execute.satellite.remediation",
      method: "POST",
      path: "/v1/fleet/satellites/:satelliteId/remediation/:actionId/execute",
      auth: { public: false, anyOfScopes: ["hub.admin"] },
      async handler(ctx) {
        const { satelliteId, actionId } = ctx.params as {
          satelliteId: UUID;
          actionId: string;
        };
        return deps.fleetService.executeSatelliteRemediationAction({
          satelliteId,
          actionId,
        });
      },
    },
  ];
}
