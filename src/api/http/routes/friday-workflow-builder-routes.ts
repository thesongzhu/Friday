import { FridayDomainError } from "#errors";
import type {
  FridayAuthPrincipal,
  FridayPaginationQuery,
  FridayRouteDefinition,
} from "../../model/friday-api-common.types.js";
import {
  assertBoundPrincipalAuthorityForOperation,
  type FridayPublicMutationOperation,
} from "../../../security/friday-owner-session-channel-capability.js";
import type { UUID } from "#workflows";
import type {
  FridayAcquireWorkflowLockRequest,
  FridayAcquireWorkflowLockResponse,
  FridayAutosaveDraftRequest,
  FridayAutosaveDraftResponse,
  FridayCompileDraftResponse,
  FridayCreateDraftRequest,
  FridayCreateDraftResponse,
  FridayExportDraftBundleResponse,
  FridayGetDraftResponse,
  FridayGetWorkflowBuilderTemplateResponse,
  FridayImportWorkflowBundleRequest,
  FridayImportWorkflowBundleResponse,
  FridayInstantiateWorkflowBuilderTemplateRequest,
  FridayInstantiateWorkflowBuilderTemplateResponse,
  FridayListDraftsResponse,
  FridayListWorkflowBuilderTemplatesResponse,
  FridayPublishDraftRequest,
  FridayPublishDraftResponse,
  FridayReleaseWorkflowLockRequest,
  FridayReleaseWorkflowLockResponse,
  FridayRenewWorkflowLockRequest,
  FridayRenewWorkflowLockResponse,
  FridaySaveDraftRequest,
  FridaySaveDraftResponse,
} from "../../model/friday-api-workflow.types.js";

export interface FridayWorkflowBuilderTemplateRoutesDeps {
  listTemplates: (query: { scope?: string }) => FridayListWorkflowBuilderTemplatesResponse;
  getTemplate: (templateId: string) => FridayGetWorkflowBuilderTemplateResponse;
  instantiateTemplate: (
    templateId: string,
    body: FridayInstantiateWorkflowBuilderTemplateRequest,
  ) => FridayInstantiateWorkflowBuilderTemplateResponse;
  /**
   * Test-oracle only: allows the legacy TypeScript workflow builder draft/lock/
   * template-instantiate mutations in isolated route/runtime validation.
   * Default/live runtime must leave these fail-closed until Rust owns workflow
   * builder draft authoring truth.
   */
  allowTestOnlyWorkflowBuilderDraftExecution?: boolean;
}

function throwRetiredWorkflowBuilderDraft(): never {
  throw new FridayDomainError(
    "TS_RUNTIME_WORKFLOW_BUILDER_DRAFT_RETIRED",
    "TypeScript workflow builder draft/lock/template authoring is retired in default/live runtime; use the Rust-owned workflow builder draft entrypoint.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_builder_draft_entrypoint_required",
      },
    },
  );
}

function assertWorkflowBuilderDraftTestOracleAllowed(allow: boolean | undefined): void {
  if (allow !== true) {
    throwRetiredWorkflowBuilderDraft();
  }
}

function assertWorkflowBuilderWritePrincipal(
  principal: FridayAuthPrincipal | null | undefined,
  operation: FridayPublicMutationOperation,
): void {
  assertBoundPrincipalAuthorityForOperation(principal, operation, "api", {
    anyOfScopes: ["hub.admin", "workflow.write"],
    anyOfRoles: ["owner", "admin", "operator"],
  });
}

export function createFridayWorkflowBuilderTemplateRoutes(
  deps: FridayWorkflowBuilderTemplateRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "templates.list",
      method: "GET",
      path: "/v1/workflow-builder/templates",
      auth: { public: true },
      async handler(ctx) {
        const query = ctx.query as Record<string, unknown>;
        return deps.listTemplates({
          scope: typeof query.scope === "string" ? query.scope : undefined,
        });
      },
    },
    {
      operationId: "templates.get",
      method: "GET",
      path: "/v1/workflow-builder/templates/:templateId",
      auth: { public: true },
      async handler(ctx) {
        const { templateId } = ctx.params as { templateId: string };
        return deps.getTemplate(templateId);
      },
    },
    {
      operationId: "templates.instantiate",
      method: "POST",
      path: "/v1/workflow-builder/templates/:templateId/instantiate",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowBuilderDraftTestOracleAllowed(deps.allowTestOnlyWorkflowBuilderDraftExecution);
        assertWorkflowBuilderWritePrincipal(ctx.principal ?? null, "workflow.template.instantiate");
        const { templateId } = ctx.params as { templateId: string };
        const body = ctx.body as FridayInstantiateWorkflowBuilderTemplateRequest;
        return deps.instantiateTemplate(templateId, body);
      },
    },
  ];
}

