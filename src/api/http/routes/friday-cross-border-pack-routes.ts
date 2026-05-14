import { FridayDomainError } from "#errors";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayCrossBorderDisableAllResponse,
  FridayCrossBorderImportRequest,
  FridayCrossBorderImportResponse,
  FridayCrossBorderImportStaleResponse,
  FridayCrossBorderProfileResponse,
  FridayCrossBorderProfileUpdateRequest,
  FridayCrossBorderRunEvidenceCaptureResponse,
  FridayCrossBorderSnapshotResponse,
  FridayCrossBorderWorkflowPresetApplyRequest,
  FridayCrossBorderWorkflowPresetResponse,
  FridayCrossBorderWorkflowPresetToggleRequest,
} from "../../model/friday-api-cross-border-pack.types.js";
import type { FridayCrossBorderPackService } from "../../../packs/cross-border/friday-cross-border-pack-service.js";
import type { FridayCrossBorderWorkflowId } from "../../../packs/cross-border/friday-cross-border-pack.types.js";

export interface FridayCrossBorderPackRoutesDeps {
  service: FridayCrossBorderPackService;
}

function requireUserId(principal: { userId?: string } | null): string {
  if (!principal?.userId) {
    throw new FridayDomainError("UNAUTHORIZED", "A user-scoped assistant principal is required", {
      httpStatus: 401,
    });
  }
  return principal.userId;
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `${key} is required`, { httpStatus: 400 });
  }
  return value.trim();
}

function readBodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body must be an object", { httpStatus: 400 });
  }
  return body as Record<string, unknown>;
}

function readWorkflowIdParam(params: Record<string, unknown>): FridayCrossBorderWorkflowId {
  return readString(params, "workflowId") as FridayCrossBorderWorkflowId;
}

