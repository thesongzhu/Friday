import { FridayDomainError } from "#errors";
import type { CategoryRetention, FridayRetentionSettingsStore } from "#jobs";
import { FRIDAY_MAX_AFTER_DAYS, FRIDAY_MIN_AFTER_DAYS, isValidAfterDays } from "#jobs";
import type { FridayAuthPrincipal, FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import {
  assertBoundPrincipalAuthorityForOperation,
  isUnauthenticatedPublicPrincipal,
} from "../../../security/friday-owner-session-channel-capability.js";

/**
 * Owner-bound retention-Settings HTTP surface (RETENTION-R3a).
 *
 *   GET /v1/uix/retention-policy  → the caller-owner's effective per-content-
 *     category policy (defaults every category to `{mode:"permanent"}`).
 *   PUT /v1/uix/retention-policy  → the caller-owner sets each content category
 *     to `{mode:"permanent"}` (clean "off" — the override is removed) or
 *     `{mode:"after_days",days:N}` (N an integer inside the canonical honored
 *     window `[FRIDAY_MIN_AFTER_DAYS, FRIDAY_MAX_AFTER_DAYS]`). Invalid or
 *     out-of-domain bodies are rejected with a typed 400 and NOTHING is persisted.
 *
 * Owner binding reuses the EXACT `requireUserId(principal)` pattern from
 * friday-uix-routes.ts: the owner id comes ONLY from the authenticated
 * principal — never from the request body or params — and both handlers scope
 * every read/write to that derived id (cross-owner isolation).
 */

export interface FridayRetentionSettingsRoutesDeps {
  store: FridayRetentionSettingsStore;
}

interface FridayRetentionPolicyResponse {
  policy: Record<string, CategoryRetention>;
}

function requireUserId(principal: { userId?: string } | null): string {
  if (isUnauthenticatedPublicPrincipal(principal as never) || !principal?.userId) {
    throw new FridayDomainError("UNAUTHORIZED", "A user-scoped assistant principal is required", {
      httpStatus: 401,
    });
  }
  return principal.userId;
}

/**
 * Retention config is CANONICAL-LOCAL-OWNER-only (SEC-NET-PRINCIPAL-001): it
 * governs global content deletion, so both READS and MUTATIONS require owner
 * authority — a non-owner (viewer / operator) or synthetic-public / release-
 * disabled-device principal must never read or activate it. Reuses the SAME
 * mechanism as the owner-only runtime.secret.* routes
 * (`assertBoundPrincipalAuthorityForOperation`): the synthetic-public / disabled-
 * device principal is refused 401 (bound-principal required) and a bound but
 * non-owner principal is refused 403 (owner/admin authority required). The
 * canonical owner authenticates as role owner/admin (which carries the hub.admin
 * scope) via the local passphrase → bearer flow.
 */
function assertRetentionOwner(
  principal: FridayAuthPrincipal | null,
  operation: "retention.policy.read" | "retention.policy.update",
): void {
  assertBoundPrincipalAuthorityForOperation(principal, operation, "api", {
    anyOfScopes: ["hub.admin"],
    anyOfRoles: ["owner", "admin"],
  });
}

/**
 * Strictly parse ONE per-category `CategoryRetention` value from an untrusted
 * request body. Rejects (typed 400) anything that is not exactly
 * `{mode:"permanent"}` or `{mode:"after_days",days:<N>}` where N is inside the
 * canonical honored window `[FRIDAY_MIN_AFTER_DAYS, FRIDAY_MAX_AFTER_DAYS]` — bad
 * mode, missing/non-integer/NaN/Infinity `days`, `days ≤ 0`, or an OUT-OF-RANGE
 * window the reaper would silently treat as permanent (accept ⊆ honored). The
 * caller MUST validate the WHOLE body before any persistence so an invalid entry
 * persists nothing.
 */
function parseCategoryRetention(category: string, raw: unknown): CategoryRetention {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FridayDomainError(
      "RETENTION_POLICY_VALIDATION_FAILED",
      `Invalid retention config for '${category}': expected an object with a 'mode'.`,
      { httpStatus: 400 },
    );
  }
  const mode = (raw as { mode?: unknown }).mode;
  if (mode === "permanent") {
    return { mode: "permanent" };
  }
  if (mode !== "after_days") {
    throw new FridayDomainError(
      "RETENTION_POLICY_VALIDATION_FAILED",
      `Invalid retention config for '${category}': mode must be 'permanent' or 'after_days'.`,
      { httpStatus: 400 },
    );
  }
  const days = (raw as { days?: unknown }).days;
  if (!isValidAfterDays(days)) {
    throw new FridayDomainError(
      "RETENTION_POLICY_VALIDATION_FAILED",
      `Invalid retention config for '${category}': 'after_days' requires an integer 'days' in [${FRIDAY_MIN_AFTER_DAYS}, ${FRIDAY_MAX_AFTER_DAYS}].`,
      { httpStatus: 400 },
    );
  }
  return { mode: "after_days", days };
}

export function createFridayRetentionSettingsRoutes(
  deps: FridayRetentionSettingsRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "uix.retention.policy.get",
      method: "GET",
      path: "/v1/uix/retention-policy",
      auth: { public: true },
      async handler(ctx): Promise<FridayRetentionPolicyResponse> {
        assertRetentionOwner(ctx.principal ?? null, "retention.policy.read");
        const userId = requireUserId(ctx.principal);
        return { policy: deps.store.readOwnerContentPolicy({ principalId: userId }) };
      },
    },
    {
      operationId: "uix.retention.policy.update",
      method: "PUT",
      path: "/v1/uix/retention-policy",
      auth: { public: true },
      async handler(ctx): Promise<FridayRetentionPolicyResponse> {
        assertRetentionOwner(ctx.principal ?? null, "retention.policy.update");
        const userId = requireUserId(ctx.principal);

        const body = ctx.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new FridayDomainError(
            "RETENTION_POLICY_VALIDATION_FAILED",
            "Request body must be an object with a 'policy' map.",
            { httpStatus: 400 },
          );
        }
        const policyInput = (body as { policy?: unknown }).policy;
        if (!policyInput || typeof policyInput !== "object" || Array.isArray(policyInput)) {
          throw new FridayDomainError(
            "RETENTION_POLICY_VALIDATION_FAILED",
            "'policy' must be a map of content-category → retention config.",
            { httpStatus: 400 },
          );
        }

        // Known content categories = the keys of the effective policy (all 7).
        // Deriving them from the store keeps this handler decoupled from the
        // category list while still rejecting unknown keys.
        const known = new Set(
          Object.keys(deps.store.readOwnerContentPolicy({ principalId: userId })),
        );

        // Validate the WHOLE body FIRST (reject → 400, persist nothing), then apply.
        const updates: Record<string, CategoryRetention> = {};
        for (const [category, raw] of Object.entries(policyInput as Record<string, unknown>)) {
          if (!known.has(category)) {
            throw new FridayDomainError(
              "RETENTION_POLICY_VALIDATION_FAILED",
              `Unknown retention content category: '${category}'.`,
              { httpStatus: 400 },
            );
          }
          updates[category] = parseCategoryRetention(category, raw);
        }

        return {
          policy: deps.store.applyOwnerContentPolicy({ principalId: userId, updates }),
        };
      },
    },
  ];
}
