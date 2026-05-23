import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "#workflows";
import { FridayDomainError } from "#errors";
import {
  assertBoundPrincipalAuthorityForOperation,
  type FridayPublicMutationOperation,
} from "../../../security/friday-owner-session-channel-capability.js";

/** Maximum value for list endpoint limit query parameters. */
const WORKFLOW_MAX_LIST_LIMIT = 100;
import type {
  FridayArchiveWorkflowResponse,
  FridayCreateWorkflowRequest,
  FridayCreateWorkflowResponse,
  FridayGetWorkflowResponse,
  FridayGetWorkflowVersionResponse,
  FridayListVersionsQuery,
  FridayListVersionsResponse,
  FridayListWorkflowsQuery,
  FridayListWorkflowsResponse,
  FridayPublishWorkflowRequest,
  FridayPublishWorkflowResponse,
  FridayUpdateWorkflowRequest,
  FridayUpdateWorkflowResponse,
} from "../../model/friday-api-workflow.types.js";

export interface FridayWorkflowRoutesDeps {
  listWorkflows: (query: FridayListWorkflowsQuery) => FridayListWorkflowsResponse;
  createWorkflow: (input: FridayCreateWorkflowRequest) => FridayCreateWorkflowResponse;
  getWorkflow: (workflowId: UUID) => FridayGetWorkflowResponse;
  updateWorkflow: (workflowId: UUID, input: FridayUpdateWorkflowRequest) => FridayUpdateWorkflowResponse;
  archiveWorkflow: (workflowId: UUID) => FridayArchiveWorkflowResponse;
  publishWorkflow: (workflowId: UUID, input: FridayPublishWorkflowRequest) => FridayPublishWorkflowResponse;
  listVersions: (workflowId: UUID, query: FridayListVersionsQuery) => FridayListVersionsResponse;
  getVersion: (versionId: UUID) => FridayGetWorkflowVersionResponse;
}

function assertWorkflowWritePrincipal(
  principal: Parameters<typeof assertBoundPrincipalAuthorityForOperation>[0],
  operation: FridayPublicMutationOperation,
): void {
  assertBoundPrincipalAuthorityForOperation(principal, operation, "api", {
    anyOfScopes: ["hub.admin", "workflow.write"],
    anyOfRoles: ["owner", "admin", "operator"],
  });
}

export function createFridayWorkflowRoutes(
  deps: FridayWorkflowRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "workflows.list",
      method: "GET",
      path: "/v1/workflows",
      auth: { public: true },
      async handler(ctx) {
        const query = ctx.query as Record<string, string | undefined>;
        let limit: number | undefined;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            throw new FridayDomainError(
              "VALIDATION_ERROR",
              "limit must be a positive integer",
              { httpStatus: 400 },
            );
          }
          limit = Math.min(parsed, WORKFLOW_MAX_LIST_LIMIT);
        }
        const sanitised: FridayListWorkflowsQuery = {
          ...query,
          limit,
          cursor: query.cursor,
        };
        return deps.listWorkflows(sanitised);
      },
    },
    {
      operationId: "workflows.create",
      method: "POST",
      path: "/v1/workflows",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowWritePrincipal(ctx.principal ?? null, "workflow.create");
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.slug !== "string" || body.slug.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "slug is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        if (body.slug.trim().length > 128) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "slug must be at most 128 characters",
            { httpStatus: 400 },
          );
        }
        if (typeof body.name !== "string" || body.name.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "name is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        if (body.name.trim().length > 255) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "name must be at most 255 characters",
            { httpStatus: 400 },
          );
        }
        return deps.createWorkflow(body as unknown as FridayCreateWorkflowRequest);
      },
    },
    {
      operationId: "workflows.get",
      method: "GET",
      path: "/v1/workflows/:workflowId",
      auth: { public: true },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.getWorkflow(workflowId);
      },
    },
    {
      operationId: "workflows.update",
      method: "PATCH",
      path: "/v1/workflows/:workflowId",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowWritePrincipal(ctx.principal ?? null, "workflow.update");
        const { workflowId } = ctx.params as { workflowId: UUID };
        const body = ctx.body as Record<string, unknown> | null;
        if (
          !body ||
          typeof body.expectedRevision !== "number" ||
          !Number.isInteger(body.expectedRevision) ||
          body.expectedRevision < 1
        ) {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "expectedRevision is required and must be a positive integer",
            { httpStatus: 400 },
          );
        }
        if (typeof body.etag !== "string" || body.etag.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "etag is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        return deps.updateWorkflow(workflowId, body as unknown as FridayUpdateWorkflowRequest);
      },
    },
    {
      operationId: "workflows.archive",
      method: "DELETE",
      path: "/v1/workflows/:workflowId",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowWritePrincipal(ctx.principal ?? null, "workflow.archive");
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.archiveWorkflow(workflowId);
      },
    },
    {
      operationId: "workflows.publish",
      method: "POST",
      path: "/v1/workflows/:workflowId/publish",
      auth: { public: true },
      rateLimitPolicyId: "workflow.publish",
      async handler(ctx) {
        assertWorkflowWritePrincipal(ctx.principal ?? null, "workflow.publish");
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.publishWorkflow(workflowId, ctx.body as FridayPublishWorkflowRequest);
      },
    },
    {
      operationId: "workflows.list.versions",
      method: "GET",
      path: "/v1/workflows/:workflowId/versions",
      auth: { public: true },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.listVersions(workflowId, ctx.query as FridayListVersionsQuery);
      },
    },
    {
      operationId: "workflow.versions.get",
      method: "GET",
      path: "/v1/workflow-versions/:versionId",
      auth: { public: true },
      async handler(ctx) {
        const { versionId } = ctx.params as { versionId: UUID };
        return deps.getVersion(versionId);
      },
    },
  ];
}
