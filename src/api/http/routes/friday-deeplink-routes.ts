import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import { FridayDomainError } from "#errors";
import {
  parseFridayDeepLinkJson,
  parseFridayDeepLinkUri,
  validateFridayDeepLink,
} from "../../../deeplink/index.js";
import type {
  FridayDeepLinkApplyResult,
  FridayDeepLinkPreviewResult,
} from "../../../deeplink/index.js";

import type { FridayDeepLinkPayload } from "../../../deeplink/index.js";
import type { FridayAuthPrincipal } from "../../model/friday-api-auth.types.js";
import type { FridayCanonicalApprovalResolution, FridayMutatingActionActor } from "../../../security/friday-mutating-action-gate.js";
import type { FridayDeepLinkApplyOptions } from "../../runtime/friday-deep-link-apply-service.js";

export interface FridayDeepLinkRoutesDeps {
  applyDeepLink?: (payload: FridayDeepLinkPayload, options: FridayDeepLinkApplyOptions) => Promise<FridayDeepLinkApplyResult>;
  /**
   * Test-oracle only: allow the legacy TypeScript deep-link product logic —
   * preview (validateFridayDeepLink verdict compute) and apply (applyDeepLink
   * dispatch -> converterService.import / workflowCrud.createWorkflow /
   * workflowImportExport.importBundle / mcpConfigStore.addServer). Production/
   * runtime callers must leave this unset so both POST routes fail-close
   * (503 TS_RUNTIME_DEEPLINK_RETIRED) until Rust owns deep-link handling.
   */
  allowTestOnlyDeepLinkExecution?: boolean;
}

/**
 * TS-runtime retirement guard for the deep-link product-logic routes. Placed
 * AFTER body validation (and, for apply, the confirmed-check) and IMMEDIATELY
 * BEFORE the validateFridayDeepLink verdict compute, so malformed -> 400 and
 * unconfirmed -> 400 still win, but the Rust-ownable verdict compute does NOT
 * run when retired. Consequence: a confirmed+blocked payload fail-closes with
 * this 503 (the blocked -> 422 path only fires under the test-oracle flag, when
 * the guard is a no-op and validateFridayDeepLink runs).
 */
function assertDeepLinkTestOracleAllowed(deps: FridayDeepLinkRoutesDeps): void {
  if (deps.allowTestOnlyDeepLinkExecution === true) {
    return;
  }
  throw new FridayDomainError(
    "TS_RUNTIME_DEEPLINK_RETIRED",
    "Deep-link preview/apply is fail-closed in the default/live runtime; the Rust-owned deep-link entrypoint is required.",
    {
      httpStatus: 503,
      details: {
        classification: "fail_closed",
        replacement: "rust_owned_deeplink_entrypoint_required",
      },
    },
  );
}

interface FridayDeepLinkPreviewRequest {
  uri?: string;
  payload?: unknown;
}

interface FridayDeepLinkPreviewResponse {
  preview: FridayDeepLinkPreviewResult;
}

interface FridayDeepLinkApplyRequest {
  uri?: string;
  payload?: unknown;
  confirmed: boolean;
  idempotencyKey?: string;
  planDigest?: string;
  canonicalApproval?: FridayCanonicalApprovalResolution;
}

interface FridayDeepLinkApplyResponse {
  result: FridayDeepLinkApplyResult;
}

function createActorFromPrincipal(
  principal: FridayAuthPrincipal | null,
  fallbackId: string,
): FridayMutatingActionActor {
  if (!principal) {
    return {
      kind: "api",
      id: fallbackId,
      principalId: fallbackId,
    };
  }

  return {
    kind: principal.principalType,
    id: principal.principalId,
    principalId: principal.principalId,
  };
}

export function createFridayDeepLinkRoutes(
  deps: FridayDeepLinkRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "deeplink.preview",
      method: "POST",
      path: "/v1/deeplink/preview",
      auth: { public: true },
      async handler(ctx: { body: unknown }): Promise<FridayDeepLinkPreviewResponse> {
        const body = ctx.body as FridayDeepLinkPreviewRequest;

        let parsed;
        if (body.uri) {
          parsed = parseFridayDeepLinkUri(body.uri);
        } else if (body.payload) {
          parsed = parseFridayDeepLinkJson(body.payload);
        } else {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            "Either 'uri' or 'payload' must be provided",
            { httpStatus: 400 },
          );
        }

        if (!parsed.ok) {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            parsed.error,
            { httpStatus: 400 },
          );
        }

        assertDeepLinkTestOracleAllowed(deps);
        const preview = validateFridayDeepLink(parsed.payload);
        return { preview };
      },
    },

    {
      operationId: "deeplink.apply",
      method: "POST",
      path: "/v1/deeplink/apply",
      auth: { public: true },
      async handler(ctx): Promise<FridayDeepLinkApplyResponse> {
        const body = ctx.body as FridayDeepLinkApplyRequest;

        if (!body.confirmed) {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            "Deep link apply requires explicit confirmation (confirmed: true)",
            { httpStatus: 400 },
          );
        }

        let parsed;
        if (body.uri) {
          parsed = parseFridayDeepLinkUri(body.uri);
        } else if (body.payload) {
          parsed = parseFridayDeepLinkJson(body.payload);
        } else {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            "Either 'uri' or 'payload' must be provided",
            { httpStatus: 400 },
          );
        }

        if (!parsed.ok) {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            parsed.error,
            { httpStatus: 400 },
          );
        }

        // TS-runtime retirement: fail-close the apply route BEFORE the
        // validateFridayDeepLink verdict compute (the same Rust-ownable product
        // logic gated in preview) so it does not execute in default/live — a
        // confirmed+blocked payload also fail-closes (503), not 422. Placed after
        // the confirmed-check (400) + body validation (400) so those still win.
        assertDeepLinkTestOracleAllowed(deps);

        const preview = validateFridayDeepLink(parsed.payload);
        if (preview.verdict === "blocked") {
          throw new FridayDomainError(
            "VALIDATION_FAILED",
            "Deep link payload has blocking issues and cannot be applied",
            { httpStatus: 422 },
          );
        }

        if (!deps.applyDeepLink) {
          // Fallback: return a "not yet wired" result for resource types
          // that don't have an apply handler yet.
          return {
            result: {
              applied: false,
              resourceType: parsed.payload.type,
              message: `Deep link apply for ${parsed.payload.type} is not yet wired in hub bootstrap.`,
            },
          };
        }

        const result = await deps.applyDeepLink(parsed.payload, {
          actor: createActorFromPrincipal(ctx.principal, `api:${ctx.requestId}`),
          surface: "api:/v1/deeplink/apply",
          idempotencyKey: body.idempotencyKey,
          planDigest: body.planDigest,
          canonicalApproval: body.canonicalApproval,
        });
        return { result };
      },
    },
  ];
}
