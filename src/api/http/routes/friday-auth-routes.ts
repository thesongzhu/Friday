import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayAuthBootstrapChallengeRequest,
  FridayAuthBootstrapChallengeResponse,
  FridayAuthBootstrapRequest,
  FridayAuthBootstrapResponse,
  FridayAuthBootstrapStatusResponse,
  FridayAuthDeviceBindingStateResponse,
  FridayAuthDeviceClaimRequest,
  FridayAuthDeviceClaimResponse,
  FridayAuthDeviceReadbackRequest,
  FridayAuthDeviceReadbackResponse,
  FridayAuthMeResponse,
  FridayAuthMigrateChallengeRequest,
  FridayAuthMigrateChallengeResponse,
  FridayAuthMigrateDeviceClaimRequest,
  FridayAuthMigrateDeviceClaimResponse,
  FridayLoginRequest,
  FridayLogoutRequest,
  FridayRefreshRequest,
} from "../../model/friday-api-auth.types.js";
import type { FridayAuthService } from "../../auth/friday-auth-service.types.js";
import {
  FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID,
  FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID,
} from "../friday-default-public-principal.js";
import { assertBoundPrincipalAuthorityForOperation } from "../../../security/friday-owner-session-channel-capability.js";
import { FridayDomainError } from "#errors";

const FRIDAY_DEFAULT_PUBLIC_HTTP_DISPLAY_NAME = "Friday Public";

export interface FridayAuthRoutesDeps {
  authService: FridayAuthService;
}

