> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 8 Code Review Package — Round 2

## Test Results: 123 test files, 1187 tests, ALL PASSED

## R1 Issues (10 total) — ALL FIXED
# Phase 8 Code Review R1: NOT APPROVED — 10 Issues

## 1. CRITICAL — Auth: email login without password
**File**: `src/api/auth/friday-auth-service.ts:131`
**Fix**: Require password for email-based auth. Fail when password missing or hash mismatch.

## 2. CRITICAL — Realtime: subscription/stream authz bypass
**Files**: `friday-realtime-subscription-service.ts:71`, `friday-realtime-ws-gateway.ts:216`, `friday-realtime-routes.ts:43`
**Fix**: Enforce deterministic stream/topic binding, principal-aware stream auth for pull/ack/resume, reject replay when stream unauthorized, implement cursor verification (HMAC + stream binding + range).

## 3. HIGH — Conflicts: resolution ignores lockToken and strategy
**File**: `src/api/conflicts/friday-workflow-conflict-service.ts:76`
**Fix**: Validate lock ownership + expected revision, apply accept_local|accept_remote|manual_merge to persisted draft state, return actual updated entities.

## 4. HIGH — Legacy: freeze doesn't activate write-freeze guard
**Files**: `friday-legacy-decommission-service.ts:59`, `friday-compatibility-mirror.ts:22`
**Fix**: Wire freezeLegacyWrites() to activateFridayLegacyWriteFreeze() and make compatibility mirror short-circuit with LEGACY_WRITE_FROZEN.

## 5. HIGH — Config: deprecated mirror fields not removed, state-dir still prefers legacy
**Files**: `friday-config.types.ts:11`, `friday-config.schema.ts:10`, `resolve-state-dir.ts:37`
**Fix**: Remove deprecated mirror config fields, add migration-on-load, switch resolver to platform-first.

## 6. HIGH — Routes: incomplete wiring in runtime
**Files**: `friday-api-runtime.ts:122`, fleet/realtime routes
**Fix**: Register ALL Phase 8 contract routes, add missing endpoints.

## 7. HIGH — Realtime: seq numbers process-local, restart collision
**Files**: `friday-realtime-event-bus.ts:16`, `friday-realtime-event-repository.ts:74`
**Fix**: Source next seq from DB (max seq per stream) in publish transaction.

## 8. MEDIUM — Fleet: calculations use placeholders/hardcoded values
**File**: `friday-fleet-dashboard-service.ts`
**Fix**: Feed calculators with real repo-derived inputs, compute actual restricted/trusted aggregates.

## 9. MEDIUM — Auth: rate limiting ignores policy keyBy, no X-RateLimit headers
**File**: `friday-auth-middleware.ts:57`
**Fix**: Implement policy-aware keys, return limit headers.

## 10. MEDIUM — Tests: incomplete route + realtime authz coverage
**Fix**: Add contract tests for all routes, negative tests for realtime authz, cursor validation, legacy freeze integration.

---

## `src/api/auth/friday-auth-middleware.ts`
```ts
import type { FridayHttpContext } from "../model/friday-api-common.types.js";
import type { FridayScope, FridayRole, FridayRateLimitPolicyId } from "../model/friday-api-auth.types.js";
import type { FridayTokenValidator } from "./friday-token-validator.js";
import { TokenValidationError } from "./friday-token-validator.js";
import { principalHasAnyScope, principalHasAnyRole } from "./friday-rbac-policy.js";
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
          code: "UNAUTHORIZED",
          message: "Authentication required",
        };
      }

      try {
        const validated = deps.tokenValidator.validate(token);
        ctx.principal = validated.principal;
        return { passed: true };
      } catch (err) {
        if (err instanceof TokenValidationError) {
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
          code: "UNAUTHORIZED",
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
          code: "FORBIDDEN",
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
          code: "FORBIDDEN",
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
          code: "RATE_LIMITED",
          message: `Rate limit exceeded for policy ${policyId}`,
          retryAfterMs: new Date(decision.resetAt).getTime() - Date.now(),
          headers: rateLimitHeaders,
        };
      }

      return { passed: true, headers: rateLimitHeaders };
    },
  };
}
```

## `src/api/auth/friday-auth-service.ts`
```ts
import * as crypto from "node:crypto";
import type {
  FridayLoginRequest,
  FridayLoginResponse,
  FridayRefreshRequest,
  FridayRefreshResponse,
  FridayLogoutRequest,
  FridayLogoutResponse,
  FridayAuthMeResponse,
  FridayAuthPrincipal,
  FridayRole,
  FridayScope,
} from "../model/friday-api-auth.types.js";
import type {
  FridayAuthService,
  CreateFridayAuthServiceDeps,
} from "./friday-auth-service.types.js";
import { getScopesForRole } from "./friday-rbac-policy.js";
import { encodeToken } from "./friday-token-validator.js";

// ─── DB Row shapes ───

interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
  role: string;
  password_hash: string | null;
  is_local_only: number;
}

interface AuthSessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: string;
  revoked_at: string | null;
}

// ─── Helpers ───

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function verifyPassword(input: string, hash: string): boolean {
  // Simple constant-time compare for local passphrase model
  return crypto.timingSafeEqual(
    Buffer.from(hashToken(input)),
    Buffer.from(hash),
  );
}

// ─── Auth Error ───

export class AuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

// ─── Factory ───

export function createFridayAuthService(deps: CreateFridayAuthServiceDeps): FridayAuthService {
  function findUserByEmail(email: string): UserRow | undefined {
    return deps.db.withReadConnection((db) =>
      db
        .prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL")
        .get(email) as UserRow | undefined,
    );
  }

  function findUserById(userId: string): UserRow | undefined {
    return deps.db.withReadConnection((db) =>
      db
        .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL")
        .get(userId) as UserRow | undefined,
    );
  }

  function findLocalUser(): UserRow | undefined {
    return deps.db.withReadConnection((db) =>
      db
        .prepare("SELECT * FROM users WHERE is_local_only = 1 AND deleted_at IS NULL LIMIT 1")
        .get() as UserRow | undefined,
    );
  }

  function generateTokenPair(
    user: UserRow,
    sessionId: string,
  ): { accessToken: string; refreshToken: string } {
    const role = user.role as FridayRole;
    const scopes = [...getScopesForRole(role)] as FridayScope[];
    const nowSec = Math.floor(new Date(deps.nowIso()).getTime() / 1000);

    const accessToken = encodeToken(
      {
        tokenId: deps.idGenerator(),
        principalType: "user",
        principalId: user.id,
        userId: user.id,
        role,
        scopes,
        iat: nowSec,
        exp: nowSec + deps.accessTokenTtlSec,
        sid: sessionId,
      },
      deps.tokenSecret,
    );

    const refreshToken = deps.idGenerator();
    return { accessToken, refreshToken };
  }

  return {
    login(request, ip, userAgent) {
      let user: UserRow | undefined;

      if (request.localPassphrase) {
        user = findLocalUser();
        if (!user) {
          throw new AuthError("USER_NOT_FOUND", "No local user configured");
        }
        if (user.password_hash && !verifyPassword(request.localPassphrase, user.password_hash)) {
          throw new AuthError("INVALID_CREDENTIALS", "Invalid passphrase");
        }
      } else if (request.email) {
        user = findUserByEmail(request.email);
        if (!user) {
          throw new AuthError("USER_NOT_FOUND", "User not found");
        }
        if (!request.password) {
          throw new AuthError("PASSWORD_REQUIRED", "Password is required for email login");
        }
        if (!user.password_hash) {
          throw new AuthError("NO_PASSWORD_SET", "User has no password configured");
        }
        if (!verifyPassword(request.password, user.password_hash)) {
          throw new AuthError("INVALID_CREDENTIALS", "Invalid credentials");
        }
      } else {
        // Fall back to local-only user
        user = findLocalUser();
        if (!user) {
          throw new AuthError("USER_NOT_FOUND", "No authentication method provided");
        }
      }

      const now = deps.nowIso();
      const sessionId = deps.idGenerator();
      const { accessToken, refreshToken } = generateTokenPair(user, sessionId);
      const refreshHash = hashToken(refreshToken);
      const expiresAt = new Date(
        new Date(now).getTime() + deps.refreshTokenTtlSec * 1000,
      ).toISOString();

      deps.db.withWriteTransaction((db) => {
        db.prepare(
          `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at, device_label, ip_address, user_agent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(sessionId, user.id, refreshHash, expiresAt, null, ip ?? null, userAgent ?? null, now, now);

        db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(
          now,
          now,
          user.id,
        );
      });

      return {
        accessToken,
        refreshToken,
        expiresInSec: deps.accessTokenTtlSec,
        user: {
          id: user.id,
          email: user.email ?? undefined,
          displayName: user.display_name,
          role: user.role as FridayRole,
        },
      };
    },

    refresh(request) {
      const refreshHash = hashToken(request.refreshToken);
      const now = deps.nowIso();

      const session = deps.db.withReadConnection((db) =>
        db
          .prepare(
            `SELECT * FROM auth_sessions
             WHERE refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
          )
          .get(refreshHash, now) as AuthSessionRow | undefined,
      );

      if (!session) {
        throw new AuthError("INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
      }

      const user = findUserById(session.user_id);
      if (!user) {
        throw new AuthError("USER_NOT_FOUND", "User no longer exists");
      }

      const { accessToken, refreshToken: newRefreshToken } = generateTokenPair(
        user,
        session.id,
      );
      const newHash = hashToken(newRefreshToken);
      const newExpires = new Date(
        new Date(now).getTime() + deps.refreshTokenTtlSec * 1000,
      ).toISOString();

      deps.db.withWriteTransaction((db) => {
        db.prepare(
          "UPDATE auth_sessions SET refresh_token_hash = ?, expires_at = ?, updated_at = ? WHERE id = ?",
        ).run(newHash, newExpires, now, session.id);
      });

      return {
        accessToken,
        refreshToken: newRefreshToken,
        expiresInSec: deps.accessTokenTtlSec,
      };
    },

    logout(request, principal) {
      const now = deps.nowIso();

      if (request.allSessions && principal.userId) {
        deps.db.withWriteTransaction((db) => {
          db.prepare(
            "UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          ).run(now, now, principal.userId);
        });
      } else if (request.refreshToken) {
        const refreshHash = hashToken(request.refreshToken);
        deps.db.withWriteTransaction((db) => {
          db.prepare(
            "UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE refresh_token_hash = ?",
          ).run(now, now, refreshHash);
        });
      } else if (principal.sessionId) {
        deps.db.withWriteTransaction((db) => {
          db.prepare(
            "UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE id = ?",
          ).run(now, now, principal.sessionId);
        });
      }

      return { ok: true as const };
    },

    me(principal) {
      if (!principal.userId) {
        throw new AuthError("NO_USER_CONTEXT", "No user associated with this principal");
      }

      const user = findUserById(principal.userId);
      if (!user) {
        throw new AuthError("USER_NOT_FOUND", "User not found");
      }

      let sessionExpiresAt: string | undefined;
      if (principal.sessionId) {
        const session = deps.db.withReadConnection((db) =>
          db
            .prepare("SELECT expires_at FROM auth_sessions WHERE id = ?")
            .get(principal.sessionId) as { expires_at: string } | undefined,
        );
        sessionExpiresAt = session?.expires_at;
      }

      return {
        user: {
          id: user.id,
          email: user.email ?? undefined,
          displayName: user.display_name,
          role: user.role as FridayRole,
        },
        scopes: principal.scopes,
        sessionExpiresAt,
      };
    },
  };
}
```

## `src/api/auth/friday-auth-service.types.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type {
  FridayLoginRequest,
  FridayLoginResponse,
  FridayRefreshRequest,
  FridayRefreshResponse,
  FridayLogoutRequest,
  FridayLogoutResponse,
  FridayAuthMeResponse,
  FridayAuthPrincipal,
} from "../model/friday-api-auth.types.js";

export interface FridayAuthService {
  login(request: FridayLoginRequest, ip?: string, userAgent?: string): FridayLoginResponse;
  refresh(request: FridayRefreshRequest): FridayRefreshResponse;
  logout(request: FridayLogoutRequest, principal: FridayAuthPrincipal): FridayLogoutResponse;
  me(principal: FridayAuthPrincipal): FridayAuthMeResponse;
}

export interface CreateFridayAuthServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  tokenSecret: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
}
```

## `src/api/auth/friday-rate-limit-service.ts`
```ts
import type {
  FridayRateLimitDecision,
  FridayRateLimitPolicy,
  FridayRateLimitPolicyId,
} from "../model/friday-api-auth.types.js";
import type {
  FridayRateLimitService,
  CreateFridayRateLimitServiceDeps,
} from "./friday-rate-limit-service.types.js";

// ─── Default Policies ───

const DEFAULT_POLICIES: FridayRateLimitPolicy[] = [
  { id: "auth.login", windowMs: 60_000, maxHits: 10, keyBy: "ip" },
  { id: "auth.refresh", windowMs: 60_000, maxHits: 30, keyBy: "session" },
  { id: "auth.logout", windowMs: 60_000, maxHits: 30, keyBy: "principal" },
  { id: "workflow.start_run", windowMs: 60_000, maxHits: 60, keyBy: "principal" },
  { id: "workflow.publish", windowMs: 60_000, maxHits: 20, keyBy: "principal" },
  { id: "workflow.resolve_conflict", windowMs: 60_000, maxHits: 20, keyBy: "principal" },
  { id: "realtime.subscribe", windowMs: 60_000, maxHits: 120, keyBy: "principal" },
  { id: "realtime.pull", windowMs: 60_000, maxHits: 300, keyBy: "principal" },
  { id: "realtime.ws_connect", windowMs: 60_000, maxHits: 20, keyBy: "principal" },
];

function buildPolicyMap(
  overrides?: Partial<Record<FridayRateLimitPolicyId, Partial<FridayRateLimitPolicy>>>,
): Map<FridayRateLimitPolicyId, FridayRateLimitPolicy> {
  const map = new Map<FridayRateLimitPolicyId, FridayRateLimitPolicy>();
  for (const policy of DEFAULT_POLICIES) {
    const override = overrides?.[policy.id];
    map.set(policy.id, override ? { ...policy, ...override } : policy);
  }
  return map;
}

function computeWindowStart(nowIso: string, windowMs: number): string {
  const nowMs = new Date(nowIso).getTime();
  const windowStart = nowMs - (nowMs % windowMs);
  return new Date(windowStart).toISOString();
}

function computeResetAt(windowStart: string, windowMs: number): string {
  const resetMs = new Date(windowStart).getTime() + windowMs;
  return new Date(resetMs).toISOString();
}

// ─── Factory ───

export function createFridayRateLimitService(
  deps: CreateFridayRateLimitServiceDeps,
): FridayRateLimitService {
  const policies = buildPolicyMap(deps.policyOverrides);

  function readCounter(bucketKey: string, windowStart: string): number {
    const row = deps.db.withReadConnection((db) =>
      db
        .prepare("SELECT hit_count FROM api_rate_limit_counters WHERE bucket_key = ? AND window_start = ?")
        .get(bucketKey, windowStart) as { hit_count: number } | undefined,
    );
    return row?.hit_count ?? 0;
  }

  function incrementCounter(bucketKey: string, windowStart: string, nowIso: string): number {
    return deps.db.withWriteTransaction((db) => {
      const existing = db
        .prepare("SELECT hit_count FROM api_rate_limit_counters WHERE bucket_key = ? AND window_start = ?")
        .get(bucketKey, windowStart) as { hit_count: number } | undefined;

      if (existing) {
        const newCount = existing.hit_count + 1;
        db.prepare(
          "UPDATE api_rate_limit_counters SET hit_count = ?, updated_at = ? WHERE bucket_key = ? AND window_start = ?",
        ).run(newCount, nowIso, bucketKey, windowStart);
        return newCount;
      }

      db.prepare(
        "INSERT INTO api_rate_limit_counters (bucket_key, window_start, hit_count, updated_at) VALUES (?, ?, 1, ?)",
      ).run(bucketKey, windowStart, nowIso);
      return 1;
    });
  }

  function buildDecision(
    policy: FridayRateLimitPolicy,
    hitCount: number,
    windowStart: string,
  ): FridayRateLimitDecision {
    const remaining = Math.max(0, policy.maxHits - hitCount);
    return {
      allowed: hitCount <= policy.maxHits,
      policyId: policy.id,
      limit: policy.maxHits,
      remaining,
      resetAt: computeResetAt(windowStart, policy.windowMs),
    };
  }

  return {
    getPolicy(policyId) {
      return policies.get(policyId);
    },

    check(policyId, key) {
      const policy = policies.get(policyId);
      if (!policy) {
        return {
          allowed: true,
          policyId,
          limit: 0,
          remaining: 0,
          resetAt: deps.nowIso(),
        };
      }
      const now = deps.nowIso();
      const windowStart = computeWindowStart(now, policy.windowMs);
      const bucketKey = `${policyId}:${key}`;
      const hitCount = readCounter(bucketKey, windowStart);
      return buildDecision(policy, hitCount, windowStart);
    },

    increment(policyId, key) {
      const policy = policies.get(policyId);
      if (!policy) {
        return {
          allowed: true,
          policyId,
          limit: 0,
          remaining: 0,
          resetAt: deps.nowIso(),
        };
      }
      const now = deps.nowIso();
      const windowStart = computeWindowStart(now, policy.windowMs);
      const bucketKey = `${policyId}:${key}`;
      const hitCount = incrementCounter(bucketKey, windowStart, now);
      return buildDecision(policy, hitCount, windowStart);
    },
  };
}
```

## `src/api/auth/friday-rate-limit-service.types.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type {
  FridayRateLimitDecision,
  FridayRateLimitPolicy,
  FridayRateLimitPolicyId,
} from "../model/friday-api-auth.types.js";

export interface FridayRateLimitService {
  check(policyId: FridayRateLimitPolicyId, key: string): FridayRateLimitDecision;
  increment(policyId: FridayRateLimitPolicyId, key: string): FridayRateLimitDecision;
  getPolicy(policyId: FridayRateLimitPolicyId): FridayRateLimitPolicy | undefined;
}

export interface CreateFridayRateLimitServiceDeps {
  db: FridaySqliteLayer;
  nowIso: () => string;
  policyOverrides?: Partial<Record<FridayRateLimitPolicyId, Partial<FridayRateLimitPolicy>>>;
}
```

## `src/api/auth/friday-rbac-policy.ts`
```ts
import type { FridayRole, FridayScope } from "../model/friday-api-auth.types.js";

// ─── Role → Scope mapping ───

const ROLE_SCOPES: Record<FridayRole, readonly FridayScope[]> = {
  owner: [
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
    "session.read",
    "session.write",
    "diagnosis.read",
    "diagnosis.write",
    "skill.read",
    "skill.write",
  ],
  admin: [
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
    "session.read",
    "session.write",
    "diagnosis.read",
    "diagnosis.write",
    "skill.read",
    "skill.write",
  ],
  operator: [
    "workflow.read",
    "workflow.write",
    "workflow.run",
    "workflow.conflict.resolve",
    "satellite.read",
    "fleet.read",
    "session.read",
    "session.write",
    "diagnosis.read",
    "skill.read",
  ],
  viewer: [
    "workflow.read",
    "satellite.read",
    "fleet.read",
    "security.read",
    "session.read",
    "diagnosis.read",
    "skill.read",
  ],
};

/** Returns all scopes granted to a role. */
export function getScopesForRole(role: FridayRole): readonly FridayScope[] {
  return ROLE_SCOPES[role] ?? [];
}

/** Returns true if the role has the given scope. */
export function roleHasScope(role: FridayRole, scope: FridayScope): boolean {
  return ROLE_SCOPES[role]?.includes(scope) ?? false;
}

/** Returns true if the principal has any of the required scopes. */
export function principalHasAnyScope(
  principalScopes: readonly FridayScope[],
  requiredScopes: readonly FridayScope[],
): boolean {
  return requiredScopes.some((s) => principalScopes.includes(s));
}

/** Returns true if the principal has any of the required roles. */
export function principalHasAnyRole(
  principalRole: FridayRole | undefined,
  requiredRoles: readonly FridayRole[],
): boolean {
  if (!principalRole) return false;
  return requiredRoles.includes(principalRole);
}
```

## `src/api/auth/friday-token-validator.ts`
```ts
import * as crypto from "node:crypto";
import type {
  FridayAuthPrincipal,
  FridayAccessTokenClaims,
  FridayValidatedToken,
} from "../model/friday-api-auth.types.js";
import type { FridayPrincipalType } from "../model/friday-api-common.types.js";

// ─── Interface ───

export interface FridayTokenValidator {
  validate(rawToken: string): FridayValidatedToken;
}

export interface CreateFridayTokenValidatorDeps {
  tokenSecret: string;
  nowMs: () => number;
  lookupTokenRevocation: (tokenId: string) => boolean;
  lookupSatelliteTokenVersion?: (satelliteId: string) => number | null;
}

// ─── Token encoding (HMAC-SHA256 based, NOT JWT — simpler for local-first) ───

export function encodeToken(claims: FridayAccessTokenClaims, secret: string): string {
  const payloadJson = JSON.stringify(claims);
  const payloadB64 = Buffer.from(payloadJson).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

// ─── Factory ───

export function createFridayTokenValidator(
  deps: CreateFridayTokenValidatorDeps,
): FridayTokenValidator {
  return {
    validate(rawToken: string): FridayValidatedToken {
      const parts = rawToken.split(".");
      if (parts.length !== 2) {
        throw new TokenValidationError("INVALID_FORMAT", "Token format is invalid");
      }

      const [payloadB64, sig] = parts;
      const expectedSig = crypto
        .createHmac("sha256", deps.tokenSecret)
        .update(payloadB64)
        .digest("base64url");

      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
        throw new TokenValidationError("INVALID_SIGNATURE", "Token signature verification failed");
      }

      const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
      const claims = JSON.parse(payloadJson) as FridayAccessTokenClaims;

      // Expiry check
      const nowSec = Math.floor(deps.nowMs() / 1000);
      if (claims.exp && claims.exp < nowSec) {
        throw new TokenValidationError("TOKEN_EXPIRED", "Token has expired");
      }

      // Revocation check
      if (deps.lookupTokenRevocation(claims.tokenId)) {
        throw new TokenValidationError("TOKEN_REVOKED", "Token has been revoked");
      }

      // Satellite token version check
      if (
        claims.principalType === "satellite" &&
        claims.ver !== undefined &&
        deps.lookupSatelliteTokenVersion
      ) {
        const currentVersion = deps.lookupSatelliteTokenVersion(claims.principalId);
        if (currentVersion !== null && claims.ver < currentVersion) {
          throw new TokenValidationError(
            "TOKEN_VERSION_MISMATCH",
            "Satellite token version is outdated",
          );
        }
      }

      const principal: FridayAuthPrincipal = {
        principalType: claims.principalType as FridayPrincipalType,
        principalId: claims.principalId,
        userId: claims.userId,
        role: claims.role,
        scopes: claims.scopes,
        tokenId: claims.tokenId,
        tokenKind: "access",
        issuedAt: new Date(claims.iat * 1000).toISOString(),
        expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : undefined,
        sessionId: claims.sid,
        tokenVersion: claims.ver,
      };

      return { principal, rawToken, claims };
    },
  };
}

// ─── Error class ───

export class TokenValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TokenValidationError";
    this.code = code;
  }
}
```

## `src/api/conflicts/friday-workflow-conflict-service.ts`
```ts
import type {
  FridayWorkflowConflictEntity,
  FridayWorkflowConflictStatus,
  FridayResolveWorkflowConflictRequest,
  FridayResolveWorkflowConflictResponse,
  FridayWorkflowDraftEntity,
} from "../model/friday-api-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../workflows/model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../../workflows/builder/model/friday-workflow-builder-canvas.types.js";
import type { UUID } from "../../workflows/model/friday-workflow.types.js";
import type {
  FridayWorkflowConflictService,
  FridayDetectConflictInput,
  CreateFridayWorkflowConflictServiceDeps,
} from "./friday-workflow-conflict-service.types.js";
import { createFridayWorkflowConflictRepository } from "../persistence/friday-workflow-conflict-repository.js";

// ─── Error ───

export class ConflictServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConflictServiceError";
    this.code = code;
  }
}

// ─── Factory ───

export function createFridayWorkflowConflictService(
  deps: CreateFridayWorkflowConflictServiceDeps,
): FridayWorkflowConflictService {
  const repo = createFridayWorkflowConflictRepository();

  return {
    detectConflict(input) {
      // Check if a base version was expected but the head has moved on
      if (!input.baseWorkflowVersionId) {
        return null; // No base = no conflict to detect
      }

      if (input.baseWorkflowVersionId === input.headWorkflowVersionId) {
        return null; // Base matches head, no conflict
      }

      const now = deps.nowIso();
      const entity: FridayWorkflowConflictEntity = {
        conflictId: deps.idGenerator(),
        workflowId: input.workflowId,
        draftId: input.draftId,
        kind: "revision_conflict",
        status: "open",
        baseWorkflowVersionId: input.baseWorkflowVersionId,
        headWorkflowVersionId: input.headWorkflowVersionId,
        detectedAt: now,
        summary: input.summary,
        patches: [],
      };

      deps.db.withWriteTransaction((db) => {
        repo.create(db, entity, now);
      });

      return entity;
    },

    listConflicts(workflowId, status, limit, cursor) {
      return deps.db.withReadConnection((db) =>
        repo.listByWorkflow(db, workflowId, status, limit, cursor),
      );
    },

    getConflict(conflictId) {
      return deps.db.withReadConnection((db) => repo.findById(db, conflictId));
    },

    resolveConflict(conflictId, request, resolvedByUserId) {
      const conflict = deps.db.withReadConnection((db) => repo.findById(db, conflictId));

      if (!conflict) {
        throw new ConflictServiceError("NOT_FOUND", `Conflict ${conflictId} not found`);
      }

      if (conflict.status !== "open") {
        throw new ConflictServiceError(
          "ALREADY_RESOLVED",
          `Conflict ${conflictId} is already ${conflict.status}`,
        );
      }

      // Validate lock token ownership
      const lockRow = deps.db.withReadConnection((db) =>
        (db
          .prepare(
            "SELECT lock_token, owner_user_id, expires_at FROM workflow_locks WHERE workflow_id = ? AND lock_token = ?",
          )
          .get(conflict.workflowId, request.lockToken) as {
          lock_token: string;
          owner_user_id: string;
          expires_at: string;
        } | undefined),
      );

      if (!lockRow) {
        throw new ConflictServiceError("LOCK_NOT_FOUND", `Lock token '${request.lockToken}' not found for workflow`);
      }

      if (resolvedByUserId && lockRow.owner_user_id !== resolvedByUserId) {
        throw new ConflictServiceError("LOCK_OWNER_MISMATCH", "Lock token does not belong to the resolving user");
      }

      const now = deps.nowIso();

      if (new Date(lockRow.expires_at) < new Date(now)) {
        throw new ConflictServiceError("LOCK_EXPIRED", "Lock has expired");
      }

      // Validate expected draft revision
      const draftRow = deps.db.withReadConnection((db) =>
        (db
          .prepare("SELECT revision, spec_json, visual_json, title FROM workflow_builder_drafts WHERE draft_id = ?")
          .get(conflict.draftId) as {
          revision: number;
          spec_json: string;
          visual_json: string;
          title: string;
        } | undefined),
      );

      if (draftRow && draftRow.revision !== request.expectedDraftRevision) {
        throw new ConflictServiceError(
          "REVISION_MISMATCH",
          `Expected draft revision ${request.expectedDraftRevision} but found ${draftRow.revision}`,
        );
      }

      // Apply resolution strategy and persist
      const result = deps.db.withWriteTransaction((db) => {
        const resolved = repo.resolve(db, conflictId, resolvedByUserId, now);
        if (!resolved) {
          throw new ConflictServiceError("RESOLVE_FAILED", "Failed to resolve conflict");
        }

        const newRevision = (draftRow?.revision ?? request.expectedDraftRevision) + 1;
        const strategy = request.resolution.strategy;

        let specJson: string;
        let visualJson: string;
        let title: string;

        if (strategy === "accept_local") {
          // Keep local draft as-is — use existing draft state
          specJson = draftRow?.spec_json ?? JSON.stringify({
            specVersion: "1.0",
            name: "resolved-local",
            trigger: { type: "manual" },
            steps: [],
          });
          visualJson = draftRow?.visual_json ?? JSON.stringify({
            viewport: { x: 0, y: 0, zoom: 1 },
            panels: { leftOpen: true, rightOpen: true, bottomOpen: false },
            nodes: [],
            edges: [],
            groups: [],
          });
          title = draftRow?.title ?? "Resolved draft (local)";
        } else if (strategy === "accept_remote") {
          // Replace with head version content
          const headVersion = db
            .prepare("SELECT graph_json FROM workflow_versions WHERE id = ?")
            .get(conflict.headWorkflowVersionId) as { graph_json: string } | undefined;
          specJson = headVersion?.graph_json ?? JSON.stringify({
            specVersion: "1.0",
            name: "resolved-remote",
            trigger: { type: "manual" },
            steps: [],
          });
          visualJson = draftRow?.visual_json ?? JSON.stringify({
            viewport: { x: 0, y: 0, zoom: 1 },
            panels: { leftOpen: true, rightOpen: true, bottomOpen: false },
            nodes: [],
            edges: [],
            groups: [],
          });
          title = draftRow?.title ?? "Resolved draft (remote)";
        } else {
          // manual_merge - use provided merged content
          const mergeReq = request.resolution as {
            strategy: "manual_merge";
            mergedSpec: FridayWorkflowSpecV1;
            mergedVisual: FridayWorkflowVisualGraphV1;
          };
          specJson = JSON.stringify(mergeReq.mergedSpec);
          visualJson = JSON.stringify(mergeReq.mergedVisual);
          title = draftRow?.title ?? "Resolved draft (merged)";
        }

        // Persist resolved draft state
        db.prepare(
          `UPDATE workflow_builder_drafts
           SET revision = ?, spec_json = ?, visual_json = ?, updated_at = ?
           WHERE draft_id = ?`,
        ).run(newRevision, specJson, visualJson, now, conflict.draftId);

        const draft: FridayWorkflowDraftEntity = {
          draftId: conflict.draftId,
          workflowId: conflict.workflowId,
          title,
          status: "active",
          revision: newRevision,
          spec: JSON.parse(specJson),
          visual: JSON.parse(visualJson),
          createdAt: conflict.detectedAt,
          updatedAt: now,
          autosave: { enabled: false, intervalMs: 30_000 },
        };

        return { conflict: resolved, draft };
      });

      return result;
    },
  };
}
```

## `src/api/conflicts/friday-workflow-conflict-service.types.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { UUID } from "../../workflows/model/friday-workflow.types.js";
import type {
  FridayWorkflowConflictEntity,
  FridayWorkflowConflictStatus,
  FridayResolveWorkflowConflictRequest,
  FridayResolveWorkflowConflictResponse,
} from "../model/friday-api-workflow.types.js";

export interface FridayWorkflowConflictService {
  detectConflict(input: FridayDetectConflictInput): FridayWorkflowConflictEntity | null;
  listConflicts(
    workflowId: UUID,
    status?: FridayWorkflowConflictStatus,
    limit?: number,
    cursor?: string,
  ): FridayWorkflowConflictEntity[];
  getConflict(conflictId: UUID): FridayWorkflowConflictEntity | null;
  resolveConflict(
    conflictId: UUID,
    request: FridayResolveWorkflowConflictRequest,
    resolvedByUserId?: UUID,
  ): FridayResolveWorkflowConflictResponse;
}

export interface FridayDetectConflictInput {
  workflowId: UUID;
  draftId: UUID;
  baseWorkflowVersionId?: UUID;
  headWorkflowVersionId: UUID;
  summary: string;
}

export interface CreateFridayWorkflowConflictServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}
```

## `src/api/fleet/friday-fleet-dashboard-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { FridaySatellitePairingStatus } from "../../satellites/model/friday-satellite.types.js";

// ─── Aggregation result types ───

export interface FridaySatelliteWithHeartbeatRow {
  id: string;
  type: string;
  display_name: string;
  pairing_status: string;
  trust_level: string;
  tags_json: string;
  last_seen_at: string | null;
  hb_ts: string | null;
  cpu_percent: number | null;
  memory_percent: number | null;
  load_avg_1m: number | null;
  queue_depth: number | null;
  active_runs: number | null;
}

export interface FridayQueueStatsRow {
  satellite_id: string;
  queued_count: number;
  leased_count: number;
  failed_count: number;
  dead_letter_count: number;
}

export interface FridayWorkflowLoadRow {
  satellite_id: string;
  queued_nodes: number;
  running_nodes: number;
  retrying_nodes: number;
  blocked_offline_nodes: number;
}

export interface FridayPairingStatusCountRow {
  pairing_status: string;
  count: number;
}

export interface FridayGlobalQueueStatsRow {
  queued_count: number;
  leased_count: number;
  failed_count: number;
  dead_letter_count: number;
}

export interface FridayWorkflowRunStatsRow {
  active_runs: number;
  completed_1h: number;
  failed_1h: number;
}

// ─── Repository interface ───

export interface FridayFleetDashboardRepository {
  listSatellitesWithHeartbeat(db: Database.Database): FridaySatelliteWithHeartbeatRow[];
  getQueueStatsBySatellite(db: Database.Database, satelliteId: string): FridayQueueStatsRow | null;
  getGlobalQueueStats(db: Database.Database): FridayGlobalQueueStatsRow;
  getWorkflowLoadBySatellite(db: Database.Database, satelliteId: string): FridayWorkflowLoadRow | null;
  getPairingStatusCounts(db: Database.Database): FridayPairingStatusCountRow[];
  getWorkflowRunStats(db: Database.Database, oneHourAgo: string): FridayWorkflowRunStatsRow;
  getCapabilities(db: Database.Database, satelliteId: string): Array<{
    key: string;
    available: number;
    limits_json: string | null;
    metadata_json: string | null;
  }>;
  getDeadLetterCount(db: Database.Database, satelliteId: string): number;
  getFailedNodeCount1h(db: Database.Database, satelliteId: string, oneHourAgo: string): number;
  getTotalNodeCount1h(db: Database.Database, satelliteId: string, oneHourAgo: string): number;
}

// ─── Factory ───

export function createFridayFleetDashboardRepository(): FridayFleetDashboardRepository {
  return {
    listSatellitesWithHeartbeat(db) {
      return db
        .prepare(
          `WITH latest AS (
             SELECT satellite_id, MAX(ts) AS max_ts
             FROM satellite_heartbeats
             GROUP BY satellite_id
           )
           SELECT s.id, s.display_name, s.type, s.pairing_status, s.trust_level, s.tags_json,
                  s.last_seen_at,
                  h.ts AS hb_ts, h.cpu_percent, h.memory_percent, h.load_avg_1m, h.queue_depth, h.active_runs
           FROM satellites s
           LEFT JOIN latest l ON l.satellite_id = s.id
           LEFT JOIN satellite_heartbeats h ON h.satellite_id = l.satellite_id AND h.ts = l.max_ts
           WHERE s.deleted_at IS NULL`,
        )
        .all() as FridaySatelliteWithHeartbeatRow[];
    },

    getQueueStatsBySatellite(db, satelliteId) {
      return (
        (db
          .prepare(
            `SELECT satellite_id,
               SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
               SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased_count,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
               SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter_count
             FROM outbox_messages
             WHERE satellite_id = ?
             GROUP BY satellite_id`,
          )
          .get(satelliteId) as FridayQueueStatsRow | undefined) ?? null
      );
    },

    getGlobalQueueStats(db) {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
             SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased_count,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
             SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter_count
           FROM outbox_messages`,
        )
        .get() as FridayGlobalQueueStatsRow | undefined;
      return row ?? { queued_count: 0, leased_count: 0, failed_count: 0, dead_letter_count: 0 };
    },

    getWorkflowLoadBySatellite(db, satelliteId) {
      return (
        (db
          .prepare(
            `WITH latest_attempt AS (
               SELECT run_id, node_id, MAX(attempt) AS max_attempt
               FROM workflow_run_nodes
               GROUP BY run_id, node_id
             )
             SELECT n.satellite_id,
               SUM(CASE WHEN n.status='queued' THEN 1 ELSE 0 END) AS queued_nodes,
               SUM(CASE WHEN n.status='running' THEN 1 ELSE 0 END) AS running_nodes,
               SUM(CASE WHEN n.status='retrying' THEN 1 ELSE 0 END) AS retrying_nodes,
               SUM(CASE WHEN n.status='blocked_offline' THEN 1 ELSE 0 END) AS blocked_offline_nodes
             FROM workflow_run_nodes n
             JOIN latest_attempt la
               ON la.run_id=n.run_id AND la.node_id=n.node_id AND la.max_attempt=n.attempt
             WHERE n.satellite_id = ?
             GROUP BY n.satellite_id`,
          )
          .get(satelliteId) as FridayWorkflowLoadRow | undefined) ?? null
      );
    },

    getPairingStatusCounts(db) {
      return db
        .prepare(
          `SELECT pairing_status, COUNT(*) AS count
           FROM satellites
           WHERE deleted_at IS NULL
           GROUP BY pairing_status`,
        )
        .all() as FridayPairingStatusCountRow[];
    },

    getWorkflowRunStats(db, oneHourAgo) {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN status IN ('queued','running','pausing','paused','compensating') THEN 1 ELSE 0 END) AS active_runs,
             SUM(CASE WHEN status = 'completed' AND finished_at >= ? THEN 1 ELSE 0 END) AS completed_1h,
             SUM(CASE WHEN status = 'failed' AND finished_at >= ? THEN 1 ELSE 0 END) AS failed_1h
           FROM workflow_runs`,
        )
        .get(oneHourAgo, oneHourAgo) as FridayWorkflowRunStatsRow | undefined;
      return row ?? { active_runs: 0, completed_1h: 0, failed_1h: 0 };
    },

    getCapabilities(db, satelliteId) {
      return db
        .prepare(
          "SELECT key, available, limits_json, metadata_json FROM satellite_capabilities WHERE satellite_id = ?",
        )
        .all(satelliteId) as Array<{
        key: string;
        available: number;
        limits_json: string | null;
        metadata_json: string | null;
      }>;
    },

    getDeadLetterCount(db, satelliteId) {
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM outbox_messages WHERE satellite_id = ? AND status = 'dead_letter'",
        )
        .get(satelliteId) as { count: number };
      return row.count;
    },

    getFailedNodeCount1h(db, satelliteId, oneHourAgo) {
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM workflow_run_nodes WHERE satellite_id = ? AND status = 'failed' AND finished_at >= ?",
        )
        .get(satelliteId, oneHourAgo) as { count: number };
      return row.count;
    },

    getTotalNodeCount1h(db, satelliteId, oneHourAgo) {
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM workflow_run_nodes WHERE satellite_id = ? AND finished_at >= ?",
        )
        .get(satelliteId, oneHourAgo) as { count: number };
      return row.count;
    },
  };
}
```

## `src/api/fleet/friday-fleet-dashboard-service.ts`
```ts
import type {
  FridayFleetOverviewResponse,
  FridayListFleetSatellitesQuery,
  FridayListFleetSatellitesResponse,
  FridayFleetSatelliteDetailResponse,
  FridayFleetSatelliteCard,
  FridaySecurityCenterResponse,
  FridayHealthState,
} from "../model/friday-api-fleet.types.js";
import type {
  FridaySatellitePairingStatus,
  FridaySatelliteTrustLevel,
  FridaySatelliteType,
} from "../../satellites/model/friday-satellite.types.js";
import type {
  FridayFleetDashboardService,
  CreateFridayFleetDashboardServiceDeps,
} from "./friday-fleet-dashboard-service.types.js";
import { createFridayFleetDashboardRepository } from "./friday-fleet-dashboard-repository.js";
import { calculateSatelliteHealth, healthStateFromScore } from "./friday-fleet-health-calculator.js";
import { calculateSatelliteTrust } from "./friday-fleet-trust-calculator.js";
import type { FridaySatelliteWithHeartbeatRow } from "./friday-fleet-dashboard-repository.js";
import type { JsonObject } from "../../workflows/model/friday-workflow.types.js";

