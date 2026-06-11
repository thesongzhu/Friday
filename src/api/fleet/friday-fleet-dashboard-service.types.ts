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
  /**
   * Test-oracle only: allows the legacy TypeScript fleet satellite-remediation
   * mutation (`executeSatelliteRemediationAction`) in isolated test/validation
   * harnesses. Default/live runtime must leave this unset so the method fails
   * closed for ALL callers (the HTTP fleet route guard is bypassed by a direct
   * method call). Reads (getOverview/listSatellites/getSatelliteDetail/
   * getSatelliteRemediationPlan/getSecurityCenter) stay live. Never default on.
   */
  allowTestOnlyFleetRemediationExecution?: boolean;
}
