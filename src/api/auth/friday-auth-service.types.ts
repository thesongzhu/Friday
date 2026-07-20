import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "#state";
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
  /**
   * SEC-SETUP-BOOTSTRAP-001 Slice 5: mint a single-use install nonce for an
   * AUTHENTICATED existing-passphrase-owner → device migration (kind
   * 'device_migration_claim'). Requires the bound OWNER principal
   * (principalId === localUser.id, role admin/owner). Loopback-only; the raw
   * nonce is returned once. ADDITIVE — removes/disables nothing.
   */
  issueMigrationChallenge(
    request: FridayAuthMigrateChallengeRequest,
    principal: FridayAuthPrincipal | null,
    ip?: string,
  ): FridayAuthMigrateChallengeResponse;
  /**
   * SEC-SETUP-BOOTSTRAP-001 Slice 5: authenticated dual-read migration of an
   * existing passphrase-owner to a PROVISIONAL device binding. Requires the
   * bound OWNER principal (the authenticated session IS the proof-of-passphrase
   * possession) + a valid device proof-of-possession. CAS from a KNOWN
   * passphrase-owner hash (never NULL / never the device sentinel). Leaves
   * users.password_hash UNTOUCHED (the passphrase STILL works — no lockout).
   * Reversible; the device binding carries ZERO authority. Loopback-only,
   * origin-bound, replay-protected, crash-safe (single txn).
   */
  migrateOwnerToDeviceKey(
    request: FridayAuthMigrateDeviceClaimRequest,
    principal: FridayAuthPrincipal | null,
    ip?: string,
  ): FridayAuthMigrateDeviceClaimResponse;
  /**
   * SEC-SETUP-BOOTSTRAP-001 FIXED-order Stage 3+4: activate a PROVISIONAL device
   * binding after the device proves FRESH proof-of-possession. CAS-flips
   * provisional → active for the authenticated local OWNER's binding matching the
   * possession-proven key. ADDITIVE, migration-free and fail-closed: NO install
   * nonce is consumed (freshness is intrinsic to the PoP transcript's expiresAt;
   * anti-replay is intrinsic to the provisional→active compare-and-set), users.
   * password_hash is NEVER touched (the passphrase STILL works — no lockout), NO
   * tombstone is written, and the device binding continues to carry ZERO authority
   * (deviceAuthorityEnabled always false). Loopback-only, origin-bound.
   */
  confirmDeviceReadback(
    request: FridayAuthDeviceReadbackRequest,
    principal: FridayAuthPrincipal | null,
    ip?: string,
  ): FridayAuthDeviceReadbackResponse;
  /**
   * SEC-SETUP-BOOTSTRAP-001 FIXED-order Stage 4: owner-gated observability read of
   * the local owner's current device-binding posture (active/provisional/revoked/
   * none). Pure read — mutates nothing. Loopback-only; requires the bound OWNER
   * principal.
   */
  getDeviceBindingState(
    principal: FridayAuthPrincipal | null,
    ip?: string,
  ): FridayAuthDeviceBindingStateResponse;
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
  /**
   * SEC-SETUP-BOOTSTRAP-001 (CR-1): server-derived predicate for whether a
   * device-bound owner principal may carry release-profile owner authority. This
   * is the SOLE gate that lets a device-key login mint a session and that flags
   * `deviceClaimAvailable` in the bootstrap status. It defaults to the real
   * `isDeviceOwnerAuthorityEnabled()` (hard-wired `false` today because the
   * native-IPC attestation precondition is absent). It is injectable ONLY so a
   * test can exercise the enabled branch WITHOUT flipping the compile-time
   * attestation constant — production wiring never overrides it, so the honest
   * native gate is never faked.
   */
  deviceOwnerAuthorityEnabled?: () => boolean;
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
