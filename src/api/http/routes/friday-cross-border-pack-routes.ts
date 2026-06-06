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
  /**
   * Test-oracle only: allow the legacy TypeScript cross-border pack mutations
   * (profile upsert, import, run-evidence capture, workflow-preset apply/toggle/
   * disable-all, import stale) in isolated mock/unit validation. Production/
   * runtime callers must leave this unset so these surfaces fail-close until Rust
   * owns the cross-border pack engine. The GET profile/snapshot reads are never
   * gated.
   */
  allowTestOnlyCrossBorderPackExecution?: boolean;
}

// ─── Retirement helper ───
//
// Every cross-border pack mutation surface writes user-scoped state (operating
// profile, import batches, run-evidence records, managed-workflow preset/trigger
// registrations) to the local preference store via writePreference /
// workflow-runtime CRUD. They fail-close by default/live until Rust owns the
// cross-border pack entrypoint; legacy behavior is reachable only through the
// explicit allowTestOnlyCrossBorderPackExecution test-oracle flag. The GET
// profile/snapshot reads stay compat_shim and are NOT gated.

function assertCrossBorderPackTestOracleAllowed(deps: FridayCrossBorderPackRoutesDeps): void {
  if (deps.allowTestOnlyCrossBorderPackExecution !== true) {
    throw new FridayDomainError(
      "TS_RUNTIME_CROSS_BORDER_PACK_RETIRED",
      "TypeScript cross-border pack mutation is fail-closed in default/live runtime; use the Rust-owned cross-border pack entrypoint.",
      {
        httpStatus: 503,
        details: {
          classification: "fail_closed",
          replacement: "rust_owned_cross_border_pack_entrypoint_required",
        },
      },
    );
  }
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
        // Hoist body validation above the retirement guard so a malformed profile
        // still returns 400 (not 503) when the flag is unset.
        const profile = {
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
        };
        assertCrossBorderPackTestOracleAllowed(deps);
        return {
          profile: deps.service.upsertProfile({ userId, profile }),
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
        // Hoist body validation above the retirement guard so a malformed import
        // still returns 400 (not 503) when the flag is unset.
        const batch = {
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
        };
        assertCrossBorderPackTestOracleAllowed(deps);
        const importBatch = deps.service.importBatch({ userId, batch });
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
        // Hoist body validation above the retirement guard (timezone is required).
        const preset = {
          workflowIds: Array.isArray(body.workflowIds)
            ? body.workflowIds.filter((value): value is FridayCrossBorderWorkflowId => typeof value === "string")
            : undefined,
          timezone: readString(body, "timezone") as FridayCrossBorderWorkflowPresetApplyRequest["timezone"],
        };
        assertCrossBorderPackTestOracleAllowed(deps);
        return {
          snapshot: await deps.service.applyWorkflowPreset({ userId, preset }),
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
        // Hoist param/body validation above the retirement guard (workflowId).
        const preset = {
          workflowId: readWorkflowIdParam(ctx.params as Record<string, unknown>),
          enabled: body.enabled as FridayCrossBorderWorkflowPresetToggleRequest["enabled"],
          ...(typeof body.timezone === "string" && body.timezone.trim().length > 0
            ? { timezone: body.timezone.trim() as FridayCrossBorderWorkflowPresetToggleRequest["timezone"] }
            : {}),
        };
        assertCrossBorderPackTestOracleAllowed(deps);
        return {
          snapshot: await deps.service.setWorkflowPresetEnabled({ userId, preset }),
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
        // Hoist body validation above the retirement guard so a malformed capture
        // still returns 400 (not 503) when the flag is unset.
        const evidenceInput = {
          workflowId: readString(body, "workflowId") as FridayCrossBorderWorkflowId,
          managedWorkflowId: readString(body, "managedWorkflowId"),
          status: readString(body, "status") as "completed" | "failed" | "skipped",
          summary: readString(body, "summary"),
        };
        assertCrossBorderPackTestOracleAllowed(deps);
        const evidence = deps.service.captureRunEvidence({ userId, evidence: evidenceInput });
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
        // Hoist param validation above the retirement guard (importBatchId).
        const importBatchId = readString(ctx.params as Record<string, unknown>, "importBatchId");
        assertCrossBorderPackTestOracleAllowed(deps);
        return {
          snapshot: deps.service.markImportStale({ userId, importBatchId }),
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
        assertCrossBorderPackTestOracleAllowed(deps);
        return {
          snapshot: await deps.service.disableAllWorkflows({ userId }),
        };
      },
    },
  ];
}