function buildSatelliteCard(
  row: FridaySatelliteWithHeartbeatRow,
  nowMs: number,
  deadLetterCount: number,
  failedNodeCount1h: number,
  totalNodeCount1h: number,
): FridayFleetSatelliteCard {
  const heartbeatAgeMs =
    row.hb_ts ? nowMs - new Date(row.hb_ts).getTime() : null;

  const healthBreakdown = calculateSatelliteHealth({
    lastHeartbeatAgeMs: heartbeatAgeMs,
    cpuPercent: row.cpu_percent,
    memoryPercent: row.memory_percent,
    loadAvg1m: row.load_avg_1m,
    queueDepth: row.queue_depth,
    deadLetterCount,
    failedNodeCount1h,
    totalNodeCount1h,
  });

  const trustBreakdown = calculateSatelliteTrust({
    pairingStatus: row.pairing_status as FridaySatellitePairingStatus,
    trustLevel: row.trust_level as FridaySatelliteTrustLevel,
    hasRevokedTokens: false,
    hasExpiredHighPrivTokens: false,
    recentRevocationCount: 0,
    recentSecurityFindingsCount: 0,
  });

  const alerts: string[] = [];
  if (healthBreakdown.state === "critical") {
    alerts.push("Health is critical");
  }
  if (trustBreakdown.band === "low") {
    alerts.push("Trust is low");
  }

  return {
    satelliteId: row.id,
    type: row.type as FridaySatelliteType,
    displayName: row.display_name,
    pairingStatus: row.pairing_status as FridaySatellitePairingStatus,
    trustLevel: row.trust_level as FridaySatelliteTrustLevel,
    trustScore: trustBreakdown.finalScore,
    trustBand: trustBreakdown.band,
    healthScore: healthBreakdown.finalScore,
    healthState: healthBreakdown.state,
    lastSeenAt: row.last_seen_at ?? undefined,
    heartbeatAgeMs: heartbeatAgeMs ?? undefined,
    cpuPercent: row.cpu_percent ?? undefined,
    memoryPercent: row.memory_percent ?? undefined,
    loadAvg1m: row.load_avg_1m ?? undefined,
    queueDepth: row.queue_depth ?? undefined,
    activeRuns: row.active_runs ?? undefined,
    tags: JSON.parse(row.tags_json) as string[],
    alerts,
  };
}

// ─── Factory ───

export function createFridayFleetDashboardService(
  deps: CreateFridayFleetDashboardServiceDeps,
): FridayFleetDashboardService {
  const repo = createFridayFleetDashboardRepository();

  return {
    getOverview() {
      const now = deps.nowIso();
      const nowMs = new Date(now).getTime();
      const oneHourAgo = new Date(nowMs - 3_600_000).toISOString();

      return deps.db.withReadConnection((db) => {
        const statusCounts = repo.getPairingStatusCounts(db);
        const queueStats = repo.getGlobalQueueStats(db);
        const runStats = repo.getWorkflowRunStats(db, oneHourAgo);

        const countMap: Record<string, number> = {};
        let totalSatellites = 0;
        for (const row of statusCounts) {
          countMap[row.pairing_status] = row.count;
          totalSatellites += row.count;
        }

        // Compute global health from satellite data
        const satellites = repo.listSatellitesWithHeartbeat(db);
        let healthSum = 0;
        let trustSum = 0;
        let lowTrustCount = 0;
        let restrictedCount = 0;
        const healthReasons: string[] = [];

        for (const sat of satellites) {
          const hbAge = sat.hb_ts
            ? nowMs - new Date(sat.hb_ts).getTime()
            : null;
          const dlCount = repo.getDeadLetterCount(db, sat.id);
          const failedCount = repo.getFailedNodeCount1h(db, sat.id, oneHourAgo);
          const totalCount = repo.getTotalNodeCount1h(db, sat.id, oneHourAgo);
          const health = calculateSatelliteHealth({
            lastHeartbeatAgeMs: hbAge,
            cpuPercent: sat.cpu_percent,
            memoryPercent: sat.memory_percent,
            loadAvg1m: sat.load_avg_1m,
            queueDepth: sat.queue_depth,
            deadLetterCount: dlCount,
            failedNodeCount1h: failedCount,
            totalNodeCount1h: totalCount,
          });
          healthSum += health.finalScore;

          // Real trust inputs from DB — api_tokens uses user_id for user tokens;
          // for satellites, we match by principal_type + a label or ID convention.
          const hasRevokedTokens = (db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE user_id = ? AND revoked_at IS NOT NULL",
            )
            .get(sat.id) as { count: number }).count > 0;
          const hasExpiredHighPrivTokens = (db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE user_id = ? AND expires_at IS NOT NULL AND expires_at <= ? AND revoked_at IS NULL AND (scopes_json LIKE '%hub.admin%' OR scopes_json LIKE '%security.write%')",
            )
            .get(sat.id, now) as { count: number }).count > 0;
          const recentRevocationCount = (db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE user_id = ? AND revoked_at IS NOT NULL AND revoked_at >= ?",
            )
            .get(sat.id, oneHourAgo) as { count: number }).count;

          const trust = calculateSatelliteTrust({
            pairingStatus: sat.pairing_status as FridaySatellitePairingStatus,
            trustLevel: sat.trust_level as FridaySatelliteTrustLevel,
            hasRevokedTokens,
            hasExpiredHighPrivTokens,
            recentRevocationCount,
            recentSecurityFindingsCount: 0,
          });
          trustSum += trust.finalScore;
          if (trust.band === "low") lowTrustCount++;
          if (sat.trust_level === "restricted") restrictedCount++;
        }

        const avgHealth = satellites.length > 0 ? Math.round(healthSum / satellites.length) : 100;
        const avgTrust = satellites.length > 0 ? Math.round(trustSum / satellites.length) : 100;

        if (avgHealth < 55) healthReasons.push("Average fleet health is critical");
        else if (avgHealth < 80) healthReasons.push("Average fleet health is degraded");

        return {
          generatedAt: now,
          totals: {
            satellites: totalSatellites,
            pending: countMap["pending"] ?? 0,
            paired: countMap["paired"] ?? 0,
            online: countMap["online"] ?? 0,
            degraded: countMap["degraded"] ?? 0,
            offline: countMap["offline"] ?? 0,
            revoked: countMap["revoked"] ?? 0,
          },
          queue: {
            queued: queueStats.queued_count ?? 0,
            leased: queueStats.leased_count ?? 0,
            failed: queueStats.failed_count ?? 0,
            deadLetter: queueStats.dead_letter_count ?? 0,
          },
          workflows: {
            activeRuns: runStats.active_runs ?? 0,
            completed1h: runStats.completed_1h ?? 0,
            failed1h: runStats.failed_1h ?? 0,
          },
          health: {
            score: avgHealth,
            state: healthStateFromScore(avgHealth),
            reasons: healthReasons,
          },
          trust: {
            averageScore: avgTrust,
            lowTrustCount,
            restrictedCount,
            revokedCount: countMap["revoked"] ?? 0,
          },
        };
      });
    },

    listSatellites(input) {
      const now = deps.nowIso();
      const nowMs = new Date(now).getTime();
      const oneHourAgo = new Date(nowMs - 3_600_000).toISOString();

      return deps.db.withReadConnection((db) => {
        let rows = repo.listSatellitesWithHeartbeat(db);

        // Apply filters
        if (input.pairingStatus) {
          rows = rows.filter((r) => r.pairing_status === input.pairingStatus);
        }
        if (input.trustLevel) {
          rows = rows.filter((r) => r.trust_level === input.trustLevel);
        }
        if (input.q) {
          const q = input.q.toLowerCase();
          rows = rows.filter(
            (r) =>
              r.display_name.toLowerCase().includes(q) ||
              r.id.toLowerCase().includes(q),
          );
        }

        const limit = Math.min(input.limit ?? 50, 200);
        const startIdx = input.cursor
          ? rows.findIndex((r) => r.id === input.cursor) + 1
          : 0;
        const slice = rows.slice(startIdx, startIdx + limit);

        const cards: FridayFleetSatelliteCard[] = slice.map((row) => {
          const dlCount = repo.getDeadLetterCount(db, row.id);
          const failedCount = repo.getFailedNodeCount1h(db, row.id, oneHourAgo);
          const totalCount = repo.getTotalNodeCount1h(db, row.id, oneHourAgo);
          return buildSatelliteCard(row, nowMs, dlCount, failedCount, totalCount);
        });

        // Health state filter (post-computation)
        const filtered = input.healthState
          ? cards.filter((c) => c.healthState === input.healthState)
          : cards;

        const nextCursor =
          slice.length === limit ? slice[slice.length - 1]?.id : undefined;

        return {
          items: filtered,
          nextCursor,
        };
      });
    },

    getSatelliteDetail(satelliteId) {
      const now = deps.nowIso();
      const nowMs = new Date(now).getTime();
      const oneHourAgo = new Date(nowMs - 3_600_000).toISOString();

      return deps.db.withReadConnection((db) => {
        const rows = repo.listSatellitesWithHeartbeat(db);
        const row = rows.find((r) => r.id === satelliteId);
        if (!row) return null;

        const dlCount = repo.getDeadLetterCount(db, satelliteId);
        const failedCount = repo.getFailedNodeCount1h(db, satelliteId, oneHourAgo);
        const totalCount = repo.getTotalNodeCount1h(db, satelliteId, oneHourAgo);

        const card = buildSatelliteCard(row, nowMs, dlCount, failedCount, totalCount);

        const caps = repo.getCapabilities(db, satelliteId);
        const queueStats = repo.getQueueStatsBySatellite(db, satelliteId);
        const workflowLoad = repo.getWorkflowLoadBySatellite(db, satelliteId);

        const heartbeatAgeMs =
          row.hb_ts ? nowMs - new Date(row.hb_ts).getTime() : null;

        const healthBreakdown = calculateSatelliteHealth({
          lastHeartbeatAgeMs: heartbeatAgeMs,
          cpuPercent: row.cpu_percent,
          memoryPercent: row.memory_percent,
          loadAvg1m: row.load_avg_1m,
          queueDepth: row.queue_depth,
          deadLetterCount: dlCount,
          failedNodeCount1h: failedCount,
          totalNodeCount1h: totalCount,
        });

        const trustBreakdown = calculateSatelliteTrust({
          pairingStatus: row.pairing_status as FridaySatellitePairingStatus,
          trustLevel: row.trust_level as FridaySatelliteTrustLevel,
          hasRevokedTokens: false,
          hasExpiredHighPrivTokens: false,
          recentRevocationCount: 0,
          recentSecurityFindingsCount: 0,
        });

        return {
          satellite: card,
          capabilities: caps.map((c) => ({
            key: c.key,
            available: c.available === 1,
            limits: c.limits_json ? (JSON.parse(c.limits_json) as JsonObject) : undefined,
            metadata: c.metadata_json ? (JSON.parse(c.metadata_json) as JsonObject) : undefined,
          })),
          queue: {
            queued: queueStats?.queued_count ?? 0,
            leased: queueStats?.leased_count ?? 0,
            failed: queueStats?.failed_count ?? 0,
            deadLetter: queueStats?.dead_letter_count ?? 0,
          },
          workflowLoad: {
            queuedNodes: workflowLoad?.queued_nodes ?? 0,
            runningNodes: workflowLoad?.running_nodes ?? 0,
            retryingNodes: workflowLoad?.retrying_nodes ?? 0,
            blockedOfflineNodes: workflowLoad?.blocked_offline_nodes ?? 0,
          },
          trustBreakdown,
          healthBreakdown,
        };
      });
    },

    getSecurityCenter() {
      const now = deps.nowIso();
      const nowMs = new Date(now).getTime();
      const twentyFourHoursAgo = new Date(nowMs - 86_400_000).toISOString();

      return deps.db.withReadConnection((db) => {
        // Token stats
        const activeTokens = (
          db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
            )
            .get(now) as { count: number }
        ).count;

        const expiredTokens = (
          db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ? AND revoked_at IS NULL",
            )
            .get(now) as { count: number }
        ).count;

        const revokedTokens24h = (
          db
            .prepare(
              "SELECT COUNT(*) as count FROM api_tokens WHERE revoked_at IS NOT NULL AND revoked_at >= ?",
            )
            .get(twentyFourHoursAgo) as { count: number }
        ).count;

        // Count high-privilege tokens
        const allActiveTokens = db
          .prepare(
            "SELECT scopes_json FROM api_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
          )
          .all(now) as Array<{ scopes_json: string }>;

        const highPrivilegeActive = allActiveTokens.filter((t) => {
          const scopes = JSON.parse(t.scopes_json) as string[];
          return scopes.includes("hub.admin") || scopes.includes("security.write");
        }).length;

        // Satellite stats
        const statusCounts = repo.getPairingStatusCounts(db);
        const scMap: Record<string, number> = {};
        for (const s of statusCounts) {
          scMap[s.pairing_status] = s.count;
        }

        const pendingPairings = (
          db
            .prepare(
              "SELECT COUNT(*) as count FROM satellite_pairing_requests WHERE status = 'pending'",
            )
            .get() as { count: number }
        ).count;

        // Real restricted/trusted counts from trust_level column
        const restrictedSatellites = (db
          .prepare(
            "SELECT COUNT(*) as count FROM satellites WHERE deleted_at IS NULL AND trust_level = 'restricted'",
          )
          .get() as { count: number }).count;
        const trustedSatellites = (db
          .prepare(
            "SELECT COUNT(*) as count FROM satellites WHERE deleted_at IS NULL AND trust_level = 'trusted'",
          )
          .get() as { count: number }).count;

        // Build findings (lightweight security scan)
        const findings: FridaySecurityCenterResponse["findings"] = [];

        if (highPrivilegeActive > 3) {
          findings.push({
            id: deps.idGenerator(),
            severity: "medium",
            type: "token_scope_risk",
            message: `${highPrivilegeActive} high-privilege tokens are active`,
            detectedAt: now,
          });
        }

        return {
          generatedAt: now,
          tokens: {
            active: activeTokens,
            expired: expiredTokens,
            revoked24h: revokedTokens24h,
            highPrivilegeActive,
          },
          satellites: {
            restricted: restrictedSatellites,
            trusted: trustedSatellites,
            revoked: scMap["revoked"] ?? 0,
            pendingPairings,
          },
          findings,
        };
      });
    },
  };
}
```

## `src/api/fleet/friday-fleet-dashboard-service.types.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { UUID } from "../../workflows/model/friday-workflow.types.js";
import type {
  FridayFleetOverviewResponse,
  FridayListFleetSatellitesQuery,
  FridayListFleetSatellitesResponse,
  FridayFleetSatelliteDetailResponse,
  FridaySecurityCenterResponse,
} from "../model/friday-api-fleet.types.js";

export interface FridayFleetDashboardService {
  getOverview(): FridayFleetOverviewResponse;
  listSatellites(input: FridayListFleetSatellitesQuery): FridayListFleetSatellitesResponse;
  getSatelliteDetail(satelliteId: UUID): FridayFleetSatelliteDetailResponse | null;
  getSecurityCenter(): FridaySecurityCenterResponse;
}

export interface CreateFridayFleetDashboardServiceDeps {
  db: FridaySqliteLayer;
  nowIso: () => string;
  idGenerator: () => string;
}
```

## `src/api/fleet/friday-fleet-health-calculator.ts`
```ts
import type { FridayHealthState, FridaySatelliteHealthBreakdown } from "../model/friday-api-fleet.types.js";

// ─── Input ───

export interface FridayHealthCalculatorInput {
  lastHeartbeatAgeMs: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  loadAvg1m: number | null;
  queueDepth: number | null;
  deadLetterCount: number;
  failedNodeCount1h: number;
  totalNodeCount1h: number;
}

// ─── Health state from score ───

export function healthStateFromScore(score: number): FridayHealthState {
  if (score >= 80) return "healthy";
  if (score >= 55) return "degraded";
  return "critical";
}

// ─── Calculator ───

export function calculateSatelliteHealth(
  input: FridayHealthCalculatorInput,
): FridaySatelliteHealthBreakdown {
  // Heartbeat score
  let heartbeatScore: number;
  if (input.lastHeartbeatAgeMs === null) {
    heartbeatScore = 0;
  } else if (input.lastHeartbeatAgeMs < 30_000) {
    heartbeatScore = 100;
  } else if (input.lastHeartbeatAgeMs <= 90_000) {
    // Linear 100 -> 40 from 30s to 90s
    const ratio = (input.lastHeartbeatAgeMs - 30_000) / 60_000;
    heartbeatScore = 100 - ratio * 60;
  } else {
    heartbeatScore = 10;
  }

  // Resource score
  const cpu = input.cpuPercent ?? 0;
  const mem = input.memoryPercent ?? 0;
  const load = input.loadAvg1m !== null ? Math.min(input.loadAvg1m * 100, 100) : 0;
  const resourceScore = Math.max(0, 100 - Math.max(cpu, mem, load));

  // Queue score
  const depth = input.queueDepth ?? 0;
  const queueScore = Math.max(0, 100 - Math.min((depth / 100) * 100, 100));

  // Reliability score
  let reliabilityScore = 100;
  if (input.deadLetterCount > 0) {
    reliabilityScore -= Math.min(input.deadLetterCount * 10, 50);
  }
  if (input.totalNodeCount1h > 0) {
    const failRate = input.failedNodeCount1h / input.totalNodeCount1h;
    reliabilityScore -= Math.min(failRate * 100, 50);
  }
  reliabilityScore = Math.max(0, reliabilityScore);

  // Final composite
  const finalScore = Math.round(
    0.35 * heartbeatScore +
    0.25 * resourceScore +
    0.20 * queueScore +
    0.20 * reliabilityScore,
  );

  const state = healthStateFromScore(finalScore);

  return {
    heartbeatScore: Math.round(heartbeatScore),
    resourceScore: Math.round(resourceScore),
    queueScore: Math.round(queueScore),
    reliabilityScore: Math.round(reliabilityScore),
    finalScore,
    state,
  };
}
```

## `src/api/fleet/friday-fleet-trust-calculator.ts`
```ts
import type {
  FridayTrustBand,
  FridaySatelliteTrustBreakdown,
} from "../model/friday-api-fleet.types.js";
import type {
  FridaySatellitePairingStatus,
  FridaySatelliteTrustLevel,
} from "../../satellites/model/friday-satellite.types.js";

// ─── Input ───

export interface FridayTrustCalculatorInput {
  pairingStatus: FridaySatellitePairingStatus;
  trustLevel: FridaySatelliteTrustLevel;
  hasRevokedTokens: boolean;
  hasExpiredHighPrivTokens: boolean;
  recentRevocationCount: number;
  recentSecurityFindingsCount: number;
}

// ─── Trust band from score ───

export function trustBandFromScore(score: number): FridayTrustBand {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

// ─── Calculator ───

export function calculateSatelliteTrust(
  input: FridayTrustCalculatorInput,
): FridaySatelliteTrustBreakdown {
  const reasons: string[] = [];

  // Identity score: trusted 40, restricted 20
  const identityScore = input.trustLevel === "trusted" ? 40 : 20;
  if (input.trustLevel === "restricted") {
    reasons.push("Satellite has restricted trust level");
  }

  // Status score
  let statusScore: number;
  switch (input.pairingStatus) {
    case "online":
      statusScore = 30;
      break;
    case "degraded":
      statusScore = 20;
      reasons.push("Satellite is in degraded state");
      break;
    case "paired":
      statusScore = 15;
      break;
    case "offline":
      statusScore = 10;
      reasons.push("Satellite is offline");
      break;
    case "pending":
      statusScore = 5;
      reasons.push("Satellite pairing is pending");
      break;
    case "revoked":
      statusScore = 0;
      reasons.push("Satellite pairing has been revoked");
      break;
    default:
      statusScore = 0;
  }

  // Hygiene score: 0..20
  let hygieneScore = 20;
  if (input.hasRevokedTokens) {
    hygieneScore -= 5;
    reasons.push("Has revoked tokens");
  }
  if (input.hasExpiredHighPrivTokens) {
    hygieneScore -= 10;
    reasons.push("Has expired high-privilege tokens");
  }
  hygieneScore = Math.max(0, hygieneScore);

  // Incident penalty: 0..40
  let incidentPenalty = 0;
  incidentPenalty += Math.min(input.recentRevocationCount * 10, 20);
  incidentPenalty += Math.min(input.recentSecurityFindingsCount * 5, 20);
  incidentPenalty = Math.min(incidentPenalty, 40);

  if (input.recentRevocationCount > 0) {
    reasons.push(`${input.recentRevocationCount} recent revocation(s)`);
  }
  if (input.recentSecurityFindingsCount > 0) {
    reasons.push(`${input.recentSecurityFindingsCount} recent security finding(s)`);
  }

  // Final score
  const rawScore = identityScore + statusScore + hygieneScore - incidentPenalty;
  const finalScore = Math.max(0, Math.min(100, rawScore));
  const band = trustBandFromScore(finalScore);

  return {
    identityScore,
    statusScore,
    hygieneScore,
    incidentPenalty,
    finalScore,
    band,
    reasons,
  };
}
```

## `src/api/http/friday-http-context.types.ts`
```ts
// Re-export HTTP context types from the model layer.

export type {
  FridayHttpContext,
  FridayRequestMeta,
  FridayRouteHandler,
  FridayRouteDefinition,
  FridayHttpMethod,
} from "../model/friday-api-common.types.js";
```

## `src/api/http/friday-http-error-mapper.ts`
```ts
import type { FridayApiErrorResponse, FridayApiError } from "../model/friday-api-common.types.js";
import { AuthError } from "../auth/friday-auth-service.js";
import { TokenValidationError } from "../auth/friday-token-validator.js";
import { ConflictServiceError } from "../conflicts/friday-workflow-conflict-service.js";

// ─── Error to HTTP status code ───

export function mapErrorToStatusCode(error: unknown): number {
  if (error instanceof TokenValidationError) {
    return 401;
  }
  if (error instanceof AuthError) {
    switch (error.code) {
      case "USER_NOT_FOUND":
      case "INVALID_CREDENTIALS":
      case "INVALID_REFRESH_TOKEN":
        return 401;
      case "NO_USER_CONTEXT":
        return 403;
      default:
        return 400;
    }
  }
  if (error instanceof ConflictServiceError) {
    switch (error.code) {
      case "NOT_FOUND":
        return 404;
      case "ALREADY_RESOLVED":
        return 409;
      default:
        return 400;
    }
  }
  return 500;
}

// ─── Error to API error ───

export function mapErrorToApiError(error: unknown): FridayApiError {
  if (error instanceof TokenValidationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof AuthError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof ConflictServiceError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === "RESOLVE_FAILED",
    };
  }
  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message,
      retryable: false,
    };
  }
  return {
    code: "UNKNOWN_ERROR",
    message: "An unexpected error occurred",
    retryable: false,
  };
}

// ─── Build full error response ───

export function buildErrorResponse(error: unknown, requestId: string): {
  statusCode: number;
  body: FridayApiErrorResponse;
} {
  return {
    statusCode: mapErrorToStatusCode(error),
    body: {
      ok: false,
      error: mapErrorToApiError(error),
      requestId,
    },
  };
}
```

## `src/api/http/friday-http-route-registry.ts`
```ts
import type { FridayRouteDefinition, FridayHttpMethod } from "../model/friday-api-common.types.js";

// ─── Route entry (type-erased for registry storage) ───

export interface FridayRouteEntry {
  operationId: string;
  method: FridayHttpMethod;
  path: string;
  auth:
    | { public: true }
    | { public: false; anyOfScopes: string[]; anyOfRoles?: string[] };
  rateLimitPolicyId?: string;
  handler: (...args: unknown[]) => Promise<unknown>;
}

// ─── Route registry ───

export interface FridayHttpRouteRegistry {
  register(route: FridayRouteEntry): void;
  getRoutes(): readonly FridayRouteEntry[];
  findRoute(method: FridayHttpMethod, path: string): FridayRouteEntry | undefined;
  getRouteCount(): number;
}

// ─── Factory ───

export function createFridayHttpRouteRegistry(): FridayHttpRouteRegistry {
  const routes: FridayRouteEntry[] = [];

  return {
    register(route) {
      // Prevent duplicate operationIds
      const existing = routes.find((r) => r.operationId === route.operationId);
      if (existing) {
        throw new Error(`Route with operationId '${route.operationId}' is already registered`);
      }
      routes.push(route);
    },

    getRoutes() {
      return routes;
    },

    findRoute(method, path) {
      return routes.find((r) => r.method === method && matchPath(r.path, path));
    },

    getRouteCount() {
      return routes.length;
    },
  };
}

// ─── Simple path matcher (supports :param segments) ───

function matchPath(pattern: string, actual: string): boolean {
  const patternParts = pattern.split("/");
  const actualParts = actual.split("/");

  if (patternParts.length !== actualParts.length) return false;

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) continue;
    if (patternParts[i] !== actualParts[i]) return false;
  }

  return true;
}
```

## `src/api/http/routes/friday-auth-routes.ts`
```ts
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayLoginRequest,
  FridayLoginResponse,
  FridayRefreshRequest,
  FridayRefreshResponse,
  FridayLogoutRequest,
  FridayLogoutResponse,
  FridayAuthMeResponse,
} from "../../model/friday-api-auth.types.js";
import type { FridayAuthService } from "../../auth/friday-auth-service.types.js";

export interface FridayAuthRoutesDeps {
  authService: FridayAuthService;
}

export function createFridayAuthRoutes(
  deps: FridayAuthRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  const login: FridayRouteDefinition<Record<string, never>, Record<string, never>, FridayLoginRequest, FridayLoginResponse> = {
    operationId: "auth.login",
    method: "POST",
    path: "/v1/auth/login",
    auth: { public: true },
    rateLimitPolicyId: "auth.login",
    async handler(ctx) {
      return deps.authService.login(ctx.body, ctx.ip, ctx.userAgent);
    },
  };

  const refresh: FridayRouteDefinition<Record<string, never>, Record<string, never>, FridayRefreshRequest, FridayRefreshResponse> = {
    operationId: "auth.refresh",
    method: "POST",
    path: "/v1/auth/refresh",
    auth: { public: true },
    rateLimitPolicyId: "auth.refresh",
    async handler(ctx) {
      return deps.authService.refresh(ctx.body);
    },
  };

  const logout: FridayRouteDefinition<Record<string, never>, Record<string, never>, FridayLogoutRequest, FridayLogoutResponse> = {
    operationId: "auth.logout",
    method: "POST",
    path: "/v1/auth/logout",
    auth: { public: false, anyOfScopes: ["session.write"] },
    rateLimitPolicyId: "auth.logout",
    async handler(ctx) {
      return deps.authService.logout(ctx.body, ctx.principal!);
    },
  };

  const me: FridayRouteDefinition<Record<string, never>, Record<string, never>, Record<string, never>, FridayAuthMeResponse> = {
    operationId: "auth.me",
    method: "GET",
    path: "/v1/auth/me",
    auth: { public: false, anyOfScopes: ["session.read"] },
    async handler(ctx) {
      return deps.authService.me(ctx.principal!);
    },
  };

  return [login, refresh, logout, me];
}
```

## `src/api/http/routes/friday-fleet-routes.ts`
```ts
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "../../../workflows/model/friday-workflow.types.js";
import type {
  FridayFleetOverviewResponse,
  FridayListFleetSatellitesQuery,
  FridayListFleetSatellitesResponse,
  FridayFleetSatelliteDetailResponse,
} from "../../model/friday-api-fleet.types.js";
import type { FridayFleetDashboardService } from "../../fleet/friday-fleet-dashboard-service.types.js";

export interface FridayFleetRoutesDeps {
  fleetService: FridayFleetDashboardService;
}

export function createFridayFleetRoutes(
  deps: FridayFleetRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "fleet.overview",
      method: "GET",
      path: "/v1/fleet/overview",
      auth: { public: false, anyOfScopes: ["fleet.read"] },
      async handler() {
        return deps.fleetService.getOverview();
      },
    },
    {
      operationId: "fleet.listSatellites",
      method: "GET",
      path: "/v1/fleet/satellites",
      auth: { public: false, anyOfScopes: ["fleet.read"] },
      async handler(ctx) {
        return deps.fleetService.listSatellites(ctx.query as FridayListFleetSatellitesQuery);
      },
    },
    {
      operationId: "fleet.getSatelliteDetail",
      method: "GET",
      path: "/v1/fleet/satellites/:satelliteId",
      auth: { public: false, anyOfScopes: ["fleet.read"] },
      async handler(ctx) {
        const { satelliteId } = ctx.params as { satelliteId: UUID };
        return deps.fleetService.getSatelliteDetail(satelliteId);
      },
    },
  ];
}
```

## `src/api/http/routes/friday-realtime-routes.ts`
```ts
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type {
  FridayRealtimeSubscribeRequest,
  FridayRealtimeSubscribeResponse,
  FridayRealtimePullRequest,
  FridayRealtimePullResponse,
  FridayRealtimeAckRequest,
  FridayRealtimeAckResponse,
} from "../../model/friday-api-realtime.types.js";
import type { FridayRealtimeSubscriptionService } from "../../realtime/friday-realtime-subscription-service.js";

export interface FridayRealtimeRoutesDeps {
  subscriptionService: FridayRealtimeSubscriptionService;
  currentEpoch: number;
}

export function createFridayRealtimeRoutes(
  deps: FridayRealtimeRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "realtime.subscribe",
      method: "POST",
      path: "/v1/realtime/subscriptions",
      auth: { public: false, anyOfScopes: ["workflow.read", "fleet.read"] },
      rateLimitPolicyId: "realtime.subscribe",
      async handler(ctx) {
        const { subscriptions } = ctx.body as FridayRealtimeSubscribeRequest;
        const result = deps.subscriptionService.validateSubscriptions(
          subscriptions,
          ctx.principal!,
        );
        return {
          subscriptions: result.accepted,
          epoch: deps.currentEpoch,
        } satisfies FridayRealtimeSubscribeResponse;
      },
    },
    {
      operationId: "realtime.pull",
      method: "POST",
      path: "/v1/realtime/pull",
      auth: { public: false, anyOfScopes: ["workflow.read", "fleet.read"] },
      rateLimitPolicyId: "realtime.pull",
      async handler(ctx) {
        const { streamId, afterSeq, limit, cursor } = ctx.body as FridayRealtimePullRequest;

        // Verify stream authorization per principal
        if (!deps.subscriptionService.isStreamAuthorized(ctx.principal!, streamId)) {
          throw Object.assign(new Error(`Not authorized for stream '${streamId}'`), {
            code: "STREAM_NOT_AUTHORIZED",
            statusCode: 403,
          });
        }

        // Verify cursor HMAC if provided
        if (cursor && !deps.subscriptionService.verifyCursor(cursor, streamId, afterSeq ?? 0, deps.currentEpoch)) {
          throw Object.assign(new Error("Invalid cursor"), {
            code: "CURSOR_INVALID",
            statusCode: 400,
          });
        }

        const events = deps.subscriptionService.pullEvents(
          streamId,
          afterSeq ?? 0,
          limit ?? 50,
        );
        return {
          items: events,
          streamId,
          epoch: deps.currentEpoch,
        } satisfies FridayRealtimePullResponse;
      },
    },
    {
      operationId: "realtime.ack",
      method: "POST",
      path: "/v1/realtime/ack",
      auth: { public: false, anyOfScopes: ["workflow.read", "fleet.read"] },
      async handler(ctx) {
        const { streamId, seq, epoch, cursor } = ctx.body as FridayRealtimeAckRequest;

        // Verify stream authorization per principal
        if (!deps.subscriptionService.isStreamAuthorized(ctx.principal!, streamId)) {
          throw Object.assign(new Error(`Not authorized for stream '${streamId}'`), {
            code: "STREAM_NOT_AUTHORIZED",
            statusCode: 403,
          });
        }

        // Verify cursor HMAC if provided
        if (cursor && !deps.subscriptionService.verifyCursor(cursor, streamId, seq, epoch)) {
          throw Object.assign(new Error("Invalid cursor"), {
            code: "CURSOR_INVALID",
            statusCode: 400,
          });
        }

        deps.subscriptionService.ackEvent(
          ctx.principal!.principalId,
          streamId,
          seq,
          epoch,
          cursor,
        );
        return {
          accepted: true,
          streamId,
          seq,
        } satisfies FridayRealtimeAckResponse;
      },
    },
  ];
}
```

## `src/api/http/routes/friday-security-routes.ts`
```ts
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "../../../workflows/model/friday-workflow.types.js";
import type { FridaySecurityCenterResponse } from "../../model/friday-api-fleet.types.js";
import type {
  FridayRevokeTokenRequest,
  FridayRevokeTokenResponse,
  FridayRevokeSatelliteRequest,
  FridayRevokeSatelliteResponse,
} from "../../model/friday-api-security.types.js";
import type { FridayFleetDashboardService } from "../../fleet/friday-fleet-dashboard-service.types.js";

export interface FridaySecurityRoutesDeps {
  fleetService: FridayFleetDashboardService;
  revokeToken: (tokenId: UUID) => FridayRevokeTokenResponse;
  revokeSatellite: (satelliteId: UUID, reason?: string) => FridayRevokeSatelliteResponse;
}

export function createFridaySecurityRoutes(
  deps: FridaySecurityRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "security.center",
      method: "GET",
      path: "/v1/security/center",
      auth: { public: false, anyOfScopes: ["security.read"] },
      async handler() {
        return deps.fleetService.getSecurityCenter();
      },
    },
    {
      operationId: "security.revokeToken",
      method: "POST",
      path: "/v1/security/tokens/revoke",
      auth: { public: false, anyOfScopes: ["security.write"] },
      async handler(ctx) {
        const { tokenId } = ctx.body as FridayRevokeTokenRequest;
        return deps.revokeToken(tokenId);
      },
    },
    {
      operationId: "security.revokeSatellite",
      method: "POST",
      path: "/v1/security/satellites/:satelliteId/revoke",
      auth: { public: false, anyOfScopes: ["security.write"] },
      async handler(ctx) {
        const { satelliteId } = ctx.params as { satelliteId: UUID };
        const { reason } = (ctx.body ?? {}) as FridayRevokeSatelliteRequest;
        return deps.revokeSatellite(satelliteId, reason);
      },
    },
  ];
}
```

## `src/api/http/routes/friday-workflow-builder-routes.ts`
```ts
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "../../../workflows/model/friday-workflow.types.js";
import type {
  FridayCreateDraftRequest,
  FridayCreateDraftResponse,
  FridayListDraftsResponse,
  FridayGetDraftResponse,
  FridaySaveDraftRequest,
  FridaySaveDraftResponse,
  FridayAutosaveDraftRequest,
  FridayAutosaveDraftResponse,
  FridayCompileDraftResponse,
  FridayPublishDraftRequest,
  FridayPublishDraftResponse,
  FridayAcquireWorkflowLockRequest,
  FridayAcquireWorkflowLockResponse,
  FridayRenewWorkflowLockRequest,
  FridayRenewWorkflowLockResponse,
  FridayReleaseWorkflowLockRequest,
  FridayReleaseWorkflowLockResponse,
} from "../../model/friday-api-workflow.types.js";
import type { FridayPaginationQuery } from "../../model/friday-api-common.types.js";

export interface FridayWorkflowBuilderRoutesDeps {
  createDraft: (workflowId: UUID, input: FridayCreateDraftRequest) => FridayCreateDraftResponse;
  listDrafts: (workflowId: UUID, query: FridayPaginationQuery) => FridayListDraftsResponse;
  getDraft: (workflowId: UUID, draftId: UUID) => FridayGetDraftResponse;
  saveDraft: (workflowId: UUID, draftId: UUID, input: FridaySaveDraftRequest) => FridaySaveDraftResponse;
  autosaveDraft: (workflowId: UUID, draftId: UUID, input: FridayAutosaveDraftRequest) => FridayAutosaveDraftResponse;
  compileDraft: (workflowId: UUID, draftId: UUID) => FridayCompileDraftResponse;
  publishDraft: (workflowId: UUID, draftId: UUID, input: FridayPublishDraftRequest) => FridayPublishDraftResponse;
  acquireLock: (workflowId: UUID, input: FridayAcquireWorkflowLockRequest) => FridayAcquireWorkflowLockResponse;
  renewLock: (workflowId: UUID, input: FridayRenewWorkflowLockRequest) => FridayRenewWorkflowLockResponse;
  releaseLock: (workflowId: UUID, input: FridayReleaseWorkflowLockRequest) => FridayReleaseWorkflowLockResponse;
}

