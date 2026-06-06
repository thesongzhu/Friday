import { assertBoundPrincipalAuthorityForOperation } from "../../../security/friday-owner-session-channel-capability.js";
import { FridayDomainError } from "#errors";
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
  /**
   * Test-oracle only: allows the legacy TypeScript workflow conflict resolution
   * mutation in isolated route/runtime validation. Default/live runtime must
   * leave conflict resolution fail-closed until Rust owns workflow conflict
   * resolution truth.
   */
  allowTestOnlyWorkflowConflictResolution?: boolean;
}

function throwRetiredWorkflowConflictResolve(): never {
  throw new FridayDomainError(
    "TS_RUNTIME_WORKFLOW_CONFLICT_RESOLVE_RETIRED",
    "TypeScript workflow conflict resolution is retired in default/live runtime; use the Rust-owned workflow conflict resolution entrypoint.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_conflict_resolution_entrypoint_required",
      },
    },
  );
}

function assertWorkflowConflictResolveTestOracleAllowed(deps: FridayWorkflowConflictRoutesDeps): void {
  if (deps.allowTestOnlyWorkflowConflictResolution !== true) {
    throwRetiredWorkflowConflictResolve();
  }
}

export function createFridayWorkflowConflictRoutes(
  deps: FridayWorkflowConflictRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "conflicts.list",
      method: "GET",
      path: "/v1/workflows/:workflowId/conflicts",
      auth: { public: true },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.listConflicts(workflowId, ctx.query as FridayListWorkflowConflictsQuery);
      },
    },
    {
      operationId: "conflicts.resolve",
      method: "POST",
      path: "/v1/workflows/:workflowId/conflicts/:conflictId/resolve",
      auth: { public: true },
      rateLimitPolicyId: "workflow.resolve_conflict",
      async handler(ctx) {
        assertWorkflowConflictResolveTestOracleAllowed(deps);
        const { workflowId, conflictId } = ctx.params as { workflowId: UUID; conflictId: UUID };
        const bound = assertBoundPrincipalAuthorityForOperation(
          ctx.principal ?? null,
          "workflow.conflict.resolve",
          "api",
          {
            anyOfScopes: ["hub.admin", "workflow.conflict.resolve", "workflow.write"],
            anyOfRoles: ["owner", "admin", "operator"],
          },
        );
        return deps.resolveConflict(
          workflowId,
          conflictId,
          ctx.body as FridayResolveWorkflowConflictRequest,
          bound.userId ?? bound.principalId,
        );
      },
    },
  ];
}
