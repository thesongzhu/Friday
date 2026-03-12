import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "#workflows";
import type {
  FridayListWorkflowConflictsQuery,
  FridayListWorkflowConflictsResponse,
  FridayResolveWorkflowConflictRequest,
  FridayResolveWorkflowConflictResponse,
} from "../../model/friday-api-workflow.types.js";

export interface FridayWorkflowConflictRoutesDeps {
  listConflicts: (
    workflowId: UUID,
    query: FridayListWorkflowConflictsQuery,
  ) => FridayListWorkflowConflictsResponse;
  resolveConflict: (
    workflowId: UUID,
    conflictId: UUID,
    input: FridayResolveWorkflowConflictRequest,
    userId?: UUID,
  ) => FridayResolveWorkflowConflictResponse;
}

export function createFridayWorkflowConflictRoutes(
  deps: FridayWorkflowConflictRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "conflicts.list",
      method: "GET",
      path: "/v1/workflows/:workflowId/conflicts",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.listConflicts(workflowId, ctx.query as FridayListWorkflowConflictsQuery);
      },
    },
    {
      operationId: "conflicts.resolve",
      method: "POST",
      path: "/v1/workflows/:workflowId/conflicts/:conflictId/resolve",
      auth: { public: false, anyOfScopes: ["workflow.conflict.resolve"] },
      rateLimitPolicyId: "workflow.resolve_conflict",
      async handler(ctx) {
        const { workflowId, conflictId } = ctx.params as { workflowId: UUID; conflictId: UUID };
        return deps.resolveConflict(
          workflowId,
          conflictId,
          ctx.body as FridayResolveWorkflowConflictRequest,
          ctx.principal?.userId,
        );
      },
    },
  ];
}