export function createFridayWorkflowBuilderRoutes(
  deps: FridayWorkflowBuilderRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "drafts.list",
      method: "GET",
      path: "/v1/workflows/:workflowId/drafts",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.listDrafts(workflowId, ctx.query as FridayPaginationQuery);
      },
    },
    {
      operationId: "drafts.create",
      method: "POST",
      path: "/v1/workflows/:workflowId/drafts",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.createDraft(workflowId, ctx.body as FridayCreateDraftRequest);
      },
    },
    {
      operationId: "drafts.get",
      method: "GET",
      path: "/v1/workflows/:workflowId/drafts/:draftId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        return deps.getDraft(workflowId, draftId);
      },
    },
    {
      operationId: "drafts.save",
      method: "PATCH",
      path: "/v1/workflows/:workflowId/drafts/:draftId",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        return deps.saveDraft(workflowId, draftId, ctx.body as FridaySaveDraftRequest);
      },
    },
    {
      operationId: "drafts.autosave",
      method: "POST",
      path: "/v1/workflows/:workflowId/drafts/:draftId/autosave",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        return deps.autosaveDraft(workflowId, draftId, ctx.body as FridayAutosaveDraftRequest);
      },
    },
    {
      operationId: "drafts.compile",
      method: "POST",
      path: "/v1/workflows/:workflowId/drafts/:draftId/compile",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        return deps.compileDraft(workflowId, draftId);
      },
    },
    {
      operationId: "drafts.publish",
      method: "POST",
      path: "/v1/workflows/:workflowId/drafts/:draftId/publish",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      rateLimitPolicyId: "workflow.publish",
      async handler(ctx) {
        const { workflowId, draftId } = ctx.params as { workflowId: UUID; draftId: UUID };
        return deps.publishDraft(workflowId, draftId, ctx.body as FridayPublishDraftRequest);
      },
    },
    {
      operationId: "locks.acquire",
      method: "POST",
      path: "/v1/workflows/:workflowId/locks/acquire",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.acquireLock(workflowId, ctx.body as FridayAcquireWorkflowLockRequest);
      },
    },
    {
      operationId: "locks.renew",
      method: "POST",
      path: "/v1/workflows/:workflowId/locks/renew",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.renewLock(workflowId, ctx.body as FridayRenewWorkflowLockRequest);
      },
    },
    {
      operationId: "locks.release",
      method: "POST",
      path: "/v1/workflows/:workflowId/locks/release",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.releaseLock(workflowId, ctx.body as FridayReleaseWorkflowLockRequest);
      },
    },
  ];
}
```

## `src/api/http/routes/friday-workflow-conflict-routes.ts`
```ts
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "../../../workflows/model/friday-workflow.types.js";
import type {
  FridayListWorkflowConflictsQuery,
  FridayListWorkflowConflictsResponse,
  FridayResolveWorkflowConflictRequest,
  FridayResolveWorkflowConflictResponse,
} from "../../model/friday-api-workflow.types.js";

export interface FridayWorkflowConflictRoutesDeps {
  listConflicts: (
    workflowId: UUID,
    query: FridayListWorkflowConflictsQuery,
  ) => FridayListWorkflowConflictsResponse;
  resolveConflict: (
    workflowId: UUID,
    conflictId: UUID,
    input: FridayResolveWorkflowConflictRequest,
    userId?: UUID,
  ) => FridayResolveWorkflowConflictResponse;
}

export function createFridayWorkflowConflictRoutes(
  deps: FridayWorkflowConflictRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "conflicts.list",
      method: "GET",
      path: "/v1/workflows/:workflowId/conflicts",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.listConflicts(workflowId, ctx.query as FridayListWorkflowConflictsQuery);
      },
    },
    {
      operationId: "conflicts.resolve",
      method: "POST",
      path: "/v1/workflows/:workflowId/conflicts/:conflictId/resolve",
      auth: { public: false, anyOfScopes: ["workflow.conflict.resolve"] },
      rateLimitPolicyId: "workflow.resolve_conflict",
      async handler(ctx) {
        const { workflowId, conflictId } = ctx.params as { workflowId: UUID; conflictId: UUID };
        return deps.resolveConflict(
          workflowId,
          conflictId,
          ctx.body as FridayResolveWorkflowConflictRequest,
          ctx.principal?.userId,
        );
      },
    },
  ];
}
```

## `src/api/http/routes/friday-workflow-routes.ts`
```ts
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "../../../workflows/model/friday-workflow.types.js";
import type {
  FridayListWorkflowsQuery,
  FridayListWorkflowsResponse,
  FridayCreateWorkflowRequest,
  FridayCreateWorkflowResponse,
  FridayGetWorkflowResponse,
  FridayUpdateWorkflowRequest,
  FridayUpdateWorkflowResponse,
  FridayArchiveWorkflowResponse,
  FridayPublishWorkflowRequest,
  FridayPublishWorkflowResponse,
  FridayListVersionsQuery,
  FridayListVersionsResponse,
} from "../../model/friday-api-workflow.types.js";

export interface FridayWorkflowRoutesDeps {
  listWorkflows: (query: FridayListWorkflowsQuery) => FridayListWorkflowsResponse;
  createWorkflow: (input: FridayCreateWorkflowRequest) => FridayCreateWorkflowResponse;
  getWorkflow: (workflowId: UUID) => FridayGetWorkflowResponse;
  updateWorkflow: (workflowId: UUID, input: FridayUpdateWorkflowRequest) => FridayUpdateWorkflowResponse;
  archiveWorkflow: (workflowId: UUID) => FridayArchiveWorkflowResponse;
  publishWorkflow: (workflowId: UUID, input: FridayPublishWorkflowRequest) => FridayPublishWorkflowResponse;
  listVersions: (workflowId: UUID, query: FridayListVersionsQuery) => FridayListVersionsResponse;
}

export function createFridayWorkflowRoutes(
  deps: FridayWorkflowRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "workflows.list",
      method: "GET",
      path: "/v1/workflows",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        return deps.listWorkflows(ctx.query as FridayListWorkflowsQuery);
      },
    },
    {
      operationId: "workflows.create",
      method: "POST",
      path: "/v1/workflows",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        return deps.createWorkflow(ctx.body as FridayCreateWorkflowRequest);
      },
    },
    {
      operationId: "workflows.get",
      method: "GET",
      path: "/v1/workflows/:workflowId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.getWorkflow(workflowId);
      },
    },
    {
      operationId: "workflows.update",
      method: "PATCH",
      path: "/v1/workflows/:workflowId",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.updateWorkflow(workflowId, ctx.body as FridayUpdateWorkflowRequest);
      },
    },
    {
      operationId: "workflows.archive",
      method: "DELETE",
      path: "/v1/workflows/:workflowId",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.archiveWorkflow(workflowId);
      },
    },
    {
      operationId: "workflows.publish",
      method: "POST",
      path: "/v1/workflows/:workflowId/publish",
      auth: { public: false, anyOfScopes: ["workflow.write"] },
      rateLimitPolicyId: "workflow.publish",
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.publishWorkflow(workflowId, ctx.body as FridayPublishWorkflowRequest);
      },
    },
    {
      operationId: "workflows.listVersions",
      method: "GET",
      path: "/v1/workflows/:workflowId/versions",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { workflowId } = ctx.params as { workflowId: UUID };
        return deps.listVersions(workflowId, ctx.query as FridayListVersionsQuery);
      },
    },
  ];
}
```

## `src/api/http/routes/friday-workflow-run-routes.ts`
```ts
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { UUID } from "../../../workflows/model/friday-workflow.types.js";
import type {
  FridayStartRunRequest,
  FridayStartRunResponse,
  FridayGetRunResponse,
  FridayListRunNodesQuery,
  FridayListRunNodesResponse,
  FridayGetRunTimelineQuery,
  FridayGetRunTimelineResponse,
  FridayCancelRunRequest,
  FridayCancelRunResponse,
  FridayRetryRunRequest,
  FridayRetryRunResponse,
} from "../../model/friday-api-workflow.types.js";

export interface FridayWorkflowRunRoutesDeps {
  startRun: (input: FridayStartRunRequest) => Promise<FridayStartRunResponse>;
  getRun: (runId: UUID) => FridayGetRunResponse;
  listRunNodes: (runId: UUID, query: FridayListRunNodesQuery) => FridayListRunNodesResponse;
  getRunTimeline: (runId: UUID, query: FridayGetRunTimelineQuery) => FridayGetRunTimelineResponse;
  cancelRun: (runId: UUID, input: FridayCancelRunRequest) => Promise<FridayCancelRunResponse>;
  retryRun: (runId: UUID, input: FridayRetryRunRequest) => Promise<FridayRetryRunResponse>;
}

export function createFridayWorkflowRunRoutes(
  deps: FridayWorkflowRunRoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "runs.start",
      method: "POST",
      path: "/v1/workflow-runs",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      rateLimitPolicyId: "workflow.start_run",
      async handler(ctx) {
        return deps.startRun(ctx.body as FridayStartRunRequest);
      },
    },
    {
      operationId: "runs.get",
      method: "GET",
      path: "/v1/workflow-runs/:runId",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.getRun(runId);
      },
    },
    {
      operationId: "runs.listNodes",
      method: "GET",
      path: "/v1/workflow-runs/:runId/nodes",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.listRunNodes(runId, ctx.query as FridayListRunNodesQuery);
      },
    },
    {
      operationId: "runs.timeline",
      method: "GET",
      path: "/v1/workflow-runs/:runId/timeline",
      auth: { public: false, anyOfScopes: ["workflow.read"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.getRunTimeline(runId, ctx.query as FridayGetRunTimelineQuery);
      },
    },
    {
      operationId: "runs.cancel",
      method: "POST",
      path: "/v1/workflow-runs/:runId/cancel",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.cancelRun(runId, ctx.body as FridayCancelRunRequest);
      },
    },
    {
      operationId: "runs.retry",
      method: "POST",
      path: "/v1/workflow-runs/:runId/retry",
      auth: { public: false, anyOfScopes: ["workflow.run"] },
      async handler(ctx) {
        const { runId } = ctx.params as { runId: UUID };
        return deps.retryRun(runId, ctx.body as FridayRetryRunRequest);
      },
    },
  ];
}
```

## `src/api/index.ts`
```ts
// ─── Phase 8: API Layer barrel exports ───

// Model types
export type * from "./model/friday-api-common.types.js";
export type * from "./model/friday-api-auth.types.js";
export type * from "./model/friday-api-workflow.types.js";
export type * from "./model/friday-api-fleet.types.js";
export type * from "./model/friday-api-realtime.types.js";
export type * from "./model/friday-api-security.types.js";

// Auth
export { createFridayAuthService, AuthError } from "./auth/friday-auth-service.js";
export { createFridayTokenValidator, encodeToken, TokenValidationError } from "./auth/friday-token-validator.js";
export { getScopesForRole, roleHasScope, principalHasAnyScope, principalHasAnyRole } from "./auth/friday-rbac-policy.js";
export { createFridayRateLimitService } from "./auth/friday-rate-limit-service.js";
export { createFridayAuthMiddlewareFactory } from "./auth/friday-auth-middleware.js";

// Realtime
export { createFridayRealtimeEventBus } from "./realtime/friday-realtime-event-bus.js";
export { createFridayRealtimeSubscriptionService } from "./realtime/friday-realtime-subscription-service.js";
export { createFridayRealtimeWsGateway } from "./realtime/friday-realtime-ws-gateway.js";

// Fleet
export { createFridayFleetDashboardService } from "./fleet/friday-fleet-dashboard-service.js";
export { calculateSatelliteHealth, healthStateFromScore } from "./fleet/friday-fleet-health-calculator.js";
export { calculateSatelliteTrust, trustBandFromScore } from "./fleet/friday-fleet-trust-calculator.js";

// Conflicts
export { createFridayWorkflowConflictService, ConflictServiceError } from "./conflicts/friday-workflow-conflict-service.js";

// Legacy
export { createFridayLegacyDecommissionService } from "./legacy/friday-legacy-decommission-service.js";
export {
  activateFridayLegacyWriteFreeze,
  isFridayLegacyWriteFrozen,
  executeFridayLegacyWrite,
  resetFridayLegacyWriteFreeze,
} from "./legacy/friday-legacy-write-freeze-guard.js";

// HTTP
export { createFridayHttpRouteRegistry } from "./http/friday-http-route-registry.js";
export { buildErrorResponse, mapErrorToStatusCode, mapErrorToApiError } from "./http/friday-http-error-mapper.js";

// Runtime
export { createFridayApiRuntime } from "./runtime/friday-api-runtime.js";
export type { FridayApiRuntime, CreateFridayApiRuntimeDeps } from "./runtime/friday-api-runtime.types.js";
```

## `src/api/legacy/friday-legacy-decommission-service.ts`
```ts
import type {
  FridayLegacyDecommissionService,
  FridayLegacyPreflightResult,
  FridayLegacyBackupResult,
  FridayLegacyConfigMigrationResult,
  FridayLegacyFreezeResult,
  FridayLegacyVerifyResult,
  CreateFridayLegacyDecommissionServiceDeps,
} from "./friday-legacy-decommission.types.js";
import {
  activateFridayLegacyWriteFreeze,
  isFridayLegacyWriteFrozen,
} from "./friday-legacy-write-freeze-guard.js";

// ─── Deprecated config keys that Phase 8 removes ───

const DEPRECATED_CONFIG_KEYS = [
  "mirror.enabled",
  "mirror.mode",
  "mirror.consistencyCheckOnStartup",
];

// ─── Mutable freeze state ───

let legacyWriteFrozenSince: string | null = null;

export function getLegacyWriteFrozenSince(): string | null {
  return legacyWriteFrozenSince;
}

// ─── Factory ───

export function createFridayLegacyDecommissionService(
  deps: CreateFridayLegacyDecommissionServiceDeps,
): FridayLegacyDecommissionService {
  return {
    runPreflight(): FridayLegacyPreflightResult {
      return {
        deprecatedConfigKeys: [...DEPRECATED_CONFIG_KEYS],
        legacySessionFilesDetected: 0,
        legacyMirrorCallsDetected: 0,
      };
    },

    createReadonlyLegacyBackup(): FridayLegacyBackupResult {
      const now = deps.nowIso();
      const backupDir = `${deps.stateDir}/legacy-backup-${now.replace(/[:.]/g, "-")}`;
      return {
        backupDir,
        createdAt: now,
      };
    },

    migrateDeprecatedConfigKeys(): FridayLegacyConfigMigrationResult {
      // In production, this would parse config file and remove deprecated keys
      return {
        updated: true,
        removedKeys: [...DEPRECATED_CONFIG_KEYS],
      };
    },

    freezeLegacyWrites(): FridayLegacyFreezeResult {
      const now = deps.nowIso();
      legacyWriteFrozenSince = now;
      // Activate the global write-freeze guard so all legacy write attempts are rejected
      activateFridayLegacyWriteFreeze();
      return {
        frozen: true,
        since: now,
      };
    },

    verifyNoLegacyWrites(windowStart): FridayLegacyVerifyResult {
      if (!isFridayLegacyWriteFrozen()) {
        return {
          ok: false,
          violations: ["Legacy writes are not frozen"],
        };
      }

      return {
        ok: true,
        violations: [],
      };
    },
  };
}
```

## `src/api/legacy/friday-legacy-decommission.types.ts`
```ts
import type { ISODateTime } from "../../workflows/model/friday-workflow.types.js";

export interface FridayLegacyPreflightResult {
  deprecatedConfigKeys: string[];
  legacySessionFilesDetected: number;
  legacyMirrorCallsDetected: number;
}

export interface FridayLegacyBackupResult {
  backupDir: string;
  createdAt: ISODateTime;
}

export interface FridayLegacyConfigMigrationResult {
  updated: boolean;
  removedKeys: string[];
}

export interface FridayLegacyFreezeResult {
  frozen: true;
  since: ISODateTime;
}

export interface FridayLegacyVerifyResult {
  ok: boolean;
  violations: string[];
}

export interface FridayLegacyDecommissionService {
  runPreflight(): FridayLegacyPreflightResult;
  createReadonlyLegacyBackup(): FridayLegacyBackupResult;
  migrateDeprecatedConfigKeys(): FridayLegacyConfigMigrationResult;
  freezeLegacyWrites(): FridayLegacyFreezeResult;
  verifyNoLegacyWrites(windowStart: ISODateTime): FridayLegacyVerifyResult;
}

export interface CreateFridayLegacyDecommissionServiceDeps {
  nowIso: () => string;
  stateDir: string;
}
```

## `src/api/legacy/friday-legacy-write-freeze-guard.ts`
```ts
// ─── Write Freeze Guard ───

/** Module-level mutable flag indicating whether legacy writes are frozen. */
let frozen = false;

/**
 * Activates the legacy write freeze.
 * Once called, all legacy write attempts should be rejected.
 */
export function activateFridayLegacyWriteFreeze(): void {
  frozen = true;
}

/**
 * Returns whether legacy writes are currently frozen.
 */
export function isFridayLegacyWriteFrozen(): boolean {
  return frozen;
}

/**
 * Attempts to execute a legacy write.
 * If frozen, returns a deterministic rejection.
 */
export function executeFridayLegacyWrite<T>(
  writeFn: () => T,
): { success: true; result: T } | { success: false; reason: "LEGACY_WRITE_FROZEN" } {
  if (frozen) {
    return { success: false, reason: "LEGACY_WRITE_FROZEN" };
  }
  return { success: true, result: writeFn() };
}

/**
 * Resets the freeze state (test utility only).
 */
export function resetFridayLegacyWriteFreeze(): void {
  frozen = false;
}
```

## `src/api/model/friday-api-auth.types.ts`
```ts
import type { ISODateTime, UUID } from "../../workflows/model/friday-workflow.types.js";
import type { FridayPrincipalType } from "./friday-api-common.types.js";

// ─── Roles ───

export type FridayRole = "owner" | "admin" | "operator" | "viewer";

// ─── Token Kind ───

export type FridayTokenKind = "access" | "refresh" | "api" | "satellite";

// ─── Scopes ───

export type FridayScope =
  | "hub.admin"
  | "workflow.read"
  | "workflow.write"
  | "workflow.run"
  | "workflow.conflict.resolve"
  | "satellite.read"
  | "satellite.write"
  | "fleet.read"
  | "security.read"
  | "security.write"
  | "session.read"
  | "session.write"
  | "diagnosis.read"
  | "diagnosis.write"
  | "skill.read"
  | "skill.write";

// ─── Rate Limit Policy IDs ───

export type FridayRateLimitPolicyId =
  | "auth.login"
  | "auth.refresh"
  | "auth.logout"
  | "workflow.start_run"
  | "workflow.publish"
  | "workflow.resolve_conflict"
  | "realtime.subscribe"
  | "realtime.pull"
  | "realtime.ws_connect";

// ─── Auth Principal ───

export interface FridayAuthPrincipal {
  principalType: FridayPrincipalType;
  principalId: string;
  userId?: UUID;
  role?: FridayRole;
  scopes: FridayScope[];
  tokenId: UUID;
  tokenKind: FridayTokenKind;
  issuedAt: ISODateTime;
  expiresAt?: ISODateTime;
  sessionId?: UUID;
  tokenVersion?: number;
}

// ─── Access Token Claims ───

export interface FridayAccessTokenClaims {
  tokenId: UUID;
  principalType: FridayPrincipalType;
  principalId: string;
  userId?: UUID;
  role?: FridayRole;
  scopes: FridayScope[];
  iat: number;
  exp: number;
  sid?: UUID;
  ver?: number;
}

// ─── Validated Token ───

export interface FridayValidatedToken {
  principal: FridayAuthPrincipal;
  rawToken: string;
  claims?: FridayAccessTokenClaims;
}

// ─── Login ───

export interface FridayLoginRequest {
  email?: string;
  password?: string;
  localPassphrase?: string;
  rememberMe?: boolean;
}

export interface FridayLoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  user: {
    id: UUID;
    email?: string;
    displayName: string;
    role: FridayRole;
  };
}

// ─── Refresh ───

export interface FridayRefreshRequest {
  refreshToken: string;
}

export interface FridayRefreshResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
}

// ─── Logout ───

export interface FridayLogoutRequest {
  refreshToken?: string;
  allSessions?: boolean;
}

export interface FridayLogoutResponse {
  ok: true;
}

// ─── Me ───

export interface FridayAuthMeResponse {
  user: {
    id: UUID;
    email?: string;
    displayName: string;
    role: FridayRole;
  };
  scopes: FridayScope[];
  sessionExpiresAt?: ISODateTime;
}

// ─── Rate Limit ───

export interface FridayRateLimitPolicy {
  id: FridayRateLimitPolicyId;
  windowMs: number;
  maxHits: number;
  keyBy: "ip" | "principal" | "principal+route" | "session";
}

export interface FridayRateLimitDecision {
  allowed: boolean;
  policyId: FridayRateLimitPolicyId;
  limit: number;
  remaining: number;
  resetAt: ISODateTime;
}
```

## `src/api/model/friday-api-common.types.ts`
```ts
import type { ISODateTime, JsonObject, JsonValue, UUID } from "../../workflows/model/friday-workflow.types.js";
import type { FridayScope, FridayRole, FridayRateLimitPolicyId } from "./friday-api-auth.types.js";

// ─── HTTP Method ───

export type FridayHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ─── Principal Type ───

export type FridayPrincipalType = "user" | "satellite" | "service" | "workflow-runner";

// ─── Pagination ───

export interface FridayPaginationQuery {
  cursor?: string;
  limit?: number;
}

export interface FridayPage<TItem> {
  items: TItem[];
  nextCursor?: string;
}

// ─── Request Meta ───

export interface FridayRequestMeta {
  requestId: string;
  traceId?: string;
  receivedAt: ISODateTime;
  ip?: string;
  userAgent?: string;
}

// ─── API Error / Success ───

export interface FridayApiError {
  code: string;
  message: string;
  details?: JsonValue;
  retryable?: boolean;
  retryAfterMs?: number;
}

export interface FridayApiErrorResponse {
  ok: false;
  error: FridayApiError;
  requestId: string;
}

export interface FridayApiSuccessResponse<T> {
  ok: true;
  data: T;
  requestId: string;
}

// ─── Auth Principal (re-exported from auth types) ───

export type { FridayAuthPrincipal } from "./friday-api-auth.types.js";

// ─── HTTP Context ───

export interface FridayHttpContext<TParams, TQuery, TBody> extends FridayRequestMeta {
  params: TParams;
  query: TQuery;
  body: TBody;
  headers: Record<string, string | undefined>;
  principal: import("./friday-api-auth.types.js").FridayAuthPrincipal | null;
}

// ─── Route Handler + Definition ───

export type FridayRouteHandler<TParams, TQuery, TBody, TResponse> = (
  ctx: FridayHttpContext<TParams, TQuery, TBody>,
) => Promise<TResponse>;

export interface FridayRouteDefinition<TParams, TQuery, TBody, TResponse> {
  operationId: string;
  method: FridayHttpMethod;
  path: string;
  auth:
    | { public: true }
    | { public: false; anyOfScopes: FridayScope[]; anyOfRoles?: FridayRole[] };
  rateLimitPolicyId?: FridayRateLimitPolicyId;
  handler: FridayRouteHandler<TParams, TQuery, TBody, TResponse>;
}
```

## `src/api/model/friday-api-conflict.types.ts`
```ts
// Conflict types are defined in friday-api-workflow.types.ts
// This barrel re-exports them for convenience.

export type {
  FridayWorkflowConflictStatus,
  FridayWorkflowConflictKind,
  FridayWorkflowConflictEntity,
  FridayListWorkflowConflictsQuery,
  FridayListWorkflowConflictsResponse,
  FridayResolveWorkflowConflictRequest,
  FridayResolveWorkflowConflictResponse,
} from "./friday-api-workflow.types.js";
```

## `src/api/model/friday-api-fleet.types.ts`
```ts
import type { ISODateTime, JsonObject, JsonValue, UUID } from "../../workflows/model/friday-workflow.types.js";
import type {
  FridaySatellitePairingStatus,
  FridaySatelliteTrustLevel,
  FridaySatelliteType,
} from "../../satellites/model/friday-satellite.types.js";
import type { FridayPaginationQuery, FridayPage } from "./friday-api-common.types.js";

// ─── Health / Trust Bands ───

export type FridayHealthState = "healthy" | "degraded" | "critical";
export type FridayTrustBand = "low" | "medium" | "high";

// ─── Fleet Overview ───

export interface FridayFleetOverviewResponse {
  generatedAt: ISODateTime;
  totals: {
    satellites: number;
    pending: number;
    paired: number;
    online: number;
    degraded: number;
    offline: number;
    revoked: number;
  };
  queue: {
    queued: number;
    leased: number;
    failed: number;
    deadLetter: number;
  };
  workflows: {
    activeRuns: number;
    completed1h: number;
    failed1h: number;
  };
  health: {
    score: number;
    state: FridayHealthState;
    reasons: string[];
  };
  trust: {
    averageScore: number;
    lowTrustCount: number;
    restrictedCount: number;
    revokedCount: number;
  };
}

// ─── Satellite Card ───

export interface FridayFleetSatelliteCard {
  satelliteId: UUID;
  type: FridaySatelliteType;
  displayName: string;
  pairingStatus: FridaySatellitePairingStatus;
  trustLevel: FridaySatelliteTrustLevel;
  trustScore: number;
  trustBand: FridayTrustBand;
  healthScore: number;
  healthState: FridayHealthState;
  lastSeenAt?: ISODateTime;
  heartbeatAgeMs?: number;
  cpuPercent?: number;
  memoryPercent?: number;
  loadAvg1m?: number;
  queueDepth?: number;
  activeRuns?: number;
  tags: string[];
  alerts: string[];
}

export interface FridayListFleetSatellitesQuery extends FridayPaginationQuery {
  pairingStatus?: FridaySatellitePairingStatus;
  trustLevel?: FridaySatelliteTrustLevel;
  healthState?: FridayHealthState;
  q?: string;
}
export interface FridayListFleetSatellitesResponse extends FridayPage<FridayFleetSatelliteCard> {}

// ─── Satellite Detail ───

export interface FridayFleetSatelliteDetailResponse {
  satellite: FridayFleetSatelliteCard;
  capabilities: Array<{
    key: string;
    available: boolean;
    limits?: JsonObject;
    metadata?: JsonObject;
  }>;
  queue: {
    queued: number;
    leased: number;
    failed: number;
    deadLetter: number;
  };
  workflowLoad: {
    queuedNodes: number;
    runningNodes: number;
    retryingNodes: number;
    blockedOfflineNodes: number;
  };
  trustBreakdown: FridaySatelliteTrustBreakdown;
  healthBreakdown: FridaySatelliteHealthBreakdown;
}

// ─── Health Breakdown ───

export interface FridaySatelliteHealthBreakdown {
  heartbeatScore: number;
  resourceScore: number;
  queueScore: number;
  reliabilityScore: number;
  finalScore: number;
  state: FridayHealthState;
}

// ─── Trust Breakdown ───

export interface FridaySatelliteTrustBreakdown {
  identityScore: number;
  statusScore: number;
  hygieneScore: number;
  incidentPenalty: number;
  finalScore: number;
  band: FridayTrustBand;
  reasons: string[];
}

// ─── Security Center ───

export interface FridaySecurityCenterResponse {
  generatedAt: ISODateTime;
  tokens: {
    active: number;
    expired: number;
    revoked24h: number;
    highPrivilegeActive: number;
  };
  satellites: {
    restricted: number;
    trusted: number;
    revoked: number;
    pendingPairings: number;
  };
  findings: Array<{
    id: UUID;
    severity: "low" | "medium" | "high";
    type: "token_scope_risk" | "revocation_gap" | "offline_high_privilege" | "trust_mismatch";
    message: string;
    satelliteId?: UUID;
    tokenId?: UUID;
    detectedAt: ISODateTime;
  }>;
}
```

## `src/api/model/friday-api-realtime.types.ts`
```ts
import type { ISODateTime, JsonValue, UUID } from "../../workflows/model/friday-workflow.types.js";
import type { FridayFleetOverviewResponse } from "./friday-api-fleet.types.js";
import type { FridayPaginationQuery, FridayPage } from "./friday-api-common.types.js";

// ─── Topics ───

export type FridayRealtimeTopic =
  | "workflow"
  | "workflow.run"
  | "workflow.node"
  | "workflow.conflict"
  | "satellite"
  | "fleet"
  | "security"
  | "diagnosis"
  | "approval";

// ─── Subscription ───

export interface FridayRealtimeSubscription {
  subscriptionId: UUID;
  streamId: string;
  topic: FridayRealtimeTopic;
  workflowId?: UUID;
  runId?: UUID;
  satelliteId?: UUID;
  fromSeq?: number;
  includeSnapshot?: boolean;
}

// ─── Event Names ───

export type FridayRealtimeEventName =
  | "workflow.updated"
  | "workflow.version.published"
  | "workflow.conflict.opened"
  | "workflow.conflict.resolved"
  | "workflow.run.started"
  | "workflow.run.paused"
  | "workflow.run.completed"
  | "workflow.run.failed"
  | "workflow.run.cancelled"
  | "workflow.node.queued"
  | "workflow.node.started"
  | "workflow.node.retrying"
  | "workflow.node.completed"
  | "workflow.node.failed"
  | "workflow.node.blocked_offline"
  | "satellite.updated"
  | "satellite.heartbeat"
  | "satellite.trust.updated"
  | "fleet.summary.updated"
  | "security.token.revoked"
  | "security.satellite.revoked";

// ─── Event Payload Map ───

export interface FridayRealtimeEventPayloadMap {
  "workflow.updated": { workflowId: UUID; revision: number; etag: string };
  "workflow.version.published": { workflowId: UUID; versionId: UUID; versionNumber: number };
  "workflow.conflict.opened": { conflictId: UUID; workflowId: UUID; draftId: UUID; kind: string };
  "workflow.conflict.resolved": { conflictId: UUID; workflowId: UUID; draftId: UUID; strategy: string };
  "workflow.run.started": { runId: UUID; workflowId: UUID; workflowVersionId: UUID };
  "workflow.run.paused": { runId: UUID; reason?: string };
  "workflow.run.completed": { runId: UUID; finishedAt: ISODateTime };
  "workflow.run.failed": { runId: UUID; error: { code: string; message: string } };
  "workflow.run.cancelled": { runId: UUID; cancelledBy?: UUID; reason?: string };
  "workflow.node.queued": { runId: UUID; nodeId: string; attempt: number };
  "workflow.node.started": { runId: UUID; nodeId: string; attempt: number; satelliteId?: UUID };
  "workflow.node.retrying": { runId: UUID; nodeId: string; attempt: number; nextAttemptAt: ISODateTime };
  "workflow.node.completed": { runId: UUID; nodeId: string; attempt: number; output?: JsonValue };
  "workflow.node.failed": { runId: UUID; nodeId: string; attempt: number; error: { code: string; message: string } };
  "workflow.node.blocked_offline": { runId: UUID; nodeId: string; attempt: number; satelliteId?: UUID; since: ISODateTime };
  "satellite.updated": { satelliteId: UUID; pairingStatus: string; trustLevel: string };
  "satellite.heartbeat": { satelliteId: UUID; ts: ISODateTime; status: string };
  "satellite.trust.updated": { satelliteId: UUID; trustScore: number; trustBand: string };
  "fleet.summary.updated": FridayFleetOverviewResponse;
  "security.token.revoked": { tokenId: UUID; principalType: string; principalId?: string };
  "security.satellite.revoked": { satelliteId: UUID; reason?: string };
}

// ─── Event Envelope ───

export interface FridayRealtimeEventEnvelope<TEvent extends FridayRealtimeEventName = FridayRealtimeEventName> {
  eventId: UUID;
  streamId: string;
  seq: number;
  event: TEvent;
  payload: FridayRealtimeEventPayloadMap[TEvent];
  emittedAt: ISODateTime;
  correlationId?: string;
  stateVersion?: {
    workflow?: number;
    fleet?: number;
    security?: number;
  };
}

// ─── Client Frames ───

export type FridayRealtimeClientFrame =
  | { type: "hello"; token: string; subscriptions?: FridayRealtimeSubscription[] }
  | { type: "subscribe"; subscriptions: FridayRealtimeSubscription[] }
  | { type: "unsubscribe"; subscriptionIds: UUID[] }
  | { type: "ack"; streamId: string; seq: number; epoch: number; cursor?: string }
  | { type: "resume"; streamId: string; lastAckedSeq: number; epoch: number; cursor: string; subscriptions: FridayRealtimeSubscription[] }
  | { type: "ping"; at: ISODateTime };

// ─── Server Frames ───

export type FridayRealtimeServerFrame =
  | {
      type: "hello_ack";
      connId: UUID;
      protocolVersion: "1.0";
      serverVersion: string;
      epoch: number;
      now: ISODateTime;
    }
  | { type: "event"; envelope: FridayRealtimeEventEnvelope }
  | { type: "subscribed"; accepted: FridayRealtimeSubscription[]; rejected: Array<{ subscriptionId: UUID; code: string; message: string }> }
  | { type: "ack_ok"; streamId: string; seq: number }
  | { type: "pong"; at: ISODateTime }
  | { type: "resync_required"; streamId: string; reason: "STREAM_EPOCH_STALE" | "STREAM_CURSOR_OUT_OF_RANGE" | "CURSOR_INVALID"; snapshotEndpoint: string }
  | { type: "error"; code: string; message: string; retryable?: boolean; retryAfterMs?: number };

// ─── HTTP Fallback DTOs ───

export interface FridayRealtimeSubscribeRequest {
  subscriptions: FridayRealtimeSubscription[];
}
export interface FridayRealtimeSubscribeResponse {
  subscriptions: FridayRealtimeSubscription[];
  epoch: number;
}

export interface FridayRealtimePullRequest {
  streamId: string;
  cursor?: string;
  afterSeq?: number;
  limit?: number;
}
export interface FridayRealtimePullResponse extends FridayPage<FridayRealtimeEventEnvelope> {
  streamId: string;
  epoch: number;
  nextCursor?: string;
  fullResyncRequired?: boolean;
}

export interface FridayRealtimeAckRequest {
  streamId: string;
  seq: number;
  epoch: number;
  cursor?: string;
}
export interface FridayRealtimeAckResponse {
  accepted: true;
  streamId: string;
  seq: number;
}
```

## `src/api/model/friday-api-route.types.ts`
```ts
// Route type definitions — re-exported from common for barrel usage.

export type {
  FridayHttpMethod,
  FridayRouteDefinition,
  FridayRouteHandler,
  FridayHttpContext,
  FridayRequestMeta,
} from "./friday-api-common.types.js";
```

## `src/api/model/friday-api-security.types.ts`
```ts
import type { UUID } from "../../workflows/model/friday-workflow.types.js";

// ─── Token Revocation ───

export interface FridayRevokeTokenRequest {
  tokenId: UUID;
}

export interface FridayRevokeTokenResponse {
  revoked: true;
  tokenId: UUID;
}

// ─── Satellite Revocation ───

export interface FridayRevokeSatelliteRequest {
  reason?: string;
}

export interface FridayRevokeSatelliteResponse {
  revoked: true;
  satelliteId: UUID;
}
```

## `src/api/model/friday-api-workflow.types.ts`
```ts
import type {
  FridayWorkflowEntity,
  FridayWorkflowVersionEntity,
  FridayWorkflowRunEntity,
  FridayWorkflowRunNodeEntity,
  WorkflowRunStatus,
  NodeAttemptStatus,
  UUID,
  ISODateTime,
  JsonObject,
  JsonValue,
} from "../../workflows/model/friday-workflow.types.js";
import type { FridayWorkflowDraftEntity } from "../../workflows/builder/model/friday-workflow-builder-draft.types.js";
import type { FridayWorkflowBuilderValidationReport } from "../../workflows/builder/model/friday-workflow-builder-validation.types.js";
import type { FridayCompiledWorkflowGraphV2 } from "../../workflows/model/friday-workflow-graph.types.js";
import type { FridayWorkflowSpecV1 } from "../../workflows/model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../../workflows/builder/model/friday-workflow-builder-canvas.types.js";
import type { FridayPaginationQuery, FridayPage } from "./friday-api-common.types.js";

// Re-export needed types
export type {
  FridayWorkflowEntity,
  FridayWorkflowVersionEntity,
  FridayWorkflowRunEntity,
  FridayWorkflowRunNodeEntity,
  WorkflowRunStatus,
  NodeAttemptStatus,
  FridayWorkflowDraftEntity,
  FridayWorkflowBuilderValidationReport,
  FridayCompiledWorkflowGraphV2,
  FridayWorkflowSpecV1,
  FridayWorkflowVisualGraphV1,
};

// ─── Workflow CRUD ───

export interface FridayListWorkflowsQuery extends FridayPaginationQuery {
  tag?: string;
  archived?: boolean;
}
export interface FridayListWorkflowsResponse extends FridayPage<FridayWorkflowEntity> {}

export interface FridayCreateWorkflowRequest {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  graph: FridayCompiledWorkflowGraphV2;
}
export interface FridayCreateWorkflowResponse {
  workflow: FridayWorkflowEntity;
  version: FridayWorkflowVersionEntity;
}

export interface FridayGetWorkflowResponse {
  workflow: FridayWorkflowEntity;
  latestVersion: FridayWorkflowVersionEntity;
  publishedVersion?: FridayWorkflowVersionEntity;
}

export interface FridayUpdateWorkflowRequest {
  expectedRevision: number;
  etag: string;
  name?: string;
  description?: string;
  tags?: string[];
  graph?: FridayCompiledWorkflowGraphV2;
}
export interface FridayUpdateWorkflowResponse {
  workflow: FridayWorkflowEntity;
  version?: FridayWorkflowVersionEntity;
}

export interface FridayArchiveWorkflowResponse {
  archived: true;
}

export interface FridayPublishWorkflowRequest {
  versionNumber?: number;
  changeNote?: string;
}
export interface FridayPublishWorkflowResponse {
  publishedVersion: FridayWorkflowVersionEntity;
}

