import * as crypto from "node:crypto";

import { FridayDomainError } from "#errors";

import type {
  FridayAccessTokenClaims,
  FridayAuthBootstrapChallengeRequest,
  FridayAuthBootstrapChallengeResponse,
  FridayAuthBootstrapRequest,
  FridayAuthBootstrapResponse,
  FridayAuthBootstrapStatusResponse,
  FridayAuthDeviceClaimRequest,
  FridayAuthDeviceClaimResponse,
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
  FridayScope,
} from "../model/friday-api-auth.types.js";
import type {
  CreateFridayAuthServiceDeps,
  FridayAuthService,
} from "./friday-auth-service.types.js";
import { AUTH_LOCKOUT_SCOPE_SHARED_SECRET } from "./friday-rate-limit-service.types.js";
import { getScopesForRole } from "./friday-rbac-policy.js";
import { encodeToken } from "./friday-token-validator.js";
import { createFridayUserRepository } from "../persistence/friday-user-repository.js";
import type { FridayUserRow } from "../persistence/friday-user-repository.js";
import { createFridayAuthSessionRepository } from "../persistence/friday-auth-session-repository.js";
import { createFridaySetupBootstrapNonceRepository } from "../persistence/friday-setup-bootstrap-nonce-repository.js";
import { createFridayDeviceOwnerBindingRepository } from "../persistence/friday-device-owner-binding-repository.js";
import { isUnauthenticatedPublicPrincipal } from "../../security/friday-owner-session-channel-capability.js";
import { isFridayTestSecurityWarningSuppressed } from "#utilities";
import { isFridayLoopbackAddress } from "../http/friday-http-client-ip.js";
import {
  createFridayOwnerClaimPoPVerifier,
} from "./device-attest/index.js";
import type {
  OwnerClaimPresentedSignature,
  OwnerClaimTranscript,
} from "./device-attest/index.js";
import {
  deriveDeviceKeyProtection,
  isDeviceOwnerAuthorityEnabled,
} from "../../security/friday-device-owner-authority-precondition.js";

// ─── Helpers ───

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ─── SEC-SETUP-BOOTSTRAP-001 device-bound owner claim ───

/** sha256 of a value, hex. Used for install-nonce + device-public-key hashing. */
function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Namespaced sentinel stored in users.password_hash when ownership is claimed by
 * a device (not a passphrase). It is deliberately NOT a valid scrypt/legacy hash
 * so verifyPassword() falls through to the unknown-format branch and rejects any
 * passphrase login against a device-claimed owner (fails closed). Non-null, so
 * getBootstrapStatus()/bootstrapLocalPassphrase() correctly treat ownership as
 * already claimed. This overloads no existing behaviour — it is a new, distinct,
 * inert marker value.
 */
const DEVICE_OWNER_HASH_PREFIX = "device-owner$v1$";

function deviceOwnerSentinel(devicePublicKeyHash: string): string {
  return `${DEVICE_OWNER_HASH_PREFIX}${devicePublicKeyHash}`;
}

/**
 * SEC-SETUP-BOOTSTRAP-001 Slice 3: defensively coerce an untrusted request-body
 * device-claim proof into the strict transcript + signature shape the S2a
 * verifier consumes. Returns null for any structurally invalid input (→ the
 * caller fails closed). The literal-typed transcript fields are forwarded
 * verbatim; the verifier re-validates version/algorithm/kind against its
 * allowlists and rejects anything malformed — so this coercion grants nothing.
 */
function coerceDeviceClaimProof(raw: unknown): {
  transcript: OwnerClaimTranscript;
  signature: OwnerClaimPresentedSignature;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const proof = raw as Record<string, unknown>;
  const t = proof.transcript;
  const sig = proof.signature;
  if (!t || typeof t !== "object") return null;
  if (!sig || typeof sig !== "object") return null;
  const tr = t as Record<string, unknown>;
  const sg = sig as Record<string, unknown>;
  if (sg.encoding !== "ieee-p1363-base64" || typeof sg.value !== "string") return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const transcript: OwnerClaimTranscript = {
    transcriptVersion: str(tr.transcriptVersion) as OwnerClaimTranscript["transcriptVersion"],
    algorithm: str(tr.algorithm) as OwnerClaimTranscript["algorithm"],
    kind: str(tr.kind) as OwnerClaimTranscript["kind"],
    hubId: str(tr.hubId),
    installId: str(tr.installId),
    osUser: str(tr.osUser),
    deviceId: str(tr.deviceId),
    action: str(tr.action),
    origin: str(tr.origin),
    channel: str(tr.channel),
    nonce: str(tr.nonce),
    expiresAt: str(tr.expiresAt),
    devicePublicKeyHash: str(tr.devicePublicKeyHash),
  };
  return { transcript, signature: { encoding: "ieee-p1363-base64", value: sg.value } };
}

/** True when the caught error is a better-sqlite3 UNIQUE/constraint violation. */
function isSqliteConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

function isLocalhostAddress(addr?: string): boolean {
  return isFridayLoopbackAddress(addr);
}

function normalizeTenantId(value: string | null | undefined): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

// ─── scrypt password hashing (SEC-004) ───

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 32;

/**
 * Hash a password using scrypt. Returns `scrypt$<hex-salt>$<hex-derived-key>`.
 */
