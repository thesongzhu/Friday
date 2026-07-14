import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayAuthBootstrapChallengeRequest,
  FridayAuthBootstrapChallengeResponse,
  FridayAuthBootstrapRequest,
  FridayAuthBootstrapResponse,
  FridayAuthBootstrapStatusResponse,
  FridayAuthDeviceClaimRequest,
  FridayAuthDeviceClaimResponse,
  FridayAuthMeResponse,
  FridayLoginRequest,
  FridayLogoutRequest,
  FridayRefreshRequest,
} from "../../model/friday-api-auth.types.js";
import type { FridayAuthService } from "../../auth/friday-auth-service.types.js";
import {
  FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID,
  FRIDAY_DEFAULT_PUBLIC_HTTP_USER_ID,
} from "../friday-default-public-principal.js";
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
      // SEC-SETUP-BOOTSTRAP-001: first-boot device-claim leg. Mints a single-use
      // install nonce. Loopback-only + first-boot gates are enforced in
      // authService.issueBootstrapChallenge before any side effect (same posture
      // as auth.bootstrap.local.passphrase). Only the nonce HASH is persisted.
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
        };
        return deps.authService.claimOwnerWithDeviceKey(request, ctx.ip);
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