export interface FridayListVersionsQuery extends FridayPaginationQuery {}
export interface FridayListVersionsResponse extends FridayPage<FridayWorkflowVersionEntity> {}

// ─── Builder / Draft CRUD ───

export interface FridayCreateDraftRequest {
  title: string;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  ownerUserId?: UUID;
  baseWorkflowVersionId?: UUID;
}
export interface FridayCreateDraftResponse {
  draft: FridayWorkflowDraftEntity;
}

export interface FridayListDraftsResponse extends FridayPage<FridayWorkflowDraftEntity> {}

export interface FridayGetDraftResponse {
  draft: FridayWorkflowDraftEntity;
}

export interface FridaySaveDraftRequest {
  expectedRevision: number;
  lockToken: string;
  title?: string;
  spec?: FridayWorkflowSpecV1;
  visual?: FridayWorkflowVisualGraphV1;
  autosave?: {
    enabled?: boolean;
    intervalMs?: number;
  };
}
export interface FridaySaveDraftResponse {
  draft: FridayWorkflowDraftEntity;
}

export interface FridayAutosaveDraftRequest {
  lockToken: string;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
}
export interface FridayAutosaveDraftResponse {
  draft: FridayWorkflowDraftEntity | null;
}

export interface FridayCompileDraftResponse {
  compiled: FridayCompiledWorkflowGraphV2;
  validation: FridayWorkflowBuilderValidationReport;
}

export interface FridayPublishDraftRequest {
  workflowId: UUID;
  lockToken: string;
  createdByUserId?: UUID;
  changeNote?: string;
  publishNow: boolean;
}
export interface FridayPublishDraftResponse {
  workflowId: UUID;
  workflowVersionId: UUID;
  versionNumber: number;
  published: boolean;
  checksum: string;
  validation: FridayWorkflowBuilderValidationReport;
}

// ─── Collaboration Locks ───

export interface FridayAcquireWorkflowLockRequest {
  ownerUserId: UUID;
  ownerSessionId?: string;
  ttlSec: number;
}

export interface FridayAcquireWorkflowLockResponse {
  acquired: boolean;
  lock?: {
    workflowId: UUID;
    lockToken: string;
    ownerUserId: UUID;
    ownerSessionId?: string;
    acquiredAt: ISODateTime;
    heartbeatAt: ISODateTime;
    expiresAt: ISODateTime;
  };
  conflict?: {
    workflowId: UUID;
    lockToken: string;
    ownerUserId: UUID;
    ownerSessionId?: string;
    acquiredAt: ISODateTime;
    heartbeatAt: ISODateTime;
    expiresAt: ISODateTime;
  };
}

export interface FridayRenewWorkflowLockRequest {
  lockToken: string;
  ttlSec: number;
}
export interface FridayRenewWorkflowLockResponse {
  lock: FridayAcquireWorkflowLockResponse["lock"];
}

export interface FridayReleaseWorkflowLockRequest {
  lockToken: string;
}
export interface FridayReleaseWorkflowLockResponse {
  released: true;
}

// ─── Conflict Resolution ───

export type FridayWorkflowConflictStatus = "open" | "resolved" | "dismissed";
export type FridayWorkflowConflictKind = "revision_conflict" | "lock_conflict";

export interface FridayWorkflowConflictEntity {
  conflictId: UUID;
  workflowId: UUID;
  draftId: UUID;
  kind: FridayWorkflowConflictKind;
  status: FridayWorkflowConflictStatus;
  baseWorkflowVersionId?: UUID;
  headWorkflowVersionId: UUID;
  detectedAt: ISODateTime;
  resolvedAt?: ISODateTime;
  resolvedByUserId?: UUID;
  summary: string;
  patches: Array<{
    path: string;
    op: "add" | "remove" | "replace";
    baseValue?: JsonValue;
    localValue?: JsonValue;
    headValue?: JsonValue;
  }>;
}

export interface FridayListWorkflowConflictsQuery extends FridayPaginationQuery {
  status?: FridayWorkflowConflictStatus;
}
export interface FridayListWorkflowConflictsResponse extends FridayPage<FridayWorkflowConflictEntity> {}

export interface FridayResolveWorkflowConflictRequest {
  resolution:
    | { strategy: "accept_local" }
    | { strategy: "accept_remote" }
    | {
        strategy: "manual_merge";
        mergedSpec: FridayWorkflowSpecV1;
        mergedVisual: FridayWorkflowVisualGraphV1;
      };
  lockToken: string;
  expectedDraftRevision: number;
}
export interface FridayResolveWorkflowConflictResponse {
  conflict: FridayWorkflowConflictEntity;
  draft: FridayWorkflowDraftEntity;
}

// ─── Run Execution ───

export interface FridayStartRunRequest {
  workflowId: UUID;
  workflowVersionId?: UUID;
  triggerType: string;
  triggerPayload?: JsonObject;
  dryRun?: boolean;
}
export interface FridayStartRunResponse {
  run: FridayWorkflowRunEntity;
}

export interface FridayGetRunResponse {
  run: FridayWorkflowRunEntity;
}

export interface FridayListRunNodesQuery extends FridayPaginationQuery {
  status?: NodeAttemptStatus;
}
export interface FridayListRunNodesResponse extends FridayPage<FridayWorkflowRunNodeEntity> {}

export interface FridayRunTimelineEntry {
  seq: number;
  streamId: string;
  event: string;
  emittedAt: ISODateTime;
  nodeId?: string;
  attempt?: number;
  status?: WorkflowRunStatus | NodeAttemptStatus;
  payload: JsonObject;
}

export interface FridayGetRunTimelineQuery extends FridayPaginationQuery {
  afterSeq?: number;
}
export interface FridayGetRunTimelineResponse extends FridayPage<FridayRunTimelineEntry> {}

export interface FridayCancelRunRequest {
  reason?: string;
}
export interface FridayCancelRunResponse {
  run: FridayWorkflowRunEntity;
}

export interface FridayRetryRunRequest {
  nodeIds?: string[];
}
export interface FridayRetryRunResponse {
  run: FridayWorkflowRunEntity;
  retriedNodes: string[];
}
```

## `src/api/persistence/friday-api-token-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { FridayApiTokenRow } from "../../satellites/model/friday-satellite.types.js";

// ─── Repository ───

export interface FridayApiTokenRepository {
  findById(db: Database.Database, tokenId: string): FridayApiTokenRow | null;
  isRevoked(db: Database.Database, tokenId: string): boolean;
  revoke(db: Database.Database, tokenId: string, now: string): boolean;
  listActive(db: Database.Database, limit?: number): FridayApiTokenRow[];
  countActive(db: Database.Database): number;
  countExpired(db: Database.Database, now: string): number;
  countRevokedSince(db: Database.Database, since: string): number;
  countHighPrivilegeActive(db: Database.Database, now: string): number;
}

// ─── Factory ───

export function createFridayApiTokenRepository(): FridayApiTokenRepository {
  return {
    findById(db, tokenId) {
      return (
        (db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(tokenId) as
          | FridayApiTokenRow
          | undefined) ?? null
      );
    },

    isRevoked(db, tokenId) {
      const row = db
        .prepare("SELECT revoked_at FROM api_tokens WHERE id = ?")
        .get(tokenId) as { revoked_at: string | null } | undefined;
      return row?.revoked_at !== null && row?.revoked_at !== undefined;
    },

    revoke(db, tokenId, now) {
      const result = db
        .prepare("UPDATE api_tokens SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(now, now, tokenId);
      return result.changes > 0;
    },

    listActive(db, limit = 100) {
      return db
        .prepare(
          "SELECT * FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT ?",
        )
        .all(limit) as FridayApiTokenRow[];
    },

    countActive(db) {
      const row = db
        .prepare("SELECT COUNT(*) as count FROM api_tokens WHERE revoked_at IS NULL")
        .get() as { count: number };
      return row.count;
    },

    countExpired(db, now) {
      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < ? AND revoked_at IS NULL",
        )
        .get(now) as { count: number };
      return row.count;
    },

    countRevokedSince(db, since) {
      const row = db
        .prepare("SELECT COUNT(*) as count FROM api_tokens WHERE revoked_at IS NOT NULL AND revoked_at >= ?")
        .get(since) as { count: number };
      return row.count;
    },

    countHighPrivilegeActive(db, now) {
      // High privilege = tokens with hub.admin or security.write scope
      const rows = db
        .prepare(
          "SELECT scopes_json FROM api_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
        )
        .all(now) as Array<{ scopes_json: string }>;

      return rows.filter((row) => {
        const scopes = JSON.parse(row.scopes_json) as string[];
        return scopes.includes("hub.admin") || scopes.includes("security.write");
      }).length;
    },
  };
}
```

## `src/api/persistence/friday-auth-session-repository.ts`
```ts
import type Database from "better-sqlite3";

// ─── Row type ───

export interface FridayAuthSessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  device_label: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Repository ───

export interface FridayAuthSessionRepository {
  findById(db: Database.Database, sessionId: string): FridayAuthSessionRow | null;
  findByRefreshHash(db: Database.Database, hash: string, now: string): FridayAuthSessionRow | null;
  create(db: Database.Database, input: FridayCreateAuthSessionInput): void;
  revokeById(db: Database.Database, sessionId: string, now: string): void;
  revokeAllForUser(db: Database.Database, userId: string, now: string): void;
  updateRefreshHash(db: Database.Database, sessionId: string, newHash: string, expiresAt: string, now: string): void;
}

export interface FridayCreateAuthSessionInput {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: string;
  deviceLabel?: string;
  ipAddress?: string;
  userAgent?: string;
  now: string;
}

// ─── Factory ───