export function hashPasswordScrypt(password: string): string {
  const salt = crypto.randomBytes(SCRYPT_SALT_LENGTH);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a password against a scrypt hash (`scrypt$<hex-salt>$<hex-derived-key>`).
 *
 * VULN-2: All code paths must execute one scrypt derivation to prevent
 * timing side-channels that leak whether a hash is well-formed.
 */
function verifyPasswordScrypt(input: string, storedHash: string): boolean {
  const parts = storedHash.split("$");

  // Validate structure: must be exactly "scrypt$<hex-salt>$<hex-derived-key>"
  const wellFormed =
    parts.length === 3 &&
    parts[0] === "scrypt" &&
    /^[0-9a-f]+$/i.test(parts[1]) &&
    /^[0-9a-f]+$/i.test(parts[2]) &&
    parts[1].length === SCRYPT_SALT_LENGTH * 2 &&
    parts[2].length === SCRYPT_KEY_LENGTH * 2;

  if (!wellFormed) {
    // Malformed hash — still run one scrypt derivation (timing pad) before rejecting
    scryptDerive(input, crypto.randomBytes(SCRYPT_SALT_LENGTH));
    return false;
  }

  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const derived = scryptDerive(input, salt);
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Shared scrypt derivation helper — single place for the heavy work,
 * used by both real verification and timing-pad paths.
 */
function scryptDerive(input: string, salt: Buffer): Buffer {
  return crypto.scryptSync(input, salt, SCRYPT_KEY_LENGTH);
}

/**
 * Returns true if the hash is a legacy SHA-256 hex string (64 hex chars).
 */
function isLegacySha256Hash(hash: string): boolean {
  return /^[0-9a-f]{64}$/i.test(hash);
}

/**
 * SEC-SETUP-BOOTSTRAP-001 Slice 5: true iff `hash` is a KNOWN passphrase-owner
 * credential — the only valid migration SOURCE. NULL (first-boot, unclaimed) and
 * the device-owner sentinel (already device-owned) both return false, so the
 * authenticated migration can never reuse the first-boot bootstrap leg nor
 * clobber an existing device owner. The device sentinel
 * (`device-owner$v1$<64hex>`) is not `scrypt$…` and is longer than 64 chars, so
 * it fails both branches.
 */
function isKnownPassphraseOwnerHash(hash: string | null | undefined): boolean {
  if (!hash) return false;
  if (hash.startsWith("scrypt$")) return true;
  if (isLegacySha256Hash(hash)) return true;
  return false;
}

/**
 * Verify a password against a legacy SHA-256 hex hash using constant-time comparison.
 */
function verifyPasswordLegacySha256(input: string, hash: string): boolean {
  const inputHash = Buffer.from(
    crypto.createHash("sha256").update(input).digest("hex"),
  );
  const storedHash = Buffer.from(hash);
  if (inputHash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(inputHash, storedHash);
}

/**
 * Run a dummy scrypt verification to pad timing on non-scrypt paths.
 * This ensures legacy SHA-256 and unknown-format branches take roughly
 * the same wall-clock time as a real scrypt verification (VULN-2).
 */
function scryptTimingPad(input: string): void {
  verifyPasswordScrypt(input, DUMMY_SCRYPT_HASH);
}

/**
 * Verify a password, supporting both scrypt and legacy SHA-256 formats.
 * Returns { valid, needsUpgrade } so the caller can auto-upgrade.
 *
 * All code paths execute one scrypt derivation so that timing is constant
 * regardless of hash format (VULN-2 timing-oracle mitigation).
 */
function verifyPassword(input: string, hash: string): { valid: boolean; needsUpgrade: boolean } {
  if (hash.startsWith("scrypt$")) {
    return { valid: verifyPasswordScrypt(input, hash), needsUpgrade: false };
  }
  if (isLegacySha256Hash(hash)) {
    const valid = verifyPasswordLegacySha256(input, hash);
    // Pad timing: run a dummy scrypt so this path costs the same as a real scrypt path
    scryptTimingPad(input);
    return { valid, needsUpgrade: true };
  }
  // Unknown/malformed hash format — pad timing before rejecting
  scryptTimingPad(input);
  return { valid: false, needsUpgrade: false };
}

// ─── Auth Error ───

// Dummy scrypt hash for constant-time verification against non-existent users.
// Generated once at module load; the actual password doesn't matter.
const DUMMY_SCRYPT_HASH = hashPasswordScrypt("__friday_dummy_password_for_timing__");
// P2-06: Per-sink Map deduplicates warnings for the same warn function across instances.
const warnedBySink = new Map<(message: string) => void, Set<string>>();

function createWarnOnce(warn: (message: string) => void): (message: string) => void {
  return (message: string) => {
    let seen = warnedBySink.get(warn);
    if (!seen) {
      seen = new Set<string>();
      warnedBySink.set(warn, seen);
    }
    if (seen.has(message)) return;
    seen.add(message);
    warn(message);
  };
}

export class FridayAuthError extends FridayDomainError {
  override readonly name = "FridayAuthError";
  constructor(code: string, message: string, options?: { retryAfterMs?: number }) {
    super(code, message, {
      httpStatus: code === "AUTH_LOCKED_OUT" ? 429 : 401,
      retryable: code === "AUTH_LOCKED_OUT",
      details: options?.retryAfterMs != null ? { retryAfterMs: options.retryAfterMs } : undefined,
    });
  }
}

// ─── Factory ───

export function createFridayAuthService(deps: CreateFridayAuthServiceDeps): FridayAuthService {
  const userRepo = createFridayUserRepository();
  const sessionRepo = createFridayAuthSessionRepository();
  const bootstrapNonceRepo = createFridaySetupBootstrapNonceRepository();
  // SEC-SETUP-BOOTSTRAP-001 Slice 5: durable dual-read owner↔device binding
  // record (provisional bind) + INACTIVE tombstone/rollback scaffolding.
  const bindingRepo = createFridayDeviceOwnerBindingRepository();
  // SEC-SETUP-BOOTSTRAP-001 Slice 3: the merged S2a proof-of-possession verifier.
  // Crypto lives entirely in the device-attest seam — never re-implemented here.
  const ownerClaimPoPVerifier = createFridayOwnerClaimPoPVerifier();
  const bootstrapHubId = deps.hubId ?? "local-hub";
  const bootstrapNonceTtlSec = deps.bootstrapNonceTtlSec ?? 300;
  const generateBootstrapNonce =
    deps.generateBootstrapNonce ?? (() => crypto.randomBytes(32).toString("base64url"));
  const warn = deps.warn ?? console.warn;
  const warnOnce = createWarnOnce(warn);
  const rateLimiter = deps.rateLimiter;
  const warnSinkMeta = warn as unknown as { mock?: unknown };
  const suppressExpectedTestWarnings = isFridayTestSecurityWarningSuppressed()
    && warn === console.warn
    && warnSinkMeta.mock === undefined;

  // P1-SEC-004: Warn if token secret is too short; enforce in production
  if (deps.tokenSecret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[friday] FRIDAY_TOKEN_SECRET must be at least 32 characters in production. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    if (!suppressExpectedTestWarnings) {
      warnOnce("[friday][SECURITY] Token secret is shorter than recommended minimum (32 chars) — session tokens may be vulnerable to brute-force");
    }
  }

  // P1-SEC-005: Warn if rate limiter is not configured
  if (!rateLimiter && !suppressExpectedTestWarnings) {
    warnOnce("[friday][SECURITY] Auth rate limiter not configured — brute-force protection disabled");
  }

  /**
   * Derive a principal key for lockout tracking.
   * Keys are scoped to the actual principal (email / user ID), NOT the IP,
   * so that different accounts have independent lockout counters.
   */
  function deriveLockoutKey(request: FridayLoginRequest, userId?: string): string {
    if (request.email) return `email:${request.email.toLowerCase().trim()}`;
    if (request.localPassphrase) return `local:${userId ?? "local"}`;
    return `local:local`;
  }

  /**
   * Check both principal lockout and IP lockout. Throws if either is locked.
   * Shared-secret scope is used for principal lockout.
   */
  function checkLockout(principalKey: string, ip?: string): void {
    if (!rateLimiter) return;

    // Check IP lockout first
    const ipStatus = rateLimiter.checkIpLockout(ip);
    if (ipStatus.locked) {
      deps.auditAuthEvent?.({
        type: "auth.login.locked_out",
        at: deps.nowIso(),
        principalKey,
        ip,
        code: "AUTH_LOCKED_OUT",
        message: "IP lockout is active",
      });
      throw new FridayAuthError(
        "AUTH_LOCKED_OUT",
        `Too many failed login attempts from this IP. Try again after ${ipStatus.retryAfter ?? "a while"}.`,
        { retryAfterMs: ipStatus.retryAfterMs },
      );
    }

    // Check principal lockout (scoped to shared-secret)
    const status = rateLimiter.checkAuthLockout(principalKey, AUTH_LOCKOUT_SCOPE_SHARED_SECRET);
    if (status.locked) {
      deps.auditAuthEvent?.({
        type: "auth.login.locked_out",
        at: deps.nowIso(),
        principalKey,
        ip,
        code: "AUTH_LOCKED_OUT",
        message: "Principal lockout is active",
      });
      throw new FridayAuthError(
        "AUTH_LOCKED_OUT",
        `Too many failed login attempts. Try again after ${status.retryAfter ?? "a while"}.`,
        { retryAfterMs: status.retryAfterMs },
      );
    }
  }

  /**
   * Record a failed auth attempt for both principal and IP.
   */
  function recordFailure(principalKey: string, ip?: string): void {
    deps.auditAuthEvent?.({
      type: "auth.login.failed",
      at: deps.nowIso(),
      principalKey,
      ip,
      code: "AUTH_FAILED",
      message: "Login attempt failed credential validation",
    });
    if (!rateLimiter) return;
    const principalStatus = rateLimiter.recordAuthFailure(principalKey, AUTH_LOCKOUT_SCOPE_SHARED_SECRET);
    const ipStatus = rateLimiter.recordIpFailure(ip);
    if (principalStatus.locked || ipStatus.locked) {
      deps.auditAuthEvent?.({
        type: "auth.login.locked_out",
        at: deps.nowIso(),
        principalKey,
        ip,
        code: "AUTH_LOCKED_OUT",
        message: principalStatus.locked
          ? "Principal lockout was triggered by failed login"
          : "IP lockout was triggered by failed login",
      });
    }
  }

  /**
   * Reset auth failures on successful login for both principal and IP.
   */
  function resetFailures(principalKey: string, ip?: string): void {
    if (!rateLimiter) return;
    rateLimiter.resetAuthFailures(principalKey, AUTH_LOCKOUT_SCOPE_SHARED_SECRET);
    rateLimiter.resetIpFailures(ip);
  }

  function findUserByEmail(email: string): FridayUserRow | null {
    return deps.db.withReadConnection((db) => userRepo.findByEmail(db, email));
  }

  function findUserById(userId: string): FridayUserRow | null {
    return deps.db.withReadConnection((db) => userRepo.findById(db, userId));
  }

  function findLocalUser(): FridayUserRow | null {
    return deps.db.withReadConnection((db) => userRepo.findLocalUser(db));
  }

  function resolveTenantId(user: FridayUserRow): string {
    const role = user.role as FridayRole;
    return normalizeTenantId(
      deps.resolveTenantId?.({
        principalType: "user",
        principalId: user.id,
        userId: user.id,
        role,
      }),
    ) ?? user.id;
  }

  /** Auto-upgrade a legacy SHA-256 hash to scrypt on successful login. */
  function upgradePasswordHash(userId: string, plaintext: string): void {
    const newHash = hashPasswordScrypt(plaintext);
    const now = deps.nowIso();
    deps.db.withWriteTransaction((db) => {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
        newHash,
        now,
        userId,
      );
    });
  }

  function generateTokenPair(
    user: FridayUserRow,
    sessionId: string,
  ): {
    accessToken: string;
    refreshToken: string;
    accessTokenClaims: FridayAccessTokenClaims;
  } {
    const role = user.role as FridayRole;
    const scopes = [...getScopesForRole(role)] as FridayScope[];
    const nowSec = Math.floor(new Date(deps.nowIso()).getTime() / 1000);
    const tenantId = resolveTenantId(user);

    const accessTokenClaims: FridayAccessTokenClaims = {
      tokenId: deps.idGenerator(),
      principalType: "user",
      principalId: user.id,
      tenantId,
      userId: user.id,
      role,
      scopes,
      iat: nowSec,
      exp: nowSec + deps.accessTokenTtlSec,
      sid: sessionId,
    };

    const accessToken = encodeToken(
      accessTokenClaims,
      deps.tokenSecret,
    );

    const refreshToken = deps.idGenerator();
    return { accessToken, refreshToken, accessTokenClaims };
  }

  /**
   * SEC-SETUP-BOOTSTRAP-001 Slice 5: fail-closed guard that the caller is the
   * AUTHENTICATED local owner (from a passphrase login). Defence-in-depth on top
   * of the http-server L1 public-mutation floor: refuse the synthetic public
   * principal AND any release-disabled device principal, then require the bound
   * owner identity (principalId === localUser.id) + an owner/admin role. The
   * authenticated session IS the proof-of-passphrase-possession — the passphrase
   * is never re-typed into a body, and Origin/UA/bundle-string are never trusted
   * for identity.
   */
  function assertAuthenticatedLocalOwner(
    principal: FridayAuthPrincipal | null,
    localUser: FridayUserRow,
  ): void {
    if (isUnauthenticatedPublicPrincipal(principal)) {
      throw new FridayDomainError(
        "AUTH_MIGRATE_OWNER_REQUIRED",
        "Migration requires the authenticated local owner; the synthetic public principal cannot migrate ownership.",
        { httpStatus: 401 },
      );
    }
    const p = principal as FridayAuthPrincipal;
    const roleOk = p.role === "admin" || p.role === "owner";
    const identityOk = p.principalId === localUser.id;
    if (!roleOk || !identityOk) {
      throw new FridayDomainError(
        "AUTH_MIGRATE_FORBIDDEN",
        "Migration requires the authenticated local owner principal (admin/owner bound to the local user).",
        { httpStatus: 403 },
      );
    }
  }

  return {
    getBootstrapStatus(): FridayAuthBootstrapStatusResponse {
      const localUser = findLocalUser();
      const bootstrapRequired = Boolean(
        localUser &&
        !localUser.password_hash,
      );
      return {
        bootstrapRequired,
      };
    },

    bootstrapLocalPassphrase(
      request: FridayAuthBootstrapRequest,
      ip?: string,
    ): FridayAuthBootstrapResponse {
      if (!isLocalhostAddress(ip)) {
        throw new FridayDomainError(
          "AUTH_BOOTSTRAP_NOT_ALLOWED",
          "Bootstrap is only allowed from localhost.",
          { httpStatus: 403 },
        );
      }

      const passphrase = request.passphrase.trim();
      if (passphrase.length < 12) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "passphrase must be at least 12 characters",
          { httpStatus: 400 },
        );
      }

      const localUser = findLocalUser();
      if (!localUser) {
        throw new FridayDomainError(
          "USER_NOT_FOUND",
          "No local user configured",
          { httpStatus: 404 },
        );
      }

      if (localUser.password_hash) {
        throw new FridayDomainError(
          "AUTH_BOOTSTRAP_ALREADY_DONE",
          "Local bootstrap has already been completed.",
          { httpStatus: 409 },
        );
      }

      const now = deps.nowIso();
      const hashed = hashPasswordScrypt(passphrase);
      // Compare-and-set: the pre-check above reads outside the write transaction,
      // so a concurrent claimant (second hub process or hostile local process on the
      // shared SQLite DB) can commit its own passphrase inside the TOCTOU window after
      // we observed NULL. Guard the write with `AND password_hash IS NULL` and require
      // exactly one affected row, so the losing claim fails closed with ZERO state
      // change instead of clobbering the legitimate owner (SEC-SETUP-BOOTSTRAP-001).
      deps.db.withWriteTransaction((db) => {
        const res = db
          .prepare(
            "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash IS NULL",
          )
          .run(hashed, now, localUser.id);
        if (res.changes !== 1) {
          throw new FridayDomainError(
            "AUTH_BOOTSTRAP_ALREADY_DONE",
            "Local bootstrap has already been completed.",
            { httpStatus: 409 },
          );
        }
      });

      return {
        initialized: true,
        initializedAt: now,
        userId: localUser.id,
      };
    },

    issueBootstrapChallenge(
      request: FridayAuthBootstrapChallengeRequest,
      ip?: string,
    ): FridayAuthBootstrapChallengeResponse {
      // Loopback-only, mirroring bootstrapLocalPassphrase's ingress boundary.
      if (!isLocalhostAddress(ip)) {
        throw new FridayDomainError(
          "AUTH_BOOTSTRAP_NOT_ALLOWED",
          "Bootstrap challenge is only allowed from localhost.",
          { httpStatus: 403 },
        );
      }

      const installId = (request.installId ?? "").trim();
      const osUser = (request.osUser ?? "").trim();
      const origin = (request.origin ?? "").trim();
      const action = (request.action ?? "owner-claim").trim() || "owner-claim";
      if (!installId || !osUser || !origin) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "installId, osUser and origin are required to issue a bootstrap challenge",
          { httpStatus: 400 },
        );
      }

      const now = deps.nowIso();
      const expiresAt = new Date(
        new Date(now).getTime() + bootstrapNonceTtlSec * 1000,
      ).toISOString();
      const challengeId = deps.idGenerator();
      // Raw nonce is returned ONCE; only its hash is persisted.
      const nonce = generateBootstrapNonce();
      const nonceHash = sha256Hex(nonce);

      deps.db.withWriteTransaction((db) => {
        bootstrapNonceRepo.insertNonce(db, {
          id: challengeId,
          nonceHash,
          kind: "install_owner_claim",
          hubId: bootstrapHubId,
          installId,
          osUser,
          origin,
          action,
          createdAt: now,
          expiresAt,
        });
      });

      return {
        challengeId,
        nonce,
        kind: "install_owner_claim",
        hubId: bootstrapHubId,
        installId,
        osUser,
        origin,
        action,
        createdAt: now,
        expiresAt,
      };
    },

    claimOwnerWithDeviceKey(
      request: FridayAuthDeviceClaimRequest,
      ip?: string,
    ): FridayAuthDeviceClaimResponse {
      // (d) loopback-only guard — a non-loopback claim fails closed.
      if (!isLocalhostAddress(ip)) {
        throw new FridayDomainError(
          "AUTH_BOOTSTRAP_NOT_ALLOWED",
          "Owner claim is only allowed from localhost.",
          { httpStatus: 403 },
        );
      }

      const nonce = (request.nonce ?? "").trim();
      const devicePublicKey = (request.devicePublicKey ?? "").trim();
      const deviceId = (request.deviceId ?? "").trim();
      const origin = (request.origin ?? "").trim();
      if (!nonce || !devicePublicKey || !deviceId || !origin) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "nonce, devicePublicKey, deviceId and origin are required",
          { httpStatus: 400 },
        );
      }

      // ── SEC-SETUP-BOOTSTRAP-001 Slice 3: proof-of-possession gate ──
      // Nonce-possession alone no longer suffices: the device MUST prove
      // possession of the PRIVATE key by signing the canonical transcript. This
      // runs BEFORE the single-use nonce is consumed (below), so a PoP failure
      // leaves the nonce un-burned AND the owner slot untouched. Crypto is
      // delegated ENTIRELY to the merged S2a device-attest verifier.
      const proof = coerceDeviceClaimProof(request.deviceClaimProof);
      if (!proof) {
        throw new FridayDomainError(
          "AUTH_BOOTSTRAP_POP_REQUIRED",
          "Device owner-claim requires a proof-of-possession (signed transcript + signature).",
          { httpStatus: 400 },
        );
      }
      // Bind the signed transcript to THIS claim request: a device may not sign
      // one transcript and submit a different nonce/origin/device in the claim.
      if (
        proof.transcript.nonce !== nonce ||
        proof.transcript.origin !== origin ||
        proof.transcript.deviceId !== deviceId
      ) {
        throw new FridayDomainError(
          "AUTH_BOOTSTRAP_POP_INVALID",
          "Proof-of-possession transcript does not match the claim request.",
          { httpStatus: 401 },
        );
      }
      const pop = ownerClaimPoPVerifier.verifyPossession({
        transcript: proof.transcript,
        devicePublicKey: { encoding: "spki-der-base64", value: devicePublicKey },
        signature: proof.signature,
        nowMs: Date.parse(deps.nowIso()),
      });
      if (!pop.ok) {
        // PoP-unverified key ⇒ REFUSAL. No nonce consume, no owner write.
        throw new FridayDomainError(
          "AUTH_BOOTSTRAP_POP_INVALID",
          `Device proof-of-possession failed: ${pop.reason}.`,
          { httpStatus: 401 },
        );
      }
      // Server-derived key-protection posture (never self-reported). Today the
      // only reachable value is "unverified" → fail closed for release authority.
      const keyProtection = deriveDeviceKeyProtection();

      const localUser = findLocalUser();
      if (!localUser) {
        throw new FridayDomainError(
          "USER_NOT_FOUND",
          "No local user configured",
          { httpStatus: 404 },
        );
      }
      // Fast fail-closed if ownership is already claimed (passphrase or device).
      // The authoritative check is the CAS below; this is a friendly early exit.
      if (localUser.password_hash) {
        throw new FridayDomainError(
          "AUTH_BOOTSTRAP_ALREADY_DONE",
          "Local bootstrap has already been completed.",
          { httpStatus: 409 },
        );
      }

      const now = deps.nowIso();
      const nonceHash = sha256Hex(nonce);
      const devicePublicKeyHash = sha256Hex(devicePublicKey);
      const ownerSentinel = deviceOwnerSentinel(devicePublicKeyHash);

      // Atomic, crash-safe claim: BOTH writes run in ONE write transaction, so a
      // crash / thrown error mid-claim rolls back the whole unit — the nonce stays
      // unconsumed AND the owner slot stays NULL (never a partial owner).
      //   1. CAS-consume the nonce (origin/expiry/single-use gate). changes=0 =>
      //      replay / expired / cross-origin => reject, ZERO state change.
      //   2. CAS-claim the owner slot (password_hash IS NULL). changes=0 =>
      //      already claimed => 409, ZERO state change (nonce consume rolls back).
      try {
        deps.db.withWriteTransaction((db) => {
          const consumed = bootstrapNonceRepo.consumeOwnerClaimNonce(db, {
            nonceHash,
            kind: "install_owner_claim",
            origin,
            nowIso: now,
            devicePublicKey,
            devicePublicKeyHash,
            deviceId,
            claimedUserId: localUser.id,
          });
          if (consumed !== 1) {
            throw new FridayDomainError(
              "AUTH_BOOTSTRAP_NONCE_INVALID",
              "Install nonce is invalid, expired, cross-origin, or already used.",
              { httpStatus: 409 },
            );
          }

          const claimed = db
            .prepare(
              "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash IS NULL",
            )
            .run(ownerSentinel, now, localUser.id);
          if (claimed.changes !== 1) {
            throw new FridayDomainError(
              "AUTH_BOOTSTRAP_ALREADY_DONE",
              "Local bootstrap has already been completed.",
              { httpStatus: 409 },
            );
          }
        });
      } catch (error) {
        // Defence-in-depth: the partial UNIQUE(kind) WHERE consumed_at IS NOT NULL
        // makes a second consumed owner-claim a UNIQUE violation. Surface it as a
        // clean fail-closed 409 rather than a raw SQLite error.
        if (isSqliteConstraintError(error)) {
          throw new FridayDomainError(
            "AUTH_BOOTSTRAP_ALREADY_DONE",
            "Local bootstrap has already been completed.",
            { httpStatus: 409 },
          );
        }
        throw error;
      }

      return {
        claimed: true,
        claimedAt: now,
        userId: localUser.id,
        deviceId,
        devicePublicKeyHash,
        // Authoritative readback: server-derived posture + the truth that this
        // device binding carries NO owner authority in release/default (the
        // device principal stays DISABLED until native-IPC precondition (b)).
        keyProtection,
        deviceAuthorityEnabled: isDeviceOwnerAuthorityEnabled(),
      };
    },

    issueMigrationChallenge(
      request: FridayAuthMigrateChallengeRequest,
      principal: FridayAuthPrincipal | null,
      ip?: string,
    ): FridayAuthMigrateChallengeResponse {
      // Loopback-only, mirroring the bootstrap challenge ingress boundary.
      if (!isLocalhostAddress(ip)) {
        throw new FridayDomainError(
          "AUTH_MIGRATE_NOT_ALLOWED",
          "Migration challenge is only allowed from localhost.",
          { httpStatus: 403 },
        );
      }

      const localUser = findLocalUser();
      if (!localUser) {
        throw new FridayDomainError(
          "USER_NOT_FOUND",
          "No local user configured",
          { httpStatus: 404 },
        );
      }
      // Authenticated-owner gate: only the bound local owner starts a migration.
      assertAuthenticatedLocalOwner(principal, localUser);
      // Only a KNOWN passphrase-owner is a valid migration source. NULL
      // (first-boot) or the device sentinel (already migrated) fail closed — the
      // migration never reuses the first-boot leg nor re-migrates a device owner.
      if (!isKnownPassphraseOwnerHash(localUser.password_hash)) {
        throw new FridayDomainError(
          "AUTH_MIGRATE_NO_LEGACY_OWNER",
          "Migration requires an existing passphrase owner; there is no legacy passphrase credential to migrate.",
          { httpStatus: 409 },
        );
      }

      const installId = (request.installId ?? "").trim();
      const osUser = (request.osUser ?? "").trim();
      const origin = (request.origin ?? "").trim();
      const action = (request.action ?? "owner-migrate").trim() || "owner-migrate";
      if (!installId || !osUser || !origin) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "installId, osUser and origin are required to issue a migration challenge",
          { httpStatus: 400 },
        );
      }

      const now = deps.nowIso();
      const expiresAt = new Date(
        new Date(now).getTime() + bootstrapNonceTtlSec * 1000,
      ).toISOString();
      const challengeId = deps.idGenerator();
      const nonce = generateBootstrapNonce();
      const nonceHash = sha256Hex(nonce);

      deps.db.withWriteTransaction((db) => {
        bootstrapNonceRepo.insertNonce(db, {
          id: challengeId,
          nonceHash,
          kind: "device_migration_claim",
          hubId: bootstrapHubId,
          installId,
          osUser,
          origin,
          action,
          createdAt: now,
          expiresAt,
        });
      });

      return {
        challengeId,
        nonce,
        kind: "device_migration_claim",
        hubId: bootstrapHubId,
        installId,
        osUser,
        origin,
        action,
        createdAt: now,
        expiresAt,
      };
    },

    migrateOwnerToDeviceKey(
      request: FridayAuthMigrateDeviceClaimRequest,
      principal: FridayAuthPrincipal | null,
      ip?: string,
    ): FridayAuthMigrateDeviceClaimResponse {
      // Loopback-only guard.
      if (!isLocalhostAddress(ip)) {
        throw new FridayDomainError(
          "AUTH_MIGRATE_NOT_ALLOWED",
          "Migration is only allowed from localhost.",
          { httpStatus: 403 },
        );
      }

      const localUser = findLocalUser();
      if (!localUser) {
        throw new FridayDomainError(
          "USER_NOT_FOUND",
          "No local user configured",
          { httpStatus: 404 },
        );
      }
      // Authenticated-owner gate (the session is the proof-of-passphrase).
      assertAuthenticatedLocalOwner(principal, localUser);

      const nonce = (request.nonce ?? "").trim();
      const devicePublicKey = (request.devicePublicKey ?? "").trim();
      const deviceId = (request.deviceId ?? "").trim();
      const origin = (request.origin ?? "").trim();
      if (!nonce || !devicePublicKey || !deviceId || !origin) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "nonce, devicePublicKey, deviceId and origin are required",
          { httpStatus: 400 },
        );
      }

      // ── Proof-of-possession gate (identical posture to claimOwnerWithDeviceKey) ──
      // The device MUST prove PRIVATE-key possession by signing the canonical
      // transcript over the server nonce. Verified BEFORE the nonce is consumed,
      // so a PoP failure leaves the nonce un-burned and adds NO binding. Crypto is
      // delegated ENTIRELY to the merged S2a verifier — never re-implemented here.
      const proof = coerceDeviceClaimProof(request.deviceClaimProof);
      if (!proof) {
        throw new FridayDomainError(
          "AUTH_MIGRATE_POP_REQUIRED",
          "Device migration requires a proof-of-possession (signed transcript + signature).",
          { httpStatus: 400 },
        );
      }
      if (
        proof.transcript.nonce !== nonce ||
        proof.transcript.origin !== origin ||
        proof.transcript.deviceId !== deviceId
      ) {
        throw new FridayDomainError(
          "AUTH_MIGRATE_POP_INVALID",
          "Proof-of-possession transcript does not match the migration request.",
          { httpStatus: 401 },
        );
      }
      const pop = ownerClaimPoPVerifier.verifyPossession({
        transcript: proof.transcript,
        devicePublicKey: { encoding: "spki-der-base64", value: devicePublicKey },
        signature: proof.signature,
        nowMs: Date.parse(deps.nowIso()),
      });
      if (!pop.ok) {
        throw new FridayDomainError(
          "AUTH_MIGRATE_POP_INVALID",
          `Device proof-of-possession failed: ${pop.reason}.`,
          { httpStatus: 401 },
        );
      }
      const keyProtection = deriveDeviceKeyProtection();

      // Migration SOURCE gate: CAS from a KNOWN passphrase-owner hash ONLY. NULL
      // (first-boot) ⇒ refuse (never reuse the bootstrap leg). Device sentinel ⇒
      // refuse (already migrated). Captured now for the in-txn re-assert below.
      const observedHash = localUser.password_hash;
      if (!isKnownPassphraseOwnerHash(observedHash)) {
        throw new FridayDomainError(
          "AUTH_MIGRATE_NO_LEGACY_OWNER",
          "Migration requires an existing passphrase owner; there is no legacy passphrase credential to migrate.",
          { httpStatus: 409 },
        );
      }

      const now = deps.nowIso();
      const nonceHash = sha256Hex(nonce);
      const devicePublicKeyHash = sha256Hex(devicePublicKey);
      const bindingId = deps.idGenerator();

      // ADDITIVE, dual-read, abort-safe: BOTH writes run in ONE transaction. A
      // crash / thrown error rolls the whole unit back — the nonce stays
      // unconsumed AND no binding is added. Crucially, users.password_hash is
      // NEVER written here: the passphrase stays authoritative (NO lockout), the
      // device binding is only 'provisional', and the tombstone/sentinel flip is
      // a LATER stage (INACTIVE scaffolding this slice).
      //   1. CAS-consume the migration nonce (kind='device_migration_claim',
      //      origin/expiry/single-use). changes=0 ⇒ replay/expired/cross-origin ⇒
      //      reject, ZERO state change.
      //   2. Re-assert the observed legacy hash is UNCHANGED inside the txn — a
      //      concurrent passphrase rotation / re-bootstrap / device-claim aborts
      //      the migration with ZERO state change (never bind against a moved slot).
      //   3. Insert the 'provisional' dual-read binding. password_hash UNTOUCHED.
      try {
        deps.db.withWriteTransaction((db) => {
          const consumed = bootstrapNonceRepo.consumeOwnerClaimNonce(db, {
            nonceHash,
            kind: "device_migration_claim",
            origin,
            nowIso: now,
            devicePublicKey,
            devicePublicKeyHash,
            deviceId,
            claimedUserId: localUser.id,
          });
          if (consumed !== 1) {
            throw new FridayDomainError(
              "AUTH_MIGRATE_NONCE_INVALID",
              "Migration nonce is invalid, expired, cross-origin, or already used.",
              { httpStatus: 409 },
            );
          }

          const current = db
            .prepare("SELECT password_hash AS h FROM users WHERE id = ?")
            .get(localUser.id) as { h: string | null } | undefined;
          if (!current || current.h !== observedHash) {
            throw new FridayDomainError(
              "AUTH_MIGRATE_OWNER_CHANGED",
              "The owner credential changed during migration; aborted with no state change.",
              { httpStatus: 409 },
            );
          }

          bindingRepo.insertProvisionalBinding(db, {
            id: bindingId,
            userId: localUser.id,
            deviceId,
            devicePublicKey,
            devicePublicKeyHash,
            migratedFrom: "passphrase",
            origin,
            hubId: bootstrapHubId,
            createdAt: now,
          });
        });
      } catch (error) {
        // Defence-in-depth: the partial UNIQUE(kind) WHERE consumed_at IS NOT NULL
        // makes a second consumed migration nonce a UNIQUE violation. Surface it
        // as a clean fail-closed 409 rather than a raw SQLite error.
        if (isSqliteConstraintError(error)) {
          throw new FridayDomainError(
            "AUTH_MIGRATE_ALREADY_DONE",
            "A device migration has already been recorded for this owner.",
            { httpStatus: 409 },
          );
        }
        throw error;
      }

      return {
        migrated: true,
        state: "provisional",
        bindingId,
        migratedAt: now,
        userId: localUser.id,
        deviceId,
        devicePublicKeyHash,
        // The passphrase is still the working owner credential — no lockout.
        passphraseStillActive: true,
        keyProtection,
        // ALWAYS false in release/default — the provisional device binding
        // carries ZERO authority until native-IPC precondition (b) lands.
        deviceAuthorityEnabled: isDeviceOwnerAuthorityEnabled(),
      };
    },

    login(request, ip, userAgent) {
      let user: FridayUserRow | null = null;

      // Resolve the principal early for lockout key derivation.
      // For local auth, look up the local user to get their ID.
      let earlyUserId: string | undefined;
      if (request.localPassphrase) {
        const localUser = findLocalUser();
        earlyUserId = localUser?.id;
      }
      const lockoutKey = deriveLockoutKey(request, earlyUserId);

      // Pre-check: reject if locked out (checks both principal and IP)
      checkLockout(lockoutKey, ip);

      if (request.localPassphrase) {
        user = findLocalUser();
        if (!user) {
          recordFailure(lockoutKey, ip);
          throw new FridayAuthError("USER_NOT_FOUND", "No local user configured");
        }
        if (!user.password_hash) {
          recordFailure(lockoutKey, ip);
          throw new FridayAuthError(
            "NO_PASSWORD_CONFIGURED",
            "No password configured for this account",
          );
        }
        const result = verifyPassword(request.localPassphrase, user.password_hash);
        if (!result.valid) {
          recordFailure(lockoutKey, ip);
          throw new FridayAuthError("INVALID_CREDENTIALS", "Invalid passphrase");
        }
        if (result.needsUpgrade) {
          upgradePasswordHash(user.id, request.localPassphrase);
        }
      } else if (request.email) {
        user = findUserByEmail(request.email);

        if (!request.password) {
          // Always run a dummy verify to prevent timing leak on missing password
          verifyPassword("__dummy__", DUMMY_SCRYPT_HASH);
          recordFailure(lockoutKey, ip);
          throw new FridayAuthError("INVALID_CREDENTIALS", "Invalid credentials");
        }

        // Determine which hash to verify against: real hash or dummy for unknown/no-hash users
        const hashToVerify = (user && user.password_hash) ? user.password_hash : DUMMY_SCRYPT_HASH;
        const result = verifyPassword(request.password, hashToVerify);

        if (!user || !user.password_hash || !result.valid) {
          recordFailure(lockoutKey, ip);
          throw new FridayAuthError("INVALID_CREDENTIALS", "Invalid credentials");
        }

        if (result.needsUpgrade) {
          upgradePasswordHash(user.id, request.password);
        }
      } else {
        throw new FridayAuthError(
          "AUTH_METHOD_REQUIRED",
          "No authentication method provided. Supply localPassphrase or email+password.",
        );
      }

      // Auth succeeded — reset lockout state
      resetFailures(lockoutKey, ip);

      const now = deps.nowIso();
      const sessionId = deps.idGenerator();
      const { accessToken, refreshToken, accessTokenClaims } = generateTokenPair(user, sessionId);
      const refreshHash = hashToken(refreshToken);
      const expiresAt = new Date(
        new Date(now).getTime() + deps.refreshTokenTtlSec * 1000,
      ).toISOString();

      deps.db.withWriteTransaction((db) => {
        sessionRepo.create(db, {
          id: sessionId,
          userId: user.id,
          refreshTokenHash: refreshHash,
          expiresAt,
          ipAddress: ip,
          userAgent,
          now,
        });
        deps.registerIssuedAccessToken?.(db, {
          tokenId: accessTokenClaims.tokenId,
          sessionId,
          userId: user.id,
          expiresAtEpoch: accessTokenClaims.exp,
          now,
        });

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
        sessionRepo.findByRefreshHash(db, refreshHash, now),
      );

      if (!session) {
        throw new FridayAuthError("INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
      }

      const user = findUserById(session.user_id);
      if (!user) {
        throw new FridayAuthError("USER_NOT_FOUND", "User no longer exists");
      }

      const { accessToken, refreshToken: newRefreshToken, accessTokenClaims } = generateTokenPair(
        user,
        session.id,
      );
      const newHash = hashToken(newRefreshToken);
      const newExpires = new Date(
        new Date(now).getTime() + deps.refreshTokenTtlSec * 1000,
      ).toISOString();

      // Atomic compare-and-swap: ensures a refresh token can only be used once.
      // If another request already rotated the token, this will fail (changes === 0).
      const swapped = deps.db.withWriteTransaction((db) => {
        const didSwap = sessionRepo.compareAndSwapRefreshHash(
          db,
          session.id,
          refreshHash,
          newHash,
          newExpires,
          now,
        );
        if (didSwap) {
          deps.registerIssuedAccessToken?.(db, {
            tokenId: accessTokenClaims.tokenId,
            sessionId: session.id,
            userId: user.id,
            expiresAtEpoch: accessTokenClaims.exp,
            now,
          });
        }
        return didSwap;
      });

      if (!swapped) {
        warn(
          `[friday] SECURITY WARNING: Refresh token replay detected for session ${session.id}, user ${session.user_id}. ` +
          "Token was already rotated by a concurrent request.",
        );
        throw new FridayAuthError(
          "TOKEN_ALREADY_USED",
          "Refresh token has already been used. This may indicate a replay attack.",
        );
      }

      return {
        accessToken,
        refreshToken: newRefreshToken,
        expiresInSec: deps.accessTokenTtlSec,
      };
    },

    logout(request, principal) {
      const now = deps.nowIso();

      // Revoke the current access token in-memory (SEC-005)
      if (principal.tokenId && deps.markAccessTokenRevoked) {
        const expSec = principal.expiresAt
          ? Math.floor(new Date(principal.expiresAt).getTime() / 1000)
          : Math.floor(new Date(now).getTime() / 1000) + deps.accessTokenTtlSec;
        deps.markAccessTokenRevoked(principal.tokenId, expSec);
      }

      if (request.allSessions && principal.userId) {
        deps.db.withWriteTransaction((db) => {
          sessionRepo.revokeAllForUser(db, principal.userId!, now);
        });
      } else if (request.refreshToken) {
        const refreshHash = hashToken(request.refreshToken);
        deps.db.withWriteTransaction((db) => {
          // Find session by hash regardless of active/expired/revoked state
          const session = sessionRepo.findByRefreshHashAny(db, refreshHash);
          if (session) {
            sessionRepo.revokeById(db, session.id, now);
          }
        });
      } else if (principal.sessionId) {
        deps.db.withWriteTransaction((db) => {
          sessionRepo.revokeById(db, principal.sessionId!, now);
        });
      }

      return { ok: true as const };
    },

    me(principal) {
      if (!principal.userId) {
        throw new FridayAuthError("NO_USER_CONTEXT", "No user associated with this principal");
      }

      const user = findUserById(principal.userId);
      if (!user) {
        throw new FridayAuthError("USER_NOT_FOUND", "User not found");
      }

      let sessionExpiresAt: string | undefined;
      if (principal.sessionId) {
        const session = deps.db.withReadConnection((db) =>
          sessionRepo.findById(db, principal.sessionId!),
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
