import { randomUUID } from "node:crypto";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "#workflows";
import { FridayDomainError } from "#errors";
import {
  assertBoundPrincipalAuthorityForOperation,
  type FridayPublicMutationOperation,
} from "../../../security/friday-owner-session-channel-capability.js";
import type {
  FridayRustHubWorkflowCatalogBridgeService,
  FridayRustHubWorkflowCatalogReceipt,
} from "../../mission-spine/friday-rust-hub-workflow-catalog-bridge-service.js";

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
  /**
   * Test-oracle only: allows legacy TypeScript workflow catalog mutations in
   * isolated route/runtime validation. Default/live runtime must leave these
   * surfaces fail-closed until Rust owns workflow catalog write truth.
   */
  allowTestOnlyWorkflowCatalogMutationExecution?: boolean;
  /**
   * Tier-2 WORKFLOW catalog-mutation route bridge (DARK), DEFAULT-OFF. When `true`, the
   * catalog-mutation handlers route `update` / `publish` / `archive` to the Rust
   * `hub_workflow_catalog` bin (#657) via {@link rustWorkflowCatalogBridge} (after auth)
   * instead of the retired TS path, returning a refs-only receipt. DEFAULT/unset ⇒
   * byte-identical to today's fail-closed `TS_RUNTIME_WORKFLOW_CATALOG_MUTATION_RETIRED`
   * 503 (this flag's branch is never entered). The catalog pointer-`deploy` remains
   * intentionally NOT route-wired because it has a semantic mismatch with the richer draft-deploy
   * route.
   */
  routeWorkflowsViaRust?: boolean;
  /**
   * The refs-only TS→Rust catalog-mutation bridge, consulted ONLY on the
   * {@link routeWorkflowsViaRust}-on branch. Absent + flag-on ⇒ fail closed (503). Never
   * consulted while the flag is off.
   */
  rustWorkflowCatalogBridge?: FridayRustHubWorkflowCatalogBridgeService;
}

/**
 * Refs-only response returned by the catalog-mutation routes when
 * {@link FridayWorkflowRoutesDeps.routeWorkflowsViaRust} is on. This is DELIBERATELY NOT the
 * verbatim {@link FridayUpdateWorkflowResponse}/etc. shape: the Rust bin withholds the
 * verbatim slug/name/description/tags (refs-only — bounded sha256+len projections) and never
 * emits the definition body, so the full TS response cannot be honestly reconstructed. The
 * production cut-over either enriches the response server-side from a verbatim-allowed read or
 * moves the client onto this refs-only contract (see the PR body).
 */
export interface FridayWorkflowCatalogRustRouteResponse {
  readonly routedVia: "rust_hub_workflow_catalog";
  readonly receipt: FridayRustHubWorkflowCatalogReceipt;
}

function rustWorkflowBridgeUnavailable(): never {
  throw new FridayDomainError(
    "TS_RUNTIME_WORKFLOW_CATALOG_RUST_BRIDGE_UNAVAILABLE",
    "Rust workflow catalog route bridge is enabled but no bridge service is configured.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_catalog_write_entrypoint_required",
      },
    },
  );
}

function requireRustWorkflowBridge(
  deps: FridayWorkflowRoutesDeps,
): FridayRustHubWorkflowCatalogBridgeService {
  if (!deps.rustWorkflowCatalogBridge) {
    rustWorkflowBridgeUnavailable();
  }
  return deps.rustWorkflowCatalogBridge;
}

/** Require a positive-integer field on a flag-on request body, failing closed otherwise. */
function requirePositiveIntField(body: Record<string, unknown> | null, field: string): number {
  const value = body ? body[field] : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${field} is required and must be a positive integer`,
      { httpStatus: 400 },
    );
  }
  return value;
}

function requireNonEmptyStringField(body: Record<string, unknown> | null, field: string, maxLen: number): string {
  const value = body ? body[field] : undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${field} is required and must be a non-empty string`,
      { httpStatus: 400 },
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLen) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      `${field} must be at most ${String(maxLen)} characters`,
      { httpStatus: 400 },
    );
  }
  return trimmed;
}

function throwRetiredWorkflowCatalogMutation(): never {
  throw new FridayDomainError(
    "TS_RUNTIME_WORKFLOW_CATALOG_MUTATION_RETIRED",
    "TypeScript workflow catalog mutations are retired in default/live runtime; use the Rust-owned workflow catalog write entrypoint.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_catalog_write_entrypoint_required",
      },
    },
  );
}

