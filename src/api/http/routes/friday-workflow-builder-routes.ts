import type {
  FridayAuthPrincipal,
  FridayPaginationQuery,
  FridayRouteDefinition,
} from "../../model/friday-api-common.types.js";
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
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.releaseLock(workflowId, ctx.body as FridayReleaseWorkflowLockRequest, ctx.principal);
      },
    },
  ];
}
