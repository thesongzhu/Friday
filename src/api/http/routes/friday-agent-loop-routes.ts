import { FridayDomainError } from "#errors";
import { isUnauthenticatedPublicPrincipal } from "../../../security/friday-owner-session-channel-capability.js";
import type {
  FridayAgentLoopRunDetails,
  FridayAgentLoopService,
} from "../../../learning/services/friday-agent-loop-service.js";
import type { FridayAuthPrincipal } from "../../model/friday-api-auth.types.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayAgentLoopRunControlResponse,
  FridayAgentLoopRunRecord,
  FridayGetAgentLoopExpertModeResponse,
  FridayGetAgentLoopPolicyResponse,
  FridayGetAgentLoopRunResponse,
  FridayGetExpertAgentLoopRunResponse,
  FridayListAgentLoopRunsResponse,
  FridayListExpertAgentLoopRunsResponse,
  FridayUpdateAgentLoopExpertModeRequest,
  FridayUpdateAgentLoopExpertModeResponse,
  FridayUpdateAgentLoopPolicyRequest,
  FridayUpdateAgentLoopPolicyResponse,
} from "../../model/friday-api-agent-loop.types.js";
import {
  toFridayDiagnosisIncidentRecord,
  toFridayFixPlanRecord,
} from "./friday-self-healing-route-mappers.js";

export interface FridayAgentLoopRoutesDeps {
  service: FridayAgentLoopService;
  allowTestOnlyAgentLoopRunControlExecution?: boolean;
}

function throwRetiredAgentLoopRunControl(): never {
  throw new FridayDomainError(
    "TS_RUNTIME_AGENT_LOOP_CONTROLS_RETIRED",
    "Agent loop run controls are fail-closed while runtime ownership is being moved out of TypeScript.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_agent_loop_control_entrypoint_required",
      },
    },
  );
}

