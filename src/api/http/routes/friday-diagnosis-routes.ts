import { FridayDomainError } from "#errors";
import type { FridaySelfHealingApiService } from "#learning";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayDiagnosisIncidentRecord,
  FridayDiagnosisSummary,
  FridayGetDiagnosisIncidentResponse,
  FridayGetIncidentDiagnosisResponse,
  FridayListDiagnosisIncidentsResponse,
} from "../../model/friday-api-self-healing.types.js";
import {
  toFridayDiagnosisIncidentRecord,
  toFridayDiagnosisSummary,
} from "./friday-self-healing-route-mappers.js";

export interface FridayDiagnosisRoutesDeps {
  service: FridaySelfHealingApiService;
  agentLoop?: {
    findRunByIncidentId(incidentId: string): { loopRunId: string } | null;
  };
}

function readPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function requireUserId(principal: { userId?: string } | null): string {
  if (!principal?.userId) {
    throw new FridayDomainError("UNAUTHORIZED", "A user-scoped diagnosis principal is required", {
      httpStatus: 401,
    });
  }
  return principal.userId;
}

function toDiagnosisSummary(
  deps: FridayDiagnosisRoutesDeps,
  details: NonNullable<ReturnType<FridaySelfHealingApiService["getIncidentDiagnosis"]>>,
): FridayDiagnosisSummary {
  return toFridayDiagnosisSummary(
    details,
    deps.agentLoop?.findRunByIncidentId(details.incident.incidentId)?.loopRunId,
  );
}

function toIncidentRecord(
  deps: FridayDiagnosisRoutesDeps,
  details: NonNullable<ReturnType<FridaySelfHealingApiService["getIncidentDiagnosis"]>>,
): FridayDiagnosisIncidentRecord {
  const loopRunId = deps.agentLoop?.findRunByIncidentId(details.incident.incidentId)?.loopRunId;
  return toFridayDiagnosisIncidentRecord(details, {
    incidentLoopRunId: loopRunId,
    actionLoopRunId: loopRunId,
  });
}

export function createFridayDiagnosisRoutes(
  deps: FridayDiagnosisRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "diagnosis.incidents.list",
      method: "GET",
      path: "/v1/diagnosis/incidents",
      auth: { public: false, anyOfScopes: ["diagnosis.read"] },
      async handler(ctx): Promise<FridayListDiagnosisIncidentsResponse> {
        const userId = requireUserId(ctx.principal);
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        const status = typeof query.status === "string"
          ? query.status as "open" | "mitigated" | "resolved"
          : undefined;
        const limit = readPositiveInt(query.limit);
        return {
          items: deps.service.listIncidents({ userId, status, limit }).map((item) => toIncidentRecord(deps, item)),
        };
      },
    },
    {
      operationId: "diagnosis.incidents.get",
      method: "GET",
      path: "/v1/diagnosis/incidents/:incidentId",
      auth: { public: false, anyOfScopes: ["diagnosis.read"] },
      async handler(ctx): Promise<FridayGetDiagnosisIncidentResponse> {
        requireUserId(ctx.principal);
        const { incidentId } = ctx.params as { incidentId: string };
        const incident = deps.service.getIncident({ incidentId });
        if (!incident) {
          throw new FridayDomainError("DIAGNOSIS_INCIDENT_NOT_FOUND", "Incident not found", {
            httpStatus: 404,
          });
        }
        return toIncidentRecord(deps, incident);
      },
    },
    {
      operationId: "diagnosis.incidents.diagnosis.get",
      method: "GET",
      path: "/v1/diagnosis/incidents/:incidentId/diagnosis",
      auth: { public: false, anyOfScopes: ["diagnosis.read"] },
      async handler(ctx): Promise<FridayGetIncidentDiagnosisResponse> {
        requireUserId(ctx.principal);
        const { incidentId } = ctx.params as { incidentId: string };
        const details = deps.service.getIncidentDiagnosis({ incidentId });
        if (!details) {
          throw new FridayDomainError("DIAGNOSIS_RECORD_NOT_FOUND", "Diagnosis not found", {
            httpStatus: 404,
          });
        }
        return {
          incident: details.incident,
          diagnosis: details.diagnosis,
          summary: toDiagnosisSummary(deps, details),
          action: details.action
            ? {
              action: details.action.action,
              approval: details.action.approval,
              summary: {
                actionId: details.action.action.actionId,
                incidentId: details.action.action.incidentId,
                title: details.action.action.plan.title,
                summary: details.action.action.plan.summary,
                riskTier: details.action.action.riskTier,
                status: details.action.action.status,
                outcome: details.action.action.outcome,
                requiresApproval: details.action.risk.requiresApproval,
                autoApplyAllowed: details.action.risk.autoApplyAllowed,
                rollbackPlanAvailable: details.action.evidence.selectedPlan.rollbackPlanAvailable,
                createdAt: details.action.action.createdAt,
                updatedAt: details.action.action.updatedAt,
              },
              evidence: details.action.evidence,
            }
            : null,
        };
      },
    },
  ];
}
