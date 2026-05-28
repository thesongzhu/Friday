/**
 * Sensitive-read route classification.
 *
 * Friday's HTTP posture is no-login-by-default: every route is reachable without an
 * Authorization header, and unauthenticated callers resolve to a single synthetic
 * "default-public" principal (see friday-default-public-principal.ts). That synthetic
 * principal is shared across ALL anonymous callers (one fixed tenant/user), so any read it
 * is allowed to perform leaks data between anonymous callers and exposes sensitive surfaces
 * to anyone on the network.
 *
 * Locked product decision: sensitive reads require a bound owner/session/channel principal;
 * anonymous public access is only for minimal setup/health/onboarding surfaces. The route
 * groups below carry personal data or security posture, so the synthetic anonymous principal
 * is denied GET/HEAD on them (it must authenticate via the localhost bootstrap → login →
 * bearer flow first). This is the single, auditable classification source consumed by the
 * server-level sensitive-read floor in friday-http-server.ts.
 *
 * Targeted scope (per the approved classification):
 *   - /v1/memory     personal memory items (also closes the anonymous-memory-SHARING gap:
 *                    all anonymous callers share one tenant, so an open memory read let any
 *                    anonymous caller read another's items)
 *   - /v1/secrets    secret metadata (id/scope/refKey enumeration)
 *   - /v1/security   security findings / posture
 *   - /v1/fleet      fleet inventory
 *   - /v1/diagnosis  diagnosis data
 *   - /v1/sessions   session details
 *
 * Intentionally NOT gated here (kept anonymous): health, setup, onboarding, auth
 * bootstrap/login/refresh, version/status/capabilities, and the core no-login UX surfaces
 * (agent, chat, skills, workflows, …). Mutations on public routes are already fail-closed by
 * the public-mutation safety floor; this gate closes the read side for sensitive surfaces.
 */
export const FRIDAY_SENSITIVE_READ_ROUTE_PREFIXES: readonly string[] = [
  "/v1/memory",
  "/v1/secrets",
  "/v1/security",
  "/v1/fleet",
  "/v1/diagnosis",
  "/v1/sessions",
];

/**
 * True when a route path is a sensitive-read surface (exact prefix or a sub-path of it).
 * The trailing-slash boundary prevents a sibling like `/v1/secretspolicy` from matching
 * `/v1/secrets`.
 */
export function isFridaySensitiveReadRoute(routePath: string): boolean {
  return FRIDAY_SENSITIVE_READ_ROUTE_PREFIXES.some(
    (prefix) => routePath === prefix || routePath.startsWith(`${prefix}/`),
  );
}