function requireUserId(principal: FridayAuthPrincipal | null): string {
  if (isUnauthenticatedPublicPrincipal(principal) || !principal?.userId) {
    throw new FridayDomainError("UNAUTHORIZED", "A user-scoped agent-loop principal is required", {
      httpStatus: 401,
    });
  }
  return principal.userId;
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

export function createFridayAgentLoopRoutes(
  deps: FridayAgentLoopRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const toRunRecord = (details: FridayAgentLoopRunDetails): FridayAgentLoopRunRecord => ({
    run: details.run,
    incident: details.incident
      ? toFridayDiagnosisIncidentRecord(details.incident, {
        incidentLoopRunId: details.run.loopRunId,
        actionLoopRunId: details.run.loopRunId,
      })
      : null,
    action: details.action ? toFridayFixPlanRecord(details.action, details.run.loopRunId) : null,
  });

  return [
    {
      operationId: "agent.loop.expertmode.get",
      method: "GET",
      path: "/v1/agent-loop/expert-mode",
      auth: { public: true },
      async handler(ctx): Promise<FridayGetAgentLoopExpertModeResponse> {
        const userId = requireUserId(ctx.principal);
        return {
          expertMode: deps.service.getExpertMode(userId),
        };
      },
    },
    {
      operationId: "agent.loop.expertmode.update",
      method: "PUT",
      path: "/v1/agent-loop/expert-mode",
      auth: { public: true },
      async handler(ctx): Promise<FridayUpdateAgentLoopExpertModeResponse> {
        requireUserId(ctx.principal);
        const body = (ctx.body ?? {}) as FridayUpdateAgentLoopExpertModeRequest;
        return {
          expertMode: deps.service.updateExpertMode({
            expertModeEnabled: body.enabled,
            expertModeUserIds: body.allowedUserIds,
            expertModeWorkspaceIds: body.allowedWorkspaceIds,
            expertModeEnvironments: body.allowedEnvironments,
            contextInferenceAllowed: body.contextInferenceAllowed,
            multiStepHypothesisSearchAllowed: body.multiStepHypothesisSearchAllowed,
            safeProbeExecutionAllowed: body.safeProbeExecutionAllowed,
            crossSurfaceOrchestrationAllowed: body.crossSurfaceOrchestrationAllowed,
            highRiskFinalApprovalRequired: body.highRiskFinalApprovalRequired,
            productionDestructiveActionApprovalRequired:
              body.productionDestructiveActionApprovalRequired,
            probeBudget: body.probeBudget,
            timeBudgetMinutes: body.timeBudgetMinutes,
          }),
        };
      },
    },
    {
      operationId: "agent.loop.policy.get",
      method: "GET",
      path: "/v1/agent-loop/policy",
      auth: { public: true },
      async handler(): Promise<FridayGetAgentLoopPolicyResponse> {
        return {
          policy: deps.service.getPolicy(),
        };
      },
    },
    {
      operationId: "agent.loop.policy.update",
      method: "PUT",
      path: "/v1/agent-loop/policy",
      auth: { public: true },
      async handler(ctx): Promise<FridayUpdateAgentLoopPolicyResponse> {
        requireUserId(ctx.principal);
        const body = (ctx.body ?? {}) as FridayUpdateAgentLoopPolicyRequest;
        return {
          policy: deps.service.updatePolicy(body),
        };
      },
    },
    {
      operationId: "agent.loop.runs.list",
      method: "GET",
      path: "/v1/agent-loop/runs",
      auth: { public: true },
      async handler(ctx): Promise<FridayListAgentLoopRunsResponse> {
        const userId = requireUserId(ctx.principal);
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        const status = typeof query.status === "string"
          ? query.status as Parameters<FridayAgentLoopService["listRuns"]>[0]["status"]
          : undefined;
        const limit = readPositiveInt(query.limit);
        return {
          items: deps.service.listRuns({ userId, status, limit }).map(toRunRecord),
        };
      },
    },
    {
      operationId: "agent.loop.expertruns.list",
      method: "GET",
      path: "/v1/agent-loop/expert-runs",
      auth: { public: true },
      async handler(ctx): Promise<FridayListExpertAgentLoopRunsResponse> {
        const userId = requireUserId(ctx.principal);
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        const status = typeof query.status === "string"
          ? query.status as Parameters<FridayAgentLoopService["listRuns"]>[0]["status"]
          : undefined;
        const limit = readPositiveInt(query.limit);
        return {
          items: deps.service.listExpertRuns({ userId, status, limit }).map(toRunRecord),
        };
      },
    },
    {
      operationId: "agent.loop.runs.get",
      method: "GET",
      path: "/v1/agent-loop/runs/:loopRunId",
      auth: { public: true },
      async handler(ctx): Promise<FridayGetAgentLoopRunResponse> {
        requireUserId(ctx.principal);
        const { loopRunId } = ctx.params as { loopRunId: string };
        const run = deps.service.getRun({ loopRunId });
        if (!run) {
          throw new FridayDomainError("AGENT_LOOP_RUN_NOT_FOUND", "Agent loop run not found", {
            httpStatus: 404,
          });
        }
        return toRunRecord(run);
      },
    },
    {
      operationId: "agent.loop.expertruns.get",
      method: "GET",
      path: "/v1/agent-loop/expert-runs/:loopRunId",
      auth: { public: true },
      async handler(ctx): Promise<FridayGetExpertAgentLoopRunResponse> {
        requireUserId(ctx.principal);
        const { loopRunId } = ctx.params as { loopRunId: string };
        const run = deps.service.getExpertRun({ loopRunId });
        if (!run) {
          throw new FridayDomainError("AGENT_LOOP_RUN_NOT_FOUND", "Agent loop run not found", {
            httpStatus: 404,
          });
        }
        return toRunRecord(run);
      },
    },
    {
      operationId: "agent.loop.runs.pause",
      method: "POST",
      path: "/v1/agent-loop/runs/:loopRunId/pause",
      auth: { public: true },
      async handler(ctx): Promise<FridayAgentLoopRunControlResponse> {
        requireUserId(ctx.principal);
        const { loopRunId } = ctx.params as { loopRunId: string };
        if (deps.allowTestOnlyAgentLoopRunControlExecution !== true) {
          throwRetiredAgentLoopRunControl();
        }
        return {
          run: toRunRecord(deps.service.pauseRun({ loopRunId })),
        };
      },
    },
    {
      operationId: "agent.loop.runs.resume",
      method: "POST",
      path: "/v1/agent-loop/runs/:loopRunId/resume",
      auth: { public: true },
      async handler(ctx): Promise<FridayAgentLoopRunControlResponse> {
        requireUserId(ctx.principal);
        const { loopRunId } = ctx.params as { loopRunId: string };
        if (deps.allowTestOnlyAgentLoopRunControlExecution !== true) {
          throwRetiredAgentLoopRunControl();
        }
        return {
          run: toRunRecord(await deps.service.resumeRun({ loopRunId })),
        };
      },
    },
    {
      operationId: "agent.loop.runs.cancel",
      method: "POST",
      path: "/v1/agent-loop/runs/:loopRunId/cancel",
      auth: { public: true },
      async handler(ctx): Promise<FridayAgentLoopRunControlResponse> {
        requireUserId(ctx.principal);
        const { loopRunId } = ctx.params as { loopRunId: string };
        if (deps.allowTestOnlyAgentLoopRunControlExecution !== true) {
          throwRetiredAgentLoopRunControl();
        }
        return {
          run: toRunRecord(deps.service.cancelRun({ loopRunId })),
        };
      },
    },
  ];
}
