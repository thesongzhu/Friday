import type { FridayHttpContext } from "../model/friday-api-common.types.js";
import type {
  FridayRateLimitPolicyId,
  FridayRole,
  FridayScope,
} from "../model/friday-api-auth.types.js";
import { FRIDAY_API_ERROR_CODES } from "../model/friday-api-error-codes.js";
import { FridayTokenValidationError } from "./friday-token-validator.js";
import type { FridayTokenValidator } from "./friday-token-validator.js";
import { principalHasAnyRole, principalHasAnyScope } from "./friday-rbac-policy.js";
import type { FridayRateLimitService } from "./friday-rate-limit-service.types.js";

// ─── Middleware result types ───

export interface FridayMiddlewareResult {
  passed: true;
  headers?: Record<string, string>;
}

export interface FridayMiddlewareRejection {
  passed: false;
  statusCode: number;
  code: string;
  message: string;
  retryAfterMs?: number;
  headers?: Record<string, string>;
}

export type FridayMiddlewareOutcome = FridayMiddlewareResult | FridayMiddlewareRejection;

// ─── Middleware factory interface ───

export interface FridayAuthMiddlewareFactory {
  requireAuth(ctx: FridayHttpContext<unknown, unknown, unknown>): FridayMiddlewareOutcome;
  requireAnyScope(
    ctx: FridayHttpContext<unknown, unknown, unknown>,
    scopes: FridayScope[],
  ): FridayMiddlewareOutcome;
  requireAnyRole(
    ctx: FridayHttpContext<unknown, unknown, unknown>,
    roles: FridayRole[],
  ): FridayMiddlewareOutcome;
  enforceRateLimit(
    ctx: FridayHttpContext<unknown, unknown, unknown>,
    policyId: FridayRateLimitPolicyId,
  ): FridayMiddlewareOutcome;
}

export interface CreateFridayAuthMiddlewareFactoryDeps {
  tokenValidator: FridayTokenValidator;
  rateLimitService: FridayRateLimitService;
}

// ─── Helpers ───

function extractBearerToken(headers: Record<string, string | undefined>): string | undefined {
  const authHeader = headers["authorization"] ?? headers["Authorization"];
  if (!authHeader) return undefined;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return undefined;
  return parts[1];
}

function getRateLimitKey(
  ctx: FridayHttpContext<unknown, unknown, unknown>,
  keyBy: "ip" | "principal" | "principal+route" | "session",
  operationId?: string,
): string {
  switch (keyBy) {
    case "ip":
      return ctx.ip ?? "unknown";
    case "principal":
      return ctx.principal?.principalId ?? ctx.ip ?? "unknown";
    case "principal+route":
      return `${ctx.principal?.principalId ?? ctx.ip ?? "unknown"}:${operationId ?? ""}`;
    case "session":
      return ctx.principal?.sessionId ?? ctx.principal?.principalId ?? ctx.ip ?? "unknown";
    default:
      return ctx.principal?.principalId ?? ctx.ip ?? "unknown";
  }
}

// ─── Factory ───

export function createFridayAuthMiddlewareFactory(
  deps: CreateFridayAuthMiddlewareFactoryDeps,
): FridayAuthMiddlewareFactory {
  return {
    requireAuth(ctx) {
      if (ctx.principal) {
        return { passed: true };
      }

      const token = extractBearerToken(ctx.headers);
      if (!token) {
        return {
          passed: false,
          statusCode: 401,
          code: FRIDAY_API_ERROR_CODES.UNAUTHORIZED,
          message: "Authentication required",
        };
      }

      try {
        const validated = deps.tokenValidator.validate(token);
        ctx.principal = validated.principal;
        return { passed: true };
      } catch (err) {
        if (err instanceof FridayTokenValidationError) {
          return {
            passed: false,
            statusCode: 401,
            code: err.code,
            message: err.message,
          };
        }
        return {
          passed: false,
          statusCode: 401,
          code: FRIDAY_API_ERROR_CODES.UNAUTHORIZED,
          message: "Authentication failed",
        };
      }
    },

    requireAnyScope(ctx, scopes) {
      const authResult = this.requireAuth(ctx);
      if (!authResult.passed) return authResult;

      if (!ctx.principal || !principalHasAnyScope(ctx.principal.scopes, scopes)) {
        return {
          passed: false,
          statusCode: 403,
          code: FRIDAY_API_ERROR_CODES.FORBIDDEN,
          message: `Requires one of scopes: ${scopes.join(", ")}`,
        };
      }

      return { passed: true };
    },

    requireAnyRole(ctx, roles) {
      const authResult = this.requireAuth(ctx);
      if (!authResult.passed) return authResult;

      if (!ctx.principal || !principalHasAnyRole(ctx.principal.role, roles)) {
        return {
          passed: false,
          statusCode: 403,
          code: FRIDAY_API_ERROR_CODES.FORBIDDEN,
          message: `Requires one of roles: ${roles.join(", ")}`,
        };
      }

      return { passed: true };
    },

    enforceRateLimit(ctx, policyId) {
      const policy = deps.rateLimitService.getPolicy(policyId);
      const keyBy = policy?.keyBy ?? "principal";
      const key = getRateLimitKey(ctx, keyBy);
      const decision = deps.rateLimitService.increment(policyId, key);

      const rateLimitHeaders: Record<string, string> = {
        "X-RateLimit-Limit": String(decision.limit),
        "X-RateLimit-Remaining": String(decision.remaining),
        "X-RateLimit-Reset": decision.resetAt,
      };

      if (!decision.allowed) {
        return {
          passed: false,
          statusCode: 429,
          code: FRIDAY_API_ERROR_CODES.RATE_LIMITED,
          message: `Rate limit exceeded for policy ${policyId}`,
          retryAfterMs: new Date(decision.resetAt).getTime() - Date.now(),
          headers: rateLimitHeaders,
        };
      }

      return { passed: true, headers: rateLimitHeaders };
    },
  };
}