export interface FridayWorkflowBuilderRoutesDeps {
  createDraft: (workflowId: UUID, input: FridayCreateDraftRequest) => FridayCreateDraftResponse;
  listDrafts: (workflowId: UUID, query: FridayPaginationQuery) => FridayListDraftsResponse;
  getDraft: (workflowId: UUID, draftId: UUID) => FridayGetDraftResponse;
  exportDraftBundle: (workflowId: UUID, draftId: UUID) => FridayExportDraftBundleResponse;
  importWorkflowBundle: (workflowId: UUID, input: FridayImportWorkflowBundleRequest) => FridayImportWorkflowBundleResponse;
  saveDraft: (workflowId: UUID, draftId: UUID, input: FridaySaveDraftRequest) => FridaySaveDraftResponse;
  autosaveDraft: (workflowId: UUID, draftId: UUID, input: FridayAutosaveDraftRequest) => FridayAutosaveDraftResponse;
  compileDraft: (workflowId: UUID, draftId: UUID) => FridayCompileDraftResponse;
  publishDraft: (workflowId: UUID, draftId: UUID, input: FridayPublishDraftRequest) => FridayPublishDraftResponse;
  acquireLock: (
    workflowId: UUID,
    input: FridayAcquireWorkflowLockRequest,
    principal: FridayAuthPrincipal | null,
  ) => FridayAcquireWorkflowLockResponse;
  renewLock: (
    workflowId: UUID,
    input: FridayRenewWorkflowLockRequest,
    principal: FridayAuthPrincipal | null,
  ) => FridayRenewWorkflowLockResponse;
  releaseLock: (
    workflowId: UUID,
    input: FridayReleaseWorkflowLockRequest,
    principal: FridayAuthPrincipal | null,
  ) => FridayReleaseWorkflowLockResponse;
  /**
   * Test-oracle only: allows the legacy TypeScript workflow bundle import
   * mutation in isolated route/runtime validation. Default/live runtime must
   * leave bundle import fail-closed until Rust owns workflow bundle import
   * truth.
   */
  allowTestOnlyWorkflowBundleImportExecution?: boolean;
  /**
   * Test-oracle only: allows the legacy TypeScript workflow builder draft/lock
   * mutations in isolated route/runtime validation. Default/live runtime must
   * leave these fail-closed until Rust owns workflow builder draft authoring
   * truth.
   */
  allowTestOnlyWorkflowBuilderDraftExecution?: boolean;
}

function throwRetiredWorkflowBundleImport(): never {
  throw new FridayDomainError(
    "TS_RUNTIME_WORKFLOW_BUNDLE_IMPORT_RETIRED",
    "TypeScript workflow bundle import is retired in default/live runtime; use the Rust-owned workflow bundle import entrypoint.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_workflow_bundle_import_entrypoint_required",
      },
    },
  );
}

function assertWorkflowBundleImportTestOracleAllowed(deps: FridayWorkflowBuilderRoutesDeps): void {
  if (deps.allowTestOnlyWorkflowBundleImportExecution !== true) {
    throwRetiredWorkflowBundleImport();
  }
}

