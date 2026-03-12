import { FridayDomainError } from "#errors";
import type { FridaySelfHealingApiService } from "#learning";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayAutoFixApprovalResponse,
  FridayAutoFixExecutionResponse,
  FridayAutoFixMetricsResponse,
  FridayFixPlanRecord,
  FridayGetAutoFixActionResponse,
  FridayListAutoFixActionsResponse,
} from "../../model/friday-api-self-healing.types.js";
import { toFridayFixPlanRecord } from "./friday-self-healing-route-mappers.js";

export interface FridayAutoFixRoutesDeps {
  service: FridaySelfHealingApiService;
  agentLoop?: {
    findRunByActionId(actionId: string): { loopRunId: string } | null;
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
    throw new FridayDomainError("UNAUTHORIZED", "A user-scoped auto-fix principal is required", {
      httpStatus: 401,
    });
  }
  return principal.userId;
}

function readReason(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  return typeof record.reason === "string" && record.reason.trim().length > 0
    ? record.reason
    : undefined;
}

function toActionRecord(
  deps: FridayAutoFixRoutesDeps,
  details: NonNullable<ReturnType<FridaySelfHealingApiService["getAction"]>>,
): FridayFixPlanRecord {
  return toFridayFixPlanRecord(
    details,
    deps.agentLoop?.findRunByActionId(details.action.actionId)?.loopRunId,
  );
}

export function createFridayAutoFixRoutes(
  deps: FridayAutoFixRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "autofix.actions.list",
      method: "GET",
      path: "/v1/auto-fix/actions",
      auth: { public: false, anyOfScopes: ["diagnosis.read"] },
      async handler(ctx): Promise<FridayListAutoFixActionsResponse> {
        const userId = requireUserId(ctx.principal);
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        const status = typeof query.status === "string"
          ? query.status as "planned" | "applied" | "rolled_back" | "rejected"
          : undefined;
        const incidentId = typeof query.incidentId === "string" && query.incidentId.length > 0
          ? query.incidentId
          : undefined;
        const limit = readPositiveInt(query.limit);
        return {
          items: deps.service.listActions({ userId, status, incidentId, limit }).map((item) => toActionRecord(deps, item)),
        };
      },
    },
    {
      operationId: "autofix.actions.get",
      method: "GET",
      path: "/v1/auto-fix/actions/:actionId",
      auth: { public: false, anyOfScopes: ["diagnosis.read"] },
      async handler(ctx): Promise<FridayGetAutoFixActionResponse> {
        requireUserId(ctx.principal);
        const { actionId } = ctx.params as { actionId: string };
        const action = deps.service.getAction({ actionId });
        if (!action) {
          throw new FridayDomainError("AUTOFIX_ACTION_NOT_FOUND", "Auto-fix action not found", {
            httpStatus: 404,
          });
        }
        return toActionRecord(deps, action);
      },
    },
    {
      operationId: "autofix.actions.approve",
      method: "POST",
      path: "/v1/auto-fix/actions/:actionId/approve",
      auth: { public: false, anyOfScopes: ["diagnosis.write"] },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayAutoFixApprovalResponse> {
        const respondedBy = requireUserId(ctx.principal);
        const { actionId } = ctx.params as { actionId: string };
        const updated = await deps.service.approveAction({
          actionId,
          respondedBy,
          reason: readReason(ctx.body),
        });
        return {
          approval: updated.approval,
          action: toActionRecord(deps, updated),
        };
      },
    },
    {
      operationId: "autofix.actions.deny",
      method: "POST",
      path: "/v1/auto-fix/actions/:actionId/deny",
      auth: { public: false, anyOfScopes: ["diagnosis.write"] },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayAutoFixApprovalResponse> {
        const respondedBy = requireUserId(ctx.principal);
        const { actionId } = ctx.params as { actionId: string };
        const updated = await deps.service.denyAction({
          actionId,
          respondedBy,
          reason: readReason(ctx.body),
        });
        return {
          approval: updated.approval,
          action: toActionRecord(deps, updated),
        };
      },
    },
    {
      operationId: "autofix.actions.execute",
      method: "POST",
      path: "/v1/auto-fix/actions/:actionId/execute",
      auth: { public: false, anyOfScopes: ["diagnosis.write"] },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayAutoFixExecutionResponse> {
        requireUserId(ctx.principal);
        const { actionId } = ctx.params as { actionId: string };
        const updated = await deps.service.executeAction({ actionId });
        return {
          action: toActionRecord(deps, updated),
        };
      },
    },
    {
      operationId: "autofix.actions.rollback",
      method: "POST",
      path: "/v1/auto-fix/actions/:actionId/rollback",
      auth: { public: false, anyOfScopes: ["diagnosis.write"] },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayAutoFixExecutionResponse> {
        requireUserId(ctx.principal);
        const { actionId } = ctx.params as { actionId: string };
        const reason = readReason(ctx.body);
        if (!reason) {
          throw new FridayDomainError("VALIDATION_ERROR", "reason is required", {
            httpStatus: 400,
          });
        }
        const updated = await deps.service.rollbackAction({ actionId, reason });
        return {
          action: toActionRecord(deps, updated),
        };
      },
    },
    {
      operationId: "autofix.metrics.get",
      method: "GET",
      path: "/v1/auto-fix/metrics",
      auth: { public: false, anyOfScopes: ["diagnosis.read"] },
      async handler(ctx): Promise<FridayAutoFixMetricsResponse> {
        requireUserId(ctx.principal);
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        const day = typeof query.day === "string" ? query.day : undefined;
        const fromDay = typeof query.fromDay === "string" ? query.fromDay : undefined;
        const toDay = typeof query.toDay === "string" ? query.toDay : undefined;
        return {
          metrics: deps.service.getMetrics({ day, fromDay, toDay }),
        };
      },
    },
  ];
}
