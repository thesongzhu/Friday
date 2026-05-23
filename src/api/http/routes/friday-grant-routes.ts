import { FridayDomainError } from "#errors";
import { assertBoundPrincipalForOperation } from "../../../security/friday-owner-session-channel-capability.js";
import type { FridayAuthPrincipal } from "../../model/friday-api-auth.types.js";
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";

export interface FridayGrantRoutesDeps {
  listActiveGrants: () => Promise<Array<{ id: string; principalId: string; target: string; surface?: string; scopes: string[]; issuedAt: string; expiresAt?: string; toolName?: string }>>;
  revokeGrant: (grantId: string, reason: string | undefined, principal: FridayAuthPrincipal) => Promise<{ revoked: boolean }>;
}

export function createFridayGrantRoutes(
  deps: FridayGrantRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "grants.list",
      method: "GET",
      path: "/v1/grants",
      auth: { public: true },
      async handler() {
        const items = await deps.listActiveGrants();
        return { items };
      },
    },
    {
      operationId: "grants.revoke",
      method: "POST",
      path: "/v1/grants/:grantId/revoke",
      auth: { public: true },
      async handler(ctx) {
        assertBoundPrincipalForOperation(ctx.principal ?? null, "capability.grant.revoke", "api");
        const grantId = String((ctx.params as Record<string, unknown>).grantId ?? "").trim();
        if (!grantId) {
          throw new FridayDomainError("VALIDATION_ERROR", "grantId is required", { httpStatus: 400 });
        }
        const reason = (ctx.body as Record<string, unknown> | undefined)?.reason as string | undefined;
        const result = await deps.revokeGrant(grantId, reason, ctx.principal as FridayAuthPrincipal);
        return result;
      },
    },
  ];
}