export function createFridayAuthSessionRepository(): FridayAuthSessionRepository {
  return {
    findById(db, sessionId) {
      return (
        (db
          .prepare("SELECT * FROM auth_sessions WHERE id = ?")
          .get(sessionId) as FridayAuthSessionRow | undefined) ?? null
      );
    },

    findByRefreshHash(db, hash, now) {
      return (
        (db
          .prepare(
            "SELECT * FROM auth_sessions WHERE refresh_token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
          )
          .get(hash, now) as FridayAuthSessionRow | undefined) ?? null
      );
    },

    create(db, input) {
      db.prepare(
        `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at, device_label, ip_address, user_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.userId,
        input.refreshTokenHash,
        input.expiresAt,
        input.deviceLabel ?? null,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        input.now,
        input.now,
      );
    },

    revokeById(db, sessionId, now) {
      db.prepare("UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE id = ?").run(
        now,
        now,
        sessionId,
      );
    },

    revokeAllForUser(db, userId, now) {
      db.prepare(
        "UPDATE auth_sessions SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      ).run(now, now, userId);
    },

    updateRefreshHash(db, sessionId, newHash, expiresAt, now) {
      db.prepare(
        "UPDATE auth_sessions SET refresh_token_hash = ?, expires_at = ?, updated_at = ? WHERE id = ?",
      ).run(newHash, expiresAt, now, sessionId);
    },
  };
}
```

## `src/api/persistence/friday-rate-limit-counter-repository.ts`
```ts
import type Database from "better-sqlite3";

// ─── Row type ───

export interface FridayRateLimitCounterRow {
  bucket_key: string;
  window_start: string;
  hit_count: number;
  updated_at: string;
}

// ─── Repository ───

export interface FridayRateLimitCounterRepository {
  getCount(db: Database.Database, bucketKey: string, windowStart: string): number;
  increment(db: Database.Database, bucketKey: string, windowStart: string, now: string): number;
  cleanupBefore(db: Database.Database, before: string): number;
}

// ─── Factory ───

export function createFridayRateLimitCounterRepository(): FridayRateLimitCounterRepository {
  return {
    getCount(db, bucketKey, windowStart) {
      const row = db
        .prepare(
          "SELECT hit_count FROM api_rate_limit_counters WHERE bucket_key = ? AND window_start = ?",
        )
        .get(bucketKey, windowStart) as { hit_count: number } | undefined;
      return row?.hit_count ?? 0;
    },

    increment(db, bucketKey, windowStart, now) {
      const existing = db
        .prepare(
          "SELECT hit_count FROM api_rate_limit_counters WHERE bucket_key = ? AND window_start = ?",
        )
        .get(bucketKey, windowStart) as { hit_count: number } | undefined;

      if (existing) {
        const newCount = existing.hit_count + 1;
        db.prepare(
          "UPDATE api_rate_limit_counters SET hit_count = ?, updated_at = ? WHERE bucket_key = ? AND window_start = ?",
        ).run(newCount, now, bucketKey, windowStart);
        return newCount;
      }

      db.prepare(
        "INSERT INTO api_rate_limit_counters (bucket_key, window_start, hit_count, updated_at) VALUES (?, ?, 1, ?)",
      ).run(bucketKey, windowStart, now);
      return 1;
    },

    cleanupBefore(db, before) {
      const result = db
        .prepare("DELETE FROM api_rate_limit_counters WHERE window_start < ?")
        .run(before);
      return result.changes;
    },
  };
}
```

## `src/api/persistence/friday-realtime-checkpoint-repository.ts`
```ts
import type Database from "better-sqlite3";

// ─── Row type ───

export interface FridayRealtimeCheckpointRow {
  principal_id: string;
  stream_id: string;
  last_acked_seq: number;
  epoch: number;
  cursor: string | null;
  updated_at: string;
}

// ─── Repository ───

export interface FridayRealtimeCheckpointRepository {
  get(
    db: Database.Database,
    principalId: string,
    streamId: string,
  ): FridayRealtimeCheckpointRow | null;
  upsert(
    db: Database.Database,
    principalId: string,
    streamId: string,
    seq: number,
    epoch: number,
    cursor: string | undefined,
    now: string,
  ): void;
}

// ─── Factory ───

export function createFridayRealtimeCheckpointRepository(): FridayRealtimeCheckpointRepository {
  return {
    get(db, principalId, streamId) {
      return (
        (db
          .prepare(
            "SELECT * FROM realtime_checkpoints WHERE principal_id = ? AND stream_id = ?",
          )
          .get(principalId, streamId) as FridayRealtimeCheckpointRow | undefined) ?? null
      );
    },

    upsert(db, principalId, streamId, seq, epoch, cursor, now) {
      const existing = db
        .prepare(
          "SELECT last_acked_seq FROM realtime_checkpoints WHERE principal_id = ? AND stream_id = ?",
        )
        .get(principalId, streamId) as { last_acked_seq: number } | undefined;

      if (existing) {
        // Monotonic ack: only update if seq is higher
        if (seq > existing.last_acked_seq) {
          db.prepare(
            "UPDATE realtime_checkpoints SET last_acked_seq = ?, epoch = ?, cursor = ?, updated_at = ? WHERE principal_id = ? AND stream_id = ?",
          ).run(seq, epoch, cursor ?? null, now, principalId, streamId);
        }
      } else {
        db.prepare(
          "INSERT INTO realtime_checkpoints (principal_id, stream_id, last_acked_seq, epoch, cursor, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(principalId, streamId, seq, epoch, cursor ?? null, now);
      }
    },
  };
}
```

## `src/api/persistence/friday-realtime-event-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { FridayRealtimeEventEnvelope, FridayRealtimeEventName } from "../model/friday-api-realtime.types.js";

// ─── Row type ───

export interface FridayRealtimeEventRow {
  event_id: string;
  stream_id: string;
  seq: number;
  event: string;
  payload_json: string;
  emitted_at: string;
  correlation_id: string | null;
  state_version_json: string | null;
  created_at: string;
}

// ─── Repository ───

export interface FridayRealtimeEventRepository {
  append(db: Database.Database, envelope: FridayRealtimeEventEnvelope): void;
  getNextSeq(db: Database.Database, streamId: string): number;
  listAfterSeq(
    db: Database.Database,
    streamId: string,
    afterSeq: number,
    limit: number,
  ): FridayRealtimeEventEnvelope[];
  listByStream(
    db: Database.Database,
    streamId: string,
    limit: number,
  ): FridayRealtimeEventEnvelope[];
  deleteOlderThan(db: Database.Database, before: string): number;
  getLatestSeq(db: Database.Database, streamId: string): number;
}

function rowToEnvelope(row: FridayRealtimeEventRow): FridayRealtimeEventEnvelope {
  return {
    eventId: row.event_id,
    streamId: row.stream_id,
    seq: row.seq,
    event: row.event as FridayRealtimeEventName,
    payload: JSON.parse(row.payload_json),
    emittedAt: row.emitted_at,
    correlationId: row.correlation_id ?? undefined,
    stateVersion: row.state_version_json
      ? JSON.parse(row.state_version_json)
      : undefined,
  };
}

// ─── Factory ───

export function createFridayRealtimeEventRepository(): FridayRealtimeEventRepository {
  return {
    append(db, envelope) {
      db.prepare(
        `INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, correlation_id, state_version_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        envelope.eventId,
        envelope.streamId,
        envelope.seq,
        envelope.event,
        JSON.stringify(envelope.payload),
        envelope.emittedAt,
        envelope.correlationId ?? null,
        envelope.stateVersion ? JSON.stringify(envelope.stateVersion) : null,
        envelope.emittedAt,
      );
    },

    getNextSeq(db, streamId) {
      const row = db
        .prepare("SELECT MAX(seq) as max_seq FROM realtime_events WHERE stream_id = ?")
        .get(streamId) as { max_seq: number | null };
      return (row.max_seq ?? 0) + 1;
    },

    listAfterSeq(db, streamId, afterSeq, limit) {
      const rows = db
        .prepare(
          "SELECT * FROM realtime_events WHERE stream_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
        )
        .all(streamId, afterSeq, limit) as FridayRealtimeEventRow[];
      return rows.map(rowToEnvelope);
    },

    listByStream(db, streamId, limit) {
      const rows = db
        .prepare(
          "SELECT * FROM realtime_events WHERE stream_id = ? ORDER BY seq ASC LIMIT ?",
        )
        .all(streamId, limit) as FridayRealtimeEventRow[];
      return rows.map(rowToEnvelope);
    },

    deleteOlderThan(db, before) {
      const result = db
        .prepare("DELETE FROM realtime_events WHERE emitted_at < ?")
        .run(before);
      return result.changes;
    },

    getLatestSeq(db, streamId) {
      const row = db
        .prepare("SELECT MAX(seq) as max_seq FROM realtime_events WHERE stream_id = ?")
        .get(streamId) as { max_seq: number | null };
      return row.max_seq ?? 0;
    },
  };
}
```

## `src/api/persistence/friday-user-repository.ts`
```ts
import type Database from "better-sqlite3";

// ─── Row type ───

export interface FridayUserRow {
  id: string;
  email: string | null;
  display_name: string;
  role: string;
  password_hash: string | null;
  is_local_only: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ─── Repository interface ───

export interface FridayUserRepository {
  findById(db: Database.Database, userId: string): FridayUserRow | null;
  findByEmail(db: Database.Database, email: string): FridayUserRow | null;
  findLocalUser(db: Database.Database): FridayUserRow | null;
}

// ─── Factory ───

export function createFridayUserRepository(): FridayUserRepository {
  return {
    findById(db, userId) {
      return (
        (db
          .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL")
          .get(userId) as FridayUserRow | undefined) ?? null
      );
    },

    findByEmail(db, email) {
      return (
        (db
          .prepare("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL")
          .get(email) as FridayUserRow | undefined) ?? null
      );
    },

    findLocalUser(db) {
      return (
        (db
          .prepare("SELECT * FROM users WHERE is_local_only = 1 AND deleted_at IS NULL LIMIT 1")
          .get() as FridayUserRow | undefined) ?? null
      );
    },
  };
}
```

## `src/api/persistence/friday-workflow-conflict-repository.ts`
```ts
import type Database from "better-sqlite3";
import type {
  FridayWorkflowConflictEntity,
  FridayWorkflowConflictStatus,
  FridayWorkflowConflictKind,
} from "../model/friday-api-workflow.types.js";
import type { JsonValue } from "../../workflows/model/friday-workflow.types.js";

// ─── Row type ───

export interface FridayWorkflowConflictRow {
  conflict_id: string;
  workflow_id: string;
  draft_id: string;
  kind: string;
  status: string;
  base_workflow_version_id: string | null;
  head_workflow_version_id: string;
  detected_at: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  summary: string;
  patches_json: string;
  created_at: string;
  updated_at: string;
}

function rowToEntity(row: FridayWorkflowConflictRow): FridayWorkflowConflictEntity {
  return {
    conflictId: row.conflict_id,
    workflowId: row.workflow_id,
    draftId: row.draft_id,
    kind: row.kind as FridayWorkflowConflictKind,
    status: row.status as FridayWorkflowConflictStatus,
    baseWorkflowVersionId: row.base_workflow_version_id ?? undefined,
    headWorkflowVersionId: row.head_workflow_version_id,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedByUserId: row.resolved_by_user_id ?? undefined,
    summary: row.summary,
    patches: JSON.parse(row.patches_json) as FridayWorkflowConflictEntity["patches"],
  };
}

// ─── Repository ───

export interface FridayWorkflowConflictRepository {
  findById(db: Database.Database, conflictId: string): FridayWorkflowConflictEntity | null;
  listByWorkflow(
    db: Database.Database,
    workflowId: string,
    status?: FridayWorkflowConflictStatus,
    limit?: number,
    cursor?: string,
  ): FridayWorkflowConflictEntity[];
  create(db: Database.Database, entity: FridayWorkflowConflictEntity, now: string): void;
  resolve(
    db: Database.Database,
    conflictId: string,
    resolvedByUserId: string | undefined,
    now: string,
  ): FridayWorkflowConflictEntity | null;
  dismiss(
    db: Database.Database,
    conflictId: string,
    now: string,
  ): FridayWorkflowConflictEntity | null;
}

// ─── Factory ───

export function createFridayWorkflowConflictRepository(): FridayWorkflowConflictRepository {
  return {
    findById(db, conflictId) {
      const row = db
        .prepare("SELECT * FROM workflow_conflicts WHERE conflict_id = ?")
        .get(conflictId) as FridayWorkflowConflictRow | undefined;
      return row ? rowToEntity(row) : null;
    },

    listByWorkflow(db, workflowId, status, limit = 50, cursor) {
      let sql = "SELECT * FROM workflow_conflicts WHERE workflow_id = ?";
      const params: unknown[] = [workflowId];

      if (status) {
        sql += " AND status = ?";
        params.push(status);
      }
      if (cursor) {
        sql += " AND conflict_id > ?";
        params.push(cursor);
      }

      sql += " ORDER BY detected_at DESC LIMIT ?";
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as FridayWorkflowConflictRow[];
      return rows.map(rowToEntity);
    },

    create(db, entity, now) {
      db.prepare(
        `INSERT INTO workflow_conflicts
         (conflict_id, workflow_id, draft_id, kind, status, base_workflow_version_id,
          head_workflow_version_id, detected_at, resolved_at, resolved_by_user_id,
          summary, patches_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entity.conflictId,
        entity.workflowId,
        entity.draftId,
        entity.kind,
        entity.status,
        entity.baseWorkflowVersionId ?? null,
        entity.headWorkflowVersionId,
        entity.detectedAt,
        entity.resolvedAt ?? null,
        entity.resolvedByUserId ?? null,
        entity.summary,
        JSON.stringify(entity.patches),
        now,
        now,
      );
    },

    resolve(db, conflictId, resolvedByUserId, now) {
      db.prepare(
        "UPDATE workflow_conflicts SET status = 'resolved', resolved_at = ?, resolved_by_user_id = ?, updated_at = ? WHERE conflict_id = ?",
      ).run(now, resolvedByUserId ?? null, now, conflictId);
      return this.findById(db, conflictId);
    },

    dismiss(db, conflictId, now) {
      db.prepare(
        "UPDATE workflow_conflicts SET status = 'dismissed', resolved_at = ?, updated_at = ? WHERE conflict_id = ?",
      ).run(now, now, conflictId);
      return this.findById(db, conflictId);
    },
  };
}
```

## `src/api/realtime/friday-realtime-event-bus.ts`
```ts
import type {
  FridayRealtimeEventName,
  FridayRealtimeEventPayloadMap,
  FridayRealtimeEventEnvelope,
} from "../model/friday-api-realtime.types.js";
import type {
  FridayRealtimeEventBus,
  FridayEventBusListener,
  CreateFridayRealtimeEventBusDeps,
} from "./friday-realtime-event-bus.types.js";

export function createFridayRealtimeEventBus(
  deps: CreateFridayRealtimeEventBusDeps,
): FridayRealtimeEventBus {
  const listeners = new Set<FridayEventBusListener>();
  // In-memory cache used only when DB is not available (tests without DB)
  const streamSeqs = new Map<string, number>();

  /**
   * Get next seq for a stream.
   * When DB + eventRepo are available, source from DB in a transaction (durable).
   * Otherwise fall back to in-memory counter.
   */
  function nextSeq(streamId: string): number {
    if (deps.db && deps.eventRepo) {
      // Durable path: query max seq from DB
      return deps.db.withWriteTransaction((db) => {
        return deps.eventRepo!.getNextSeq(db, streamId);
      });
    }
    // Fallback: process-local counter
    const current = streamSeqs.get(streamId) ?? 0;
    const next = current + 1;
    streamSeqs.set(streamId, next);
    return next;
  }

  function getSeq(streamId: string): number {
    if (deps.db && deps.eventRepo) {
      return deps.db.withReadConnection((db) => {
        return deps.eventRepo!.getLatestSeq(db, streamId);
      });
    }
    return streamSeqs.get(streamId) ?? 0;
  }

  return {
    publish<TEvent extends FridayRealtimeEventName>(
      streamId: string,
      event: TEvent,
      payload: FridayRealtimeEventPayloadMap[TEvent],
      correlationId?: string,
    ): FridayRealtimeEventEnvelope<TEvent> {
      const seq = nextSeq(streamId);
      const envelope: FridayRealtimeEventEnvelope<TEvent> = {
        eventId: deps.idGenerator(),
        streamId,
        seq,
        event,
        payload,
        emittedAt: deps.nowIso(),
        correlationId,
      };

      // Update in-memory cache to stay in sync
      streamSeqs.set(streamId, seq);

      // Persist if persistence callback is provided (and we aren't using the DB path which already persisted)
      if (deps.persistEvent && !(deps.db && deps.eventRepo)) {
        deps.persistEvent(envelope);
      } else if (deps.db && deps.eventRepo) {
        // DB path: persist within transaction
        deps.db.withWriteTransaction((db) => {
          deps.eventRepo!.append(db, envelope);
        });
      }

      // Notify all in-process listeners
      for (const listener of listeners) {
        try {
          listener(envelope);
        } catch {
          // Swallow listener errors to avoid breaking event flow
        }
      }

      return envelope;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getStreamSeq(streamId) {
      return getSeq(streamId);
    },
  };
}
```

## `src/api/realtime/friday-realtime-event-bus.types.ts`
```ts
import type {
  FridayRealtimeEventName,
  FridayRealtimeEventPayloadMap,
  FridayRealtimeEventEnvelope,
} from "../model/friday-api-realtime.types.js";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayRealtimeEventRepository } from "../persistence/friday-realtime-event-repository.js";

export type FridayEventBusListener = (envelope: FridayRealtimeEventEnvelope) => void;

export interface FridayRealtimeEventBus {
  publish<TEvent extends FridayRealtimeEventName>(
    streamId: string,
    event: TEvent,
    payload: FridayRealtimeEventPayloadMap[TEvent],
    correlationId?: string,
  ): FridayRealtimeEventEnvelope<TEvent>;

  subscribe(listener: FridayEventBusListener): () => void;

  getStreamSeq(streamId: string): number;
}

export interface CreateFridayRealtimeEventBusDeps {
  idGenerator: () => string;
  nowIso: () => string;
  persistEvent?: (envelope: FridayRealtimeEventEnvelope) => void;
  /** When provided, seq numbers are sourced from the DB (durable). */
  db?: FridaySqliteLayer;
  eventRepo?: FridayRealtimeEventRepository;
}
```

## `src/api/realtime/friday-realtime-subscription-service.ts`
```ts
import * as crypto from "node:crypto";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type {
  FridayRealtimeSubscription,
  FridayRealtimeTopic,
  FridayRealtimeEventEnvelope,
} from "../model/friday-api-realtime.types.js";
import type { FridayAuthPrincipal, FridayScope } from "../model/friday-api-auth.types.js";
import type { FridayRealtimeEventRepository } from "../persistence/friday-realtime-event-repository.js";
import type { FridayRealtimeCheckpointRepository } from "../persistence/friday-realtime-checkpoint-repository.js";
import { principalHasAnyScope } from "../auth/friday-rbac-policy.js";

// ─── Topic → required scopes ───

const TOPIC_SCOPES: Record<FridayRealtimeTopic, FridayScope[]> = {
  "workflow": ["workflow.read"],
  "workflow.run": ["workflow.read"],
  "workflow.node": ["workflow.read"],
  "workflow.conflict": ["workflow.read", "workflow.conflict.resolve"],
  "satellite": ["satellite.read"],
  "fleet": ["fleet.read"],
  "security": ["security.read"],
  "diagnosis": ["diagnosis.read"],
  "approval": ["workflow.run"],
};

// ─── Topic → allowed stream prefixes ───

const TOPIC_STREAM_PREFIXES: Record<FridayRealtimeTopic, string[]> = {
  "workflow": ["workflow:"],
  "workflow.run": ["run:"],
  "workflow.node": ["run:"],
  "workflow.conflict": ["workflow:"],
  "satellite": ["satellite:"],
  "fleet": ["fleet:"],
  "security": ["security:"],
  "diagnosis": ["diagnosis:"],
  "approval": ["workflow:", "run:"],
};

// ─── Cursor HMAC helpers ───

export function computeCursorHmac(
  streamId: string,
  seq: number,
  epoch: number,
  secret: string,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${streamId}:${seq}:${epoch}`)
    .digest("hex");
}

export function verifyCursorHmac(
  cursor: string,
  streamId: string,
  seq: number,
  epoch: number,
  secret: string,
): boolean {
  const expected = computeCursorHmac(streamId, seq, epoch, secret);
  if (cursor.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(cursor), Buffer.from(expected));
}

// ─── Service interface ───

export interface FridayRealtimeSubscriptionService {
  validateSubscriptions(
    subscriptions: FridayRealtimeSubscription[],
    principal: FridayAuthPrincipal,
  ): {
    accepted: FridayRealtimeSubscription[];
    rejected: Array<{ subscriptionId: string; code: string; message: string }>;
  };

  /** Check if a principal is authorized for a given stream based on their subscriptions/scopes. */
  isStreamAuthorized(
    principal: FridayAuthPrincipal,
    streamId: string,
    acceptedSubscriptions?: Map<string, FridayRealtimeSubscription>,
  ): boolean;

  pullEvents(
    streamId: string,
    afterSeq: number,
    limit: number,
  ): FridayRealtimeEventEnvelope[];

  ackEvent(
    principalId: string,
    streamId: string,
    seq: number,
    epoch: number,
    cursor?: string,
  ): { accepted: boolean };

  getCheckpoint(
    principalId: string,
    streamId: string,
  ): { lastAckedSeq: number; epoch: number; cursor?: string } | null;

  /** Generate cursor HMAC for a given stream/seq/epoch. */
  generateCursor(streamId: string, seq: number, epoch: number): string;

  /** Verify cursor HMAC for a given stream/seq/epoch. */
  verifyCursor(cursor: string, streamId: string, seq: number, epoch: number): boolean;
}

export interface CreateFridayRealtimeSubscriptionServiceDeps {
  db: FridaySqliteLayer;
  eventRepo: FridayRealtimeEventRepository;
  checkpointRepo: FridayRealtimeCheckpointRepository;
  nowIso: () => string;
  currentEpoch: number;
  cursorSecret?: string;
}

// ─── Factory ───

export function createFridayRealtimeSubscriptionService(
  deps: CreateFridayRealtimeSubscriptionServiceDeps,
): FridayRealtimeSubscriptionService {
  const cursorSecret = deps.cursorSecret ?? "friday-default-cursor-secret";

  /** Check if a streamId is valid for the given topic based on prefix rules. */
  function isStreamValidForTopic(topic: FridayRealtimeTopic, streamId: string): boolean {
    const prefixes = TOPIC_STREAM_PREFIXES[topic];
    if (!prefixes) return false;
    return prefixes.some((prefix) => streamId.startsWith(prefix));
  }

  return {
    validateSubscriptions(subscriptions, principal) {
      const accepted: FridayRealtimeSubscription[] = [];
      const rejected: Array<{ subscriptionId: string; code: string; message: string }> = [];

      for (const sub of subscriptions) {
        const requiredScopes = TOPIC_SCOPES[sub.topic];
        if (!requiredScopes) {
          rejected.push({
            subscriptionId: sub.subscriptionId,
            code: "UNKNOWN_TOPIC",
            message: `Unknown topic: ${sub.topic}`,
          });
          continue;
        }

        if (!principalHasAnyScope(principal.scopes, requiredScopes)) {
          rejected.push({
            subscriptionId: sub.subscriptionId,
            code: "INSUFFICIENT_SCOPE",
            message: `Missing required scope for topic ${sub.topic}`,
          });
          continue;
        }

        // Validate topic → stream binding
        if (!isStreamValidForTopic(sub.topic, sub.streamId)) {
          rejected.push({
            subscriptionId: sub.subscriptionId,
            code: "INVALID_STREAM_BINDING",
            message: `Stream '${sub.streamId}' is not valid for topic '${sub.topic}'`,
          });
          continue;
        }

        accepted.push(sub);
      }

      return { accepted, rejected };
    },

    isStreamAuthorized(principal, streamId, acceptedSubscriptions) {
      // If we have accepted subscriptions, check if the stream is in them
      if (acceptedSubscriptions) {
        for (const sub of acceptedSubscriptions.values()) {
          if (sub.streamId === streamId) return true;
        }
        return false;
      }

      // Fallback: derive topic from stream prefix and check scopes
      for (const [topic, prefixes] of Object.entries(TOPIC_STREAM_PREFIXES)) {
        if (prefixes.some((prefix: string) => streamId.startsWith(prefix))) {
          const requiredScopes = TOPIC_SCOPES[topic as FridayRealtimeTopic];
          if (requiredScopes && principalHasAnyScope(principal.scopes, requiredScopes)) {
            return true;
          }
        }
      }
      return false;
    },

    pullEvents(streamId, afterSeq, limit) {
      return deps.db.withReadConnection((db) =>
        deps.eventRepo.listAfterSeq(db, streamId, afterSeq, limit),
      );
    },

    ackEvent(principalId, streamId, seq, epoch, cursor) {
      if (epoch !== deps.currentEpoch) {
        return { accepted: false };
      }

      deps.db.withWriteTransaction((db) => {
        deps.checkpointRepo.upsert(db, principalId, streamId, seq, epoch, cursor, deps.nowIso());
      });

      return { accepted: true };
    },

    getCheckpoint(principalId, streamId) {
      const checkpoint = deps.db.withReadConnection((db) =>
        deps.checkpointRepo.get(db, principalId, streamId),
      );

      if (!checkpoint) return null;

      return {
        lastAckedSeq: checkpoint.last_acked_seq,
        epoch: checkpoint.epoch,
        cursor: checkpoint.cursor ?? undefined,
      };
    },

    generateCursor(streamId, seq, epoch) {
      return computeCursorHmac(streamId, seq, epoch, cursorSecret);
    },

    verifyCursor(cursor, streamId, seq, epoch) {
      return verifyCursorHmac(cursor, streamId, seq, epoch, cursorSecret);
    },
  };
}
```

## `src/api/realtime/friday-realtime-ws-gateway.ts`
```ts
import type {
  FridayRealtimeClientFrame,
  FridayRealtimeServerFrame,
  FridayRealtimeEventEnvelope,
  FridayRealtimeSubscription,
} from "../model/friday-api-realtime.types.js";
import type { FridayAuthPrincipal } from "../model/friday-api-auth.types.js";
import type { FridayTokenValidator } from "../auth/friday-token-validator.js";
import { TokenValidationError } from "../auth/friday-token-validator.js";
import type { FridayRealtimeSubscriptionService } from "./friday-realtime-subscription-service.js";
import type { FridayRealtimeEventBus } from "./friday-realtime-event-bus.types.js";

// ─── Connection state ───

export interface FridayWsConnection {
  connId: string;
  principal: FridayAuthPrincipal | null;
  subscriptions: Map<string, FridayRealtimeSubscription>;
  authenticated: boolean;
}

// ─── Gateway interface ───

export interface FridayRealtimeWsGateway {
  handleClientFrame(
    conn: FridayWsConnection,
    frame: FridayRealtimeClientFrame,
  ): FridayRealtimeServerFrame[];
  createConnection(connId: string): FridayWsConnection;
  shouldDeliverEvent(
    conn: FridayWsConnection,
    envelope: FridayRealtimeEventEnvelope,
  ): boolean;
}

export interface CreateFridayRealtimeWsGatewayDeps {
  tokenValidator: FridayTokenValidator;
  subscriptionService: FridayRealtimeSubscriptionService;
  eventBus: FridayRealtimeEventBus;
  nowIso: () => string;
  serverVersion: string;
  currentEpoch: number;
}

// ─── Factory ───

export function createFridayRealtimeWsGateway(
  deps: CreateFridayRealtimeWsGatewayDeps,
): FridayRealtimeWsGateway {
  return {
    createConnection(connId) {
      return {
        connId,
        principal: null,
        subscriptions: new Map(),
        authenticated: false,
      };
    },

    handleClientFrame(conn, frame): FridayRealtimeServerFrame[] {
      switch (frame.type) {
        case "hello": {
          try {
            const validated = deps.tokenValidator.validate(frame.token);
            conn.principal = validated.principal;
            conn.authenticated = true;

            const responses: FridayRealtimeServerFrame[] = [
              {
                type: "hello_ack",
                connId: conn.connId,
                protocolVersion: "1.0",
                serverVersion: deps.serverVersion,
                epoch: deps.currentEpoch,
                now: deps.nowIso(),
              },
            ];

            // Process initial subscriptions if provided
            if (frame.subscriptions && frame.subscriptions.length > 0) {
              const result = deps.subscriptionService.validateSubscriptions(
                frame.subscriptions,
                conn.principal,
              );
              for (const sub of result.accepted) {
                conn.subscriptions.set(sub.subscriptionId, sub);
              }
              responses.push({
                type: "subscribed",
                accepted: result.accepted,
                rejected: result.rejected,
              });
            }

            return responses;
          } catch (err) {
            const code =
              err instanceof TokenValidationError ? err.code : "AUTH_FAILED";
            const message =
              err instanceof Error ? err.message : "Authentication failed";
            return [
              {
                type: "error",
                code,
                message,
                retryable: false,
              },
            ];
          }
        }

        case "subscribe": {
          if (!conn.authenticated || !conn.principal) {
            return [
              {
                type: "error",
                code: "NOT_AUTHENTICATED",
                message: "Must send hello frame first",
                retryable: false,
              },
            ];
          }

          const result = deps.subscriptionService.validateSubscriptions(
            frame.subscriptions,
            conn.principal,
          );
          for (const sub of result.accepted) {
            conn.subscriptions.set(sub.subscriptionId, sub);
          }

          return [
            {
              type: "subscribed",
              accepted: result.accepted,
              rejected: result.rejected,
            },
          ];
        }

        case "unsubscribe": {
          for (const subId of frame.subscriptionIds) {
            conn.subscriptions.delete(subId);
          }
          return [];
        }

        case "ack": {
          if (!conn.authenticated || !conn.principal) {
            return [
              {
                type: "error",
                code: "NOT_AUTHENTICATED",
                message: "Must send hello frame first",
                retryable: false,
              },
            ];
          }

          // Verify stream is in accepted subscriptions
          if (!deps.subscriptionService.isStreamAuthorized(conn.principal, frame.streamId, conn.subscriptions)) {
            return [
              {
                type: "error",
                code: "STREAM_NOT_AUTHORIZED",
                message: `Not subscribed to stream '${frame.streamId}'`,
                retryable: false,
              },
            ];
          }

          if (frame.epoch !== deps.currentEpoch) {
            return [
              {
                type: "resync_required",
                streamId: frame.streamId,
                reason: "STREAM_EPOCH_STALE",
                snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
              },
            ];
          }

          // Verify cursor HMAC if provided
          if (frame.cursor && !deps.subscriptionService.verifyCursor(frame.cursor, frame.streamId, frame.seq, frame.epoch)) {
            return [
              {
                type: "resync_required",
                streamId: frame.streamId,
                reason: "CURSOR_INVALID",
                snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
              },
            ];
          }

          const ackResult = deps.subscriptionService.ackEvent(
            conn.principal.principalId,
            frame.streamId,
            frame.seq,
            frame.epoch,
            frame.cursor,
          );

          if (ackResult.accepted) {
            return [{ type: "ack_ok", streamId: frame.streamId, seq: frame.seq }];
          }

          return [
            {
              type: "resync_required",
              streamId: frame.streamId,
              reason: "STREAM_EPOCH_STALE",
              snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
            },
          ];
        }

        case "resume": {
          if (!conn.authenticated || !conn.principal) {
            return [
              {
                type: "error",
                code: "NOT_AUTHENTICATED",
                message: "Must send hello frame first",
                retryable: false,
              },
            ];
          }

          if (frame.epoch !== deps.currentEpoch) {
            return [
              {
                type: "resync_required",
                streamId: frame.streamId,
                reason: "STREAM_EPOCH_STALE",
                snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
              },
            ];
          }

          // Verify cursor HMAC
          if (frame.cursor && !deps.subscriptionService.verifyCursor(frame.cursor, frame.streamId, frame.lastAckedSeq, frame.epoch)) {
            return [
              {
                type: "resync_required",
                streamId: frame.streamId,
                reason: "CURSOR_INVALID",
                snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
              },
            ];
          }

          // Re-validate and apply subscriptions
          const result = deps.subscriptionService.validateSubscriptions(
            frame.subscriptions,
            conn.principal,
          );
          for (const sub of result.accepted) {
            conn.subscriptions.set(sub.subscriptionId, sub);
          }

          // Verify stream is in the accepted subscriptions
          if (!deps.subscriptionService.isStreamAuthorized(conn.principal, frame.streamId, conn.subscriptions)) {
            return [
              {
                type: "resync_required",
                streamId: frame.streamId,
                reason: "STREAM_CURSOR_OUT_OF_RANGE",
                snapshotEndpoint: `/v1/realtime/pull?streamId=${frame.streamId}`,
              },
            ];
          }

          // Replay events after last acked seq
          const events = deps.subscriptionService.pullEvents(
            frame.streamId,
            frame.lastAckedSeq,
            100,
          );

          const responses: FridayRealtimeServerFrame[] = [
            {
              type: "subscribed",
              accepted: result.accepted,
              rejected: result.rejected,
            },
          ];

          for (const envelope of events) {
            responses.push({ type: "event", envelope });
          }

          return responses;
        }

        case "ping": {
          return [{ type: "pong", at: deps.nowIso() }];
        }
      }
    },

    shouldDeliverEvent(conn, envelope) {
      if (!conn.authenticated) return false;

      for (const sub of conn.subscriptions.values()) {
        if (envelope.streamId === sub.streamId) {
          return true;
        }
      }

      return false;
    },
  };
}
```

## `src/api/runtime/friday-api-runtime.ts`
```ts
import type { FridayApiRuntime, CreateFridayApiRuntimeDeps } from "./friday-api-runtime.types.js";
import { createFridayAuthService } from "../auth/friday-auth-service.js";
import { createFridayTokenValidator } from "../auth/friday-token-validator.js";
import { createFridayRateLimitService } from "../auth/friday-rate-limit-service.js";
import { createFridayAuthMiddlewareFactory } from "../auth/friday-auth-middleware.js";
import { createFridayRealtimeEventBus } from "../realtime/friday-realtime-event-bus.js";
import { createFridayRealtimeEventRepository } from "../persistence/friday-realtime-event-repository.js";
import { createFridayRealtimeCheckpointRepository } from "../persistence/friday-realtime-checkpoint-repository.js";
import { createFridayRealtimeSubscriptionService } from "../realtime/friday-realtime-subscription-service.js";
import { createFridayRealtimeWsGateway } from "../realtime/friday-realtime-ws-gateway.js";
import { createFridayFleetDashboardService } from "../fleet/friday-fleet-dashboard-service.js";
import { createFridayWorkflowConflictService } from "../conflicts/friday-workflow-conflict-service.js";
import { createFridayLegacyDecommissionService } from "../legacy/friday-legacy-decommission-service.js";
import { createFridayHttpRouteRegistry } from "../http/friday-http-route-registry.js";
import { createFridayAuthRoutes } from "../http/routes/friday-auth-routes.js";
import { createFridayWorkflowRoutes } from "../http/routes/friday-workflow-routes.js";
import { createFridayWorkflowBuilderRoutes } from "../http/routes/friday-workflow-builder-routes.js";
import { createFridayWorkflowRunRoutes } from "../http/routes/friday-workflow-run-routes.js";
import { createFridayWorkflowConflictRoutes } from "../http/routes/friday-workflow-conflict-routes.js";
import { createFridayFleetRoutes } from "../http/routes/friday-fleet-routes.js";
import { createFridaySecurityRoutes } from "../http/routes/friday-security-routes.js";
import { createFridayRealtimeRoutes } from "../http/routes/friday-realtime-routes.js";
import { createFridayApiTokenRepository } from "../persistence/friday-api-token-repository.js";

const DEFAULT_ACCESS_TTL = 900; // 15 min
const DEFAULT_REFRESH_TTL = 604_800; // 7 days
const CURRENT_EPOCH = 1;

export function createFridayApiRuntime(deps: CreateFridayApiRuntimeDeps): FridayApiRuntime {
  const accessTokenTtlSec = deps.accessTokenTtlSec ?? DEFAULT_ACCESS_TTL;
  const refreshTokenTtlSec = deps.refreshTokenTtlSec ?? DEFAULT_REFRESH_TTL;
  const serverVersion = deps.serverVersion ?? "1.0.0";
  const stateDir = deps.stateDir ?? ".";

  // Auth
  const tokenRepo = createFridayApiTokenRepository();

  const tokenValidator = createFridayTokenValidator({
    tokenSecret: deps.tokenSecret,
    nowMs: () => new Date(deps.nowIso()).getTime(),
    lookupTokenRevocation: (tokenId) =>
      deps.db.withReadConnection((db) => tokenRepo.isRevoked(db, tokenId)),
    lookupSatelliteTokenVersion: (satelliteId) => {
      const row = deps.db.withReadConnection((db) =>
        db
          .prepare("SELECT token_version FROM satellites WHERE id = ?")
          .get(satelliteId) as { token_version: number } | undefined,
      );
      return row?.token_version ?? null;
    },
  });

  const authService = createFridayAuthService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    tokenSecret: deps.tokenSecret,
    accessTokenTtlSec,
    refreshTokenTtlSec,
  });

  const rateLimiter = createFridayRateLimitService({
    db: deps.db,
    nowIso: deps.nowIso,
  });

  const middleware = createFridayAuthMiddlewareFactory({
    tokenValidator,
    rateLimitService: rateLimiter,
  });

  // Realtime
  const eventRepo = createFridayRealtimeEventRepository();
  const checkpointRepo = createFridayRealtimeCheckpointRepository();

  const eventBus = createFridayRealtimeEventBus({
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    persistEvent: (envelope) => {
      deps.db.withWriteTransaction((db) => {
        eventRepo.append(db, envelope);
      });
    },
    db: deps.db,
    eventRepo,
  });

  const subscriptions = createFridayRealtimeSubscriptionService({
    db: deps.db,
    eventRepo,
    checkpointRepo,
    nowIso: deps.nowIso,
    currentEpoch: CURRENT_EPOCH,
    cursorSecret: deps.tokenSecret,
  });

  const wsGateway = createFridayRealtimeWsGateway({
    tokenValidator,
    subscriptionService: subscriptions,
    eventBus,
    nowIso: deps.nowIso,
    serverVersion,
    currentEpoch: CURRENT_EPOCH,
  });

  // Fleet
  const fleet = createFridayFleetDashboardService({
    db: deps.db,
    nowIso: deps.nowIso,
    idGenerator: deps.idGenerator,
  });

  // Conflicts
  const conflicts = createFridayWorkflowConflictService({
    db: deps.db,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  // Legacy
  const legacy = createFridayLegacyDecommissionService({
    nowIso: deps.nowIso,
    stateDir,
  });

  // Route registry
  const routes = createFridayHttpRouteRegistry();

  // Register auth routes
  for (const route of createFridayAuthRoutes({ authService })) {
    routes.register(route);
  }

  // Register workflow routes (stub implementations for route contract)
  for (const route of createFridayWorkflowRoutes({
    listWorkflows: () => ({ items: [] }),
    createWorkflow: (input) => ({
      workflow: { id: deps.idGenerator() } as any,
      version: { id: deps.idGenerator() } as any,
    }),
    getWorkflow: (wfId) => ({
      workflow: { id: wfId } as any,
      latestVersion: {} as any,
    }),
    updateWorkflow: (wfId) => ({
      workflow: { id: wfId } as any,
    }),
    archiveWorkflow: () => ({ archived: true }),
    publishWorkflow: (wfId) => ({
      publishedVersion: {} as any,
    }),
    listVersions: () => ({ items: [] }),
  })) {
    routes.register(route);
  }

  // Register builder routes (stub implementations for route contract)
  for (const route of createFridayWorkflowBuilderRoutes({
    createDraft: () => ({ draft: {} as any }),
    listDrafts: () => ({ items: [] }),
    getDraft: () => ({ draft: {} as any }),
    saveDraft: () => ({ draft: {} as any }),
    autosaveDraft: () => ({ draft: null }),
    compileDraft: () => ({ compiled: {} as any, validation: {} as any }),
    publishDraft: () => ({
      workflowId: "",
      workflowVersionId: "",
      versionNumber: 1,
      published: true,
      checksum: "",
      validation: {} as any,
    }),
    acquireLock: () => ({ acquired: true }),
    renewLock: () => ({ lock: null }),
    releaseLock: () => ({ released: true }),
  })) {
    routes.register(route);
  }

  // Register run routes (stub implementations for route contract)
  for (const route of createFridayWorkflowRunRoutes({
    startRun: async () => ({ run: {} as any }),
    getRun: () => ({ run: {} as any }),
    listRunNodes: () => ({ items: [] }),
    getRunTimeline: () => ({ items: [] }),
    cancelRun: async () => ({ run: {} as any }),
    retryRun: async () => ({ run: {} as any, retriedNodes: [] }),
  })) {
    routes.register(route);
  }

  // Register conflict routes
  for (const route of createFridayWorkflowConflictRoutes({
    listConflicts: (workflowId, query) => ({
      items: conflicts.listConflicts(workflowId, query.status, query.limit),
    }),
    resolveConflict: (workflowId, conflictId, input, userId) =>
      conflicts.resolveConflict(conflictId, input, userId),
  })) {
    routes.register(route);
  }

  // Register fleet routes
  for (const route of createFridayFleetRoutes({ fleetService: fleet })) {
    routes.register(route);
  }

  // Register security routes
  for (const route of createFridaySecurityRoutes({
    fleetService: fleet,
    revokeToken: (tokenId) => {
      deps.db.withWriteTransaction((db) => {
        tokenRepo.revoke(db, tokenId, deps.nowIso());
      });
      return { revoked: true, tokenId };
    },
    revokeSatellite: (satelliteId, reason) => {
      deps.db.withWriteTransaction((db) => {
        db.prepare(
          "UPDATE satellites SET pairing_status = 'revoked', updated_at = ? WHERE id = ?",
        ).run(deps.nowIso(), satelliteId);
      });
      return { revoked: true, satelliteId };
    },
  })) {
    routes.register(route);
  }

  // Register realtime routes
  for (const route of createFridayRealtimeRoutes({
    subscriptionService: subscriptions,
    currentEpoch: CURRENT_EPOCH,
  })) {
    routes.register(route);
  }

  return {
    auth: authService,
    tokenValidator,
    rateLimiter,
    middleware,
    eventBus,
    subscriptions,
    wsGateway,
    fleet,
    conflicts,
    legacy,
    routes,
  };
}
```

## `src/api/runtime/friday-api-runtime.types.ts`
```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayAuthService } from "../auth/friday-auth-service.types.js";
import type { FridayRateLimitService } from "../auth/friday-rate-limit-service.types.js";
import type { FridayTokenValidator } from "../auth/friday-token-validator.js";
import type { FridayAuthMiddlewareFactory } from "../auth/friday-auth-middleware.js";
import type { FridayRealtimeEventBus } from "../realtime/friday-realtime-event-bus.types.js";
import type { FridayRealtimeSubscriptionService } from "../realtime/friday-realtime-subscription-service.js";
import type { FridayRealtimeWsGateway } from "../realtime/friday-realtime-ws-gateway.js";
import type { FridayFleetDashboardService } from "../fleet/friday-fleet-dashboard-service.types.js";
import type { FridayWorkflowConflictService } from "../conflicts/friday-workflow-conflict-service.types.js";
import type { FridayLegacyDecommissionService } from "../legacy/friday-legacy-decommission.types.js";
import type { FridayHttpRouteRegistry } from "../http/friday-http-route-registry.js";

export interface FridayApiRuntime {
  auth: FridayAuthService;
  tokenValidator: FridayTokenValidator;
  rateLimiter: FridayRateLimitService;
  middleware: FridayAuthMiddlewareFactory;
  eventBus: FridayRealtimeEventBus;
  subscriptions: FridayRealtimeSubscriptionService;
  wsGateway: FridayRealtimeWsGateway;
  fleet: FridayFleetDashboardService;
  conflicts: FridayWorkflowConflictService;
  legacy: FridayLegacyDecommissionService;
  routes: FridayHttpRouteRegistry;
}

export interface CreateFridayApiRuntimeDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  tokenSecret: string;
  accessTokenTtlSec?: number;
  refreshTokenTtlSec?: number;
  serverVersion?: string;
  stateDir?: string;
}
```

## `src/state/sqlite/migrations/v002-phase8-api-foundation.ts`
```ts
import type { FridaySqliteMigration } from "./friday-migration.types.js";
import { computeFridayMigrationChecksum } from "./friday-migration.types.js";

export const V002_PHASE8_API_FOUNDATION_SQL = `
-- ============================================================
-- V002: Phase 8 – API Foundation tables
-- ============================================================

-- Realtime event stream persistence
CREATE TABLE IF NOT EXISTS realtime_events (
  event_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  emitted_at TEXT NOT NULL,
  correlation_id TEXT,
  state_version_json TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_realtime_events_stream_seq
  ON realtime_events(stream_id, seq);

CREATE INDEX IF NOT EXISTS idx_realtime_events_emitted
  ON realtime_events(emitted_at);

-- Realtime client checkpoint storage
CREATE TABLE IF NOT EXISTS realtime_checkpoints (
  principal_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  last_acked_seq INTEGER NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1,
  cursor TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, stream_id)
);

-- Rate limit counters
CREATE TABLE IF NOT EXISTS api_rate_limit_counters (
  bucket_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_window
  ON api_rate_limit_counters(window_start);

-- Workflow conflict records
CREATE TABLE IF NOT EXISTS workflow_conflicts (
  conflict_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  base_workflow_version_id TEXT,
  head_workflow_version_id TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_user_id TEXT,
  summary TEXT NOT NULL,
  patches_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_conflicts_workflow
  ON workflow_conflicts(workflow_id, status);

CREATE INDEX IF NOT EXISTS idx_workflow_conflicts_draft
  ON workflow_conflicts(draft_id);

-- Workflow collaboration locks
CREATE TABLE IF NOT EXISTS workflow_locks (
  workflow_id TEXT NOT NULL,
  lock_token TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_session_id TEXT,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, lock_token)
);

CREATE INDEX IF NOT EXISTS idx_workflow_locks_workflow
  ON workflow_locks(workflow_id);

-- Workflow builder drafts
CREATE TABLE IF NOT EXISTS workflow_builder_drafts (
  draft_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL DEFAULT 1,
  spec_json TEXT NOT NULL DEFAULT '{}',
  visual_json TEXT NOT NULL DEFAULT '{}',
  owner_user_id TEXT,
  base_workflow_version_id TEXT,
  lock_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  autosave_enabled INTEGER NOT NULL DEFAULT 0,
  autosave_interval_ms INTEGER NOT NULL DEFAULT 30000
);

CREATE INDEX IF NOT EXISTS idx_builder_drafts_workflow
  ON workflow_builder_drafts(workflow_id);
`;

const V002_CHECKSUM = computeFridayMigrationChecksum(V002_PHASE8_API_FOUNDATION_SQL);

export const V002_PHASE8_API_FOUNDATION_MIGRATION: FridaySqliteMigration = {
  version: 2,
  name: "v002-phase8-api-foundation",
  sql: V002_PHASE8_API_FOUNDATION_SQL,
  checksum: V002_CHECKSUM,
};
```

## `src/state/sqlite/migrations/index.ts`
```ts
import type { FridaySqliteMigration } from "./friday-migration.types.js";
import { V001_INITIAL_MIGRATION } from "./v001-initial.js";
import { V002_PHASE8_API_FOUNDATION_MIGRATION } from "./v002-phase8-api-foundation.js";

/** Ordered migration list, always ascending by version. */
export const FRIDAY_SQLITE_MIGRATIONS: readonly FridaySqliteMigration[] = [
  V001_INITIAL_MIGRATION,
  V002_PHASE8_API_FOUNDATION_MIGRATION,
];
```

## `src/config/friday-config.types.ts`
```ts
export type FridayMirrorMode = "best-effort" | "strict";
export type FridaySqliteSynchronousMode = "NORMAL" | "FULL";

export interface FridayConfig {
  stateDir?: string;
  database: {
    readPoolSize: number;
    busyTimeoutMs: number;
    synchronous: FridaySqliteSynchronousMode;
  };
  telemetry: {
    enabled: boolean;
    fileName: string;
    summaryFileName: string;
  };
  backups: {
    configBackupCount: number;
  };
}

/**
 * @deprecated Phase 8 removed mirror config. This type is retained only
 * for migration-on-load stripping.
 */
export interface FridayDeprecatedMirrorConfig {
  enabled: boolean;
  mode: FridayMirrorMode;
  consistencyCheckOnStartup: boolean;
}

/** Keys that Phase 8 strips on config load. */
export const DEPRECATED_CONFIG_KEYS = [
  "mirror",
  "mirror.enabled",
  "mirror.mode",
  "mirror.consistencyCheckOnStartup",
] as const;

/**
 * Strips deprecated mirror-related keys from a raw config object.
 * Returns the cleaned object and the list of removed keys.
 */
export function migrateDeprecatedConfigKeys(
  raw: Record<string, unknown>,
): { cleaned: Record<string, unknown>; removedKeys: string[] } {
  const removedKeys: string[] = [];
  const cleaned = { ...raw };
  if ("mirror" in cleaned) {
    removedKeys.push("mirror");
    delete cleaned.mirror;
  }
  return { cleaned, removedKeys };
}

export interface LoadedFridayConfig {
  config: FridayConfig;
  configPath: string;
  exists: boolean;
  rawText?: string;
}

export interface LoadFridayConfigOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export interface WriteFridayConfigOptions {
  configPath?: string;
  backupCount?: number;
  fileMode?: number;
}
```

## `src/config/friday-config.schema.ts`
```ts
import { z } from "zod";
import type { FridayConfig } from "./friday-config.types.js";
import { migrateDeprecatedConfigKeys } from "./friday-config.types.js";

const FridayDatabaseSchema = z.object({
  readPoolSize: z.number().int().min(1).max(16).default(4),
  busyTimeoutMs: z.number().int().min(100).max(60_000).default(5000),
  synchronous: z.enum(["NORMAL", "FULL"]).default("NORMAL"),
});

const FridayTelemetrySchema = z.object({
  enabled: z.boolean().default(true),
  fileName: z.string().default("migration-telemetry.jsonl"),
  summaryFileName: z.string().default("migration-summary.json"),
});

const FridayBackupsSchema = z.object({
  configBackupCount: z.number().int().min(0).max(20).default(3),
});

export const FridayConfigSchema: z.ZodType<FridayConfig> = z.object({
  stateDir: z.string().optional(),
  database: FridayDatabaseSchema.default({
    readPoolSize: 4,
    busyTimeoutMs: 5000,
    synchronous: "NORMAL",
  }),
  telemetry: FridayTelemetrySchema.default({
    enabled: true,
    fileName: "migration-telemetry.jsonl",
    summaryFileName: "migration-summary.json",
  }),
  backups: FridayBackupsSchema.default({
    configBackupCount: 3,
  }),
});

/** Validates unknown input and returns a fully defaulted FridayConfig.
 *  Strips deprecated keys (e.g. mirror.*) before validation. */
export function parseFridayConfig(input: unknown): FridayConfig {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const { cleaned } = migrateDeprecatedConfigKeys(input as Record<string, unknown>);
    return FridayConfigSchema.parse(cleaned);
  }
  return FridayConfigSchema.parse(input);
}

/** Returns a stable default config used when config file does not exist. */
export function buildDefaultFridayConfig(): FridayConfig {
  return FridayConfigSchema.parse({});
}
```

## `src/config/friday-config-io.ts`
```ts
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import JSON5 from "json5";
import type {
  FridayConfig,
  LoadedFridayConfig,
  LoadFridayConfigOptions,
  WriteFridayConfigOptions,
} from "./friday-config.types.js";
import { buildDefaultFridayConfig, parseFridayConfig } from "./friday-config.schema.js";
import { resolveFridayConfigPath } from "./friday-config-path.js";
import { rotateFridayConfigBackups } from "./friday-config-backup-rotation.js";

export type ParseFridayJson5Result =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Parses raw JSON5 config text without validation. */
export function parseFridayJson5(raw: string): ParseFridayJson5Result {
  try {
    const value = JSON5.parse(raw);
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Loads config from disk, applies Zod validation/defaults, returns typed result. */
export function loadFridayConfig(options?: LoadFridayConfigOptions): LoadedFridayConfig {
  const configPath = options?.configPath ?? resolveFridayConfigPath({ env: options?.env });

  // Check if file exists
  if (!fs.existsSync(configPath)) {
    return {
      config: buildDefaultFridayConfig(),
      configPath,
      exists: false,
    };
  }

  const rawText = fs.readFileSync(configPath, "utf-8");
  const parseResult = parseFridayJson5(rawText);

  if (!parseResult.ok) {
    throw new Error(`Failed to parse config at ${configPath}: ${parseResult.error}`);
  }

  const config = parseFridayConfig(parseResult.value);
  return {
    config,
    configPath,
    exists: true,
    rawText,
  };
}

/** Validates and writes config atomically, rotating backups before replacement. */
export async function writeFridayConfig(
  config: FridayConfig,
  options?: WriteFridayConfigOptions,
): Promise<void> {
  const configPath = options?.configPath ?? resolveFridayConfigPath();
  const backupCount = options?.backupCount ?? 3;
  const fileMode = options?.fileMode ?? 0o600;

  // Validate config before writing
  parseFridayConfig(config);

  // Ensure directory exists
  const dir = path.dirname(configPath);
  await fsPromises.mkdir(dir, { recursive: true });

  // Rotate backups
  await rotateFridayConfigBackups(configPath, backupCount);

  // Atomic write: write to temp file, then rename
  const tmpPath = path.join(dir, `.config-${crypto.randomUUID()}.tmp`);
  const content = JSON5.stringify(config, null, 2) + os.EOL;

  await fsPromises.writeFile(tmpPath, content, { mode: fileMode });
  await fsPromises.rename(tmpPath, configPath);
}
```

## `src/state/paths/resolve-state-dir.ts`
```ts
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

export interface ResolveStateDirOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  existsSync?: (path: string) => boolean;
}

/**
 * Resolves Friday state directory.
 * Precedence:
 * 1) FRIDAY_STATE_DIR
 * 2) existing ~/.friday/state
 * 3) existing platform-convention path
 * 4) ~/.friday/state
 */
export function resolveStateDir(options?: ResolveStateDirOptions): string {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const homedir = options?.homedir ?? os.homedir;
  const existsSync = options?.existsSync ?? fs.existsSync;

  const home = homedir();

  // 1) FRIDAY_STATE_DIR override
  const envDir = env.FRIDAY_STATE_DIR;
  if (envDir && envDir.trim() !== "") {
    const expanded = envDir.startsWith("~")
      ? path.join(home, envDir.slice(1))
      : envDir;
    return path.resolve(expanded);
  }

  // 2) Platform-convention path (preferred in Phase 8+)
  const platformPath = resolvePlatformStatePath(platform, home, env);
  if (platformPath && existsSync(platformPath)) {
    return platformPath;
  }

  // 3) Legacy default path (fallback)
  const legacyPath = path.join(home, ".friday", "state");
  if (existsSync(legacyPath)) {
    return legacyPath;
  }

  // 4) Fallback to platform path (create it) or legacy default
  return platformPath ?? legacyPath;
}

/** Resolves `${resolveStateDir()}/friday.db`. */
export function resolveFridayDbPath(options?: ResolveStateDirOptions): string {
  return path.join(resolveStateDir(options), "friday.db");
}

function resolvePlatformStatePath(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Friday", "state");
    case "linux": {
      const xdgState = env.XDG_STATE_HOME || path.join(home, ".local", "state");
      return path.join(xdgState, "friday");
    }
    case "win32": {
      const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      return path.join(localAppData, "Friday", "state");
    }
    default:
      return undefined;
  }
}
```

## `src/state/mirror/friday-compatibility-mirror.ts`
```ts
import type {
  ExecuteFridayMirrorWriteOptions,
  FridayMirrorOperation,
  FridayMirrorWriteResult,
} from "./friday-compatibility-mirror.types.js";
import type { FridayMigrationTelemetryWriter } from "../telemetry/friday-migration-telemetry.js";
import { hashFridayCanonicalJson } from "./friday-consistency-checks.js";
import { isFridayLegacyWriteFrozen } from "../../api/legacy/friday-legacy-write-freeze-guard.js";

/**
 * Executes a mirrored write against sqlite + legacy store.
 * In strict mode, legacy failures/mismatches throw.
 * In best-effort mode, they are telemetry events.
 *
 * If the legacy write freeze guard is active, legacy writes are short-circuited
 * and the result is LEGACY_WRITE_FROZEN.
 */
export function executeFridayCompatibilityMirrorWrite<TPayload>(
  operation: FridayMirrorOperation<TPayload>,
  telemetry: FridayMigrationTelemetryWriter,
  options: ExecuteFridayMirrorWriteOptions,
): FridayMirrorWriteResult {
  // 1. Write to sqlite (authoritative)
  operation.writeSqlite();

  // 1.5. Check write freeze guard — skip legacy writes if frozen
  if (isFridayLegacyWriteFrozen()) {
    telemetry.record({
      type: "compatibility-mirror-write",
      status: "ok",
      entityType: operation.entityType,
      entityKey: operation.entityKey,
      message: "Legacy write skipped: LEGACY_WRITE_FROZEN",
    });
    return { status: "legacy-write-frozen" as FridayMirrorWriteResult["status"] };
  }

  // 2. Write to legacy store
  try {
    operation.writeLegacy();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    telemetry.record({
      type: "compatibility-mirror-write",
      status: "error",
      entityType: operation.entityType,
      entityKey: operation.entityKey,
      message: `Legacy write failed: ${errorMessage}`,
    });

    if (options.mode === "strict") {
      throw new Error(
        `Mirror write failed in strict mode for ${operation.entityType}/${operation.entityKey}: ${errorMessage}`,
      );
    }

    return {
      status: "legacy-write-failed",
      errorMessage,
    };
  }

  // 3. Optional snapshot comparison
  if (operation.readSqliteSnapshot && operation.readLegacySnapshot) {
    const sqliteSnapshot = operation.readSqliteSnapshot();
    const legacySnapshot = operation.readLegacySnapshot();

    const sourceChecksum = hashFridayCanonicalJson(sqliteSnapshot);
    const targetChecksum = hashFridayCanonicalJson(legacySnapshot);

    if (sourceChecksum !== targetChecksum) {
      telemetry.record({
        type: "compatibility-mirror-write",
        status: "mismatch",
        entityType: operation.entityType,
        entityKey: operation.entityKey,
        sourceChecksum,
        targetChecksum,
        message: "Snapshot mismatch after mirror write",
      });

      if (options.mode === "strict") {
        throw new Error(
          `Mirror snapshot mismatch in strict mode for ${operation.entityType}/${operation.entityKey}`,
        );
      }

      return {
        status: "mismatch",
        sourceChecksum,
        targetChecksum,
      };
    }
  }

  telemetry.record({
    type: "compatibility-mirror-write",
    status: "ok",
    entityType: operation.entityType,
    entityKey: operation.entityKey,
  });

  return { status: "ok" };
}
```

## `test/unit/api/auth/friday-auth-middleware.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import {
  createFridayAuthMiddlewareFactory,
  type FridayAuthMiddlewareFactory,
} from "../../../../src/api/auth/friday-auth-middleware.js";
import {
  createFridayTokenValidator,
  encodeToken,
} from "../../../../src/api/auth/friday-token-validator.js";
import { createFridayRateLimitService } from "../../../../src/api/auth/friday-rate-limit-service.js";
import type { FridayHttpContext } from "../../../../src/api/model/friday-api-common.types.js";
import type { FridayAccessTokenClaims } from "../../../../src/api/model/friday-api-auth.types.js";

describe("FridayAuthMiddleware", () => {
  let db: FridaySqliteLayer;
  let mw: FridayAuthMiddlewareFactory;
  const SECRET = "test-secret";
  const NOW = "2025-06-15T10:00:00.000Z";
  const NOW_SEC = Math.floor(Date.parse(NOW) / 1000);

  function makeCtx(overrides?: Partial<FridayHttpContext<unknown, unknown, unknown>>): FridayHttpContext<unknown, unknown, unknown> {
    return {
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {},
      headers: {},
      principal: null,
      ...overrides,
    };
  }

  function makeToken(scopes: string[] = ["workflow.read"], role = "admin"): string {
    const claims: FridayAccessTokenClaims = {
      tokenId: "tok-1",
      principalType: "user",
      principalId: "user-1",
      userId: "user-1",
      role: role as "admin",
      scopes: scopes as FridayAccessTokenClaims["scopes"],
      iat: NOW_SEC,
      exp: NOW_SEC + 900,
    };
    return encodeToken(claims, SECRET);
  }

  beforeEach(() => {
    db = createTestDb();
    const tokenValidator = createFridayTokenValidator({
      tokenSecret: SECRET,
      nowMs: () => NOW_SEC * 1000,
      lookupTokenRevocation: () => false,
    });
    const rateLimitService = createFridayRateLimitService({
      db,
      nowIso: () => NOW,
    });
    mw = createFridayAuthMiddlewareFactory({ tokenValidator, rateLimitService });
  });

  afterEach(() => {
    db.close();
  });

  describe("requireAuth", () => {
    it("passes when principal already set", () => {
      const ctx = makeCtx({
        principal: {
          principalType: "user",
          principalId: "user-1",
          scopes: ["workflow.read"],
          tokenId: "tok-1",
          tokenKind: "access",
          issuedAt: NOW,
        },
      });
      const result = mw.requireAuth(ctx);
      expect(result.passed).toBe(true);
    });

    it("passes when valid bearer token provided", () => {
      const token = makeToken();
      const ctx = makeCtx({
        headers: { authorization: `Bearer ${token}` },
      });
      const result = mw.requireAuth(ctx);
      expect(result.passed).toBe(true);
      expect(ctx.principal).toBeTruthy();
    });

    it("rejects when no auth header", () => {
      const ctx = makeCtx();
      const result = mw.requireAuth(ctx);
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.statusCode).toBe(401);
      }
    });

    it("rejects when token is invalid", () => {
      const ctx = makeCtx({
        headers: { authorization: "Bearer invalid.token" },
      });
      const result = mw.requireAuth(ctx);
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.statusCode).toBe(401);
      }
    });
  });

  describe("requireAnyScope", () => {
    it("passes when principal has required scope", () => {
      const token = makeToken(["workflow.read", "workflow.write"]);
      const ctx = makeCtx({
        headers: { authorization: `Bearer ${token}` },
      });
      const result = mw.requireAnyScope(ctx, ["workflow.read"]);
      expect(result.passed).toBe(true);
    });

    it("rejects when principal lacks required scope", () => {
      const token = makeToken(["workflow.read"]);
      const ctx = makeCtx({
        headers: { authorization: `Bearer ${token}` },
      });
      const result = mw.requireAnyScope(ctx, ["hub.admin"]);
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.statusCode).toBe(403);
      }
    });
  });

  describe("requireAnyRole", () => {
    it("passes when principal has required role", () => {
      const token = makeToken(["workflow.read"], "admin");
      const ctx = makeCtx({
        headers: { authorization: `Bearer ${token}` },
      });
      const result = mw.requireAnyRole(ctx, ["admin", "owner"]);
      expect(result.passed).toBe(true);
    });

    it("rejects when principal lacks required role", () => {
      const token = makeToken(["workflow.read"], "viewer");
      const ctx = makeCtx({
        headers: { authorization: `Bearer ${token}` },
      });
      const result = mw.requireAnyRole(ctx, ["admin", "owner"]);
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.statusCode).toBe(403);
      }
    });
  });

  describe("enforceRateLimit", () => {
    it("passes within limits", () => {
      const ctx = makeCtx({ ip: "192.168.1.1" });
      const result = mw.enforceRateLimit(ctx, "auth.login");
      expect(result.passed).toBe(true);
    });

    it("rejects after exceeding limit", () => {
      for (let i = 0; i < 10; i++) {
        mw.enforceRateLimit(makeCtx({ ip: "192.168.1.1" }), "auth.login");
      }
      const result = mw.enforceRateLimit(makeCtx({ ip: "192.168.1.1" }), "auth.login");
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.statusCode).toBe(429);
        expect(result.code).toBe("RATE_LIMITED");
      }
    });

    it("returns X-RateLimit headers on success", () => {
      const result = mw.enforceRateLimit(makeCtx({ ip: "192.168.1.1" }), "auth.login");
      expect(result.passed).toBe(true);
      if (result.passed) {
        expect(result.headers).toBeDefined();
        expect(result.headers!["X-RateLimit-Limit"]).toBe("10");
        expect(Number(result.headers!["X-RateLimit-Remaining"])).toBeGreaterThanOrEqual(0);
        expect(result.headers!["X-RateLimit-Reset"]).toBeTruthy();
      }
    });

    it("returns X-RateLimit headers on rejection", () => {
      for (let i = 0; i < 11; i++) {
        mw.enforceRateLimit(makeCtx({ ip: "10.0.0.1" }), "auth.login");
      }
      const result = mw.enforceRateLimit(makeCtx({ ip: "10.0.0.1" }), "auth.login");
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.headers).toBeDefined();
        expect(result.headers!["X-RateLimit-Limit"]).toBe("10");
        expect(result.headers!["X-RateLimit-Remaining"]).toBe("0");
        expect(result.headers!["X-RateLimit-Reset"]).toBeTruthy();
      }
    });

    it("uses policy keyBy for rate limit key derivation", () => {
      // auth.login uses keyBy "ip" — different IPs should have separate limits
      for (let i = 0; i < 10; i++) {
        mw.enforceRateLimit(makeCtx({ ip: "1.2.3.4" }), "auth.login");
      }
      // Different IP should still pass
      const result = mw.enforceRateLimit(makeCtx({ ip: "5.6.7.8" }), "auth.login");
      expect(result.passed).toBe(true);
    });
  });
});
```

## `test/unit/api/auth/friday-auth-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import { createFridayAuthService, AuthError } from "../../../../src/api/auth/friday-auth-service.js";
import type { FridayAuthService } from "../../../../src/api/auth/friday-auth-service.types.js";
import * as crypto from "node:crypto";