export function createFridayAuthRoutes(
  deps: FridayAuthRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "auth.bootstrap.status",
      method: "GET",
      path: "/v1/auth/bootstrap/status",
      auth: { public: true },
      async handler(): Promise<FridayAuthBootstrapStatusResponse> {
        return deps.authService.getBootstrapStatus();
      },
    },
    {
      operationId: "auth.bootstrap.local.passphrase",
      method: "POST",
      path: "/v1/auth/bootstrap/local-passphrase",
      // First-boot only: authService.bootstrapLocalPassphrase enforces (a)
      // caller IP is loopback/private and (b) no prior local passphrase exists
      // (first-boot). Synthetic public principal alone is insufficient because
      // both boundaries are enforced before any side effect. Negative tests:
      // test/unit/api/http/routes/friday-auth-routes.test.ts:117 (non-localhost
      // rejected) and :92-112 ("already been completed" / first-boot exclusion).
      auth: { public: true, allowUnauthenticatedMutation: true },
      rateLimitPolicyId: "auth.login",
      async handler(ctx): Promise<FridayAuthBootstrapResponse> {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }

        const rawPassphrase =
          typeof body.passphrase === "string"
            ? body.passphrase
            : typeof body.localPassphrase === "string"
              ? body.localPassphrase
              : "";
        const request: FridayAuthBootstrapRequest = {
          passphrase: rawPassphrase,
        };

        return deps.authService.bootstrapLocalPassphrase(request, ctx.ip);
      },
    },
    {
      operationId: "auth.bootstrap.challenge",
      method: "POST",
      path: "/v1/auth/bootstrap/challenge",
      // SEC-SETUP-BOOTSTRAP-001: device-claim challenge leg. Mints a single-use
      // install nonce. authService.issueBootstrapChallenge enforces ONLY (a)
      // loopback-only ingress and (b) required-field presence (installId/osUser/
      // origin) before any side effect — it does NOT gate on first-boot/ownership
      // (unlike auth.bootstrap.local.passphrase, which checks the owner slot).
      // Minting a challenge post-ownership is harmless: the ownership gate is the
      // owner CAS enforced downstream at auth.bootstrap.device-claim, which fails
      // closed (409) if already claimed. Only the nonce HASH is persisted; the
      // raw nonce is returned once. Expired/unconsumed nonces are reaped by the
      // retention sweep (bounded), so this route cannot grow the ledger unbounded.
      auth: { public: true, allowUnauthenticatedMutation: true },
      rateLimitPolicyId: "auth.login",
      async handler(ctx): Promise<FridayAuthBootstrapChallengeResponse> {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }
        const request: FridayAuthBootstrapChallengeRequest = {
          installId: typeof body.installId === "string" ? body.installId : "",
          osUser: typeof body.osUser === "string" ? body.osUser : "",
          origin: typeof body.origin === "string" ? body.origin : "",
          action: typeof body.action === "string" ? body.action : undefined,
        };
        return deps.authService.issueBootstrapChallenge(request, ctx.ip);
      },
    },
    {
      operationId: "auth.bootstrap.device.claim",
      method: "POST",
      path: "/v1/auth/bootstrap/device-claim",
      // SEC-SETUP-BOOTSTRAP-001: atomically claims the local owner slot by
      // consuming a single-use install nonce and binding a device public key.
      // Loopback-only, origin-bound, replay-protected, crash-safe — all enforced
      // in authService.claimOwnerWithDeviceKey. Fails closed (409) if already
      // claimed (by passphrase or another device).
      auth: { public: true, allowUnauthenticatedMutation: true },
      rateLimitPolicyId: "auth.login",
      async handler(ctx): Promise<FridayAuthDeviceClaimResponse> {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }
        const request: FridayAuthDeviceClaimRequest = {
          nonce: typeof body.nonce === "string" ? body.nonce : "",
          devicePublicKey: typeof body.devicePublicKey === "string" ? body.devicePublicKey : "",
          deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
          origin: typeof body.origin === "string" ? body.origin : "",
          installId: typeof body.installId === "string" ? body.installId : "",
          osUser: typeof body.osUser === "string" ? body.osUser : "",
          // SEC-SETUP-BOOTSTRAP-001 Slice 3: forward the untrusted proof-of-
          // possession envelope; the auth SERVICE defensively validates it and
          // fails closed on anything malformed.
          deviceClaimProof: body.deviceClaimProof as FridayAuthDeviceClaimRequest["deviceClaimProof"],
        };
        return deps.authService.claimOwnerWithDeviceKey(request, ctx.ip);
      },
    },
    {
      operationId: "auth.migrate.challenge",
      method: "POST",
      path: "/v1/auth/migrate/challenge",
      // SEC-SETUP-BOOTSTRAP-001 Slice 5: mints a single-use migration nonce
      // (kind='device_migration_claim') the device signs. AUTHENTICATED: NOT
      // allowUnauthenticatedMutation, so the http-server L1 public-mutation floor
      // refuses the synthetic public principal (401) — a real OWNER bearer is
      // required. The handler additionally enforces owner authority, and the auth
      // SERVICE binds the principal to the local owner (principalId===localUser.id)
      // and requires an existing passphrase credential. Loopback-only,
      // rate-limited under auth.login.
      auth: { public: true },
      rateLimitPolicyId: "auth.login",
      async handler(ctx): Promise<FridayAuthMigrateChallengeResponse> {
        assertBoundPrincipalAuthorityForOperation(
          ctx.principal,
          "auth.migrate.challenge",
          "api",
          { anyOfRoles: ["owner", "admin"], anyOfScopes: ["security.write"] },
        );
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }
        const request: FridayAuthMigrateChallengeRequest = {
          installId: typeof body.installId === "string" ? body.installId : "",
          osUser: typeof body.osUser === "string" ? body.osUser : "",
          origin: typeof body.origin === "string" ? body.origin : "",
          action: typeof body.action === "string" ? body.action : undefined,
        };
        return deps.authService.issueMigrationChallenge(request, ctx.principal, ctx.ip);
      },
    },
    {
      operationId: "auth.migrate.device.claim",
      method: "POST",
      path: "/v1/auth/migrate/device-claim",
      // SEC-SETUP-BOOTSTRAP-001 Slice 5: authenticated dual-read migration of an
      // existing passphrase-owner to a PROVISIONAL device binding. ADDITIVE and
      // reversible: users.password_hash STAYS scrypt$… (the passphrase still
      // works — NO lockout) and the device binding carries ZERO authority. NOT
      // allowUnauthenticatedMutation → the L1 floor refuses the synthetic public
      // principal; the handler enforces owner authority; the auth SERVICE binds
      // the principal to the local owner (the authenticated session IS the
      // proof-of-passphrase-possession) + verifies device PoP before any bind.
      auth: { public: true },
      rateLimitPolicyId: "auth.login",
      async handler(ctx): Promise<FridayAuthMigrateDeviceClaimResponse> {
        assertBoundPrincipalAuthorityForOperation(
          ctx.principal,
          "auth.migrate.device.claim",
          "api",
          { anyOfRoles: ["owner", "admin"], anyOfScopes: ["security.write"] },
        );
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }
        const request: FridayAuthMigrateDeviceClaimRequest = {
          nonce: typeof body.nonce === "string" ? body.nonce : "",
          devicePublicKey: typeof body.devicePublicKey === "string" ? body.devicePublicKey : "",
          deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
          origin: typeof body.origin === "string" ? body.origin : "",
          installId: typeof body.installId === "string" ? body.installId : "",
          osUser: typeof body.osUser === "string" ? body.osUser : "",
          deviceClaimProof: body.deviceClaimProof as FridayAuthMigrateDeviceClaimRequest["deviceClaimProof"],
        };
        return deps.authService.migrateOwnerToDeviceKey(request, ctx.principal, ctx.ip);
      },
    },
    {
      operationId: "auth.migrate.device.readback",
      method: "POST",
      path: "/v1/auth/migrate/device-readback",
      // SEC-SETUP-BOOTSTRAP-001 FIXED-order Stage 3+4: activate a PROVISIONAL
      // device binding after a FRESH device proof-of-possession. ADDITIVE,
      // migration-free, fail-closed and reversible: users.password_hash STAYS
      // scrypt$… (the passphrase still works — NO lockout), the device binding
      // carries ZERO authority, NO install nonce is consumed and NO tombstone is
      // written. Same posture as migrate/device-claim: NOT allowUnauthenticatedMutation
      // → the L1 floor refuses the synthetic public principal; the handler enforces
      // owner authority; the auth SERVICE binds the principal to the local owner and
      // verifies device PoP before the provisional→active compare-and-set.
      auth: { public: true },
      rateLimitPolicyId: "auth.login",
      async handler(ctx): Promise<FridayAuthDeviceReadbackResponse> {
        assertBoundPrincipalAuthorityForOperation(
          ctx.principal,
          "auth.migrate.device.readback",
          "api",
          { anyOfRoles: ["owner", "admin"], anyOfScopes: ["security.write"] },
        );
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }
        const request: FridayAuthDeviceReadbackRequest = {
          nonce: typeof body.nonce === "string" ? body.nonce : "",
          devicePublicKey: typeof body.devicePublicKey === "string" ? body.devicePublicKey : "",
          deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
          origin: typeof body.origin === "string" ? body.origin : "",
          installId: typeof body.installId === "string" ? body.installId : "",
          osUser: typeof body.osUser === "string" ? body.osUser : "",
          deviceClaimProof: body.deviceClaimProof as FridayAuthDeviceReadbackRequest["deviceClaimProof"],
        };
        return deps.authService.confirmDeviceReadback(request, ctx.principal, ctx.ip);
      },
    },
    {
      operationId: "auth.migrate.device.binding.read",
      method: "GET",
      path: "/v1/auth/migrate/device-binding",
      // SEC-SETUP-BOOTSTRAP-001 FIXED-order Stage 4 observability: owner-gated read
      // of the local owner's device-binding posture (active/provisional/revoked/
      // none). Pure read — mutates nothing. public:true, but the handler enforces
      // owner authority (the synthetic public principal is refused with 401), and
      // the auth SERVICE binds the principal to the local owner + is loopback-only.
      auth: { public: true },
      async handler(ctx): Promise<FridayAuthDeviceBindingStateResponse> {
        assertBoundPrincipalAuthorityForOperation(
          ctx.principal,
          "auth.migrate.device.binding.read",
          "api",
          { anyOfRoles: ["owner", "admin"], anyOfScopes: ["security.read"] },
        );
        return deps.authService.getDeviceBindingState(ctx.principal, ctx.ip);
      },
    },
    {
      operationId: "auth.login",
      method: "POST",
      path: "/v1/auth/login",
      // Pre-auth surface: a user without a valid bearer cannot satisfy the
      // public-mutation gate by definition (they call /v1/auth/login to GET a
      // bearer). authService.login validates email/password or localPassphrase
      // and throws INVALID_CREDENTIALS without minting a session. Negative test:
      // test/unit/api/http/routes/friday-auth-routes.test.ts (login rejects bad
      // credentials without minting a session).
      auth: { public: true, allowUnauthenticatedMutation: true },
      rateLimitPolicyId: "auth.login",
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body !== "object") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "Request body is required",
            { httpStatus: 400 },
          );
        }
        const request: FridayLoginRequest = {
          email: typeof body.email === "string" ? body.email.trim() : undefined,
          password: typeof body.password === "string" ? body.password : undefined,
          localPassphrase: typeof body.localPassphrase === "string" ? body.localPassphrase : undefined,
          rememberMe: typeof body.rememberMe === "boolean" ? body.rememberMe : undefined,
          // SEC-SETUP-BOOTSTRAP-001 (CR-1): device-key login fields. The presence
          // of deviceLoginProof selects the device path in authService.login; the
          // auth SERVICE defensively validates the untrusted proof envelope and
          // fails closed on anything malformed (and requires device-owner authority
          // to be enabled before minting a session).
          devicePublicKey: typeof body.devicePublicKey === "string" ? body.devicePublicKey : undefined,
          deviceId: typeof body.deviceId === "string" ? body.deviceId : undefined,
          origin: typeof body.origin === "string" ? body.origin : undefined,
          deviceLoginProof: body.deviceLoginProof as FridayLoginRequest["deviceLoginProof"],
        };
        return deps.authService.login(request, ctx.ip, ctx.userAgent);
      },
    },
    {
      operationId: "auth.refresh",
      method: "POST",
      path: "/v1/auth/refresh",
      // Pre-auth surface: refresh exchanges a refreshToken for a new access
      // token; callers typically do not hold a valid access token bearer.
      // authService.refresh validates the refresh token and throws
      // INVALID_REFRESH_TOKEN without issuing a new access token. Negative test:
      // test/unit/api/http/routes/friday-auth-routes.test.ts (refresh rejects
      // an invalid refresh token without minting a new access token).
      auth: { public: true, allowUnauthenticatedMutation: true },
      rateLimitPolicyId: "auth.refresh",
      async handler(ctx) {
        const body = ctx.body as Record<string, unknown> | null;
        if (!body || typeof body.refreshToken !== "string" || body.refreshToken.trim() === "") {
          throw new FridayDomainError(
            "VALIDATION_ERROR",
            "refreshToken is required and must be a non-empty string",
            { httpStatus: 400 },
          );
        }
        return deps.authService.refresh({ refreshToken: body.refreshToken as string });
      },
    },
    {
      operationId: "auth.logout",
      method: "POST",
      path: "/v1/auth/logout",
      auth: { public: true },
      rateLimitPolicyId: "auth.logout",
      async handler(ctx) {
        return deps.authService.logout(ctx.body as FridayLogoutRequest, ctx.principal!);
      },
    },
    {
      operationId: "auth.me",
      method: "GET",
      path: "/v1/auth/me",
      auth: { public: true },
      async handler(ctx): Promise<FridayAuthMeResponse> {
        const principal = ctx.principal!;
        // Auth-boundary product invariant: no-login is the default. When the
        // request had no Authorization header (or an invalid one), the HTTP
        // server injected the synthetic public:default principal. /v1/auth/me
        // returns a stable synthetic public-user response so no-login callers
        // never hit a USER_NOT_FOUND envelope on this route. Real authenticated
        // callers (those who supplied a valid Bearer token that the middleware
        // hydrated into a real principal) fall through to authService.me() and
        // get their actual user.
        if (principal.principalId === FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID) {
          return {
            user: {
              id: FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID,
              displayName: FRIDAY_DEFAULT_PUBLIC_HTTP_DISPLAY_NAME,
              role: principal.role ?? "admin",
            },
            scopes: principal.scopes,
          };
        }
        return deps.authService.me(principal);
      },
    },
  ];
}
