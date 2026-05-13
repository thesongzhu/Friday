import type { FridaySqliteLayer } from "#state";
import { createFridayJobSchedulerRepository } from "#jobs";

import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { FridayFleetDashboardService } from "../../fleet/friday-fleet-dashboard-service.types.js";

export interface FridayTuiRoutesDeps {
  db: FridaySqliteLayer;
  version: string;
  fleetService: FridayFleetDashboardService;
}

interface FridayTuiStatusResponse {
  version: string;
  uptime: number;
  activeSessions: number;
  runningJobs: number;
  connectedSatellites: number;
}

interface FridayTuiJobSummaryResponse {
  jobId: string;
  name: string;
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

function mapJobStatus(input: {
  enabled: boolean;
  runningAt: string | null;
  lastStatus: "ok" | "error" | "timeout" | null;
  nextRunAt: string | null;
}): string {
  if (input.runningAt) return "running";
  if (!input.enabled) return "disabled";
  if (input.lastStatus === "error" || input.lastStatus === "timeout") return "failed";
  if (input.nextRunAt) return "scheduled";
  if (input.lastStatus === "ok") return "idle";
  return "pending";
}

export function createFridayTuiRoutes(
  deps: FridayTuiRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const schedulerRepo = createFridayJobSchedulerRepository({ db: deps.db });

  return [
    {
      operationId: "tui.status.get",
      method: "GET",
      path: "/v1/status",
      auth: { public: true },
      async handler(): Promise<FridayTuiStatusResponse> {
        const activeSessions = deps.db.withReadConnection((db) => {
          const row = db
            .prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'")
            .get() as { count?: number } | undefined;
          return row?.count ?? 0;
        });
        const overview = deps.fleetService.getOverview();
        const runningJobs = schedulerRepo.listAll().filter((job) => job.runningAt !== null).length;

        return {
          version: deps.version,
          uptime: Math.max(0, Math.floor(process.uptime())),
          activeSessions,
          runningJobs,
          connectedSatellites: overview.totals.online,
        };
      },
    },
    {
      operationId: "tui.jobs.list",
      method: "GET",
      path: "/v1/jobs",
      auth: { public: true },
      async handler(): Promise<FridayTuiJobSummaryResponse[]> {
        return schedulerRepo.listAll().map((job) => ({
          jobId: job.id,
          name: job.id,
          status: mapJobStatus(job),
          lastRunAt: job.lastRunAt,
          nextRunAt: job.nextRunAt,
        }));
      },
    },
  ];
}