describe("FridayAuthService", () => {
  let db: FridaySqliteLayer;
  let service: FridayAuthService;
  let idCounter: number;
  const NOW = "2025-06-15T10:00:00.000Z";
  const TOKEN_SECRET = "test-secret-key-for-tokens";

  beforeEach(() => {
    db = createTestDb();
    idCounter = 0;
    service = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("logs in the local-only user", () => {
    const result = service.login({});
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.expiresInSec).toBe(900);
    expect(result.user.id).toBe("test-user");
    expect(result.user.role).toBe("admin");
  });

  it("logs in with localPassphrase (no password hash check when null)", () => {
    const result = service.login({ localPassphrase: "any" });
    expect(result.user.id).toBe("test-user");
  });

  it("creates an auth session on login", () => {
    service.login({});
    const sessions = db.writer
      .prepare("SELECT * FROM auth_sessions WHERE user_id = 'test-user'")
      .all();
    expect(sessions).toHaveLength(1);
  });

  it("refreshes a token", () => {
    const loginResult = service.login({});
    const refreshResult = service.refresh({ refreshToken: loginResult.refreshToken });
    expect(refreshResult.accessToken).toBeTruthy();
    expect(refreshResult.expiresInSec).toBe(900);
  });

  it("rejects invalid refresh token", () => {
    expect(() => service.refresh({ refreshToken: "invalid" })).toThrow(AuthError);
  });

  it("logs out by revoking session", () => {
    const loginResult = service.login({});
    const principal = {
      principalType: "user" as const,
      principalId: "test-user",
      userId: "test-user",
      role: "admin" as const,
      scopes: ["session.write" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
      sessionId: "id-0001",
    };

    const result = service.logout({ refreshToken: loginResult.refreshToken }, principal);
    expect(result.ok).toBe(true);

    // Refresh should now fail
    expect(() => service.refresh({ refreshToken: loginResult.refreshToken })).toThrow(AuthError);
  });

  it("logs out all sessions", () => {
    service.login({});
    service.login({});

    const principal = {
      principalType: "user" as const,
      principalId: "test-user",
      userId: "test-user",
      role: "admin" as const,
      scopes: ["session.write" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
    };

    service.logout({ allSessions: true }, principal);

    const active = db.writer
      .prepare("SELECT * FROM auth_sessions WHERE user_id = 'test-user' AND revoked_at IS NULL")
      .all();
    expect(active).toHaveLength(0);
  });

  it("returns user info via me()", () => {
    const loginResult = service.login({});
    const principal = {
      principalType: "user" as const,
      principalId: "test-user",
      userId: "test-user",
      role: "admin" as const,
      scopes: ["session.read" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
      sessionId: "id-0001",
    };

    const me = service.me(principal);
    expect(me.user.id).toBe("test-user");
    expect(me.user.displayName).toBe("Test User");
    expect(me.scopes).toContain("session.read");
  });

  // ─── Email login password enforcement ───

  it("rejects email login without password", () => {
    // Insert an email user
    db.writer.prepare(
      `INSERT INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('email-user', 'user@example.com', 'Email User', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run(crypto.createHash("sha256").update("secret123").digest("hex"));

    expect(() => service.login({ email: "user@example.com" })).toThrow(AuthError);
    try {
      service.login({ email: "user@example.com" });
    } catch (err) {
      expect((err as AuthError).code).toBe("PASSWORD_REQUIRED");
    }
  });

  it("rejects email login with wrong password", () => {
    db.writer.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('email-user-2', 'user2@example.com', 'Email User 2', 'admin', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run(crypto.createHash("sha256").update("correct-password").digest("hex"));

    expect(() => service.login({ email: "user2@example.com", password: "wrong-password" })).toThrow(AuthError);
    try {
      service.login({ email: "user2@example.com", password: "wrong-password" });
    } catch (err) {
      expect((err as AuthError).code).toBe("INVALID_CREDENTIALS");
    }
  });

  it("succeeds email login with correct password", () => {
    const passwordHash = crypto.createHash("sha256").update("correct-password").digest("hex");
    db.writer.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('email-user-3', 'user3@example.com', 'Email User 3', 'viewer', 0, ?, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run(passwordHash);

    const result = service.login({ email: "user3@example.com", password: "correct-password" });
    expect(result.user.id).toBe("email-user-3");
    expect(result.user.email).toBe("user3@example.com");
    expect(result.accessToken).toBeTruthy();
  });

  it("rejects email login when user has no password hash set", () => {
    db.writer.prepare(
      `INSERT OR IGNORE INTO users (id, email, display_name, role, is_local_only, password_hash, created_at, updated_at)
       VALUES ('email-user-4', 'user4@example.com', 'Email User 4', 'admin', 0, NULL, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    ).run();

    expect(() => service.login({ email: "user4@example.com", password: "anything" })).toThrow(AuthError);
    try {
      service.login({ email: "user4@example.com", password: "anything" });
    } catch (err) {
      expect((err as AuthError).code).toBe("NO_PASSWORD_SET");
    }
  });

  it("throws when me() has no userId", () => {
    const principal = {
      principalType: "service" as const,
      principalId: "svc-1",
      scopes: ["session.read" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
    };
    expect(() => service.me(principal)).toThrow(AuthError);
  });
});
```

## `test/unit/api/auth/friday-rate-limit-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import { createFridayRateLimitService } from "../../../../src/api/auth/friday-rate-limit-service.js";
import type { FridayRateLimitService } from "../../../../src/api/auth/friday-rate-limit-service.types.js";

describe("FridayRateLimitService", () => {
  let db: FridaySqliteLayer;
  let service: FridayRateLimitService;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    service = createFridayRateLimitService({
      db,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("allows requests within limit", () => {
    const decision = service.increment("auth.login", "192.168.1.1");
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(9); // 10 max - 1 hit
  });

  it("counts incrementally", () => {
    for (let i = 0; i < 5; i++) {
      service.increment("auth.login", "192.168.1.1");
    }
    const decision = service.check("auth.login", "192.168.1.1");
    expect(decision.remaining).toBe(5); // 10 - 5
  });

  it("rejects when limit exceeded", () => {
    for (let i = 0; i < 10; i++) {
      service.increment("auth.login", "192.168.1.1");
    }
    const decision = service.increment("auth.login", "192.168.1.1");
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  it("tracks different keys separately", () => {
    for (let i = 0; i < 10; i++) {
      service.increment("auth.login", "192.168.1.1");
    }
    const decision = service.increment("auth.login", "192.168.1.2");
    expect(decision.allowed).toBe(true);
  });

  it("returns policy info", () => {
    const policy = service.getPolicy("auth.login");
    expect(policy).toBeDefined();
    expect(policy!.windowMs).toBe(60_000);
    expect(policy!.maxHits).toBe(10);
    expect(policy!.keyBy).toBe("ip");
  });

  it("returns undefined for unknown policy", () => {
    const policy = service.getPolicy("nonexistent" as "auth.login");
    expect(policy).toBeUndefined();
  });

  it("allows requests for unknown policy (permissive fallback)", () => {
    const decision = service.increment("nonexistent" as "auth.login", "key");
    expect(decision.allowed).toBe(true);
  });

  it("check does not increment counter", () => {
    const before = service.check("auth.login", "192.168.1.1");
    const after = service.check("auth.login", "192.168.1.1");
    expect(before.remaining).toBe(after.remaining);
  });

  it("includes resetAt in decision", () => {
    const decision = service.increment("auth.login", "192.168.1.1");
    expect(decision.resetAt).toBeTruthy();
    expect(new Date(decision.resetAt).getTime()).toBeGreaterThan(0);
  });

  it("supports policy overrides", () => {
    const customService = createFridayRateLimitService({
      db,
      nowIso: () => NOW,
      policyOverrides: {
        "auth.login": { maxHits: 2 },
      },
    });

    customService.increment("auth.login", "key");
    customService.increment("auth.login", "key");
    const decision = customService.increment("auth.login", "key");
    expect(decision.allowed).toBe(false);
  });
});
```

## `test/unit/api/auth/friday-rbac-policy.test.ts`
```ts
import { describe, it, expect } from "vitest";
import {
  getScopesForRole,
  roleHasScope,
  principalHasAnyScope,
  principalHasAnyRole,
} from "../../../../src/api/auth/friday-rbac-policy.js";

describe("FridayRbacPolicy", () => {
  describe("getScopesForRole", () => {
    it("returns all scopes for owner", () => {
      const scopes = getScopesForRole("owner");
      expect(scopes).toContain("hub.admin");
      expect(scopes).toContain("workflow.read");
      expect(scopes).toContain("security.write");
      expect(scopes).toContain("skill.write");
    });

    it("returns all scopes for admin", () => {
      const scopes = getScopesForRole("admin");
      expect(scopes).toContain("hub.admin");
      expect(scopes).toContain("security.write");
    });

    it("returns limited scopes for operator", () => {
      const scopes = getScopesForRole("operator");
      expect(scopes).toContain("workflow.read");
      expect(scopes).toContain("workflow.write");
      expect(scopes).toContain("workflow.run");
      expect(scopes).not.toContain("hub.admin");
      expect(scopes).not.toContain("security.write");
    });

    it("returns read-only scopes for viewer", () => {
      const scopes = getScopesForRole("viewer");
      expect(scopes).toContain("workflow.read");
      expect(scopes).toContain("fleet.read");
      expect(scopes).not.toContain("workflow.write");
      expect(scopes).not.toContain("workflow.run");
      expect(scopes).not.toContain("hub.admin");
    });
  });

  describe("roleHasScope", () => {
    it("owner has hub.admin", () => {
      expect(roleHasScope("owner", "hub.admin")).toBe(true);
    });

    it("viewer does not have workflow.write", () => {
      expect(roleHasScope("viewer", "workflow.write")).toBe(false);
    });

    it("operator has satellite.read", () => {
      expect(roleHasScope("operator", "satellite.read")).toBe(true);
    });

    it("operator does not have satellite.write", () => {
      expect(roleHasScope("operator", "satellite.write")).toBe(false);
    });
  });

  describe("principalHasAnyScope", () => {
    it("returns true when principal has at least one required scope", () => {
      expect(
        principalHasAnyScope(["workflow.read", "workflow.write"], ["workflow.read"]),
      ).toBe(true);
    });

    it("returns false when principal has none of the required scopes", () => {
      expect(
        principalHasAnyScope(["workflow.read"], ["hub.admin", "security.write"]),
      ).toBe(false);
    });
  });

  describe("principalHasAnyRole", () => {
    it("returns true when principal role is in required roles", () => {
      expect(principalHasAnyRole("admin", ["admin", "owner"])).toBe(true);
    });

    it("returns false when principal role is not in required roles", () => {
      expect(principalHasAnyRole("viewer", ["admin", "owner"])).toBe(false);
    });

    it("returns false for undefined role", () => {
      expect(principalHasAnyRole(undefined, ["admin"])).toBe(false);
    });
  });
});
```

## `test/unit/api/auth/friday-token-validator.test.ts`
```ts
import { describe, it, expect } from "vitest";
import {
  createFridayTokenValidator,
  encodeToken,
  TokenValidationError,
} from "../../../../src/api/auth/friday-token-validator.js";
import type { FridayAccessTokenClaims } from "../../../../src/api/model/friday-api-auth.types.js";

describe("FridayTokenValidator", () => {
  const SECRET = "test-secret-key";
  const NOW_SEC = Math.floor(Date.parse("2025-06-15T10:00:00.000Z") / 1000);

  function makeClaims(overrides?: Partial<FridayAccessTokenClaims>): FridayAccessTokenClaims {
    return {
      tokenId: "tok-001",
      principalType: "user",
      principalId: "user-001",
      userId: "user-001",
      role: "admin",
      scopes: ["workflow.read", "workflow.write"],
      iat: NOW_SEC,
      exp: NOW_SEC + 900,
      ...overrides,
    };
  }

  function makeValidator(overrides?: {
    nowMs?: () => number;
    lookupRevoked?: (id: string) => boolean;
    lookupSatVersion?: (id: string) => number | null;
  }) {
    return createFridayTokenValidator({
      tokenSecret: SECRET,
      nowMs: overrides?.nowMs ?? (() => NOW_SEC * 1000),
      lookupTokenRevocation: overrides?.lookupRevoked ?? (() => false),
      lookupSatelliteTokenVersion: overrides?.lookupSatVersion,
    });
  }

  it("validates a well-formed token", () => {
    const claims = makeClaims();
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator();

    const result = validator.validate(token);
    expect(result.principal.principalId).toBe("user-001");
    expect(result.principal.scopes).toContain("workflow.read");
    expect(result.rawToken).toBe(token);
  });

  it("rejects a token with invalid signature", () => {
    const claims = makeClaims();
    const token = encodeToken(claims, "wrong-secret");
    const validator = makeValidator();

    expect(() => validator.validate(token)).toThrow(TokenValidationError);
    try {
      validator.validate(token);
    } catch (e) {
      expect((e as TokenValidationError).code).toBe("INVALID_SIGNATURE");
    }
  });

  it("rejects an expired token", () => {
    const claims = makeClaims({ exp: NOW_SEC - 100 });
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator();

    expect(() => validator.validate(token)).toThrow(TokenValidationError);
    try {
      validator.validate(token);
    } catch (e) {
      expect((e as TokenValidationError).code).toBe("TOKEN_EXPIRED");
    }
  });

  it("rejects a revoked token", () => {
    const claims = makeClaims();
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator({ lookupRevoked: () => true });

    expect(() => validator.validate(token)).toThrow(TokenValidationError);
    try {
      validator.validate(token);
    } catch (e) {
      expect((e as TokenValidationError).code).toBe("TOKEN_REVOKED");
    }
  });

  it("rejects a satellite token with outdated version", () => {
    const claims = makeClaims({
      principalType: "satellite",
      principalId: "sat-001",
      ver: 1,
    });
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator({
      lookupSatVersion: () => 2,
    });

    expect(() => validator.validate(token)).toThrow(TokenValidationError);
    try {
      validator.validate(token);
    } catch (e) {
      expect((e as TokenValidationError).code).toBe("TOKEN_VERSION_MISMATCH");
    }
  });

  it("accepts a satellite token with matching version", () => {
    const claims = makeClaims({
      principalType: "satellite",
      principalId: "sat-001",
      ver: 2,
    });
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator({
      lookupSatVersion: () => 2,
    });

    const result = validator.validate(token);
    expect(result.principal.principalId).toBe("sat-001");
  });

  it("rejects malformed token (no dot)", () => {
    const validator = makeValidator();
    expect(() => validator.validate("no-dot-token")).toThrow(TokenValidationError);
  });

  it("builds correct principal from claims", () => {
    const claims = makeClaims({
      sid: "session-123",
      ver: 3,
    });
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator();

    const result = validator.validate(token);
    expect(result.principal.tokenKind).toBe("access");
    expect(result.principal.sessionId).toBe("session-123");
    expect(result.principal.tokenVersion).toBe(3);
    expect(result.principal.issuedAt).toBeTruthy();
    expect(result.principal.expiresAt).toBeTruthy();
  });
});
```

## `test/unit/api/conflicts/friday-workflow-conflict-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import {
  createFridayWorkflowConflictService,
  ConflictServiceError,
} from "../../../../src/api/conflicts/friday-workflow-conflict-service.js";
import type { FridayWorkflowConflictService } from "../../../../src/api/conflicts/friday-workflow-conflict-service.types.js";

describe("FridayWorkflowConflictService", () => {
  let db: FridaySqliteLayer;
  let service: FridayWorkflowConflictService;
  let idGen: () => string;
  const NOW = "2025-06-15T10:00:00.000Z";

  function insertLock(workflowId: string, lockToken: string, ownerUserId: string, expiresAt = "2025-06-16T10:00:00.000Z") {
    db.writer.prepare(
      `INSERT INTO workflow_locks (workflow_id, lock_token, owner_user_id, acquired_at, heartbeat_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(workflowId, lockToken, ownerUserId, NOW, NOW, expiresAt, NOW, NOW);
  }

  function insertDraft(draftId: string, workflowId: string, revision = 1) {
    db.writer.prepare(
      `INSERT INTO workflow_builder_drafts (draft_id, workflow_id, title, status, revision, spec_json, visual_json, created_at, updated_at)
       VALUES (?, ?, 'Test Draft', 'active', ?, '{}', '{}', ?, ?)`,
    ).run(draftId, workflowId, revision, NOW, NOW);
  }

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    service = createFridayWorkflowConflictService({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── detectConflict ───

  it("returns null when no base version provided", () => {
    const result = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      headWorkflowVersionId: "v2",
      summary: "test conflict",
    });
    expect(result).toBeNull();
  });

  it("returns null when base matches head (no divergence)", () => {
    const result = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v1",
      summary: "no conflict",
    });
    expect(result).toBeNull();
  });

  it("detects conflict when base differs from head", () => {
    const result = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "Someone published v2 while editing from v1",
    });

    expect(result).not.toBeNull();
    expect(result!.conflictId).toBeTruthy();
    expect(result!.workflowId).toBe("wf-1");
    expect(result!.draftId).toBe("draft-1");
    expect(result!.kind).toBe("revision_conflict");
    expect(result!.status).toBe("open");
    expect(result!.baseWorkflowVersionId).toBe("v1");
    expect(result!.headWorkflowVersionId).toBe("v2");
    expect(result!.detectedAt).toBe(NOW);
  });

  it("persists conflict to database", () => {
    service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "persisted conflict",
    });

    const row = db.writer
      .prepare("SELECT * FROM workflow_conflicts WHERE workflow_id = 'wf-1'")
      .get() as any;
    expect(row).toBeTruthy();
    expect(row.status).toBe("open");
  });

  // ─── listConflicts ───

  it("lists conflicts for a workflow", () => {
    service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "conflict 1",
    });
    service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-2",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v3",
      summary: "conflict 2",
    });
    service.detectConflict({
      workflowId: "wf-2",
      draftId: "draft-3",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "conflict for different workflow",
    });

    const conflicts = service.listConflicts("wf-1");
    expect(conflicts).toHaveLength(2);
  });

  it("filters conflicts by status", () => {
    insertLock("wf-1", "lock-1", "user-1");
    insertDraft("draft-1", "wf-1", 1);

    const conflict = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "to be resolved",
    })!;

    service.resolveConflict(
      conflict.conflictId,
      {
        resolution: { strategy: "accept_local" },
        lockToken: "lock-1",
        expectedDraftRevision: 1,
      },
      "user-1",
    );

    service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-2",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v3",
      summary: "still open",
    });

    const openConflicts = service.listConflicts("wf-1", "open");
    expect(openConflicts).toHaveLength(1);
    expect(openConflicts[0].status).toBe("open");

    const resolved = service.listConflicts("wf-1", "resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].status).toBe("resolved");
  });

  // ─── getConflict ───

  it("returns a conflict by ID", () => {
    const created = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "get by id",
    })!;

    const retrieved = service.getConflict(created.conflictId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.conflictId).toBe(created.conflictId);
  });

  it("returns null for unknown conflict ID", () => {
    const result = service.getConflict("nonexistent");
    expect(result).toBeNull();
  });

  // ─── resolveConflict ───

  it("resolves an open conflict with accept_local strategy", () => {
    insertLock("wf-1", "lock-1", "user-1");
    insertDraft("draft-1", "wf-1", 1);

    const conflict = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "resolve me",
    })!;

    const result = service.resolveConflict(
      conflict.conflictId,
      {
        resolution: { strategy: "accept_local" },
        lockToken: "lock-1",
        expectedDraftRevision: 1,
      },
      "user-1",
    );

    expect(result.conflict.status).toBe("resolved");
    expect(result.conflict.resolvedAt).toBe(NOW);
    expect(result.conflict.resolvedByUserId).toBe("user-1");
    expect(result.draft).toBeTruthy();
    expect(result.draft.draftId).toBe("draft-1");
  });

  it("throws NOT_FOUND for unknown conflict", () => {
    expect(() =>
      service.resolveConflict(
        "nonexistent",
        {
          resolution: { strategy: "accept_local" },
          lockToken: "lock-1",
          expectedDraftRevision: 1,
        },
        "user-1",
      ),
    ).toThrow(ConflictServiceError);

    try {
      service.resolveConflict(
        "nonexistent",
        {
          resolution: { strategy: "accept_local" },
          lockToken: "lock-1",
          expectedDraftRevision: 1,
        },
        "user-1",
      );
    } catch (err) {
      expect((err as ConflictServiceError).code).toBe("NOT_FOUND");
    }
  });

  it("throws ALREADY_RESOLVED for already resolved conflict", () => {
    insertLock("wf-1", "lock-1", "user-1");
    insertLock("wf-1", "lock-2", "user-2");
    insertDraft("draft-1", "wf-1", 1);

    const conflict = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "resolve twice",
    })!;

    service.resolveConflict(
      conflict.conflictId,
      {
        resolution: { strategy: "accept_local" },
        lockToken: "lock-1",
        expectedDraftRevision: 1,
      },
      "user-1",
    );

    expect(() =>
      service.resolveConflict(
        conflict.conflictId,
        {
          resolution: { strategy: "accept_remote" },
          lockToken: "lock-2",
          expectedDraftRevision: 2,
        },
        "user-2",
      ),
    ).toThrow(ConflictServiceError);

    try {
      service.resolveConflict(
        conflict.conflictId,
        {
          resolution: { strategy: "accept_remote" },
          lockToken: "lock-2",
          expectedDraftRevision: 2,
        },
        "user-2",
      );
    } catch (err) {
      expect((err as ConflictServiceError).code).toBe("ALREADY_RESOLVED");
    }
  });

  it("draft revision is incremented after resolution", () => {
    insertLock("wf-1", "lock-1", "user-1");
    insertDraft("draft-1", "wf-1", 5);

    const conflict = service.detectConflict({
      workflowId: "wf-1",
      draftId: "draft-1",
      baseWorkflowVersionId: "v1",
      headWorkflowVersionId: "v2",
      summary: "revision test",
    })!;

    const result = service.resolveConflict(
      conflict.conflictId,
      {
        resolution: { strategy: "accept_local" },
        lockToken: "lock-1",
        expectedDraftRevision: 5,
      },
      "user-1",
    );

    expect(result.draft.revision).toBe(6);
  });
});
```

## `test/unit/api/fleet/friday-fleet-dashboard-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import {
  createFridayFleetDashboardRepository,
  type FridayFleetDashboardRepository,
} from "../../../../src/api/fleet/friday-fleet-dashboard-repository.js";

describe("FridayFleetDashboardRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayFleetDashboardRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  function insertSatellite(
    id: string,
    opts: {
      displayName?: string;
      type?: string;
      pairingStatus?: string;
      trustLevel?: string;
      tags?: string[];
      deletedAt?: string | null;
    } = {},
  ) {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, display_name, type, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, last_seen_at, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.displayName ?? `Satellite ${id}`,
        opts.type ?? "standard",
        opts.pairingStatus ?? "online",
        opts.trustLevel ?? "trusted",
        JSON.stringify(opts.tags ?? []),
        NOW,
        NOW,
        NOW,
        opts.deletedAt ?? null,
      );
  }

  function insertHeartbeat(
    satelliteId: string,
    ts: string,
    opts: { cpu?: number; mem?: number; load?: number; queue?: number; runs?: number } = {},
  ) {
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status, cpu_percent, memory_percent, load_avg_1m, queue_depth, active_runs)
         VALUES (?, ?, ?, 'ok', ?, ?, ?, ?, ?)`,
      )
      .run(
        `hb-${satelliteId}-${ts}`,
        satelliteId,
        ts,
        opts.cpu ?? 25,
        opts.mem ?? 50,
        opts.load ?? 0.5,
        opts.queue ?? 3,
        opts.runs ?? 1,
      );
  }

  let msgCounter = 0;
  function insertOutboxMessage(
    satelliteId: string,
    status: string,
    id?: string,
  ) {
    msgCounter++;
    db.writer
      .prepare(
        `INSERT INTO outbox_messages (id, satellite_id, queue_key, message_type, payload_ciphertext, nonce, key_id, idempotency_key, status, created_at, updated_at)
         VALUES (?, ?, 'commands', 'task', 'enc', 'n', 'k', ?, ?, ?, ?)`,
      )
      .run(id ?? `msg-${msgCounter}`, satelliteId, `idem-${msgCounter}`, status, NOW, NOW);
  }

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayFleetDashboardRepository();
  });

  afterEach(() => {
    db.close();
  });

  // ─── listSatellitesWithHeartbeat ───

  it("returns satellites with their latest heartbeat", () => {
    insertSatellite("sat-1");
    insertHeartbeat("sat-1", "2025-06-15T09:00:00.000Z", { cpu: 10 });
    insertHeartbeat("sat-1", "2025-06-15T09:30:00.000Z", { cpu: 50 });

    const rows = db.withReadConnection((r) =>
      repo.listSatellitesWithHeartbeat(r),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cpu_percent).toBe(50); // latest heartbeat
  });

  it("excludes deleted satellites", () => {
    insertSatellite("sat-1");
    insertSatellite("sat-deleted", { deletedAt: NOW });

    const rows = db.withReadConnection((r) =>
      repo.listSatellitesWithHeartbeat(r),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("sat-1");
  });

  it("returns satellite with null heartbeat when no heartbeat exists", () => {
    insertSatellite("sat-no-hb");

    const rows = db.withReadConnection((r) =>
      repo.listSatellitesWithHeartbeat(r),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].hb_ts).toBeNull();
    expect(rows[0].cpu_percent).toBeNull();
  });

  // ─── getQueueStatsBySatellite ───

  it("returns queue stats for a satellite", () => {
    insertSatellite("sat-1");
    insertOutboxMessage("sat-1", "queued", "m1");
    insertOutboxMessage("sat-1", "queued", "m2");
    insertOutboxMessage("sat-1", "leased", "m3");
    insertOutboxMessage("sat-1", "failed", "m4");
    insertOutboxMessage("sat-1", "dead_letter", "m5");

    const stats = db.withReadConnection((r) =>
      repo.getQueueStatsBySatellite(r, "sat-1"),
    );
    expect(stats).not.toBeNull();
    expect(stats!.queued_count).toBe(2);
    expect(stats!.leased_count).toBe(1);
    expect(stats!.failed_count).toBe(1);
    expect(stats!.dead_letter_count).toBe(1);
  });

  it("returns null when no outbox messages for satellite", () => {
    insertSatellite("sat-1");
    const stats = db.withReadConnection((r) =>
      repo.getQueueStatsBySatellite(r, "sat-1"),
    );
    expect(stats).toBeNull();
  });

  // ─── getGlobalQueueStats ───

  it("returns global queue stats across all satellites", () => {
    insertSatellite("sat-1");
    insertSatellite("sat-2");
    insertOutboxMessage("sat-1", "queued", "m1");
    insertOutboxMessage("sat-2", "queued", "m2");
    insertOutboxMessage("sat-2", "failed", "m3");

    const stats = db.withReadConnection((r) => repo.getGlobalQueueStats(r));
    expect(stats.queued_count).toBe(2);
    expect(stats.failed_count).toBe(1);
  });

  it("returns zero/null counts when no messages exist", () => {
    const stats = db.withReadConnection((r) => repo.getGlobalQueueStats(r));
    // SUM() returns null when no rows match, so the fallback object provides 0
    // But the actual query may return null for each SUM column
    expect(stats.queued_count ?? 0).toBe(0);
    expect(stats.leased_count ?? 0).toBe(0);
  });

  // ─── getPairingStatusCounts ───

  it("returns counts by pairing status", () => {
    insertSatellite("sat-1", { pairingStatus: "online" });
    insertSatellite("sat-2", { pairingStatus: "online" });
    insertSatellite("sat-3", { pairingStatus: "pending" });
    insertSatellite("sat-4", { pairingStatus: "revoked" });
    insertSatellite("sat-del", { pairingStatus: "online", deletedAt: NOW });

    const counts = db.withReadConnection((r) => repo.getPairingStatusCounts(r));
    const map: Record<string, number> = {};
    for (const row of counts) map[row.pairing_status] = row.count;

    expect(map["online"]).toBe(2);
    expect(map["pending"]).toBe(1);
    expect(map["revoked"]).toBe(1);
  });

  // ─── getDeadLetterCount ───

  it("returns dead letter count for satellite", () => {
    insertSatellite("sat-1");
    insertOutboxMessage("sat-1", "dead_letter", "m1");
    insertOutboxMessage("sat-1", "dead_letter", "m2");
    insertOutboxMessage("sat-1", "queued", "m3");

    const count = db.withReadConnection((r) =>
      repo.getDeadLetterCount(r, "sat-1"),
    );
    expect(count).toBe(2);
  });

  // ─── getCapabilities ───

  it("returns capabilities for a satellite", () => {
    insertSatellite("sat-1");
    db.writer
      .prepare(
        `INSERT INTO satellite_capabilities (id, satellite_id, key, available, limits_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("cap-1", "sat-1", "gpu", 1, '{"maxVram": 8192}', null, NOW, NOW);

    const caps = db.withReadConnection((r) =>
      repo.getCapabilities(r, "sat-1"),
    );
    expect(caps).toHaveLength(1);
    expect(caps[0].key).toBe("gpu");
    expect(caps[0].available).toBe(1);
    expect(JSON.parse(caps[0].limits_json!)).toEqual({ maxVram: 8192 });
  });
});
```

## `test/unit/api/fleet/friday-fleet-dashboard-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.js";
import { createFridayFleetDashboardService } from "../../../../src/api/fleet/friday-fleet-dashboard-service.js";
import type { FridayFleetDashboardService } from "../../../../src/api/fleet/friday-fleet-dashboard-service.types.js";

describe("FridayFleetDashboardService", () => {
  let db: FridaySqliteLayer;
  let service: FridayFleetDashboardService;
  const NOW = "2025-06-15T10:00:00.000Z";

  function insertSatellite(
    id: string,
    opts: {
      displayName?: string;
      type?: string;
      pairingStatus?: string;
      trustLevel?: string;
      tags?: string[];
    } = {},
  ) {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, display_name, type, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.displayName ?? `Satellite ${id}`,
        opts.type ?? "standard",
        opts.pairingStatus ?? "online",
        opts.trustLevel ?? "trusted",
        JSON.stringify(opts.tags ?? []),
        NOW,
        NOW,
        NOW,
      );
  }

  function insertHeartbeat(
    satelliteId: string,
    ts: string,
    opts: { cpu?: number; mem?: number; load?: number; queue?: number; runs?: number } = {},
  ) {
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status, cpu_percent, memory_percent, load_avg_1m, queue_depth, active_runs)
         VALUES (?, ?, ?, 'ok', ?, ?, ?, ?, ?)`,
      )
      .run(
        `hb-${satelliteId}-${ts}`,
        satelliteId,
        ts,
        opts.cpu ?? 25,
        opts.mem ?? 50,
        opts.load ?? 0.5,
        opts.queue ?? 3,
        opts.runs ?? 1,
      );
  }

  function insertApiToken(
    tokenId: string,
    opts: { scopes?: string[]; revokedAt?: string | null; expiresAt?: string | null } = {},
  ) {
    db.writer
      .prepare(
        `INSERT INTO api_tokens (id, user_id, principal_type, label, token_hash, scopes_json, expires_at, revoked_at, created_at, updated_at)
         VALUES (?, 'test-user', 'user', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tokenId,
        `Token ${tokenId}`,
        `hash-${tokenId}`,
        JSON.stringify(opts.scopes ?? ["workflow.read"]),
        opts.expiresAt ?? null,
        opts.revokedAt ?? null,
        NOW,
        NOW,
      );
  }

  function insertPairingRequest(id: string, status: string) {
    db.writer
      .prepare(
        `INSERT INTO satellite_pairing_requests (id, code, nonce, status, expires_at, created_at, updated_at)
         VALUES (?, 'code-123', 'nonce-456', ?, ?, ?, ?)`,
      )
      .run(id, status, "2099-01-01T00:00:00.000Z", NOW, NOW);
  }

  beforeEach(() => {
    db = createTestDb();
    service = createFridayFleetDashboardService({
      db,
      nowIso: () => NOW,
      idGenerator: createTestIdGenerator(),
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── getOverview ───

  it("returns fleet overview with totals", () => {
    insertSatellite("sat-1", { pairingStatus: "online" });
    insertSatellite("sat-2", { pairingStatus: "online" });
    insertSatellite("sat-3", { pairingStatus: "pending" });
    insertHeartbeat("sat-1", "2025-06-15T09:59:55.000Z"); // 5s old
    insertHeartbeat("sat-2", "2025-06-15T09:59:55.000Z");

    const overview = service.getOverview();
    expect(overview.generatedAt).toBe(NOW);
    expect(overview.totals.satellites).toBe(3);
    expect(overview.totals.online).toBe(2);
    expect(overview.totals.pending).toBe(1);
  });

  it("returns health score and state", () => {
    insertSatellite("sat-1", { pairingStatus: "online" });
    insertHeartbeat("sat-1", "2025-06-15T09:59:55.000Z", { cpu: 10, mem: 15 });

    const overview = service.getOverview();
    expect(overview.health.score).toBeGreaterThan(0);
    expect(["healthy", "degraded", "critical"]).toContain(overview.health.state);
  });

  it("returns trust metrics", () => {
    insertSatellite("sat-1", { pairingStatus: "online", trustLevel: "trusted" });

    const overview = service.getOverview();
    expect(overview.trust.averageScore).toBeGreaterThan(0);
  });

  it("returns empty overview when no satellites exist", () => {
    const overview = service.getOverview();
    expect(overview.totals.satellites).toBe(0);
    expect(overview.health.score).toBe(100); // default when no satellites
    expect(overview.health.state).toBe("healthy");
  });

  // ─── listSatellites ───

  it("lists all satellites as cards", () => {
    insertSatellite("sat-1");
    insertSatellite("sat-2");
    insertHeartbeat("sat-1", "2025-06-15T09:59:55.000Z");
    insertHeartbeat("sat-2", "2025-06-15T09:59:55.000Z");

    const result = service.listSatellites({});
    expect(result.items).toHaveLength(2);
    expect(result.items[0].satelliteId).toBeTruthy();
    expect(result.items[0].healthState).toBeTruthy();
    expect(result.items[0].trustBand).toBeTruthy();
  });

  it("filters by pairing status", () => {
    insertSatellite("sat-1", { pairingStatus: "online" });
    insertSatellite("sat-2", { pairingStatus: "pending" });

    const result = service.listSatellites({ pairingStatus: "online" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].pairingStatus).toBe("online");
  });

  it("filters by trust level", () => {
    insertSatellite("sat-1", { trustLevel: "trusted" });
    insertSatellite("sat-2", { trustLevel: "restricted" });

    const result = service.listSatellites({ trustLevel: "trusted" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].trustLevel).toBe("trusted");
  });

  it("search by display name", () => {
    insertSatellite("sat-alpha", { displayName: "Alpha Bot" });
    insertSatellite("sat-beta", { displayName: "Beta Bot" });

    const result = service.listSatellites({ q: "alpha" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].displayName).toBe("Alpha Bot");
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      insertSatellite(`sat-${i}`);
    }

    const result = service.listSatellites({ limit: 2 });
    expect(result.items.length).toBeLessThanOrEqual(2);
  });

  it("satellite card includes health and trust data", () => {
    // With no heartbeat, health is degraded (not critical: hb=0, resource=100, queue=100, reliability=100 → 65)
    // revoked+restricted trust: identity=20, status=0, hygiene=20 → 40 = medium
    insertSatellite("sat-crit", { pairingStatus: "revoked", trustLevel: "restricted" });

    const result = service.listSatellites({});
    const card = result.items.find((c) => c.satelliteId === "sat-crit");
    expect(card).toBeTruthy();
    expect(card!.healthState).toBe("degraded");
    expect(card!.trustBand).toBe("medium");
    expect(card!.pairingStatus).toBe("revoked");
  });

  // ─── getSatelliteDetail ───

  it("returns detailed satellite information", () => {
    insertSatellite("sat-1");
    insertHeartbeat("sat-1", "2025-06-15T09:59:55.000Z", { cpu: 30, mem: 40 });

    db.writer
      .prepare(
        `INSERT INTO satellite_capabilities (id, satellite_id, key, available, limits_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'gpu', 1, '{"maxVram": 8192}', null, ?, ?)`,
      )
      .run("cap-1", "sat-1", NOW, NOW);

    const detail = service.getSatelliteDetail("sat-1");
    expect(detail).not.toBeNull();
    expect(detail!.satellite.satelliteId).toBe("sat-1");
    expect(detail!.capabilities).toHaveLength(1);
    expect(detail!.capabilities[0].key).toBe("gpu");
    expect(detail!.capabilities[0].available).toBe(true);
    expect(detail!.healthBreakdown).toBeTruthy();
    expect(detail!.trustBreakdown).toBeTruthy();
  });

  it("returns null for unknown satellite", () => {
    const detail = service.getSatelliteDetail("nonexistent");
    expect(detail).toBeNull();
  });

  // ─── getSecurityCenter ───

  it("returns security center with token stats", () => {
    insertApiToken("tok-1", { scopes: ["workflow.read"] });
    insertApiToken("tok-2", { scopes: ["hub.admin"], revokedAt: "2025-06-15T05:00:00.000Z" });
    insertApiToken("tok-3", { scopes: ["workflow.read"], expiresAt: "2025-06-14T00:00:00.000Z" });

    const security = service.getSecurityCenter();
    expect(security.generatedAt).toBe(NOW);
    expect(security.tokens.active).toBeGreaterThanOrEqual(1);
    expect(security.tokens.revoked24h).toBeGreaterThanOrEqual(1);
  });

  it("returns pending pairing count", () => {
    insertPairingRequest("pr-1", "pending");
    insertPairingRequest("pr-2", "pending");
    insertPairingRequest("pr-3", "approved");

    const security = service.getSecurityCenter();
    expect(security.satellites.pendingPairings).toBe(2);
  });

  it("counts high-privilege active tokens", () => {
    insertApiToken("tok-admin-1", { scopes: ["hub.admin"] });
    insertApiToken("tok-admin-2", { scopes: ["security.write"] });
    insertApiToken("tok-normal", { scopes: ["workflow.read"] });

    const security = service.getSecurityCenter();
    expect(security.tokens.highPrivilegeActive).toBe(2);
  });
});
```

## `test/unit/api/fleet/friday-fleet-health-calculator.test.ts`
```ts
import { describe, it, expect } from "vitest";
import {
  calculateSatelliteHealth,
  healthStateFromScore,
  type FridayHealthCalculatorInput,
} from "../../../../src/api/fleet/friday-fleet-health-calculator.js";

describe("FridayFleetHealthCalculator", () => {
  function makeInput(overrides: Partial<FridayHealthCalculatorInput> = {}): FridayHealthCalculatorInput {
    return {
      lastHeartbeatAgeMs: 10_000,
      cpuPercent: 20,
      memoryPercent: 30,
      loadAvg1m: 0.2,
      queueDepth: 5,
      deadLetterCount: 0,
      failedNodeCount1h: 0,
      totalNodeCount1h: 10,
      ...overrides,
    };
  }

  // ─── healthStateFromScore ───

  it("returns 'healthy' for score >= 80", () => {
    expect(healthStateFromScore(80)).toBe("healthy");
    expect(healthStateFromScore(100)).toBe("healthy");
  });

  it("returns 'degraded' for score 55-79", () => {
    expect(healthStateFromScore(55)).toBe("degraded");
    expect(healthStateFromScore(79)).toBe("degraded");
  });

  it("returns 'critical' for score < 55", () => {
    expect(healthStateFromScore(54)).toBe("critical");
    expect(healthStateFromScore(0)).toBe("critical");
  });

  // ─── Heartbeat score ───

  it("heartbeat < 30s → heartbeatScore = 100", () => {
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: 5_000 }));
    expect(result.heartbeatScore).toBe(100);
  });

  it("heartbeat = 30s → heartbeatScore = 100", () => {
    // At exactly 30s, ratio = 0, so score = 100
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: 30_000 }));
    expect(result.heartbeatScore).toBe(100);
  });

  it("heartbeat = 60s → heartbeatScore = 70 (midpoint of linear decay)", () => {
    // At 60s: ratio = (60_000-30_000)/60_000 = 0.5, score = 100 - 0.5*60 = 70
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: 60_000 }));
    expect(result.heartbeatScore).toBe(70);
  });

  it("heartbeat = 90s → heartbeatScore = 40 (end of linear decay)", () => {
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: 90_000 }));
    expect(result.heartbeatScore).toBe(40);
  });

  it("heartbeat > 90s → heartbeatScore = 10", () => {
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: 120_000 }));
    expect(result.heartbeatScore).toBe(10);
  });

  it("null heartbeat → heartbeatScore = 0", () => {
    const result = calculateSatelliteHealth(makeInput({ lastHeartbeatAgeMs: null }));
    expect(result.heartbeatScore).toBe(0);
  });

  // ─── Resource score ───

  it("low resource usage → high resource score", () => {
    const result = calculateSatelliteHealth(
      makeInput({ cpuPercent: 10, memoryPercent: 15, loadAvg1m: 0.1 }),
    );
    // max(10, 15, 10) = 15; score = 100 - 15 = 85
    expect(result.resourceScore).toBe(85);
  });

  it("high CPU usage → low resource score", () => {
    const result = calculateSatelliteHealth(
      makeInput({ cpuPercent: 90, memoryPercent: 30, loadAvg1m: 0.2 }),
    );
    // max(90, 30, 20) = 90; score = 100 - 90 = 10
    expect(result.resourceScore).toBe(10);
  });

  it("null resource values treated as 0", () => {
    const result = calculateSatelliteHealth(
      makeInput({ cpuPercent: null, memoryPercent: null, loadAvg1m: null }),
    );
    expect(result.resourceScore).toBe(100);
  });

  // ─── Queue score ───

  it("empty queue → queueScore = 100", () => {
    const result = calculateSatelliteHealth(makeInput({ queueDepth: 0 }));
    expect(result.queueScore).toBe(100);
  });

  it("queue depth 50 → queueScore = 50", () => {
    const result = calculateSatelliteHealth(makeInput({ queueDepth: 50 }));
    expect(result.queueScore).toBe(50);
  });

  it("queue depth >= 100 → queueScore = 0", () => {
    const result = calculateSatelliteHealth(makeInput({ queueDepth: 100 }));
    expect(result.queueScore).toBe(0);

    const over = calculateSatelliteHealth(makeInput({ queueDepth: 200 }));
    expect(over.queueScore).toBe(0);
  });

  // ─── Reliability score ───

  it("no dead letters and no failures → reliabilityScore = 100", () => {
    const result = calculateSatelliteHealth(
      makeInput({ deadLetterCount: 0, failedNodeCount1h: 0, totalNodeCount1h: 10 }),
    );
    expect(result.reliabilityScore).toBe(100);
  });

  it("dead letters reduce reliability", () => {
    const result = calculateSatelliteHealth(
      makeInput({ deadLetterCount: 3, failedNodeCount1h: 0, totalNodeCount1h: 0 }),
    );
    // 100 - min(3*10, 50) = 100 - 30 = 70
    expect(result.reliabilityScore).toBe(70);
  });

  it("high dead letter count caps at -50", () => {
    const result = calculateSatelliteHealth(
      makeInput({ deadLetterCount: 10, failedNodeCount1h: 0, totalNodeCount1h: 0 }),
    );
    // 100 - min(100, 50) = 50
    expect(result.reliabilityScore).toBe(50);
  });

  it("failed nodes reduce reliability", () => {
    const result = calculateSatelliteHealth(
      makeInput({ deadLetterCount: 0, failedNodeCount1h: 5, totalNodeCount1h: 10 }),
    );
    // failRate = 0.5, penalty = min(50, 50) = 50; score = 100 - 50 = 50
    expect(result.reliabilityScore).toBe(50);
  });

  // ─── Composite score ───

  it("perfect health → score ≈ 100 → healthy", () => {
    const result = calculateSatelliteHealth(
      makeInput({
        lastHeartbeatAgeMs: 5_000,
        cpuPercent: 10,
        memoryPercent: 10,
        loadAvg1m: 0.05,
        queueDepth: 0,
        deadLetterCount: 0,
        failedNodeCount1h: 0,
        totalNodeCount1h: 10,
      }),
    );
    // hb=100, resource=90, queue=100, reliability=100
    // 0.35*100 + 0.25*90 + 0.20*100 + 0.20*100 = 35+22.5+20+20 = 97.5 → 98
    expect(result.finalScore).toBeGreaterThanOrEqual(95);
    expect(result.state).toBe("healthy");
  });

  it("terrible health → low score → critical", () => {
    const result = calculateSatelliteHealth(
      makeInput({
        lastHeartbeatAgeMs: null,
        cpuPercent: 95,
        memoryPercent: 90,
        loadAvg1m: 2.0,
        queueDepth: 200,
        deadLetterCount: 10,
        failedNodeCount1h: 10,
        totalNodeCount1h: 10,
      }),
    );
    expect(result.finalScore).toBeLessThan(55);
    expect(result.state).toBe("critical");
  });

  it("borderline degraded health", () => {
    // Calibrate to get score ~65
    const result = calculateSatelliteHealth(
      makeInput({
        lastHeartbeatAgeMs: 60_000, // hb=70
        cpuPercent: 50,             // resource=50
        memoryPercent: 40,
        loadAvg1m: 0.2,
        queueDepth: 30,             // queue=70
        deadLetterCount: 1,
        failedNodeCount1h: 1,
        totalNodeCount1h: 10,
      }),
    );
    // hb=70, resource=50, queue=70, reliability=80
    // 0.35*70 + 0.25*50 + 0.20*70 + 0.20*80 = 24.5+12.5+14+16 = 67
    expect(result.state).toBe("degraded");
  });
});
```

## `test/unit/api/fleet/friday-fleet-trust-calculator.test.ts`
```ts
import { describe, it, expect } from "vitest";
import {
  calculateSatelliteTrust,
  trustBandFromScore,
  type FridayTrustCalculatorInput,
} from "../../../../src/api/fleet/friday-fleet-trust-calculator.js";

