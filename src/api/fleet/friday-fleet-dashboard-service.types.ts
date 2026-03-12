import type { FridaySqliteLayer } from "#state";
import type { UUID } from "#workflows";
import type { FridayOutboxQueueService } from "#satellites";
import type {
  FridayFleetOverviewResponse,
  FridayFleetRemediationActionExecutionResult,
  FridayFleetRemediationPlan,
  FridayFleetSatelliteDetailResponse,
  FridayListFleetSatellitesQuery,
  FridayListFleetSatellitesResponse,
  FridaySecurityCenterResponse,
} from "../model/friday-api-fleet.types.js";

export interface FridayFleetDashboardService {
  getOverview(): FridayFleetOverviewResponse;
  listSatellites(input: FridayListFleetSatellitesQuery): FridayListFleetSatellitesResponse;
  getSatelliteDetail(satelliteId: UUID): FridayFleetSatelliteDetailResponse | null;
  getSatelliteRemediationPlan(satelliteId: UUID): FridayFleetRemediationPlan | null;
  executeSatelliteRemediationAction(input: {
    satelliteId: UUID;
    actionId: string;
  }): Promise<FridayFleetRemediationActionExecutionResult>;
  getSecurityCenter(): FridaySecurityCenterResponse;
}

export interface CreateFridayFleetDashboardServiceDeps {
  db: FridaySqliteLayer;
  nowIso: () => string;
  idGenerator: () => string;
  outboxQueueService?: FridayOutboxQueueService;
}