export function createFridayWorkflowBuilderRoutes(
  deps: FridayWorkflowBuilderRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "drafts.list",
      method: "GET",
      path: "/v1/workflows/:workflowId/drafts",
      auth: { public: true },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.listDrafts(workflowId, ctx.query as FridayPaginationQuery);
      },
    },
    {
      operationId: "drafts.create",
      method: "POST",
      path: "/v1/workflows/:workflowId/drafts",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowBuilderDraftTestOracleAllowed(deps.allowTestOnlyWorkflowBuilderDraftExecution);
        assertWorkflowBuilderWritePrincipal(ctx.principal ?? null, "workflow.draft.create");
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.createDraft(workflowId, ctx.body as FridayCreateDraftRequest);
      },
    },
    {
      operationId: "drafts.get",
      method: "GET",
      path: "/v1/workflows/:workflowId/drafts/:draftId",
      auth: { public: true },
      async handler(ctx) {
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        return deps.getDraft(workflowId, draftId);
      },
    },
    {
      operationId: "drafts.export",
      method: "GET",
      path: "/v1/workflows/:workflowId/drafts/:draftId/export",
      auth: { public: true },
      async handler(ctx) {
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        return deps.exportDraftBundle(workflowId, draftId);
      },
    },
    {
      operationId: "workflows.bundles.import",
      method: "POST",
      path: "/v1/workflows/:workflowId/import",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowBundleImportTestOracleAllowed(deps);
        assertWorkflowBuilderWritePrincipal(ctx.principal ?? null, "workflow.bundle.import");
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.importWorkflowBundle(workflowId, ctx.body as FridayImportWorkflowBundleRequest);
      },
    },
    {
      operationId: "drafts.save",
      method: "PATCH",
      path: "/v1/workflows/:workflowId/drafts/:draftId",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowBuilderDraftTestOracleAllowed(deps.allowTestOnlyWorkflowBuilderDraftExecution);
        assertWorkflowBuilderWritePrincipal(ctx.principal ?? null, "workflow.draft.save");
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        return deps.saveDraft(workflowId, draftId, ctx.body as FridaySaveDraftRequest);
      },
    },
    {
      operationId: "drafts.autosave",
      method: "POST",
      path: "/v1/workflows/:workflowId/drafts/:draftId/autosave",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowBuilderDraftTestOracleAllowed(deps.allowTestOnlyWorkflowBuilderDraftExecution);
        assertWorkflowBuilderWritePrincipal(ctx.principal ?? null, "workflow.draft.autosave");
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        return deps.autosaveDraft(workflowId, draftId, ctx.body as FridayAutosaveDraftRequest);
      },
    },
    {
      operationId: "drafts.compile",
      method: "POST",
      path: "/v1/workflows/:workflowId/drafts/:draftId/compile",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowBuilderDraftTestOracleAllowed(deps.allowTestOnlyWorkflowBuilderDraftExecution);
        assertWorkflowBuilderWritePrincipal(ctx.principal ?? null, "workflow.draft.compile");
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        return deps.compileDraft(workflowId, draftId);
      },
    },
    {
      operationId: "drafts.publish",
      method: "POST",
      path: "/v1/workflows/:workflowId/drafts/:draftId/publish",
      auth: { public: true },
      rateLimitPolicyId: "workflow.publish",
      async handler(ctx) {
        assertWorkflowBuilderDraftTestOracleAllowed(deps.allowTestOnlyWorkflowBuilderDraftExecution);
        assertWorkflowBuilderWritePrincipal(ctx.principal ?? null, "workflow.draft.publish");
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        return deps.publishDraft(workflowId, draftId, ctx.body as FridayPublishDraftRequest);
      },
    },
    {
      operationId: "locks.acquire",
      method: "POST",
      path: "/v1/workflows/:workflowId/locks/acquire",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowBuilderDraftTestOracleAllowed(deps.allowTestOnlyWorkflowBuilderDraftExecution);
        assertWorkflowBuilderWritePrincipal(ctx.principal ?? null, "workflow.lock.acquire");
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.acquireLock(workflowId, ctx.body as FridayAcquireWorkflowLockRequest, ctx.principal);
      },
    },
    {
      operationId: "locks.renew",
      method: "POST",
      path: "/v1/workflows/:workflowId/locks/renew",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowBuilderDraftTestOracleAllowed(deps.allowTestOnlyWorkflowBuilderDraftExecution);
        assertWorkflowBuilderWritePrincipal(ctx.principal ?? null, "workflow.lock.renew");
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.renewLock(workflowId, ctx.body as FridayRenewWorkflowLockRequest, ctx.principal);
      },
    },
    {
      operationId: "locks.release",
      method: "POST",
      path: "/v1/workflows/:workflowId/locks/release",
      auth: { public: true },
      async handler(ctx) {
        assertWorkflowBuilderDraftTestOracleAllowed(deps.allowTestOnlyWorkflowBuilderDraftExecution);
        assertWorkflowBuilderWritePrincipal(ctx.principal ?? null, "workflow.lock.release");
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.releaseLock(workflowId, ctx.body as FridayReleaseWorkflowLockRequest, ctx.principal);
      },
    },
  ];
}