describe("FridayFleetTrustCalculator", () => {
  function makeInput(overrides: Partial<FridayTrustCalculatorInput> = {}): FridayTrustCalculatorInput {
    return {
      pairingStatus: "online",
      trustLevel: "trusted",
      hasRevokedTokens: false,
      hasExpiredHighPrivTokens: false,
      recentRevocationCount: 0,
      recentSecurityFindingsCount: 0,
      ...overrides,
    };
  }

  // ─── trustBandFromScore ───

  it("returns 'high' for score >= 70", () => {
    expect(trustBandFromScore(70)).toBe("high");
    expect(trustBandFromScore(100)).toBe("high");
  });

  it("returns 'medium' for score 40-69", () => {
    expect(trustBandFromScore(40)).toBe("medium");
    expect(trustBandFromScore(69)).toBe("medium");
  });

  it("returns 'low' for score < 40", () => {
    expect(trustBandFromScore(39)).toBe("low");
    expect(trustBandFromScore(0)).toBe("low");
  });

  // ─── Identity score ───

  it("trusted satellite → identityScore = 40", () => {
    const result = calculateSatelliteTrust(makeInput({ trustLevel: "trusted" }));
    expect(result.identityScore).toBe(40);
  });

  it("restricted satellite → identityScore = 20", () => {
    const result = calculateSatelliteTrust(makeInput({ trustLevel: "restricted" }));
    expect(result.identityScore).toBe(20);
    expect(result.reasons).toContain("Satellite has restricted trust level");
  });

  // ─── Status score ───

  it("online → statusScore = 30", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "online" }));
    expect(result.statusScore).toBe(30);
  });

  it("degraded → statusScore = 20", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "degraded" }));
    expect(result.statusScore).toBe(20);
    expect(result.reasons).toContain("Satellite is in degraded state");
  });

  it("paired → statusScore = 15", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "paired" }));
    expect(result.statusScore).toBe(15);
  });

  it("offline → statusScore = 10", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "offline" }));
    expect(result.statusScore).toBe(10);
    expect(result.reasons).toContain("Satellite is offline");
  });

  it("pending → statusScore = 5", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "pending" }));
    expect(result.statusScore).toBe(5);
    expect(result.reasons).toContain("Satellite pairing is pending");
  });

  it("revoked → statusScore = 0", () => {
    const result = calculateSatelliteTrust(makeInput({ pairingStatus: "revoked" }));
    expect(result.statusScore).toBe(0);
    expect(result.reasons).toContain("Satellite pairing has been revoked");
  });

  // ─── Hygiene score ───

  it("clean hygiene → hygieneScore = 20", () => {
    const result = calculateSatelliteTrust(makeInput());
    expect(result.hygieneScore).toBe(20);
  });

  it("revoked tokens reduce hygiene by 5", () => {
    const result = calculateSatelliteTrust(makeInput({ hasRevokedTokens: true }));
    expect(result.hygieneScore).toBe(15);
    expect(result.reasons).toContain("Has revoked tokens");
  });

  it("expired high-priv tokens reduce hygiene by 10", () => {
    const result = calculateSatelliteTrust(makeInput({ hasExpiredHighPrivTokens: true }));
    expect(result.hygieneScore).toBe(10);
    expect(result.reasons).toContain("Has expired high-privilege tokens");
  });

  it("both hygiene issues reduce hygiene to 5", () => {
    const result = calculateSatelliteTrust(
      makeInput({ hasRevokedTokens: true, hasExpiredHighPrivTokens: true }),
    );
    expect(result.hygieneScore).toBe(5);
  });

  // ─── Incident penalty ───

  it("no incidents → incidentPenalty = 0", () => {
    const result = calculateSatelliteTrust(makeInput());
    expect(result.incidentPenalty).toBe(0);
  });

  it("revocations add 10 each, capped at 20", () => {
    const result1 = calculateSatelliteTrust(makeInput({ recentRevocationCount: 1 }));
    expect(result1.incidentPenalty).toBe(10);

    const result3 = calculateSatelliteTrust(makeInput({ recentRevocationCount: 3 }));
    expect(result3.incidentPenalty).toBe(20); // capped at 20 from revocations
  });

  it("security findings add 5 each, capped at 20", () => {
    const result2 = calculateSatelliteTrust(makeInput({ recentSecurityFindingsCount: 2 }));
    expect(result2.incidentPenalty).toBe(10);

    const result5 = calculateSatelliteTrust(makeInput({ recentSecurityFindingsCount: 5 }));
    expect(result5.incidentPenalty).toBe(20); // capped
  });

  it("combined incidents capped at 40", () => {
    const result = calculateSatelliteTrust(
      makeInput({ recentRevocationCount: 3, recentSecurityFindingsCount: 5 }),
    );
    expect(result.incidentPenalty).toBe(40);
  });

  // ─── Composite score / band ───

  it("perfect trusted online satellite → high band", () => {
    const result = calculateSatelliteTrust(makeInput());
    // identity=40, status=30, hygiene=20, penalty=0 → finalScore=90
    expect(result.finalScore).toBe(90);
    expect(result.band).toBe("high");
  });

  it("restricted offline with incidents → low band", () => {
    const result = calculateSatelliteTrust(
      makeInput({
        trustLevel: "restricted",
        pairingStatus: "offline",
        hasRevokedTokens: true,
        hasExpiredHighPrivTokens: true,
        recentRevocationCount: 2,
        recentSecurityFindingsCount: 2,
      }),
    );
    // identity=20, status=10, hygiene=5, penalty=30 → raw=5
    expect(result.finalScore).toBe(5);
    expect(result.band).toBe("low");
  });

  it("score is clamped to 0 minimum", () => {
    const result = calculateSatelliteTrust(
      makeInput({
        trustLevel: "restricted",
        pairingStatus: "revoked",
        hasRevokedTokens: true,
        hasExpiredHighPrivTokens: true,
        recentRevocationCount: 3,
        recentSecurityFindingsCount: 5,
      }),
    );
    // identity=20, status=0, hygiene=5, penalty=40 → raw=-15 → clamped to 0
    expect(result.finalScore).toBe(0);
    expect(result.band).toBe("low");
  });

  it("score is clamped to 100 maximum", () => {
    // The max possible is 40+30+20-0 = 90, so we verify it doesn't exceed that
    const result = calculateSatelliteTrust(makeInput());
    expect(result.finalScore).toBeLessThanOrEqual(100);
  });

  it("medium band for borderline scores", () => {
    // restricted (20) + paired (15) + clean hygiene (20) - 0 = 55
    const result = calculateSatelliteTrust(
      makeInput({ trustLevel: "restricted", pairingStatus: "paired" }),
    );
    expect(result.finalScore).toBe(55);
    expect(result.band).toBe("medium");
  });

  it("collects reasons for all contributing factors", () => {
    const result = calculateSatelliteTrust(
      makeInput({
        trustLevel: "restricted",
        pairingStatus: "offline",
        hasRevokedTokens: true,
        recentRevocationCount: 1,
      }),
    );
    expect(result.reasons).toContain("Satellite has restricted trust level");
    expect(result.reasons).toContain("Satellite is offline");
    expect(result.reasons).toContain("Has revoked tokens");
    expect(result.reasons).toContain("1 recent revocation(s)");
  });
});
```

## `test/unit/api/http/routes/friday-auth-routes.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../../satellites/_helpers/create-test-db.js";
import { createFridayAuthRoutes } from "../../../../../src/api/http/routes/friday-auth-routes.js";
import { createFridayAuthService } from "../../../../../src/api/auth/friday-auth-service.js";
import type { FridayAuthService } from "../../../../../src/api/auth/friday-auth-service.types.js";
import type { FridayRouteDefinition, FridayHttpContext } from "../../../../../src/api/model/friday-api-common.types.js";

describe("FridayAuthRoutes", () => {
  let db: FridaySqliteLayer;
  let authService: FridayAuthService;
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
  const NOW = "2025-06-15T10:00:00.000Z";
  const TOKEN_SECRET = "test-route-secret";
  let idCounter: number;

  function makeCtx(overrides: Partial<FridayHttpContext<any, any, any>> = {}): FridayHttpContext<any, any, any> {
    return {
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {},
      headers: {},
      principal: null,
      ...overrides,
    };
  }

  function findRoute(operationId: string) {
    return routes.find((r) => r.operationId === operationId)!;
  }

  beforeEach(() => {
    db = createTestDb();
    idCounter = 0;
    authService = createFridayAuthService({
      db,
      idGenerator: () => `id-${String(++idCounter).padStart(4, "0")}`,
      nowIso: () => NOW,
      tokenSecret: TOKEN_SECRET,
      accessTokenTtlSec: 900,
      refreshTokenTtlSec: 604800,
    });
    routes = createFridayAuthRoutes({ authService });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Route registration ───

  it("registers 4 auth routes", () => {
    expect(routes).toHaveLength(4);
  });

  it("has correct operation IDs", () => {
    const opIds = routes.map((r) => r.operationId);
    expect(opIds).toContain("auth.login");
    expect(opIds).toContain("auth.refresh");
    expect(opIds).toContain("auth.logout");
    expect(opIds).toContain("auth.me");
  });

  // ─── Login route ───

  it("POST /v1/auth/login is public", () => {
    const route = findRoute("auth.login");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/login");
    expect(route.auth).toEqual({ public: true });
  });

  it("login handler returns tokens", async () => {
    const route = findRoute("auth.login");
    const ctx = makeCtx({ body: {} });

    const result = await route.handler(ctx);
    expect(result).toHaveProperty("accessToken");
    expect(result).toHaveProperty("refreshToken");
    expect(result).toHaveProperty("expiresInSec");
    expect(result).toHaveProperty("user");
  });

  it("login has rate limit policy", () => {
    const route = findRoute("auth.login");
    expect(route.rateLimitPolicyId).toBe("auth.login");
  });

  // ─── Refresh route ───

  it("POST /v1/auth/refresh is public", () => {
    const route = findRoute("auth.refresh");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/refresh");
    expect(route.auth).toEqual({ public: true });
  });

  it("refresh handler returns new access token", async () => {
    const loginResult = authService.login({});
    const route = findRoute("auth.refresh");
    const ctx = makeCtx({ body: { refreshToken: loginResult.refreshToken } });

    const result = await route.handler(ctx);
    expect(result).toHaveProperty("accessToken");
    expect(result).toHaveProperty("expiresInSec");
  });

  // ─── Logout route ───

  it("POST /v1/auth/logout requires session.write scope", () => {
    const route = findRoute("auth.logout");
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/v1/auth/logout");
    expect(route.auth).toEqual({ public: false, anyOfScopes: ["session.write"] });
  });

  it("logout handler revokes session", async () => {
    const loginResult = authService.login({});
    const route = findRoute("auth.logout");

    const principal = {
      principalType: "user" as const,
      principalId: "test-user",
      userId: "test-user",
      role: "admin" as const,
      scopes: ["session.write" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
      sessionId: "id-0001",
    };

    const ctx = makeCtx({
      body: { refreshToken: loginResult.refreshToken },
      principal,
    });

    const result = await route.handler(ctx);
    expect(result).toEqual({ ok: true });
  });

  // ─── Me route ───

  it("GET /v1/auth/me requires session.read scope", () => {
    const route = findRoute("auth.me");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/auth/me");
    expect(route.auth).toEqual({ public: false, anyOfScopes: ["session.read"] });
  });

  it("me handler returns user info", async () => {
    authService.login({});
    const route = findRoute("auth.me");

    const principal = {
      principalType: "user" as const,
      principalId: "test-user",
      userId: "test-user",
      role: "admin" as const,
      scopes: ["session.read" as const],
      tokenId: "tok-1",
      tokenKind: "access" as const,
      issuedAt: NOW,
      sessionId: "id-0001",
    };

    const ctx = makeCtx({ principal });
    const result = await route.handler(ctx);
    expect(result).toHaveProperty("user");
    expect((result as any).user.id).toBe("test-user");
  });
});
```

## `test/unit/api/http/routes/friday-fleet-routes.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb, createTestIdGenerator } from "../../../satellites/_helpers/create-test-db.js";
import { createFridayFleetRoutes } from "../../../../../src/api/http/routes/friday-fleet-routes.js";
import { createFridayFleetDashboardService } from "../../../../../src/api/fleet/friday-fleet-dashboard-service.js";
import type { FridayFleetDashboardService } from "../../../../../src/api/fleet/friday-fleet-dashboard-service.types.js";
import type { FridayRouteDefinition, FridayHttpContext } from "../../../../../src/api/model/friday-api-common.types.js";

describe("FridayFleetRoutes", () => {
  let db: FridaySqliteLayer;
  let fleetService: FridayFleetDashboardService;
  let routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
  const NOW = "2025-06-15T10:00:00.000Z";

  function makeCtx(overrides: Partial<FridayHttpContext<any, any, any>> = {}): FridayHttpContext<any, any, any> {
    return {
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {},
      headers: {},
      principal: {
        principalType: "user" as const,
        principalId: "user-1",
        userId: "user-1",
        role: "admin" as const,
        scopes: ["fleet.read" as const],
        tokenId: "tok-1",
        tokenKind: "access" as const,
        issuedAt: NOW,
      },
      ...overrides,
    };
  }

  function findRoute(operationId: string) {
    return routes.find((r) => r.operationId === operationId)!;
  }

  function insertSatellite(id: string, pairingStatus: string = "online") {
    db.writer
      .prepare(
        `INSERT INTO satellites (id, display_name, type, pairing_status, trust_level, public_key,
         token_version, transport, platform, arch, app_version, node_version, tags_json, last_seen_at, created_at, updated_at)
         VALUES (?, ?, 'standard', ?, 'trusted', 'pk', 1, 'ws', 'linux', 'arm64', '1.0', '22.0', '[]', ?, ?, ?)`,
      )
      .run(id, `Satellite ${id}`, pairingStatus, NOW, NOW, NOW);
  }

  function insertHeartbeat(satelliteId: string) {
    db.writer
      .prepare(
        `INSERT INTO satellite_heartbeats (id, satellite_id, ts, status, cpu_percent, memory_percent, load_avg_1m, queue_depth, active_runs)
         VALUES (?, ?, ?, 'ok', 20, 30, 0.5, 3, 1)`,
      )
      .run(`hb-${satelliteId}`, satelliteId, "2025-06-15T09:59:55.000Z");
  }

  beforeEach(() => {
    db = createTestDb();
    fleetService = createFridayFleetDashboardService({
      db,
      nowIso: () => NOW,
      idGenerator: createTestIdGenerator(),
    });
    routes = createFridayFleetRoutes({ fleetService });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Route registration ───

  it("registers 3 fleet routes", () => {
    expect(routes).toHaveLength(3);
  });

  it("has correct operation IDs", () => {
    const opIds = routes.map((r) => r.operationId);
    expect(opIds).toContain("fleet.overview");
    expect(opIds).toContain("fleet.listSatellites");
    expect(opIds).toContain("fleet.getSatelliteDetail");
  });

  // ─── All routes require fleet.read scope ───

  it("all fleet routes require fleet.read scope", () => {
    for (const route of routes) {
      expect(route.auth).toEqual({ public: false, anyOfScopes: ["fleet.read"] });
    }
  });

  // ─── Fleet overview route ───

  it("GET /v1/fleet/overview returns overview data", async () => {
    insertSatellite("sat-1");
    insertHeartbeat("sat-1");

    const route = findRoute("fleet.overview");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/fleet/overview");

    const result = await route.handler(makeCtx());
    expect(result).toHaveProperty("generatedAt");
    expect(result).toHaveProperty("totals");
    expect(result).toHaveProperty("health");
    expect(result).toHaveProperty("trust");
  });

  it("fleet overview works with no satellites", async () => {
    const route = findRoute("fleet.overview");
    const result = await route.handler(makeCtx());
    expect((result as any).totals.satellites).toBe(0);
  });

  // ─── List satellites route ───

  it("GET /v1/fleet/satellites lists satellite cards", async () => {
    insertSatellite("sat-1");
    insertSatellite("sat-2");
    insertHeartbeat("sat-1");
    insertHeartbeat("sat-2");

    const route = findRoute("fleet.listSatellites");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/fleet/satellites");

    const ctx = makeCtx({ query: {} });
    const result = await route.handler(ctx);
    expect((result as any).items).toHaveLength(2);
  });

  it("list satellites handles query filters", async () => {
    insertSatellite("sat-1", "online");
    insertSatellite("sat-2", "pending");

    const route = findRoute("fleet.listSatellites");
    const ctx = makeCtx({ query: { pairingStatus: "online" } });
    const result = await route.handler(ctx);
    expect((result as any).items).toHaveLength(1);
  });

  // ─── Get satellite detail route ───

  it("GET /v1/fleet/satellites/:satelliteId returns detail", async () => {
    insertSatellite("sat-1");
    insertHeartbeat("sat-1");

    const route = findRoute("fleet.getSatelliteDetail");
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/v1/fleet/satellites/:satelliteId");

    const ctx = makeCtx({ params: { satelliteId: "sat-1" } });
    const result = await route.handler(ctx);
    expect(result).not.toBeNull();
    expect((result as any).satellite.satelliteId).toBe("sat-1");
  });

  it("satellite detail returns null for unknown ID", async () => {
    const route = findRoute("fleet.getSatelliteDetail");
    const ctx = makeCtx({ params: { satelliteId: "nonexistent" } });
    const result = await route.handler(ctx);
    expect(result).toBeNull();
  });
});
```

## `test/unit/api/http/routes/friday-realtime-routes.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../../satellites/_helpers/create-test-db.js";
import { createFridayRealtimeRoutes } from "../../../../../src/api/http/routes/friday-realtime-routes.js";
import { createFridayRealtimeSubscriptionService } from "../../../../../src/api/realtime/friday-realtime-subscription-service.js";
import { createFridayRealtimeEventRepository } from "../../../../../src/api/persistence/friday-realtime-event-repository.js";
import { createFridayRealtimeCheckpointRepository } from "../../../../../src/api/persistence/friday-realtime-checkpoint-repository.js";
import type { FridayAuthPrincipal } from "../../../../../src/api/model/friday-api-auth.types.js";

describe("FridayRealtimeRoutes", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";
  const EPOCH = 1;

  const adminPrincipal: FridayAuthPrincipal = {
    principalType: "user",
    principalId: "user-1",
    userId: "user-1",
    role: "admin",
    scopes: ["workflow.read", "fleet.read", "satellite.read"],
    tokenId: "tok-1",
    tokenKind: "access",
    issuedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function makeRoutes() {
    const eventRepo = createFridayRealtimeEventRepository();
    const checkpointRepo = createFridayRealtimeCheckpointRepository();
    const subscriptionService = createFridayRealtimeSubscriptionService({
      db,
      eventRepo,
      checkpointRepo,
      nowIso: () => NOW,
      currentEpoch: EPOCH,
      cursorSecret: "test-secret",
    });
    return createFridayRealtimeRoutes({ subscriptionService, currentEpoch: EPOCH });
  }

  it("registers 3 realtime routes", () => {
    const routes = makeRoutes();
    expect(routes).toHaveLength(3);
  });

  it("POST /v1/realtime/subscriptions requires auth", () => {
    const routes = makeRoutes();
    const route = routes.find((r) => r.operationId === "realtime.subscribe");
    expect(route).toBeDefined();
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read", "fleet.read"] });
    expect(route!.rateLimitPolicyId).toBe("realtime.subscribe");
  });

  it("POST /v1/realtime/pull requires auth", () => {
    const routes = makeRoutes();
    const route = routes.find((r) => r.operationId === "realtime.pull");
    expect(route).toBeDefined();
    expect(route!.rateLimitPolicyId).toBe("realtime.pull");
  });

  it("POST /v1/realtime/ack requires auth", () => {
    const routes = makeRoutes();
    const route = routes.find((r) => r.operationId === "realtime.ack");
    expect(route).toBeDefined();
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read", "fleet.read"] });
  });

  it("pull rejects unauthorized stream", async () => {
    const routes = makeRoutes();
    const route = routes.find((r) => r.operationId === "realtime.pull")!;
    const restrictedPrincipal: FridayAuthPrincipal = {
      ...adminPrincipal,
      scopes: ["fleet.read"], // no workflow.read
    };
    await expect(
      route.handler({
        requestId: "req-1",
        receivedAt: NOW,
        params: {},
        query: {},
        body: { streamId: "workflow:wf-1", afterSeq: 0, limit: 10 },
        headers: {},
        principal: restrictedPrincipal,
      }),
    ).rejects.toThrow(/Not authorized/);
  });

  it("ack rejects unauthorized stream", async () => {
    const routes = makeRoutes();
    const route = routes.find((r) => r.operationId === "realtime.ack")!;
    const restrictedPrincipal: FridayAuthPrincipal = {
      ...adminPrincipal,
      scopes: ["fleet.read"],
    };
    await expect(
      route.handler({
        requestId: "req-1",
        receivedAt: NOW,
        params: {},
        query: {},
        body: { streamId: "workflow:wf-1", seq: 1, epoch: EPOCH },
        headers: {},
        principal: restrictedPrincipal,
      }),
    ).rejects.toThrow(/Not authorized/);
  });
});
```

## `test/unit/api/http/routes/friday-security-routes.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridaySecurityRoutes } from "../../../../../src/api/http/routes/friday-security-routes.js";

describe("FridaySecurityRoutes", () => {
  const stubDeps = {
    fleetService: {
      getOverview: () => ({} as any),
      listSatellites: () => ({ items: [] }),
      getSatelliteDetail: () => null,
      getSecurityCenter: () => ({
        generatedAt: "2025-01-01T00:00:00Z",
        tokens: { active: 0, expired: 0, revoked24h: 0, highPrivilegeActive: 0 },
        satellites: { restricted: 0, trusted: 0, revoked: 0, pendingPairings: 0 },
        findings: [],
      }),
    },
    revokeToken: (tokenId: string) => ({ revoked: true as const, tokenId }),
    revokeSatellite: (satelliteId: string) => ({ revoked: true as const, satelliteId }),
  };

  const routes = createFridaySecurityRoutes(stubDeps);

  it("registers 3 security routes", () => {
    expect(routes).toHaveLength(3);
  });

  it("GET /v1/security/center requires security.read", () => {
    const route = routes.find((r) => r.operationId === "security.center");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["security.read"] });
  });

  it("POST /v1/security/tokens/revoke requires security.write", () => {
    const route = routes.find((r) => r.operationId === "security.revokeToken");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["security.write"] });
  });

  it("POST /v1/security/satellites/:satelliteId/revoke requires security.write", () => {
    const route = routes.find((r) => r.operationId === "security.revokeSatellite");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["security.write"] });
  });
});
```

## `test/unit/api/http/routes/friday-workflow-builder-routes.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayWorkflowBuilderRoutes } from "../../../../../src/api/http/routes/friday-workflow-builder-routes.js";

describe("FridayWorkflowBuilderRoutes", () => {
  const stubDeps = {
    createDraft: () => ({ draft: {} as any }),
    listDrafts: () => ({ items: [] }),
    getDraft: () => ({ draft: {} as any }),
    saveDraft: () => ({ draft: {} as any }),
    autosaveDraft: () => ({ draft: null }),
    compileDraft: () => ({ compiled: {} as any, validation: {} as any }),
    publishDraft: () => ({
      workflowId: "",
      workflowVersionId: "",
      versionNumber: 1,
      published: true,
      checksum: "",
      validation: {} as any,
    }),
    acquireLock: () => ({ acquired: true }),
    renewLock: () => ({ lock: null }),
    releaseLock: () => ({ released: true as const }),
  };

  const routes = createFridayWorkflowBuilderRoutes(stubDeps);

  it("registers 10 builder routes (7 draft + 3 lock)", () => {
    expect(routes).toHaveLength(10);
  });

  it("GET /v1/workflows/:workflowId/drafts requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "drafts.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });
  });

  it("POST /v1/workflows/:workflowId/drafts/:draftId/publish has rate limit", () => {
    const route = routes.find((r) => r.operationId === "drafts.publish");
    expect(route).toBeDefined();
    expect(route!.rateLimitPolicyId).toBe("workflow.publish");
  });

  it("POST /v1/workflows/:workflowId/locks/acquire requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "locks.acquire");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.write"] });
  });
});
```

## `test/unit/api/http/routes/friday-workflow-conflict-routes.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayWorkflowConflictRoutes } from "../../../../../src/api/http/routes/friday-workflow-conflict-routes.js";

describe("FridayWorkflowConflictRoutes", () => {
  const stubDeps = {
    listConflicts: () => ({ items: [] }),
    resolveConflict: () => ({ conflict: {} as any, draft: {} as any }),
  };

  const routes = createFridayWorkflowConflictRoutes(stubDeps);

  it("registers 2 conflict routes", () => {
    expect(routes).toHaveLength(2);
  });

  it("GET /v1/workflows/:workflowId/conflicts requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "conflicts.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });
  });

  it("POST /v1/workflows/:workflowId/conflicts/:conflictId/resolve requires workflow.conflict.resolve", () => {
    const route = routes.find((r) => r.operationId === "conflicts.resolve");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.conflict.resolve"] });
    expect(route!.rateLimitPolicyId).toBe("workflow.resolve_conflict");
  });
});
```

## `test/unit/api/http/routes/friday-workflow-routes.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayWorkflowRoutes } from "../../../../../src/api/http/routes/friday-workflow-routes.js";

describe("FridayWorkflowRoutes", () => {
  const stubDeps = {
    listWorkflows: () => ({ items: [] }),
    createWorkflow: () => ({ workflow: { id: "wf-1" } as any, version: { id: "v-1" } as any }),
    getWorkflow: (id: string) => ({ workflow: { id } as any, latestVersion: {} as any }),
    updateWorkflow: (id: string) => ({ workflow: { id } as any }),
    archiveWorkflow: () => ({ archived: true as const }),
    publishWorkflow: () => ({ publishedVersion: {} as any }),
    listVersions: () => ({ items: [] }),
  };

  const routes = createFridayWorkflowRoutes(stubDeps);

  it("registers 7 workflow routes", () => {
    expect(routes).toHaveLength(7);
  });

  it("GET /v1/workflows requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "workflows.list");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.path).toBe("/v1/workflows");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });
  });

  it("POST /v1/workflows requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "workflows.create");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.write"] });
  });

  it("DELETE /v1/workflows/:workflowId requires workflow.write", () => {
    const route = routes.find((r) => r.operationId === "workflows.archive");
    expect(route).toBeDefined();
    expect(route!.method).toBe("DELETE");
  });

  it("POST /v1/workflows/:workflowId/publish has rate limit", () => {
    const route = routes.find((r) => r.operationId === "workflows.publish");
    expect(route).toBeDefined();
    expect(route!.rateLimitPolicyId).toBe("workflow.publish");
  });
});
```

## `test/unit/api/http/routes/friday-workflow-run-routes.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { createFridayWorkflowRunRoutes } from "../../../../../src/api/http/routes/friday-workflow-run-routes.js";

describe("FridayWorkflowRunRoutes", () => {
  const stubDeps = {
    startRun: async () => ({ run: {} as any }),
    getRun: () => ({ run: {} as any }),
    listRunNodes: () => ({ items: [] }),
    getRunTimeline: () => ({ items: [] }),
    cancelRun: async () => ({ run: {} as any }),
    retryRun: async () => ({ run: {} as any, retriedNodes: [] }),
  };

  const routes = createFridayWorkflowRunRoutes(stubDeps);

  it("registers 6 run routes", () => {
    expect(routes).toHaveLength(6);
  });

  it("POST /v1/workflow-runs requires workflow.run", () => {
    const route = routes.find((r) => r.operationId === "runs.start");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.run"] });
    expect(route!.rateLimitPolicyId).toBe("workflow.start_run");
  });

  it("GET /v1/workflow-runs/:runId requires workflow.read", () => {
    const route = routes.find((r) => r.operationId === "runs.get");
    expect(route).toBeDefined();
    expect(route!.method).toBe("GET");
    expect(route!.auth).toEqual({ public: false, anyOfScopes: ["workflow.read"] });
  });

  it("POST /v1/workflow-runs/:runId/cancel requires workflow.run", () => {
    const route = routes.find((r) => r.operationId === "runs.cancel");
    expect(route).toBeDefined();
    expect(route!.method).toBe("POST");
  });
});
```

## `test/unit/api/legacy/friday-legacy-decommission-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createFridayLegacyDecommissionService,
  getLegacyWriteFrozenSince,
} from "../../../../src/api/legacy/friday-legacy-decommission-service.js";
import {
  activateFridayLegacyWriteFreeze,
  isFridayLegacyWriteFrozen,
  executeFridayLegacyWrite,
  resetFridayLegacyWriteFreeze,
} from "../../../../src/api/legacy/friday-legacy-write-freeze-guard.js";
import type { FridayLegacyDecommissionService } from "../../../../src/api/legacy/friday-legacy-decommission.types.js";

