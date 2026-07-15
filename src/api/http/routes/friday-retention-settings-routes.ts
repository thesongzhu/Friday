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
 * Owner binding is CANONICAL-OWNER-scoped (SEC-NET-PRINCIPAL-001): the id comes
 * ONLY from the authenticated principal — never from the request body or params —
 * AND the authenticated principal's `userId` MUST MATCH the single canonical
 * owner the production reaper is bound to (`resolveCanonicalOwnerId`). Owner/admin
 * ROLE is a floor, not identity: a second, legitimately-authenticated admin is
 * refused 403 so a persisted opt-in can never diverge from what the reaper reads
 * (accept == honored). Both handlers scope every read/write to the resolved
 * canonical-owner id, and fail closed (403, zero effect) if it cannot be resolved.
 */

export interface FridayRetentionSettingsRoutesDeps {
  store: FridayRetentionSettingsStore;
  /**
   * Resolves the SINGLE canonical-owner identity that GOVERNS the reaper —
   * i.e. the exact id the production per-sweep policy loader is bound to
   * (`learningDefaultUserId` = `admin-001` in `friday-hub-bootstrap.ts`). Both
   * GET and PUT require the authenticated principal's `userId` to MATCH this
   * id (SEC-NET-PRINCIPAL-001): role/scope (owner/admin + hub.admin) is a floor,
   * NOT canonical-owner identity — the repo schema permits multiple users and
   * each role-derived `hub.admin` token would otherwise be accepted, persisting
   * an override the canonical-owner-bound reaper NEVER reads (DATA-RETENTION-001
   * truthfulness: accept must equal honored end-to-end).
   *
   * This is a PRODUCTION dependency threaded from the SAME source the reaper
   * consumes — never a per-request caller value and never a route-local literal.
   *
   * FAIL-CLOSED: if this returns null/undefined/empty (or throws), the route
   * denies (403, zero persistence, zero readback) rather than falling open to
   * "any admin".
   */
  resolveCanonicalOwnerId: () => string | null | undefined;
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
 * CANONICAL-OWNER binding (SEC-NET-PRINCIPAL-001 / DATA-RETENTION-001). Beyond
 * the bound-principal + owner/admin authority FLOOR (kept as defense in depth),
 * retention config is governed by a SINGLE canonical owner — the exact identity
 * the production reaper's policy loader is bound to. Role/scope alone is NOT
 * canonical-owner identity (the schema permits multiple hub.admin users), so the
 * authenticated principal's `userId` MUST MATCH the resolved canonical-owner id
 * on BOTH reads and mutations. Anything an owner/admin-authorized-but-non-
 * canonical principal (e.g. `admin-002`) submits would persist under an id the
 * canonical-owner-bound reaper never reads (accept ≠ honored) — so it is refused.
 *
 * Returns the resolved canonical-owner id (== the caller's userId) that every
 * read/write MUST be keyed to — never a caller-supplied value. FAIL-CLOSED: an
 * unresolvable canonical-owner id (null/undefined/blank, or the provider throws)
 * denies with a typed 403 and ZERO effect, rather than falling open to any admin.
 */
function assertCanonicalRetentionOwner(
  principal: FridayAuthPrincipal | null,
  operation: "retention.policy.read" | "retention.policy.update",
  resolveCanonicalOwnerId: () => string | null | undefined,
): string {
  // Floor first (defense in depth): synthetic-public / disabled-device → 401;
  // bound non-owner (viewer / operator) → 403.
  assertRetentionOwner(principal, operation);
  const userId = requireUserId(principal);

  // Resolve the canonical-owner id the reaper actually consumes. FAIL-CLOSED on
  // any resolution failure (throw or nullish/blank) — never fall open.
  let canonicalOwnerId: string | null | undefined;
  try {
    canonicalOwnerId = resolveCanonicalOwnerId();
  } catch {
    canonicalOwnerId = null;
  }
  if (typeof canonicalOwnerId !== "string" || canonicalOwnerId.trim().length === 0) {
    throw new FridayDomainError(
      "RETENTION_CANONICAL_OWNER_UNRESOLVED",
      "Retention policy is unavailable: the canonical owner identity could not be resolved.",
      { httpStatus: 403 },
    );
  }

  // The authenticated principal must BE the canonical owner (not merely hold
  // owner/admin authority). A second, legitimately-authenticated admin is denied.
  if (userId !== canonicalOwnerId) {
    throw new FridayDomainError(
      "RETENTION_NOT_CANONICAL_OWNER",
      "Retention policy is governed by the single canonical owner; this principal is not the canonical owner.",
      { httpStatus: 403 },
    );
  }

  return canonicalOwnerId;
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
        const ownerId = assertCanonicalRetentionOwner(
          ctx.principal ?? null,
          "retention.policy.read",
          deps.resolveCanonicalOwnerId,
        );
        return { policy: deps.store.readOwnerContentPolicy({ principalId: ownerId }) };
      },
    },
    {
      operationId: "uix.retention.policy.update",
      method: "PUT",
      path: "/v1/uix/retention-policy",
      auth: { public: true },
      async handler(ctx): Promise<FridayRetentionPolicyResponse> {
        const ownerId = assertCanonicalRetentionOwner(
          ctx.principal ?? null,
          "retention.policy.update",
          deps.resolveCanonicalOwnerId,
        );

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
          Object.keys(deps.store.readOwnerContentPolicy({ principalId: ownerId })),
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
          policy: deps.store.applyOwnerContentPolicy({ principalId: ownerId, updates }),
        };
      },
    },
  ];
}
