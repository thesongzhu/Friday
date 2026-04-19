import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
import type {
  FridayAuthBootstrapRequest,
  FridayAuthBootstrapResponse,
  FridayAuthBootstrapStatusResponse,
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
  /** When true, allow login with `{}` (no credentials) for local-only user. Default: false. */
  allowPasswordlessLocalLogin?: boolean;
  /**
   * When true, allow `login({ local: true })` to succeed without passphrase checks.
   * Localhost is always required — this flag only bypasses the passphrase, never the IP trust boundary.
   */
  allowLocalBypassLogin?: boolean;
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
  /** Optional tenant resolver used when issuing auth claims. Defaults to the principal ID. */
  resolveTenantId?: (input: {
    principalType: "user";
    principalId: string;
    userId: string;
    role: FridayRole;
  }) => string | null | undefined;
}