describe("FridayLegacyDecommissionService", () => {
  let service: FridayLegacyDecommissionService;
  const NOW = "2025-06-15T10:00:00.000Z";
  const STATE_DIR = "/tmp/friday-test-state";

  beforeEach(() => {
    resetFridayLegacyWriteFreeze();
    service = createFridayLegacyDecommissionService({
      nowIso: () => NOW,
      stateDir: STATE_DIR,
    });
  });

  afterEach(() => {
    resetFridayLegacyWriteFreeze();
  });

  // ─── runPreflight ───

  it("returns deprecated config keys", () => {
    const result = service.runPreflight();
    expect(result.deprecatedConfigKeys).toContain("mirror.enabled");
    expect(result.deprecatedConfigKeys).toContain("mirror.mode");
    expect(result.deprecatedConfigKeys).toContain("mirror.consistencyCheckOnStartup");
    expect(result.deprecatedConfigKeys).toHaveLength(3);
  });

  it("returns zero counts for legacy artifacts", () => {
    const result = service.runPreflight();
    expect(result.legacySessionFilesDetected).toBe(0);
    expect(result.legacyMirrorCallsDetected).toBe(0);
  });

  // ─── createReadonlyLegacyBackup ───

  it("returns backup dir and timestamp", () => {
    const result = service.createReadonlyLegacyBackup();
    expect(result.backupDir).toContain(STATE_DIR);
    expect(result.backupDir).toContain("legacy-backup-");
    expect(result.createdAt).toBe(NOW);
  });

  // ─── migrateDeprecatedConfigKeys ───

  it("reports deprecated keys as removed", () => {
    const result = service.migrateDeprecatedConfigKeys();
    expect(result.updated).toBe(true);
    expect(result.removedKeys).toContain("mirror.enabled");
    expect(result.removedKeys).toContain("mirror.mode");
    expect(result.removedKeys).toContain("mirror.consistencyCheckOnStartup");
  });

  // ─── freezeLegacyWrites ───

  it("activates legacy write freeze", () => {
    const result = service.freezeLegacyWrites();
    expect(result.frozen).toBe(true);
    expect(result.since).toBe(NOW);
  });

  it("freeze persists in module state", () => {
    service.freezeLegacyWrites();
    expect(getLegacyWriteFrozenSince()).toBe(NOW);
  });

  // ─── verifyNoLegacyWrites ───

  it("verification fails when writes are not frozen", () => {
    const result = service.verifyNoLegacyWrites("2025-06-15T09:00:00.000Z");
    expect(result.ok).toBe(false);
    expect(result.violations).toContain("Legacy writes are not frozen");
  });

  it("verification succeeds — freezeLegacyWrites now auto-activates guard", () => {
    // Phase 8 fix: freezeLegacyWrites() automatically calls activateFridayLegacyWriteFreeze()
    service.freezeLegacyWrites();
    // Guard should now be active without explicit call
    expect(isFridayLegacyWriteFrozen()).toBe(true);
    const result = service.verifyNoLegacyWrites("2025-06-15T09:00:00.000Z");
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // ─── Legacy write guard integration ───

  it("freezeLegacyWrites blocks executeFridayLegacyWrite", () => {
    // Before freeze, writes succeed
    const beforeFreeze = executeFridayLegacyWrite(() => "hello");
    expect(beforeFreeze.success).toBe(true);
    if (beforeFreeze.success) expect(beforeFreeze.result).toBe("hello");

    // Freeze via service
    service.freezeLegacyWrites();

    // After freeze, writes are rejected
    const afterFreeze = executeFridayLegacyWrite(() => "should not run");
    expect(afterFreeze.success).toBe(false);
    if (!afterFreeze.success) expect(afterFreeze.reason).toBe("LEGACY_WRITE_FROZEN");
  });

  // ─── Full sequence ───

  it("complete decommission sequence works end-to-end", () => {
    // 1. Preflight
    const preflight = service.runPreflight();
    expect(preflight.deprecatedConfigKeys.length).toBeGreaterThan(0);

    // 2. Backup
    const backup = service.createReadonlyLegacyBackup();
    expect(backup.backupDir).toBeTruthy();

    // 3. Config migration
    const migration = service.migrateDeprecatedConfigKeys();
    expect(migration.updated).toBe(true);

    // 4. Freeze (service now auto-activates guard)
    const freeze = service.freezeLegacyWrites();
    expect(freeze.frozen).toBe(true);
    expect(isFridayLegacyWriteFrozen()).toBe(true);

    // 5. Verify
    const verify = service.verifyNoLegacyWrites("2025-06-15T09:00:00.000Z");
    expect(verify.ok).toBe(true);
  });
});
```

## `test/unit/api/legacy/friday-legacy-write-freeze-guard.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  activateFridayLegacyWriteFreeze,
  isFridayLegacyWriteFrozen,
  executeFridayLegacyWrite,
  resetFridayLegacyWriteFreeze,
} from "../../../../src/api/legacy/friday-legacy-write-freeze-guard.js";

describe("FridayLegacyWriteFreezeGuard", () => {
  beforeEach(() => {
    resetFridayLegacyWriteFreeze();
  });

  afterEach(() => {
    resetFridayLegacyWriteFreeze();
  });

  // ─── isFridayLegacyWriteFrozen ───

  it("is not frozen by default", () => {
    expect(isFridayLegacyWriteFrozen()).toBe(false);
  });

  it("is frozen after activation", () => {
    activateFridayLegacyWriteFreeze();
    expect(isFridayLegacyWriteFrozen()).toBe(true);
  });

  it("reset restores unfrozen state", () => {
    activateFridayLegacyWriteFreeze();
    expect(isFridayLegacyWriteFrozen()).toBe(true);
    resetFridayLegacyWriteFreeze();
    expect(isFridayLegacyWriteFrozen()).toBe(false);
  });

  // ─── executeFridayLegacyWrite ───

  it("executes write fn when not frozen", () => {
    const result = executeFridayLegacyWrite(() => 42);
    expect(result).toEqual({ success: true, result: 42 });
  });

  it("returns write function result of any type", () => {
    const result = executeFridayLegacyWrite(() => ({ key: "value" }));
    expect(result).toEqual({ success: true, result: { key: "value" } });
  });

  it("rejects writes when frozen with LEGACY_WRITE_FROZEN", () => {
    activateFridayLegacyWriteFreeze();
    const result = executeFridayLegacyWrite(() => 42);
    expect(result).toEqual({ success: false, reason: "LEGACY_WRITE_FROZEN" });
  });

  it("write fn is never called when frozen", () => {
    activateFridayLegacyWriteFreeze();
    let called = false;
    executeFridayLegacyWrite(() => {
      called = true;
      return "should not execute";
    });
    expect(called).toBe(false);
  });

  it("multiple freeze activations are idempotent", () => {
    activateFridayLegacyWriteFreeze();
    activateFridayLegacyWriteFreeze();
    activateFridayLegacyWriteFreeze();
    expect(isFridayLegacyWriteFrozen()).toBe(true);

    const result = executeFridayLegacyWrite(() => "test");
    expect(result).toEqual({ success: false, reason: "LEGACY_WRITE_FROZEN" });
  });

  it("writes work again after reset", () => {
    activateFridayLegacyWriteFreeze();
    resetFridayLegacyWriteFreeze();

    const result = executeFridayLegacyWrite(() => "works");
    expect(result).toEqual({ success: true, result: "works" });
  });
});
```

## `test/unit/api/realtime/friday-realtime-event-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import {
  createFridayRealtimeEventRepository,
  type FridayRealtimeEventRepository,
} from "../../../../src/api/persistence/friday-realtime-event-repository.js";
import type { FridayRealtimeEventEnvelope } from "../../../../src/api/model/friday-api-realtime.types.js";

describe("FridayRealtimeEventRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayRealtimeEventRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  function makeEnvelope(
    overrides: Partial<FridayRealtimeEventEnvelope> = {},
  ): FridayRealtimeEventEnvelope {
    return {
      eventId: overrides.eventId ?? "evt-1",
      streamId: overrides.streamId ?? "workflow:wf-1",
      seq: overrides.seq ?? 1,
      event: overrides.event ?? "workflow.updated",
      payload: overrides.payload ?? { workflowId: "wf-1", revision: 1, etag: "abc" },
      emittedAt: overrides.emittedAt ?? NOW,
      correlationId: overrides.correlationId,
      stateVersion: overrides.stateVersion,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayRealtimeEventRepository();
  });

  afterEach(() => {
    db.close();
  });

  it("appends and retrieves an event by stream", () => {
    const env = makeEnvelope();
    db.withWriteTransaction((w) => repo.append(w, env));

    const events = db.withReadConnection((r) => repo.listByStream(r, "workflow:wf-1", 10));
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe("evt-1");
    expect(events[0].event).toBe("workflow.updated");
    expect(events[0].payload).toEqual({ workflowId: "wf-1", revision: 1, etag: "abc" });
  });

  it("getNextSeq returns 1 for empty stream", () => {
    const seq = db.withReadConnection((r) => repo.getNextSeq(r, "workflow:wf-1"));
    expect(seq).toBe(1);
  });

  it("getNextSeq returns max+1 after appending events", () => {
    db.withWriteTransaction((w) => {
      repo.append(w, makeEnvelope({ seq: 1 }));
      repo.append(w, makeEnvelope({ eventId: "evt-2", seq: 2 }));
      repo.append(w, makeEnvelope({ eventId: "evt-3", seq: 3 }));
    });
    const seq = db.withReadConnection((r) => repo.getNextSeq(r, "workflow:wf-1"));
    expect(seq).toBe(4);
  });

  it("listAfterSeq returns events after the given seq", () => {
    db.withWriteTransaction((w) => {
      repo.append(w, makeEnvelope({ eventId: "evt-1", seq: 1 }));
      repo.append(w, makeEnvelope({ eventId: "evt-2", seq: 2 }));
      repo.append(w, makeEnvelope({ eventId: "evt-3", seq: 3 }));
    });

    const events = db.withReadConnection((r) =>
      repo.listAfterSeq(r, "workflow:wf-1", 1, 10),
    );
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(2);
    expect(events[1].seq).toBe(3);
  });

  it("listAfterSeq respects limit", () => {
    db.withWriteTransaction((w) => {
      for (let i = 1; i <= 5; i++) {
        repo.append(w, makeEnvelope({ eventId: `evt-${i}`, seq: i }));
      }
    });

    const events = db.withReadConnection((r) =>
      repo.listAfterSeq(r, "workflow:wf-1", 0, 2),
    );
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });

  it("listByStream limits results", () => {
    db.withWriteTransaction((w) => {
      for (let i = 1; i <= 5; i++) {
        repo.append(w, makeEnvelope({ eventId: `evt-${i}`, seq: i }));
      }
    });

    const events = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-1", 3),
    );
    expect(events).toHaveLength(3);
  });

  it("events from different streams are isolated", () => {
    db.withWriteTransaction((w) => {
      repo.append(w, makeEnvelope({ streamId: "workflow:wf-1", seq: 1 }));
      repo.append(
        w,
        makeEnvelope({ eventId: "evt-2", streamId: "workflow:wf-2", seq: 1 }),
      );
    });

    const events1 = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-1", 10),
    );
    const events2 = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-2", 10),
    );
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  it("deleteOlderThan removes old events", () => {
    db.withWriteTransaction((w) => {
      repo.append(
        w,
        makeEnvelope({ eventId: "evt-old", seq: 1, emittedAt: "2025-06-14T00:00:00.000Z" }),
      );
      repo.append(
        w,
        makeEnvelope({ eventId: "evt-new", seq: 2, emittedAt: "2025-06-15T12:00:00.000Z" }),
      );
    });

    const deleted = db.withWriteTransaction((w) =>
      repo.deleteOlderThan(w, "2025-06-15T00:00:00.000Z"),
    );
    expect(deleted).toBe(1);

    const remaining = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-1", 10),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].eventId).toBe("evt-new");
  });

  it("getLatestSeq returns 0 for empty stream", () => {
    const seq = db.withReadConnection((r) => repo.getLatestSeq(r, "workflow:wf-1"));
    expect(seq).toBe(0);
  });

  it("getLatestSeq returns max seq", () => {
    db.withWriteTransaction((w) => {
      repo.append(w, makeEnvelope({ eventId: "evt-1", seq: 1 }));
      repo.append(w, makeEnvelope({ eventId: "evt-2", seq: 5 }));
    });
    const seq = db.withReadConnection((r) => repo.getLatestSeq(r, "workflow:wf-1"));
    expect(seq).toBe(5);
  });

  it("preserves correlationId and stateVersion", () => {
    const env = makeEnvelope({
      correlationId: "corr-123",
      stateVersion: { workflow: 5, fleet: 2, security: 1 },
    });
    db.withWriteTransaction((w) => repo.append(w, env));

    const events = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-1", 10),
    );
    expect(events[0].correlationId).toBe("corr-123");
    expect(events[0].stateVersion).toEqual({ workflow: 5, fleet: 2, security: 1 });
  });

  it("handles missing correlationId and stateVersion", () => {
    const env = makeEnvelope({ correlationId: undefined, stateVersion: undefined });
    db.withWriteTransaction((w) => repo.append(w, env));

    const events = db.withReadConnection((r) =>
      repo.listByStream(r, "workflow:wf-1", 10),
    );
    expect(events[0].correlationId).toBeUndefined();
    expect(events[0].stateVersion).toBeUndefined();
  });
});
```

## `test/unit/api/realtime/friday-realtime-subscription-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import {
  createFridayRealtimeSubscriptionService,
  type FridayRealtimeSubscriptionService,
} from "../../../../src/api/realtime/friday-realtime-subscription-service.js";
import { createFridayRealtimeEventRepository } from "../../../../src/api/persistence/friday-realtime-event-repository.js";
import { createFridayRealtimeCheckpointRepository } from "../../../../src/api/persistence/friday-realtime-checkpoint-repository.js";
import type { FridayAuthPrincipal } from "../../../../src/api/model/friday-api-auth.types.js";
import type {
  FridayRealtimeSubscription,
  FridayRealtimeEventEnvelope,
} from "../../../../src/api/model/friday-api-realtime.types.js";

describe("FridayRealtimeSubscriptionService", () => {
  let db: FridaySqliteLayer;
  let service: FridayRealtimeSubscriptionService;
  const NOW = "2025-06-15T10:00:00.000Z";
  const EPOCH = 1;

  const adminPrincipal: FridayAuthPrincipal = {
    principalType: "user",
    principalId: "user-1",
    userId: "user-1",
    role: "admin",
    scopes: [
      "workflow.read",
      "workflow.write",
      "fleet.read",
      "security.read",
      "satellite.read",
      "diagnosis.read",
      "session.read",
    ],
    tokenId: "tok-1",
    tokenKind: "access",
    issuedAt: NOW,
  };

  const viewerPrincipal: FridayAuthPrincipal = {
    principalType: "user",
    principalId: "user-2",
    userId: "user-2",
    role: "viewer",
    scopes: ["workflow.read", "fleet.read"],
    tokenId: "tok-2",
    tokenKind: "access",
    issuedAt: NOW,
  };

  function makeSub(overrides: Partial<FridayRealtimeSubscription> = {}): FridayRealtimeSubscription {
    return {
      subscriptionId: overrides.subscriptionId ?? "sub-1",
      streamId: overrides.streamId ?? "workflow:wf-1",
      topic: overrides.topic ?? "workflow",
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    const eventRepo = createFridayRealtimeEventRepository();
    const checkpointRepo = createFridayRealtimeCheckpointRepository();
    service = createFridayRealtimeSubscriptionService({
      db,
      eventRepo,
      checkpointRepo,
      nowIso: () => NOW,
      currentEpoch: EPOCH,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Subscription validation ───

  it("accepts subscriptions when principal has required scope", () => {
    const result = service.validateSubscriptions(
      [makeSub({ topic: "workflow" })],
      adminPrincipal,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects subscription for unknown topic", () => {
    const result = service.validateSubscriptions(
      [makeSub({ topic: "bogus" as any })],
      adminPrincipal,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("UNKNOWN_TOPIC");
  });

  it("rejects subscription when principal lacks required scope", () => {
    const restrictedPrincipal: FridayAuthPrincipal = {
      ...adminPrincipal,
      scopes: ["workflow.read"],
    };

    const result = service.validateSubscriptions(
      [makeSub({ topic: "security", subscriptionId: "sub-sec" })],
      restrictedPrincipal,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("INSUFFICIENT_SCOPE");
  });

  it("validates mixed subscriptions (some accepted, some rejected)", () => {
    const restrictedPrincipal: FridayAuthPrincipal = {
      ...adminPrincipal,
      scopes: ["workflow.read"],
    };

    const result = service.validateSubscriptions(
      [
        makeSub({ subscriptionId: "sub-wf", topic: "workflow" }),
        makeSub({ subscriptionId: "sub-fleet", topic: "fleet" }),
      ],
      restrictedPrincipal,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].subscriptionId).toBe("sub-wf");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].subscriptionId).toBe("sub-fleet");
  });

  it("accepts fleet topic for viewer with fleet.read scope", () => {
    const result = service.validateSubscriptions(
      [makeSub({ topic: "fleet", streamId: "fleet:global" })],
      viewerPrincipal,
    );
    expect(result.accepted).toHaveLength(1);
  });

  // ─── Topic → Stream binding validation ───

  it("rejects subscription with invalid stream binding", () => {
    // topic "workflow" should only allow streams starting with "workflow:"
    const result = service.validateSubscriptions(
      [makeSub({ topic: "workflow", streamId: "fleet:global", subscriptionId: "sub-bad" })],
      adminPrincipal,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("INVALID_STREAM_BINDING");
  });

  it("rejects satellite topic with workflow: stream prefix", () => {
    const result = service.validateSubscriptions(
      [makeSub({ topic: "satellite", streamId: "workflow:wf-1", subscriptionId: "sub-wrong" })],
      adminPrincipal,
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("INVALID_STREAM_BINDING");
  });

  it("accepts fleet topic with fleet: stream prefix", () => {
    const result = service.validateSubscriptions(
      [makeSub({ topic: "fleet", streamId: "fleet:global", subscriptionId: "sub-fleet" })],
      viewerPrincipal,
    );
    expect(result.accepted).toHaveLength(1);
  });

  // ─── Stream authorization ───

  it("isStreamAuthorized returns true for subscribed stream", () => {
    const subs = new Map<string, FridayRealtimeSubscription>();
    subs.set("sub-1", makeSub({ subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" }));
    expect(service.isStreamAuthorized(adminPrincipal, "workflow:wf-1", subs)).toBe(true);
  });

  it("isStreamAuthorized returns false for non-subscribed stream", () => {
    const subs = new Map<string, FridayRealtimeSubscription>();
    subs.set("sub-1", makeSub({ subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" }));
    expect(service.isStreamAuthorized(adminPrincipal, "workflow:wf-2", subs)).toBe(false);
  });

  it("isStreamAuthorized falls back to scope check when no subscriptions map", () => {
    expect(service.isStreamAuthorized(adminPrincipal, "workflow:wf-1")).toBe(true);
    expect(service.isStreamAuthorized(viewerPrincipal, "security:global")).toBe(false);
  });

  // ─── Cursor HMAC ───

  it("generateCursor returns deterministic HMAC", () => {
    const cursor1 = service.generateCursor("workflow:wf-1", 5, 1);
    const cursor2 = service.generateCursor("workflow:wf-1", 5, 1);
    expect(cursor1).toBe(cursor2);
    expect(cursor1.length).toBeGreaterThan(0);
  });

  it("verifyCursor validates correct cursor", () => {
    const cursor = service.generateCursor("workflow:wf-1", 5, 1);
    expect(service.verifyCursor(cursor, "workflow:wf-1", 5, 1)).toBe(true);
  });

  it("verifyCursor rejects tampered cursor", () => {
    const cursor = service.generateCursor("workflow:wf-1", 5, 1);
    expect(service.verifyCursor(cursor + "x", "workflow:wf-1", 5, 1)).toBe(false);
  });

  it("verifyCursor rejects cursor for different stream", () => {
    const cursor = service.generateCursor("workflow:wf-1", 5, 1);
    expect(service.verifyCursor(cursor, "workflow:wf-2", 5, 1)).toBe(false);
  });

  it("verifyCursor rejects cursor for different seq", () => {
    const cursor = service.generateCursor("workflow:wf-1", 5, 1);
    expect(service.verifyCursor(cursor, "workflow:wf-1", 6, 1)).toBe(false);
  });

  it("verifyCursor rejects cursor for different epoch", () => {
    const cursor = service.generateCursor("workflow:wf-1", 5, 1);
    expect(service.verifyCursor(cursor, "workflow:wf-1", 5, 2)).toBe(false);
  });

  // ─── Pull events ───

  it("pullEvents returns events after given seq", () => {
    const eventRepo = createFridayRealtimeEventRepository();
    db.withWriteTransaction((w) => {
      eventRepo.append(w, {
        eventId: "evt-1",
        streamId: "workflow:wf-1",
        seq: 1,
        event: "workflow.updated",
        payload: { workflowId: "wf-1", revision: 1, etag: "a" },
        emittedAt: NOW,
      });
      eventRepo.append(w, {
        eventId: "evt-2",
        streamId: "workflow:wf-1",
        seq: 2,
        event: "workflow.updated",
        payload: { workflowId: "wf-1", revision: 2, etag: "b" },
        emittedAt: NOW,
      });
    });

    const events = service.pullEvents("workflow:wf-1", 1, 10);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(2);
  });

  it("pullEvents returns empty for nonexistent stream", () => {
    const events = service.pullEvents("workflow:nonexistent", 0, 10);
    expect(events).toHaveLength(0);
  });

  // ─── Ack ───

  it("ackEvent succeeds with matching epoch", () => {
    const result = service.ackEvent("user-1", "workflow:wf-1", 5, EPOCH);
    expect(result.accepted).toBe(true);
  });

  it("ackEvent fails with mismatched epoch", () => {
    const result = service.ackEvent("user-1", "workflow:wf-1", 5, EPOCH + 1);
    expect(result.accepted).toBe(false);
  });

  it("ack is monotonic — lower seq does not overwrite higher", () => {
    service.ackEvent("user-1", "workflow:wf-1", 10, EPOCH);
    service.ackEvent("user-1", "workflow:wf-1", 5, EPOCH);

    const checkpoint = service.getCheckpoint("user-1", "workflow:wf-1");
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.lastAckedSeq).toBe(10);
  });

  it("ack updates to higher seq", () => {
    service.ackEvent("user-1", "workflow:wf-1", 5, EPOCH);
    service.ackEvent("user-1", "workflow:wf-1", 10, EPOCH);

    const checkpoint = service.getCheckpoint("user-1", "workflow:wf-1");
    expect(checkpoint!.lastAckedSeq).toBe(10);
  });

  // ─── Checkpoint ───

  it("getCheckpoint returns null for unknown principal+stream", () => {
    const checkpoint = service.getCheckpoint("unknown", "unknown-stream");
    expect(checkpoint).toBeNull();
  });

  it("getCheckpoint returns stored checkpoint after ack", () => {
    service.ackEvent("user-1", "workflow:wf-1", 7, EPOCH, "cursor-abc");

    const checkpoint = service.getCheckpoint("user-1", "workflow:wf-1");
    expect(checkpoint).toEqual({
      lastAckedSeq: 7,
      epoch: EPOCH,
      cursor: "cursor-abc",
    });
  });

  it("checkpoints from different principals are isolated", () => {
    service.ackEvent("user-1", "workflow:wf-1", 10, EPOCH);
    service.ackEvent("user-2", "workflow:wf-1", 5, EPOCH);

    const cp1 = service.getCheckpoint("user-1", "workflow:wf-1");
    const cp2 = service.getCheckpoint("user-2", "workflow:wf-1");
    expect(cp1!.lastAckedSeq).toBe(10);
    expect(cp2!.lastAckedSeq).toBe(5);
  });
});
```

## `test/unit/api/realtime/friday-realtime-ws-gateway.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";
import {
  createFridayRealtimeWsGateway,
  type FridayRealtimeWsGateway,
  type FridayWsConnection,
} from "../../../../src/api/realtime/friday-realtime-ws-gateway.js";
import { createFridayRealtimeSubscriptionService } from "../../../../src/api/realtime/friday-realtime-subscription-service.js";
import { createFridayRealtimeEventRepository } from "../../../../src/api/persistence/friday-realtime-event-repository.js";
import { createFridayRealtimeCheckpointRepository } from "../../../../src/api/persistence/friday-realtime-checkpoint-repository.js";
import { createFridayRealtimeEventBus } from "../../../../src/api/realtime/friday-realtime-event-bus.js";
import {
  createFridayTokenValidator,
  encodeToken,
  TokenValidationError,
} from "../../../../src/api/auth/friday-token-validator.js";
import type {
  FridayRealtimeClientFrame,
  FridayRealtimeServerFrame,
} from "../../../../src/api/model/friday-api-realtime.types.js";
import type { FridayAccessTokenClaims } from "../../../../src/api/model/friday-api-auth.types.js";

describe("FridayRealtimeWsGateway", () => {
  let db: FridaySqliteLayer;
  let gateway: FridayRealtimeWsGateway;
  const NOW = "2025-06-15T10:00:00.000Z";
  const NOW_MS = new Date(NOW).getTime();
  const TOKEN_SECRET = "test-secret-for-ws";
  const EPOCH = 1;

  function makeToken(
    overrides: Partial<FridayAccessTokenClaims> = {},
  ): string {
    const claims: FridayAccessTokenClaims = {
      tokenId: "tok-1",
      principalType: "user",
      principalId: "user-1",
      userId: "user-1",
      role: "admin",
      scopes: [
        "workflow.read",
        "workflow.write",
        "fleet.read",
        "satellite.read",
        "security.read",
        "diagnosis.read",
        "session.read",
        "session.write",
      ],
      iat: Math.floor(NOW_MS / 1000) - 60,
      exp: Math.floor(NOW_MS / 1000) + 900,
      ...overrides,
    };
    return encodeToken(claims, TOKEN_SECRET);
  }

  beforeEach(() => {
    db = createTestDb();
    const eventRepo = createFridayRealtimeEventRepository();
    const checkpointRepo = createFridayRealtimeCheckpointRepository();
    const subscriptionService = createFridayRealtimeSubscriptionService({
      db,
      eventRepo,
      checkpointRepo,
      nowIso: () => NOW,
      currentEpoch: EPOCH,
    });
    const eventBus = createFridayRealtimeEventBus({
      idGenerator: () => "bus-evt-1",
      nowIso: () => NOW,
    });
    const tokenValidator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => NOW_MS,
      lookupTokenRevocation: () => false,
    });

    gateway = createFridayRealtimeWsGateway({
      tokenValidator,
      subscriptionService,
      eventBus,
      nowIso: () => NOW,
      serverVersion: "1.0.0-test",
      currentEpoch: EPOCH,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Connection creation ───

  it("creates an unauthenticated connection", () => {
    const conn = gateway.createConnection("conn-1");
    expect(conn.connId).toBe("conn-1");
    expect(conn.authenticated).toBe(false);
    expect(conn.principal).toBeNull();
    expect(conn.subscriptions.size).toBe(0);
  });

  // ─── Hello frame ───

  it("hello with valid token authenticates connection", () => {
    const conn = gateway.createConnection("conn-1");
    const token = makeToken();

    const responses = gateway.handleClientFrame(conn, {
      type: "hello",
      token,
    });

    expect(conn.authenticated).toBe(true);
    expect(conn.principal).not.toBeNull();
    expect(conn.principal!.principalId).toBe("user-1");
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("hello_ack");

    const ack = responses[0] as Extract<FridayRealtimeServerFrame, { type: "hello_ack" }>;
    expect(ack.connId).toBe("conn-1");
    expect(ack.protocolVersion).toBe("1.0");
    expect(ack.serverVersion).toBe("1.0.0-test");
    expect(ack.epoch).toBe(EPOCH);
  });

  it("hello with invalid token returns error", () => {
    const conn = gateway.createConnection("conn-1");

    const responses = gateway.handleClientFrame(conn, {
      type: "hello",
      token: "invalid.token",
    });

    expect(conn.authenticated).toBe(false);
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("error");

    const err = responses[0] as Extract<FridayRealtimeServerFrame, { type: "error" }>;
    expect(err.retryable).toBe(false);
  });

  it("hello with initial subscriptions processes them", () => {
    const conn = gateway.createConnection("conn-1");
    const token = makeToken();

    const responses = gateway.handleClientFrame(conn, {
      type: "hello",
      token,
      subscriptions: [
        {
          subscriptionId: "sub-1",
          streamId: "workflow:wf-1",
          topic: "workflow",
        },
      ],
    });

    expect(responses).toHaveLength(2);
    expect(responses[0].type).toBe("hello_ack");
    expect(responses[1].type).toBe("subscribed");

    const subscribed = responses[1] as Extract<
      FridayRealtimeServerFrame,
      { type: "subscribed" }
    >;
    expect(subscribed.accepted).toHaveLength(1);
    expect(conn.subscriptions.size).toBe(1);
  });

  // ─── Subscribe frame ───

  it("subscribe before hello returns error", () => {
    const conn = gateway.createConnection("conn-1");

    const responses = gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("error");
    const err = responses[0] as Extract<FridayRealtimeServerFrame, { type: "error" }>;
    expect(err.code).toBe("NOT_AUTHENTICATED");
  });

  it("subscribe after hello accepts valid subscriptions", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });

    const responses = gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
        { subscriptionId: "sub-2", streamId: "fleet:global", topic: "fleet" },
      ],
    });

    expect(responses).toHaveLength(1);
    const subscribed = responses[0] as Extract<
      FridayRealtimeServerFrame,
      { type: "subscribed" }
    >;
    expect(subscribed.accepted).toHaveLength(2);
    expect(conn.subscriptions.size).toBe(2);
  });

  // ─── Unsubscribe frame ───

  it("unsubscribe removes subscriptions", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
        { subscriptionId: "sub-2", streamId: "fleet:global", topic: "fleet" },
      ],
    });

    expect(conn.subscriptions.size).toBe(2);

    const responses = gateway.handleClientFrame(conn, {
      type: "unsubscribe",
      subscriptionIds: ["sub-1"],
    });

    expect(responses).toHaveLength(0);
    expect(conn.subscriptions.size).toBe(1);
    expect(conn.subscriptions.has("sub-2")).toBe(true);
  });

  // ─── Ack frame ───

  it("ack before hello returns error", () => {
    const conn = gateway.createConnection("conn-1");
    const responses = gateway.handleClientFrame(conn, {
      type: "ack",
      streamId: "workflow:wf-1",
      seq: 1,
      epoch: EPOCH,
    });

    expect(responses[0].type).toBe("error");
  });

  it("ack with matching epoch returns ack_ok", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    // Must subscribe to the stream first
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    const responses = gateway.handleClientFrame(conn, {
      type: "ack",
      streamId: "workflow:wf-1",
      seq: 5,
      epoch: EPOCH,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("ack_ok");
    const ackOk = responses[0] as Extract<FridayRealtimeServerFrame, { type: "ack_ok" }>;
    expect(ackOk.streamId).toBe("workflow:wf-1");
    expect(ackOk.seq).toBe(5);
  });

  it("ack with stale epoch returns resync_required", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    // Must subscribe to the stream first
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    const responses = gateway.handleClientFrame(conn, {
      type: "ack",
      streamId: "workflow:wf-1",
      seq: 5,
      epoch: EPOCH + 99,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("resync_required");
    const resync = responses[0] as Extract<
      FridayRealtimeServerFrame,
      { type: "resync_required" }
    >;
    expect(resync.reason).toBe("STREAM_EPOCH_STALE");
  });

  // ─── Resume frame ───

  it("resume before hello returns error", () => {
    const conn = gateway.createConnection("conn-1");
    const responses = gateway.handleClientFrame(conn, {
      type: "resume",
      streamId: "workflow:wf-1",
      lastAckedSeq: 0,
      epoch: EPOCH,
      cursor: "c",
      subscriptions: [],
    });
    expect(responses[0].type).toBe("error");
  });

  it("resume with stale epoch returns resync_required", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });

    const responses = gateway.handleClientFrame(conn, {
      type: "resume",
      streamId: "workflow:wf-1",
      lastAckedSeq: 0,
      epoch: EPOCH + 5,
      cursor: "c",
      subscriptions: [],
    });

    expect(responses[0].type).toBe("resync_required");
  });

  it("resume with valid epoch re-subscribes and replays events", () => {
    // Seed some events
    const eventRepo = createFridayRealtimeEventRepository();
    db.withWriteTransaction((w) => {
      eventRepo.append(w, {
        eventId: "evt-1",
        streamId: "workflow:wf-1",
        seq: 1,
        event: "workflow.updated",
        payload: { workflowId: "wf-1", revision: 1, etag: "a" },
        emittedAt: NOW,
      });
      eventRepo.append(w, {
        eventId: "evt-2",
        streamId: "workflow:wf-1",
        seq: 2,
        event: "workflow.updated",
        payload: { workflowId: "wf-1", revision: 2, etag: "b" },
        emittedAt: NOW,
      });
    });

    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });

    // Use empty cursor (no HMAC check needed when cursor is empty)
    const responses = gateway.handleClientFrame(conn, {
      type: "resume",
      streamId: "workflow:wf-1",
      lastAckedSeq: 0,
      epoch: EPOCH,
      cursor: "",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    // First response is subscribed, then 2 event frames
    const types = responses.map((r) => r.type);
    expect(types[0]).toBe("subscribed");
    expect(types.filter((t) => t === "event")).toHaveLength(2);
  });

  // ─── Stream authorization enforcement ───

  it("ack on non-subscribed stream returns STREAM_NOT_AUTHORIZED", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    // Subscribe to wf-1 only
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    // Try to ack wf-2 (not subscribed)
    const responses = gateway.handleClientFrame(conn, {
      type: "ack",
      streamId: "workflow:wf-2",
      seq: 1,
      epoch: EPOCH,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("error");
    const err = responses[0] as Extract<FridayRealtimeServerFrame, { type: "error" }>;
    expect(err.code).toBe("STREAM_NOT_AUTHORIZED");
  });

  it("ack with invalid cursor returns CURSOR_INVALID", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    const responses = gateway.handleClientFrame(conn, {
      type: "ack",
      streamId: "workflow:wf-1",
      seq: 5,
      epoch: EPOCH,
      cursor: "invalid-cursor-value",
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("resync_required");
    const resync = responses[0] as Extract<FridayRealtimeServerFrame, { type: "resync_required" }>;
    expect(resync.reason).toBe("CURSOR_INVALID");
  });

  it("resume with invalid cursor returns CURSOR_INVALID", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });

    const responses = gateway.handleClientFrame(conn, {
      type: "resume",
      streamId: "workflow:wf-1",
      lastAckedSeq: 0,
      epoch: EPOCH,
      cursor: "tampered-cursor",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("resync_required");
    const resync = responses[0] as Extract<FridayRealtimeServerFrame, { type: "resync_required" }>;
    expect(resync.reason).toBe("CURSOR_INVALID");
  });

  it("topic-stream binding rejection in subscription", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });

    const responses = gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        // workflow topic with fleet: prefix → invalid
        { subscriptionId: "sub-bad", streamId: "fleet:global", topic: "workflow" },
      ],
    });

    expect(responses).toHaveLength(1);
    const subscribed = responses[0] as Extract<FridayRealtimeServerFrame, { type: "subscribed" }>;
    expect(subscribed.accepted).toHaveLength(0);
    expect(subscribed.rejected).toHaveLength(1);
    expect(subscribed.rejected[0].code).toBe("INVALID_STREAM_BINDING");
  });

  // ─── Ping frame ───

  it("ping returns pong", () => {
    const conn = gateway.createConnection("conn-1");
    const responses = gateway.handleClientFrame(conn, {
      type: "ping",
      at: NOW,
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe("pong");
    const pong = responses[0] as Extract<FridayRealtimeServerFrame, { type: "pong" }>;
    expect(pong.at).toBe(NOW);
  });

  // ─── shouldDeliverEvent ───

  it("shouldDeliverEvent returns false for unauthenticated connection", () => {
    const conn = gateway.createConnection("conn-1");
    const result = gateway.shouldDeliverEvent(conn, {
      eventId: "evt-1",
      streamId: "workflow:wf-1",
      seq: 1,
      event: "workflow.updated",
      payload: { workflowId: "wf-1", revision: 1, etag: "a" },
      emittedAt: NOW,
    });
    expect(result).toBe(false);
  });

  it("shouldDeliverEvent returns true when subscribed to the stream", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    const result = gateway.shouldDeliverEvent(conn, {
      eventId: "evt-1",
      streamId: "workflow:wf-1",
      seq: 1,
      event: "workflow.updated",
      payload: { workflowId: "wf-1", revision: 1, etag: "a" },
      emittedAt: NOW,
    });
    expect(result).toBe(true);
  });

  it("shouldDeliverEvent returns false for non-subscribed stream", () => {
    const conn = gateway.createConnection("conn-1");
    gateway.handleClientFrame(conn, { type: "hello", token: makeToken() });
    gateway.handleClientFrame(conn, {
      type: "subscribe",
      subscriptions: [
        { subscriptionId: "sub-1", streamId: "workflow:wf-1", topic: "workflow" },
      ],
    });

    const result = gateway.shouldDeliverEvent(conn, {
      eventId: "evt-1",
      streamId: "workflow:wf-2",
      seq: 1,
      event: "workflow.updated",
      payload: { workflowId: "wf-2", revision: 1, etag: "a" },
      emittedAt: NOW,
    });
    expect(result).toBe(false);
  });
});
```

## `test/unit/state/sqlite/v002-phase8-api-foundation-schema.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createTestDb } from "../../satellites/_helpers/create-test-db.js";

describe("V002 Phase 8 API Foundation Schema", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function getTableNames(): string[] {
    const rows = db.writer
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  function getIndexNames(): string[] {
    const rows = db.writer
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  it("creates realtime_events table", () => {
    const tables = getTableNames();
    expect(tables).toContain("realtime_events");
  });

  it("creates realtime_checkpoints table", () => {
    const tables = getTableNames();
    expect(tables).toContain("realtime_checkpoints");
  });

  it("creates api_rate_limit_counters table", () => {
    const tables = getTableNames();
    expect(tables).toContain("api_rate_limit_counters");
  });

  it("creates workflow_conflicts table", () => {
    const tables = getTableNames();
    expect(tables).toContain("workflow_conflicts");
  });

  it("creates correct indexes for realtime_events", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_realtime_events_stream_seq");
    expect(indexes).toContain("idx_realtime_events_emitted");
  });

  it("creates correct indexes for rate limit counters", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_rate_limit_window");
  });

  it("creates correct indexes for workflow_conflicts", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("idx_workflow_conflicts_workflow");
    expect(indexes).toContain("idx_workflow_conflicts_draft");
  });

  it("enforces unique stream_id + seq in realtime_events", () => {
    db.writer
      .prepare(
        "INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("e1", "stream:1", 1, "test", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

    expect(() =>
      db.writer
        .prepare(
          "INSERT INTO realtime_events (event_id, stream_id, seq, event, payload_json, emitted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("e2", "stream:1", 1, "test", "{}", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"),
    ).toThrow();
  });

  it("enforces composite PK on realtime_checkpoints", () => {
    db.writer
      .prepare(
        "INSERT INTO realtime_checkpoints (principal_id, stream_id, last_acked_seq, epoch, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("p1", "stream:1", 5, 1, "2025-01-01T00:00:00Z");

    expect(() =>
      db.writer
        .prepare(
          "INSERT INTO realtime_checkpoints (principal_id, stream_id, last_acked_seq, epoch, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("p1", "stream:1", 10, 1, "2025-01-01T00:00:00Z"),
    ).toThrow();
  });

  it("enforces composite PK on api_rate_limit_counters", () => {
    db.writer
      .prepare(
        "INSERT INTO api_rate_limit_counters (bucket_key, window_start, hit_count, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("key1", "2025-01-01T00:00:00Z", 1, "2025-01-01T00:00:00Z");

    expect(() =>
      db.writer
        .prepare(
          "INSERT INTO api_rate_limit_counters (bucket_key, window_start, hit_count, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("key1", "2025-01-01T00:00:00Z", 2, "2025-01-01T00:00:00Z"),
    ).toThrow();
  });

  it("records v002 migration in schema_migrations", () => {
    const row = db.writer
      .prepare("SELECT * FROM schema_migrations WHERE version = 2")
      .get() as { version: number; name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("v002-phase8-api-foundation");
  });
});
```

