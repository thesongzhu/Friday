import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import type {
  FridayAuthBootstrapChallengeRequest,
  FridayAuthBootstrapChallengeResponse,
  FridayAuthBootstrapRequest,
  FridayAuthBootstrapResponse,
  FridayAuthBootstrapStatusResponse,
  FridayAuthDeviceClaimRequest,
  FridayAuthDeviceClaimResponse,
  FridayAuthMeResponse,
  FridayAuthPrincipal,
  FridayLoginRequest,
  FridayLoginResponse,
  FridayLogoutRequest,
  FridayLogoutResponse,
  FridayRefreshRequest,
  FridayRefreshResponse,
  FridayRole,
} from "../model/friday-api-auth.types.js";
import type { FridayRateLimitService } from "./friday-rate-limit-service.types.js";

export interface FridayAuthService {
  login(request: FridayLoginRequest, ip?: string, userAgent?: string): FridayLoginResponse;
  refresh(request: FridayRefreshRequest): FridayRefreshResponse;
  logout(request: FridayLogoutRequest, principal: FridayAuthPrincipal): FridayLogoutResponse;
  me(principal: FridayAuthPrincipal): FridayAuthMeResponse;
  getBootstrapStatus(): FridayAuthBootstrapStatusResponse;
  bootstrapLocalPassphrase(
    request: FridayAuthBootstrapRequest,
    ip?: string,
  ): FridayAuthBootstrapResponse;
  /**
   * SEC-SETUP-BOOTSTRAP-001: mint a single-use install nonce bound to the issue
   * context (hub/install/os-user/origin/action). Returns the raw nonce ONCE;
   * only its hash is persisted. Loopback-only.
   */
  issueBootstrapChallenge(
    request: FridayAuthBootstrapChallengeRequest,
    ip?: string,
  ): FridayAuthBootstrapChallengeResponse;
  /**
   * SEC-SETUP-BOOTSTRAP-001: atomically claim the local owner slot by consuming
   * a single-use install nonce and binding a device public key. Replay-protected,
   * origin-bound, loopback-only, crash-safe (single txn). Fails closed with 409
   * if the owner slot was already claimed (by passphrase or another device).
   */
  claimOwnerWithDeviceKey(
    request: FridayAuthDeviceClaimRequest,
    ip?: string,
  ): FridayAuthDeviceClaimResponse;
}

export interface FridayIssuedAccessTokenRecord {
  tokenId: string;
  sessionId: string;
  userId: string;
  expiresAtEpoch: number;
  now: string;
}

export interface CreateFridayAuthServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  tokenSecret: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  /**
   * SEC-SETUP-BOOTSTRAP-001: stable identifier for this hub install, bound into
   * issued install nonces. Defaults to "local-hub" when not supplied.
   */
  hubId?: string;
  /**
   * TTL (seconds) for issued install/bootstrap nonces. Defaults to 300s.
   */
  bootstrapNonceTtlSec?: number;
  /**
   * Cryptographically-random raw nonce generator. Defaults to
   * crypto.randomBytes(32).toString("base64url"). Overridable for deterministic
   * tests. MUST return high-entropy values in production.
   */
  generateBootstrapNonce?: () => string;
  /** Logger for warnings. Default: console.warn. */
  warn?: (message: string) => void;
  /** Callback to mark an access token as revoked in the in-memory revocation map. */
  markAccessTokenRevoked?: (tokenId: string, expSec: number) => void;
  /** Callback to persist minted session access-token metadata transactionally with auth session writes. */
  registerIssuedAccessToken?: (
    db: Database.Database,
    input: FridayIssuedAccessTokenRecord,
  ) => void;
  /** Optional rate limit service for auth lockout. */
  rateLimiter?: FridayRateLimitService;
  /** Optional audit hook for failed auth and lockout decisions. */
  auditAuthEvent?: (event: {
    type: "auth.login.failed" | "auth.login.locked_out";
    at: string;
    principalKey: string;
    ip?: string;
    code: string;
    message: string;
  }) => void;
  /** Optional tenant resolver used when issuing auth claims. Defaults to the principal ID. */
  resolveTenantId?: (input: {
    principalType: "user";
    principalId: string;
    userId: string;
    role: FridayRole;
  }) => string | null | undefined;
}
