import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayAuthBootstrapRequest,
  FridayAuthBootstrapResponse,
  FridayAuthBootstrapStatusResponse,
  FridayLoginRequest,
  FridayLogoutRequest,
  FridayRefreshRequest,
} from "../../model/friday-api-auth.types.js";
import type { FridayAuthService } from "../../auth/friday-auth-service.types.js";
import { FridayDomainError } from "#errors";

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
      auth: { public: true },
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
      operationId: "auth.login",
      method: "POST",
      path: "/v1/auth/login",
      auth: { public: true },
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
        return deps.authService.login(body as unknown as FridayLoginRequest, ctx.ip, ctx.userAgent);
      },
    },
    {
      operationId: "auth.refresh",
      method: "POST",
      path: "/v1/auth/refresh",
      auth: { public: true },
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
      auth: { public: false, anyOfScopes: ["session.write"] },
      rateLimitPolicyId: "auth.logout",
      async handler(ctx) {
        return deps.authService.logout(ctx.body as FridayLogoutRequest, ctx.principal!);
      },
    },
    {
      operationId: "auth.me",
      method: "GET",
      path: "/v1/auth/me",
      auth: { public: false, anyOfScopes: ["session.read"] },
      async handler(ctx) {
        return deps.authService.me(ctx.principal!);
      },
    },
  ];
}
