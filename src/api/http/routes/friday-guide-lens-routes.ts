import { FridayDomainError } from "#errors";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayGuideLensAvatarPreference,
  FridayGuideLensPreferences,
  FridayGuideLensResolveTargetRequest,
  FridayGuideLensScreenshotIntakeRequest,
  FridayGuideLensService,
  FridayGuideLensShowOverlayRequest,
  FridayGuideLensSnapshotRequest,
  FridayGuideLensVerificationRequest,
} from "../../../guide-lens/model/friday-guide-lens.types.js";

export interface FridayGuideLensRoutesDeps {
  service: FridayGuideLensService;
  /**
   * Test-oracle only: allow legacy TypeScript guide-lens routes in isolated validation.
   * Production/runtime callers must leave this unset so guide-lens action/write routes
   * stay fail-closed until the guide-lens surface is governed or Rust-owned.
   */
  allowTestOnlyGuideLensExecution?: boolean;
}

function requireBodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new FridayDomainError("VALIDATION_ERROR", "Request body must be an object", { httpStatus: 400 });
  }
  return body as Record<string, unknown>;
}

function requireString(body: unknown, field: string): void {
  const obj = requireBodyObject(body);
  if (typeof obj[field] !== "string" || (obj[field] as string).trim().length === 0) {
    throw new FridayDomainError("VALIDATION_ERROR", `${field} is required`, { httpStatus: 400 });
  }
}

function validateNoMutatingIntent(service: FridayGuideLensService, body: unknown): void {
  const obj = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  for (const key of ["action", "actionType", "intent", "instruction", "message"]) {
    const value = obj[key];
    if (typeof value === "string") {
      service.assertReadOnlyAction(value);
    }
  }
}

function throwRetiredGuideLens(): never {
  throw new FridayDomainError(
    "TS_RUNTIME_GUIDE_LENS_RETIRED",
    "TypeScript guide-lens routes are fail-closed in default/live runtime; use the governed Rust-owned guide-lens entrypoint.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_guide_lens_entrypoint_required",
      },
    },
  );
}

function assertGuideLensTestOracleAllowed(deps: FridayGuideLensRoutesDeps): void {
  if (deps.allowTestOnlyGuideLensExecution !== true) {
    throwRetiredGuideLens();
  }
}

export function createFridayGuideLensRoutes(
  deps: FridayGuideLensRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "guidelens.state.get",
      method: "GET",
      path: "/v1/guide-lens/state",
      auth: { public: true },
      async handler() {
        return deps.service.getState();
      },
    },
    {
      operationId: "guidelens.snapshot.create",
      method: "POST",
      path: "/v1/guide-lens/snapshot",
      auth: { public: true },
      async handler(ctx) {
        assertGuideLensTestOracleAllowed(deps);
        validateNoMutatingIntent(deps.service, ctx.body);
        return deps.service.captureSnapshot(ctx.body as FridayGuideLensSnapshotRequest);
      },
    },
    {
      operationId: "guidelens.targets.resolve",
      method: "POST",
      path: "/v1/guide-lens/targets/resolve",
      auth: { public: true },
      async handler(ctx) {
        assertGuideLensTestOracleAllowed(deps);
        requireString(ctx.body, "instruction");
        validateNoMutatingIntent(deps.service, ctx.body);
        return deps.service.resolveTarget(ctx.body as FridayGuideLensResolveTargetRequest);
      },
    },
    {
      operationId: "guidelens.overlay.show",
      method: "POST",
      path: "/v1/guide-lens/overlay",
      auth: { public: true },
      async handler(ctx) {
        assertGuideLensTestOracleAllowed(deps);
        requireString(ctx.body, "message");
        validateNoMutatingIntent(deps.service, ctx.body);
        return deps.service.showOverlay(ctx.body as FridayGuideLensShowOverlayRequest);
      },
    },
    {
      operationId: "guidelens.overlay.clear",
      method: "DELETE",
      path: "/v1/guide-lens/overlay",
      auth: { public: true },
      async handler(ctx) {
        assertGuideLensTestOracleAllowed(deps);
        const query = ctx.query as { sessionId?: string };
        return deps.service.clearOverlay(query.sessionId);
      },
    },
    {
      operationId: "guidelens.screenshots.analyze",
      method: "POST",
      path: "/v1/guide-lens/screenshots/analyze",
      auth: { public: true },
      async handler(ctx) {
        assertGuideLensTestOracleAllowed(deps);
        validateNoMutatingIntent(deps.service, ctx.body);
        return deps.service.analyzeScreenshot(ctx.body as FridayGuideLensScreenshotIntakeRequest);
      },
    },
    {
      operationId: "guidelens.verifications.create",
      method: "POST",
      path: "/v1/guide-lens/verifications",
      auth: { public: true },
      async handler(ctx) {
        assertGuideLensTestOracleAllowed(deps);
        validateNoMutatingIntent(deps.service, ctx.body);
        return deps.service.verify(ctx.body as FridayGuideLensVerificationRequest);
      },
    },
    {
      operationId: "guidelens.preferences.update",
      method: "PATCH",
      path: "/v1/guide-lens/preferences",
      auth: { public: true },
      async handler(ctx) {
        assertGuideLensTestOracleAllowed(deps);
        const patch = requireBodyObject(ctx.body) as Partial<FridayGuideLensPreferences>;
        return deps.service.updatePreferences(patch);
      },
    },
    {
      operationId: "guidelens.avatar.update",
      method: "POST",
      path: "/v1/guide-lens/avatar",
      auth: { public: true },
      async handler(ctx) {
        assertGuideLensTestOracleAllowed(deps);
        const avatar = requireBodyObject(ctx.body) as Partial<FridayGuideLensAvatarPreference>;
        return deps.service.updateAvatar(avatar);
      },
    },
  ];
}
