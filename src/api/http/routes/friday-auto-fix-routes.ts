import { FridayDomainError } from "#errors";
import type { FridayAutoFixFeedbackReasonCode, FridaySelfHealingApiService } from "#learning";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayAutoFixApprovalResponse,
  FridayAutoFixExecutionResponse,
  FridayAutoFixMetricsResponse,
  FridayAutoFixRunReadyResponse,
  FridayFixPlanRecord,
  FridayGetAutoFixActionResponse,
  FridayListAutoFixActionsResponse,
} from "../../model/friday-api-self-healing.types.js";
import { assertBoundPrincipalForOperation } from "../../../security/friday-owner-session-channel-capability.js";
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

function readReasonCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  return typeof record.reasonCode === "string" && record.reasonCode.trim().length > 0
    ? record.reasonCode.trim()
    : undefined;
}

function readMaxRiskTier(body: unknown): 0 | 1 | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const value = (body as Record<string, unknown>).maxRiskTier;
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseInt(value, 10)
      : Number.NaN;
  if (parsed === 0 || parsed === 1) {
    return parsed;
  }
  throw new FridayDomainError(
    "VALIDATION_ERROR",
    "maxRiskTier must be 0 or 1 for homepage self-repair",
    { httpStatus: 400 },
  );
}

function isFeedbackReasonCode(value: string | undefined): value is FridayAutoFixFeedbackReasonCode {
  return value === "wrong_root_cause"
    || value === "too_risky"
    || value === "wrong_fix"
    || value === "insufficient_evidence"
    || value === "wrong_model_or_backend_choice";
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

function toExecutionResponse(
  deps: FridayAutoFixRoutesDeps,
  item: Awaited<ReturnType<FridaySelfHealingApiService["runReadyActions"]>>["executed"][number],
): FridayAutoFixExecutionResponse {
  return {
    action: toActionRecord(deps, item.details),
    result: {
      success: item.result.success,
      verificationPassed: item.result.verificationPassed,
      rollbackAttempted: item.result.rollbackAttempted,
      rollbackSucceeded: item.result.rollbackSucceeded,
      ...(item.result.errorMessage ? { errorMessage: item.result.errorMessage } : {}),
    },
  };
}

export function createFridayAutoFixRoutes(
  deps: FridayAutoFixRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "autofix.actions.list",
      method: "GET",
      path: "/v1/auto-fix/actions",
      auth: { public: true },
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
      operationId: "autofix.actions.run.ready",
      method: "POST",
      path: "/v1/auto-fix/actions/run-ready",
      auth: { public: true },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayAutoFixRunReadyResponse> {
        // Phase 14.5B module_28b: refuse synthetic public principal and null
        // principal. One-click self-repair cannot fire from a channel/API
        // message that lacks a bound owner/session/channel principal.
        assertBoundPrincipalForOperation(ctx.principal ?? null, "autofix.actions.run.ready", "api");
        const userId = requireUserId(ctx.principal);
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const run = await deps.service.runReadyActions({
          userId,
          maxRiskTier: readMaxRiskTier(body),
          limit: readPositiveInt(body.limit) ?? 20,
        });
        return {
          summary: run.summary,
          executed: run.executed.map((item) => toExecutionResponse(deps, item)),
          skipped: run.skipped.map((item) => ({
            action: toActionRecord(deps, item.details),
            reason: item.reason,
            reasonText: item.reasonText,
          })),
        };
      },
    },
    {
      operationId: "autofix.actions.get",
      method: "GET",
      path: "/v1/auto-fix/actions/:actionId",
      auth: { public: true },
      async handler(ctx): Promise<FridayGetAutoFixActionResponse> {
        const userId = requireUserId(ctx.principal);
        const { actionId } = ctx.params as { actionId: string };
        const action = deps.service.getAction({ actionId, userId });
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
      auth: { public: true },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayAutoFixApprovalResponse> {
        // Phase 14.5B module_28b: approval boundary must carry a bound owner
        // principal; the synthetic public principal cannot approve a repair.
        assertBoundPrincipalForOperation(ctx.principal ?? null, "autofix.actions.approve", "api");
        const respondedBy = requireUserId(ctx.principal);
        const { actionId } = ctx.params as { actionId: string };
        const updated = await deps.service.approveAction({
          actionId,
          userId: respondedBy,
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
      auth: { public: true },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayAutoFixApprovalResponse> {
        // Phase 14.5B module_28b: denial carries learning signals so it must
        // also be authored by a bound owner/session/channel principal.
        assertBoundPrincipalForOperation(ctx.principal ?? null, "autofix.actions.deny", "api");
        const respondedBy = requireUserId(ctx.principal);
        const { actionId } = ctx.params as { actionId: string };
        const updated = await deps.service.denyAction({
          actionId,
          userId: respondedBy,
          respondedBy,
          reason: readReason(ctx.body),
          reasonCode: (() => {
            const reasonCode = readReasonCode(ctx.body);
            return isFeedbackReasonCode(reasonCode) ? reasonCode : undefined;
          })(),
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
      auth: { public: true },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayAutoFixExecutionResponse> {
        // Phase 14.5B module_28b: execute mutates runtime/config — the
        // synthetic public principal must be refused even though it carries
        // hub.admin scope for read-only routes.
        assertBoundPrincipalForOperation(ctx.principal ?? null, "autofix.actions.execute", "api");
        const userId = requireUserId(ctx.principal);
        const { actionId } = ctx.params as { actionId: string };
        const updated = await deps.service.executeAction({ actionId, userId });
        return {
          action: toActionRecord(deps, updated.details),
          result: {
            success: updated.result.success,
            verificationPassed: updated.result.verificationPassed,
            rollbackAttempted: updated.result.rollbackAttempted,
            rollbackSucceeded: updated.result.rollbackSucceeded,
            ...(updated.result.errorMessage ? { errorMessage: updated.result.errorMessage } : {}),
          },
        };
      },
    },
    {
      operationId: "autofix.actions.rollback",
      method: "POST",
      path: "/v1/auto-fix/actions/:actionId/rollback",
      auth: { public: true },
      rateLimitPolicyId: "generator.write",
      async handler(ctx): Promise<FridayAutoFixExecutionResponse> {
        // Phase 14.5B module_28b: rollback also mutates runtime state, so
        // the same bound-principal gate applies as execute.
        assertBoundPrincipalForOperation(ctx.principal ?? null, "autofix.actions.rollback", "api");
        const userId = requireUserId(ctx.principal);
        const { actionId } = ctx.params as { actionId: string };
        const reason = readReason(ctx.body);
        if (!reason) {
          throw new FridayDomainError("VALIDATION_ERROR", "reason is required", {
            httpStatus: 400,
          });
        }
        const updated = await deps.service.rollbackAction({ actionId, userId, reason });
        return {
          action: toActionRecord(deps, updated.details),
          result: {
            success: updated.result.success,
            verificationPassed: updated.result.verificationPassed,
            rollbackAttempted: updated.result.rollbackAttempted,
            rollbackSucceeded: updated.result.rollbackSucceeded,
            ...(updated.result.errorMessage ? { errorMessage: updated.result.errorMessage } : {}),
          },
        };
      },
    },
    {
      operationId: "autofix.metrics.get",
      method: "GET",
      path: "/v1/auto-fix/metrics",
      auth: { public: true },
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
