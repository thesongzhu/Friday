import { FridayDomainError } from "#errors";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "#workflows";
import type {
  FridayWorkflowDeployResult,
  FridayWorkflowOverview,
  FridayWorkflowVisualization,
} from "../../model/friday-api-workflow.types.js";
import type { FridayWorkflowProductService } from "../../../workflows/services/friday-workflow-product-service.js";

export interface FridayWorkflowProductRoutesDeps {
  service: FridayWorkflowProductService;
}

export function createFridayWorkflowProductRoutes(
  deps: FridayWorkflowProductRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "workflows.overview",
      method: "GET",
      path: "/v1/workflows/:workflowId/overview",
      auth: { public: true },
      async handler(ctx): Promise<{ overview: FridayWorkflowOverview }> {
        const { workflowId } = ctx.params as { workflowId: UUID };
        const query = ctx.query as Record<string, unknown>;
        const recentRunLimit = typeof query.recentRunLimit === "string"
          ? Number.parseInt(query.recentRunLimit, 10)
          : undefined;
        return {
          overview: deps.service.getOverview({
            workflowId,
            recentRunLimit: Number.isFinite(recentRunLimit) ? recentRunLimit : undefined,
          }),
        };
      },
    },
    {
      operationId: "workflows.visualization",
      method: "GET",
      path: "/v1/workflows/:workflowId/visualization",
      auth: { public: true },
      async handler(ctx): Promise<{ visualization: FridayWorkflowVisualization }> {
        const { workflowId } = ctx.params as { workflowId: UUID };
        const query = ctx.query as Record<string, unknown>;
        return {
          visualization: deps.service.getVisualization({
            workflowId,
            draftId: typeof query.draftId === "string" ? query.draftId : undefined,
            versionId: typeof query.versionId === "string" ? query.versionId : undefined,
            timelineLimit: typeof query.timelineLimit === "string"
              ? Number.parseInt(query.timelineLimit, 10)
              : undefined,
          }),
        };
      },
    },
    {
      operationId: "workflows.deploy",
      method: "POST",
      path: "/v1/workflows/:workflowId/drafts/:draftId/deploy",
      auth: { public: true },
      rateLimitPolicyId: "workflow.publish",
      async handler(ctx): Promise<{ deployment: FridayWorkflowDeployResult }> {
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const actorUserId = ctx.principal?.userId ?? "workflow-operator";
        if (body.lockToken !== undefined && typeof body.lockToken !== "string") {
          throw new FridayDomainError("VALIDATION_ERROR", "lockToken must be a string when provided", {
            httpStatus: 400,
          });
        }
        return {
          deployment: await deps.service.deployDraft({
            workflowId,
            draftId,
            actorUserId,
            runNow: body.runNow === true,
            resyncTriggers: body.resyncTriggers === true,
            includeExport: body.includeExport === true,
            changeNote: typeof body.changeNote === "string" ? body.changeNote : undefined,
            lockToken: typeof body.lockToken === "string" ? body.lockToken : undefined,
            ownerSessionId: typeof body.ownerSessionId === "string" ? body.ownerSessionId : undefined,
            lockTtlSec: typeof body.lockTtlSec === "number" ? body.lockTtlSec : undefined,
            ...(body.externalReviewConfirmed === true ? { externalReviewConfirmed: true } : {}),
          }),
        };
      },
    },
  ];
}
