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
 *   - /v1/learning   diagnosis/incident data ALIAS of /v1/diagnosis — createFridayDiagnosisRoutes
 *                    mounts the SAME handlers under both prefixes (e.g. /v1/learning/incidents,
 *                    /v1/learning/overview), so gating /v1/diagnosis without /v1/learning would
 *                    leave the identical incident data anonymously readable via the alias.
 *   - /v1/sessions   session details (incl. conversation history; anonymous users must sign in
 *                    to list/read sessions — an accepted trade-off of the targeted scope)
 *   - /v1/grants     active grants and authorization posture
 *   - /v1/audit      runtime audit logs / forensic evidence
 *   - /v1/observability/audit  observability audit entries and detail readback
 *   - /v1/providers/usage  provider spend/usage summary (global cost data) — gated
 *                    2026-06-24 (operator-authorized per-handler review). Sub-path only:
 *                    the trailing-slash boundary keeps the bare /v1/providers list/get/health/
 *                    capability-health/doctor (accepted operator_external_adapter reads)
 *                    anonymous.
 *   - /v1/providers/budget  monthly budget status (GET) — gated 2026-06-24 (operator-
 *                    authorized). Same sub-path-only boundary as /v1/providers/usage; the bare
 *                    /v1/providers prefix stays anonymous. (PUT here is already fail-closed by
 *                    the public-mutation floor.)
 *   - /v1/system/remote/devices  remote device inventory / posture (GET list + GET detail) —
 *                    gated 2026-06-24 (operator-authorized). The POST register / DELETE /
 *                    WebAuthn auth-option routes under this prefix are mutations (unaffected by
 *                    this GET/HEAD-only read floor).
 *   - /v1/system/remote/sessions  remote session inventory / posture (GET list) — gated
 *                    2026-06-24 (operator-authorized). POST create / POST heartbeat / DELETE
 *                    under this prefix are mutations (unaffected by this read floor).
 *   - /v1/system/state, /v1/system/approvals, /v1/system/events, /v1/system/session  the sibling
 *                    systemService control-plane reads — gated 2026-07-13 (SEC-NET-PRINCIPAL-001).
 *                    Same trust boundary/service as /v1/system/remote/* above; /v1/system/state in
 *                    particular aggregates approvals + remote device/session posture, so leaving it
 *                    anonymous bypassed the /v1/system/remote/* floor. Mutations under /v1/system
 *                    (POST intents, PATCH approvals) are separately fenced and unaffected here.
 *   - /v1/uix/user-profile, /v1/uix/learned-facts and /v1/uix/retention-policy  personal UX
 *                    profile / learned preference facts / owner-bound retention Settings posture.
 *                    These are already fail-closed at the route requireUserId helper
 *                    (cr02-03 / #1450; RETENTION-R3a); exact-path floor entries keep the central
 *                    read classification honest without over-flooring anonymous setup/template UX
 *                    surfaces under the broader /v1/uix prefix.
 *
 * Intentionally NOT gated here (kept anonymous): health, setup, onboarding, auth
 * bootstrap/login/refresh, version/status/capabilities, and the core no-login UX surfaces
 * (agent, chat, skills, workflows, …). Mutations on public routes are already fail-closed by
 * the public-mutation safety floor; this gate closes the read side for sensitive surfaces.
 *
 * The historical /v1/uix personal-read gap is not left open: /v1/uix/user-profile and
 * /v1/uix/learned-facts are bound-principal-gated in their handlers and redundantly classified
 * here as exact sensitive-read paths. Broader systemic public-GET classification remains a
 * separate policy hardening track; do not replace this targeted list with a blanket /v1/uix
 * prefix without auditing setup/onboarding/template consumers.
 */
export const FRIDAY_SENSITIVE_READ_ROUTE_PREFIXES: readonly string[] = [
  "/v1/memory",
  "/v1/secrets",
  "/v1/security",
  "/v1/fleet",
  "/v1/diagnosis",
  "/v1/learning",
  "/v1/sessions",
  "/v1/grants",
  "/v1/audit",
  "/v1/observability/audit",
  // Gated 2026-06-24 (operator-authorized per-handler review). Each is a SUB-PATH of an
  // otherwise-anonymous prefix; the trailing-slash boundary in isFridaySensitiveReadRoute keeps
  // the bare /v1/providers and /v1/system/... prefixes anonymous (no over-flooring).
  "/v1/providers/usage",
  "/v1/providers/budget",
  "/v1/system/remote/devices",
  "/v1/system/remote/sessions",
  // SEC-NET-PRINCIPAL-001 (2026-07-13): extend the /v1/system read floor to the sibling
  // systemService-backed control-plane reads that #1200 left anonymous. These sit at the SAME
  // trust boundary as /v1/system/remote/devices + /v1/system/remote/sessions (same systemService,
  // same file) and each is served to the shared synthetic public principal (leaking owner
  // control-plane posture network-wide):
  //   - /v1/system/state    getState() snapshot — AGGREGATES approvals + remoteDevices +
  //                         remoteSessions + permissions/health. Leaving it anonymous was a BYPASS
  //                         of the /v1/system/remote/* floor (the same posture readable via state).
  //   - /v1/system/approvals  approval RULES (auto-approve/deny per app/action) — security posture.
  //   - /v1/system/events   system event log / stream — audit-adjacent forensic data.
  //   - /v1/system/session  getSession() — owner workspace path + companion/remote/health posture.
  // GET/HEAD read floor only; the POST /v1/system/intents + PATCH /v1/system/approvals/:id
  // mutations are separately fenced (retired test-oracle / canonical-approval gate). Bare
  // /v1/system has no other anonymous GET surface, so these exact sub-paths do not over-floor.
  "/v1/system/state",
  "/v1/system/approvals",
  "/v1/system/events",
  "/v1/system/session",
  "/v1/uix/user-profile",
  "/v1/uix/learned-facts",
  // RETENTION-R3a: owner-bound per-category retention Settings (GET reads the
  // owner's retention posture). Already fail-closed at the route requireUserId
  // helper; the exact-path floor keeps the central read classification honest
  // alongside the sibling personal /v1/uix/* surfaces without over-flooring the
  // broader anonymous /v1/uix setup/template UX.
  "/v1/uix/retention-policy",
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
