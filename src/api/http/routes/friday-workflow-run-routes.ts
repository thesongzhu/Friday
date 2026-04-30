import type {
  FridayAuthPrincipal,
  FridayRouteDefinition,
} from "../../model/friday-api-common.types.js";
import type { UUID } from "#workflows";
import { FridayDomainError } from "#errors";
import type { FridayHttpRawTextResponse } from "../friday-http-raw-response.js";
import type {
  FridayCancelRunRequest,
  FridayCancelRunResponse,
  FridayDownloadRunEvidenceExportResponse,
  FridayExportRunEvidenceRequest,
  FridayExportRunEvidenceResponse,
  FridayGetRunEvidenceExportResponse,
  FridayGetRunEvidenceQuery,
  FridayGetRunEvidenceResponse,
  FridayGetRunResponse,
  FridayGetRunTimelineQuery,
  FridayGetRunTimelineResponse,
  FridayListRunEvidenceExportsQuery,
  FridayListRunEvidenceExportsResponse,
  FridayListRunNodesQuery,
  FridayListRunNodesResponse,
  FridayResumeRunResponse,
  FridayRetryRunRequest,
  FridayRetryRunResponse,
  FridayStartRunRequest,
  FridayStartRunResponse,
} from "../../model/friday-api-workflow.types.js";

export interface FridayWorkflowRunRoutesDeps {
  startRun: (
    input: FridayStartRunRequest,
    principal: FridayAuthPrincipal | null,
  ) => Promise<FridayStartRunResponse>;
  getRun: (
    runId: UUID,
    principal: FridayAuthPrincipal | null,
  ) => FridayGetRunResponse;
  listRunNodes: (
    runId: UUID,
    query: FridayListRunNodesQuery,
    principal: FridayAuthPrincipal | null,
  ) => FridayListRunNodesResponse;
  getRunTimeline: (
    runId: UUID,
    query: FridayGetRunTimelineQuery,
    principal: FridayAuthPrincipal | null,
  ) => FridayGetRunTimelineResponse;
  getRunEvidence: (
    runId: UUID,
    query: FridayGetRunEvidenceQuery,
    principal: FridayAuthPrincipal | null,
  ) => FridayGetRunEvidenceResponse;
  listRunEvidenceExports: (
    runId: UUID,
    query: FridayListRunEvidenceExportsQuery,
    principal: FridayAuthPrincipal | null,
  ) => FridayListRunEvidenceExportsResponse;
  exportRunEvidence: (
    runId: UUID,
    input: FridayExportRunEvidenceRequest,
    principal: FridayAuthPrincipal | null,
  ) => FridayExportRunEvidenceResponse;
  getRunEvidenceExport: (
    runId: UUID,
    exportId: UUID,
    principal: FridayAuthPrincipal | null,
  ) => FridayGetRunEvidenceExportResponse;
  downloadRunEvidenceExport: (
    runId: UUID,
    exportId: UUID,
    principal: FridayAuthPrincipal | null,
  ) => FridayDownloadRunEvidenceExportResponse | FridayHttpRawTextResponse;
  cancelRun: (
    runId: UUID,
    input: FridayCancelRunRequest,
    principal: FridayAuthPrincipal | null,
  ) => Promise<FridayCancelRunResponse>;
  retryRun: (
    runId: UUID,
    input: FridayRetryRunRequest,
    principal: FridayAuthPrincipal | null,
  ) => Promise<FridayRetryRunResponse>;
  resumeRun: (
    runId: UUID,
    principal: FridayAuthPrincipal | null,
  ) => Promise<FridayResumeRunResponse>;
}

export function createFridayWorkflowRunRoutes(
  deps: FridayWorkflowRunRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "runs.start",
      method: "POST",
      path: "/v1/workflow-runs",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      rateLimitPolicyId: "workflow.start_run",
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.workflowId !== "string" || body.workflowId.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "workflowId is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        return deps.startRun(body as unknown as FridayStartRunRequest, ctx.principal);
      },
    },
    {
      operationId: "runs.get",
      method: "GET",
      path: "/v1/workflow-runs/:runId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.getRun(runId, ctx.principal);
      },
    },
    {
      operationId: "runs.list.nodes",
      method: "GET",
      path: "/v1/workflow-runs/:runId/nodes",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.listRunNodes(runId, ctx.query as FridayListRunNodesQuery, ctx.principal);
      },
    },
    {
      operationId: "runs.timeline",
      method: "GET",
      path: "/v1/workflow-runs/:runId/timeline",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.getRunTimeline(runId, ctx.query as FridayGetRunTimelineQuery, ctx.principal);
      },
    },
    {
      operationId: "runs.evidence",
      method: "GET",
      path: "/v1/workflow-runs/:runId/evidence",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.getRunEvidence(runId, ctx.query as FridayGetRunEvidenceQuery, ctx.principal);
      },
    },
    {
      operationId: "runs.evidence.exports.list",
      method: "GET",
      path: "/v1/workflow-runs/:runId/evidence/exports",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.listRunEvidenceExports(
          runId,
          ctx.query as FridayListRunEvidenceExportsQuery,
          ctx.principal,
        );
      },
    },
    {
      operationId: "runs.evidence.export",
      method: "POST",
      path: "/v1/workflow-runs/:runId/evidence/exports",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.exportRunEvidence(runId, (ctx.body ?? {}) as FridayExportRunEvidenceRequest, ctx.principal);
      },
    },
    {
      operationId: "runs.evidence.exports.get",
      method: "GET",
      path: "/v1/workflow-runs/:runId/evidence/exports/:exportId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId, exportId } = ctx.params as { runId: UUID; exportId: UUID };
        return deps.getRunEvidenceExport(runId, exportId, ctx.principal);
      },
    },
    {
      operationId: "runs.evidence.exports.download",
      method: "GET",
      path: "/v1/workflow-runs/:runId/evidence/exports/:exportId/download",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId, exportId } = ctx.params as { runId: UUID; exportId: UUID };
        return deps.downloadRunEvidenceExport(runId, exportId, ctx.principal);
      },
    },
    {
      operationId: "runs.cancel",
      method: "POST",
      path: "/v1/workflow-runs/:runId/cancel",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.cancelRun(runId, ctx.body as FridayCancelRunRequest, ctx.principal);
      },
    },
    {
      operationId: "runs.retry",
      method: "POST",
      path: "/v1/workflow-runs/:runId/retry",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.retryRun(runId, ctx.body as FridayRetryRunRequest, ctx.principal);
      },
    },
    {
      operationId: "workflows.runs.resume",
      method: "POST",
      path: "/v1/workflow-runs/:runId/resume",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.resumeRun(runId, ctx.principal);
      },
    },
  ];
}