export function createFridayCrossBorderPackRoutes(
  deps: FridayCrossBorderPackRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "packs.cross.border.profile.get",
      method: "GET",
      path: "/v1/packs/cross-border/profile",
      auth: { public: true },
      async handler(ctx): Promise<FridayCrossBorderProfileResponse> {
        const userId = requireUserId(ctx.principal);
        return {
          profile: deps.service.getProfile({ userId }),
        };
      },
    },
    {
      operationId: "packs.cross.border.profile.put",
      method: "PUT",
      path: "/v1/packs/cross-border/profile",
      auth: { public: true },
      async handler(ctx): Promise<FridayCrossBorderProfileResponse> {
        const userId = requireUserId(ctx.principal);
        const body = readBodyObject(ctx.body);
        return {
          profile: deps.service.upsertProfile({
            userId,
            profile: {
              regionFocus: readString(body, "regionFocus") as FridayCrossBorderProfileUpdateRequest["regionFocus"],
              storeStage: readString(body, "storeStage") as FridayCrossBorderProfileUpdateRequest["storeStage"],
              categoryL1: readString(body, "categoryL1"),
              categoryL2: readString(body, "categoryL2"),
              fulfillmentMode: readString(body, "fulfillmentMode") as FridayCrossBorderProfileUpdateRequest["fulfillmentMode"],
              priceBand: readString(body, "priceBand"),
              adUsage: readString(body, "adUsage") as FridayCrossBorderProfileUpdateRequest["adUsage"],
              customerServiceMode: readString(body, "customerServiceMode") as FridayCrossBorderProfileUpdateRequest["customerServiceMode"],
              monitoringDepth: readString(body, "monitoringDepth") as FridayCrossBorderProfileUpdateRequest["monitoringDepth"],
              watchTargets: Array.isArray(body.watchTargets) ? body.watchTargets as FridayCrossBorderProfileUpdateRequest["watchTargets"] : [],
              competitorTargets: Array.isArray(body.competitorTargets) ? body.competitorTargets as FridayCrossBorderProfileUpdateRequest["competitorTargets"] : [],
            },
          }),
        };
      },
    },
    {
      operationId: "packs.cross.border.snapshot.get",
      method: "GET",
      path: "/v1/packs/cross-border/snapshot",
      auth: { public: true },
      async handler(ctx): Promise<FridayCrossBorderSnapshotResponse> {
        const userId = requireUserId(ctx.principal);
        return {
          snapshot: deps.service.getSnapshot({ userId }),
        };
      },
    },
    {
      operationId: "packs.cross.border.import.post",
      method: "POST",
      path: "/v1/packs/cross-border/import",
      auth: { public: true },
      async handler(ctx): Promise<FridayCrossBorderImportResponse> {
        const userId = requireUserId(ctx.principal);
        const body = readBodyObject(ctx.body);
        const importBatch = deps.service.importBatch({
          userId,
          batch: {
            kind: readString(body, "kind") as FridayCrossBorderImportRequest["kind"],
            source: readString(body, "source") as FridayCrossBorderImportRequest["source"],
            title: readString(body, "title"),
            ...(typeof body.rawText === "string" ? { rawText: body.rawText } : {}),
            publicLinks: Array.isArray(body.publicLinks)
              ? body.publicLinks.filter((value): value is string => typeof value === "string")
              : [],
            fileNames: Array.isArray(body.fileNames)
              ? body.fileNames.filter((value): value is string => typeof value === "string")
              : [],
          },
        });
        return {
          importBatch,
          snapshot: deps.service.getSnapshot({ userId }),
        };
      },
    },
    {
      operationId: "packs.cross.border.workflow.presets.apply",
      method: "POST",
      path: "/v1/packs/cross-border/workflow-presets/apply",
      auth: { public: true },
      async handler(ctx): Promise<FridayCrossBorderWorkflowPresetResponse> {
        const userId = requireUserId(ctx.principal);
        const body = readBodyObject(ctx.body);
        return {
          snapshot: await deps.service.applyWorkflowPreset({
            userId,
            preset: {
              workflowIds: Array.isArray(body.workflowIds)
                ? body.workflowIds.filter((value): value is FridayCrossBorderWorkflowId => typeof value === "string")
                : undefined,
              timezone: readString(body, "timezone") as FridayCrossBorderWorkflowPresetApplyRequest["timezone"],
            },
          }),
        };
      },
    },
    {
      operationId: "packs.cross.border.workflow.presets.toggle",
      method: "PATCH",
      path: "/v1/packs/cross-border/workflow-presets/:workflowId",
      auth: { public: true },
      async handler(ctx): Promise<FridayCrossBorderWorkflowPresetResponse> {
        const userId = requireUserId(ctx.principal);
        const body = readBodyObject(ctx.body);
        if (typeof body.enabled !== "boolean") {
          throw new FridayDomainError("VALIDATION_ERROR", "enabled is required", { httpStatus: 400 });
        }
        return {
          snapshot: await deps.service.setWorkflowPresetEnabled({
            userId,
            preset: {
              workflowId: readWorkflowIdParam(ctx.params as Record<string, unknown>),
              enabled: body.enabled as FridayCrossBorderWorkflowPresetToggleRequest["enabled"],
              ...(typeof body.timezone === "string" && body.timezone.trim().length > 0
                ? { timezone: body.timezone.trim() as FridayCrossBorderWorkflowPresetToggleRequest["timezone"] }
                : {}),
            },
          }),
        };
      },
    },
    {
      operationId: "packs.cross.border.run.evidence.capture",
      method: "POST",
      path: "/v1/packs/cross-border/run-evidence",
      auth: { public: true },
      async handler(ctx): Promise<FridayCrossBorderRunEvidenceCaptureResponse> {
        const userId = requireUserId(ctx.principal);
        const body = readBodyObject(ctx.body);
        const evidence = deps.service.captureRunEvidence({
          userId,
          evidence: {
            workflowId: readString(body, "workflowId") as FridayCrossBorderWorkflowId,
            managedWorkflowId: readString(body, "managedWorkflowId"),
            status: readString(body, "status") as "completed" | "failed" | "skipped",
            summary: readString(body, "summary"),
          },
        });
        return {
          evidence,
          snapshot: deps.service.getSnapshot({ userId }),
        };
      },
    },
    {
      operationId: "packs.cross.border.import.stale",
      method: "PATCH",
      path: "/v1/packs/cross-border/imports/:importBatchId/stale",
      auth: { public: true },
      async handler(ctx): Promise<FridayCrossBorderImportStaleResponse> {
        const userId = requireUserId(ctx.principal);
        return {
          snapshot: deps.service.markImportStale({
            userId,
            importBatchId: readString(ctx.params as Record<string, unknown>, "importBatchId"),
          }),
        };
      },
    },
    {
      operationId: "packs.cross.border.workflows.disable.all",
      method: "POST",
      path: "/v1/packs/cross-border/workflows/disable-all",
      auth: { public: true },
      async handler(ctx): Promise<FridayCrossBorderDisableAllResponse> {
        const userId = requireUserId(ctx.principal);
        return {
          snapshot: await deps.service.disableAllWorkflows({ userId }),
        };
      },
    },
  ];
}
