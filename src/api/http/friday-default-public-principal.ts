import type { FridayAuthPrincipal } from "../model/friday-api-auth.types.js";
import type { FridayScope } from "../model/friday-api-auth.types.js";

/**
 * Auth-boundary product posture: every Friday HTTP route is reachable without an
 * Authorization header, passphrase, or bearer token. To keep formerly-authenticated
 * handlers — which read `ctx.principal.userId`, `ctx.principal.tenantId`, role, and
 * scopes — operational, the HTTP server injects this synthetic principal into
 * `ctx.principal` for every public HTTP request.
 *
 * Stable principalId / userId / tenantId so audit logs and idempotency keys
 * derived from `ctx.principal.principalId` are deterministic.
 */

const FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_SCOPES: FridayScope[] = [
  "hub.admin",
  "workflow.read",
  "workflow.write",
  "workflow.run",
  "workflow.conflict.resolve",
  "satellite.read",
  "satellite.write",
  "fleet.read",
  "security.read",
  "security.write",
  "secrets.read",
  "secrets.write",
  "session.read",
  "session.write",
  "diagnosis.read",
  "diagnosis.write",
  "agent.read",
  "agent.run",
  "agent.write",
  "skill.read",
  "skill.write",
  "plugin.read",
  "plugin.write",
  "plugin.install",
  "desktop.read",
  "desktop.write",
  "desktop.execute",
  "rules.read",
  "rules.write",
  "execution.read",
  "acceptance.read",
  "retry.read",
  "playbook.read",
  "playbook.write",
];

export const FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID = "public:default";
export const FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID = "00000000-0000-0000-0000-000000000001";
export const FRIDAY_DEFAULT_PUBLIC_HTTP_TENANT_ID = "00000000-0000-0000-0000-000000000001";
export const FRIDAY_DEFAULT_PUBLIC_HTTP_TOKEN_ID = "00000000-0000-0000-0000-000000000002";
export const FRIDAY_DEFAULT_PUBLIC_HTTP_ISSUED_AT = "2026-05-12T00:00:00.000Z";

export function createFridayDefaultPublicHttpPrincipal(): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID,
    tenantId: FRIDAY_DEFAULT_PUBLIC_HTTP_TENANT_ID,
    userId: FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID,
    role: "admin",
    scopes: [...FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_SCOPES],
    tokenId: FRIDAY_DEFAULT_PUBLIC_HTTP_TOKEN_ID,
    tokenKind: "access",
    issuedAt: FRIDAY_DEFAULT_PUBLIC_HTTP_ISSUED_AT,
  };
}