function assertWorkflowCatalogMutationTestOracleAllowed(deps: FridayWorkflowRoutesDeps): void {
  if (deps.allowTestOnlyWorkflowCatalogMutationExecution !== true) {
    throwRetiredWorkflowCatalogMutation();
  }
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

/**
 * Flag-on (DARK) `workflows.create` → Rust `hub_workflow_catalog create`. Auth has ALREADY run
 * in the handler. The route returns a refs-only receipt because the Rust bridge deliberately
 * withholds verbatim name/description/tags and the definition body.
 */
async function routeCreateViaRust(
  bridge: FridayRustHubWorkflowCatalogBridgeService,
  body: Record<string, unknown> | null,
): Promise<FridayWorkflowCatalogRustRouteResponse> {
  const slug = requireNonEmptyStringField(body, "slug", 128);
  const name = requireNonEmptyStringField(body, "name", 255);
  const description = body && typeof body.description === "string" ? body.description : undefined;
  const tagsJson = body && Array.isArray(body.tags) ? JSON.stringify(body.tags) : undefined;
  const defJson = JSON.stringify(body?.graph ?? {});
  const receipt = await bridge.mutateCatalog({
    op: "create",
    workflowId: randomUUID(),
    slug,
    name,
    description,
    tagsJson,
    defJson,
  });
  return { routedVia: "rust_hub_workflow_catalog", receipt };
}

/**
 * Flag-on (DARK) `workflows.update` → Rust `hub_workflow_catalog update`. Auth has ALREADY
 * run in the handler. Fail-closed divergences: a `graph` (definition) change is rejected (the
 * catalog `update` cannot change the definition); `etag` is accepted but not honored (the bin
 * gates on `--expected-revision`, the authoritative token). See the PR body's divergence note.
 */
async function routeUpdateViaRust(
  bridge: FridayRustHubWorkflowCatalogBridgeService,
  workflowId: UUID,
  body: Record<string, unknown> | null,
): Promise<FridayWorkflowCatalogRustRouteResponse> {
  const expectedRevision = requirePositiveIntField(body, "expectedRevision");
  if (body && body.graph !== undefined) {
    throw new FridayDomainError(
      "VALIDATION_ERROR",
      "graph (definition) change is not supported on the Rust workflow catalog update route; use a versioning op",
      { httpStatus: 400 },
    );
  }
  const receipt = await bridge.mutateCatalog({
    op: "update",
    workflowId,
    expectedRevision,
    name: body && typeof body.name === "string" ? body.name : undefined,
    description: body && typeof body.description === "string" ? body.description : undefined,
    tagsJson: body && Array.isArray(body.tags) ? JSON.stringify(body.tags) : undefined,
  });
  return { routedVia: "rust_hub_workflow_catalog", receipt };
}

/**
 * Flag-on (DARK) `workflows.archive` → Rust `hub_workflow_catalog archive`. Auth has ALREADY
 * run. NEW dark contract (fail-closed): the catalog `archive` REQUIRES `--expected-revision`
 * (optimistic concurrency), which the retired DELETE contract does not carry — so the flag-on
 * route REQUIRES `expectedRevision` in the body rather than read-then-archive (a TOCTOU that
 * would defeat the very concurrency check). See the PR body.
 */
async function routeArchiveViaRust(
  bridge: FridayRustHubWorkflowCatalogBridgeService,
  workflowId: UUID,
  body: Record<string, unknown> | null,
): Promise<FridayWorkflowCatalogRustRouteResponse> {
  const expectedRevision = requirePositiveIntField(body, "expectedRevision");
  const receipt = await bridge.mutateCatalog({ op: "archive", workflowId, expectedRevision });
  return { routedVia: "rust_hub_workflow_catalog", receipt };
}

/**
 * Flag-on (DARK) `workflows.publish` → Rust `hub_workflow_catalog publish`. Auth has ALREADY
 * run. NEW dark contract (fail-closed): the catalog `publish` REQUIRES `--version`, but the TS
 * `versionNumber` is OPTIONAL — so the flag-on route REQUIRES `versionNumber` in the body (no
 * "publish the latest" guess). See the PR body.
 */
async function routePublishViaRust(
  bridge: FridayRustHubWorkflowCatalogBridgeService,
  workflowId: UUID,
  body: Record<string, unknown> | null,
): Promise<FridayWorkflowCatalogRustRouteResponse> {
  const version = requirePositiveIntField(body, "versionNumber");
  const receipt = await bridge.mutateCatalog({ op: "publish", workflowId, version });
  return { routedVia: "rust_hub_workflow_catalog", receipt };
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
        if (deps.routeWorkflowsViaRust === true) {
          assertWorkflowWritePrincipal(ctx.principal ?? null, "workflow.create");
          return routeCreateViaRust(
            requireRustWorkflowBridge(deps),
            ctx.body as Record<string, unknown> | null,
          );
        }
        assertWorkflowCatalogMutationTestOracleAllowed(deps);
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
        // DARK Rust route (flag-on): auth THEN bridge. Flag-off falls through to today's
        // exact retirement path below (byte-identical).
        if (deps.routeWorkflowsViaRust === true) {
          assertWorkflowWritePrincipal(ctx.principal ?? null, "workflow.update");
          const { workflowId } = ctx.params as { workflowId: UUID };
          return routeUpdateViaRust(
            requireRustWorkflowBridge(deps),
            workflowId,
            ctx.body as Record<string, unknown> | null,
          );
        }
        assertWorkflowCatalogMutationTestOracleAllowed(deps);
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
        // DARK Rust route (flag-on): auth THEN bridge. Flag-off falls through to today's
        // exact retirement path below (byte-identical).
        if (deps.routeWorkflowsViaRust === true) {
          assertWorkflowWritePrincipal(ctx.principal ?? null, "workflow.archive");
          const { workflowId } = ctx.params as { workflowId: UUID };
          return routeArchiveViaRust(
            requireRustWorkflowBridge(deps),
            workflowId,
            ctx.body as Record<string, unknown> | null,
          );
        }
        assertWorkflowCatalogMutationTestOracleAllowed(deps);
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
        // DARK Rust route (flag-on): auth THEN bridge. Flag-off falls through to today's
        // exact retirement path below (byte-identical).
        if (deps.routeWorkflowsViaRust === true) {
          assertWorkflowWritePrincipal(ctx.principal ?? null, "workflow.publish");
          const { workflowId } = ctx.params as { workflowId: UUID };
          return routePublishViaRust(
            requireRustWorkflowBridge(deps),
            workflowId,
            ctx.body as Record<string, unknown> | null,
          );
        }
        assertWorkflowCatalogMutationTestOracleAllowed(deps);
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
