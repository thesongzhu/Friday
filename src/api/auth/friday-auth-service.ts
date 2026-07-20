import * as crypto from "node:crypto";

import type Database from "better-sqlite3";

import { FridayDomainError } from "#errors";

import type {
  FridayAccessTokenClaims,
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
  FridayAuthLoginChallengeRequest,
  FridayAuthLoginChallengeResponse,
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
  type FridayDeviceKeyProtection,
  isReleaseTrustedKeyProtection,
} from "../../security/friday-device-owner-authority-precondition.js";
import {
  consumeVerifiedNativeOwnerClaimContext,
  createAbsentNativeOwnerClaimResolver,
  deriveNativeOwnerExchangeConnectionId,
  type NativeOwnerClaimBinding,
  type NativeOwnerClaimContextResolver,
} from "../../security/attestation/friday-verified-native-owner-claim-context.js";

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

/**
 * The SOLE UNIQUE constraint on friday_device_owner_bindings: the partial index
 * `idx_friday_device_owner_bindings_active(user_id) WHERE state='active'` (see
 * migration v104). better-sqlite3 reports its violation as
 *   code    = "SQLITE_CONSTRAINT_UNIQUE"
 *   message = "UNIQUE constraint failed: friday_device_owner_bindings.user_id"
 * on this build; some SQLite builds name the partial index in the message instead,
 * so both the table.column and the index name are accepted signatures.
 */
const ACTIVE_BINDING_UNIQUE_INDEX = "idx_friday_device_owner_bindings_active";
const ACTIVE_BINDING_UNIQUE_COLUMN = "friday_device_owner_bindings.user_id";

/**
 * True ONLY for the active-binding uniqueness violation that the provisional→active
 * readback flip can raise. Deliberately NARROWER than isSqliteConstraintError: a
 * CHECK / FK / NOT-NULL error, or a UNIQUE on a DIFFERENT (future) column or index,
 * does NOT match and therefore propagates instead of being mislabelled 409.
 *
 * ASSUMPTION: the active-binding partial index is the ONLY UNIQUE constraint on
 * friday_device_owner_bindings. Any NEW UPDATE-time UNIQUE constraint on that table
 * (or a rename of the index/user_id column) MUST revisit this mapping.
 */
function isActiveBindingUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code !== "SQLITE_CONSTRAINT_UNIQUE") return false;
  return (
    error.message.includes(ACTIVE_BINDING_UNIQUE_INDEX) ||
    error.message.includes(ACTIVE_BINDING_UNIQUE_COLUMN)
  );
}

// ─── SEC-SETUP-BOOTSTRAP-001 · Stage 3+4 device-readback hardening follow-ups ───

/**
 * The canonical transcript `action` a device-readback proof MUST be minted for.
 * Domain-separates readback from the other PoP legs (owner-claim / owner-migrate):
 * because `action` is bound INTO the signed transcript bytes, a proof minted for a
 * DIFFERENT intent — even one that happens to share the readback
 * nonce/origin/deviceId — can NEVER be replayed to activate a device binding.
 */
const READBACK_TRANSCRIPT_ACTION = "owner-readback";

/**
 * The canonical transcript `action` an owner-CLAIM proof MUST be minted for. All
 * first-boot bootstrap challenges are issued with this action (see
 * issueBootstrapChallenge's default). Because `action` is bound INTO the signed
 * transcript bytes, requiring an exact match domain-separates the claim leg from
 * EVERY other intent (migration / readback) — not just the readback case the
 * negative cross-intent guard covers.
 */
const CLAIM_TRANSCRIPT_ACTION = "owner-claim";

/**
 * The canonical transcript `action` an owner-MIGRATION proof MUST be minted for.
 * All migration challenges are issued with this action (see
 * issueMigrationChallenge's default). Same domain-separation rationale as
 * CLAIM_TRANSCRIPT_ACTION, applied to the migration leg.
 */
const MIGRATE_TRANSCRIPT_ACTION = "owner-migrate";

/**
 * SEC-SETUP-BOOTSTRAP-001 (CR-1): the canonical transcript `action` a device-key
 * LOGIN proof MUST be minted for. Because `action` is bound INTO the signed
 * transcript bytes, a proof minted for owner-claim / owner-migrate / owner-readback
 * can NEVER be replayed into the login leg — and a login proof can never be
 * replayed into those legs. This is the domain separator for the login intent.
 */
const LOGIN_TRANSCRIPT_ACTION = "owner-login";

/**
 * Server-side maximum accepted transcript TTL for a device readback (aligned with
 * the 300s bootstrap-nonce TTL). The transcript's own `expiresAt` is the freshness
 * signal, but the PoP verifier imposes NO upper bound — so a client could mint a
 * far-future transcript once and replay it indefinitely. Clamp the accepted window
 * so a readback proof is short-lived by construction.
 */
const READBACK_MAX_TRANSCRIPT_TTL_MS = 5 * 60 * 1000;

/**
 * SEC-SETUP-BOOTSTRAP-001 (CR-1): server-side maximum accepted transcript TTL for
 * a device-key LOGIN (aligned with the readback / bootstrap-nonce 300s window).
 * The PoP verifier enforces the transcript's own `expiresAt` but imposes NO upper
 * bound, so a client could otherwise mint a far-future login transcript once and
 * replay it indefinitely. Clamp the accepted window so a login proof is
 * short-lived by construction.
 *
 * ANTI-REPLAY CONTROL HIERARCHY (Option C): the PRIMARY anti-replay control is the
 * server-issued single-use `device_login_challenge` nonce, CAS-consumed inside the
 * SAME transaction that mints the session (a replayed login finds it consumed →
 * mints NOTHING). This TTL clamp and the per-claim `VerifiedNativeOwnerClaimContext`
 * consume are DEFENCE-IN-DEPTH on top of it — the capability additionally decides
 * whether THIS request carries owner authority AT ALL (absent on this tree), and the
 * clamp bounds a proof's freshness window; but neither is what makes a proof
 * single-use. The single-use nonce is.
 */
const LOGIN_MAX_TRANSCRIPT_TTL_MS = 5 * 60 * 1000;

// ─── CR-1 Option C — opaque per-claim native-owner capability binding ───

/**
 * The pinned artifact role the attested owner-device app binary must fill. Bound
 * into every capability; the pinned code-sign policy refuses a validly-signed peer
 * filling a DIFFERENT role (helper vs. main app).
 */
const OWNER_DEVICE_ARTIFACT_ROLE = "friday.owner-device.app" as const;

/**
 * The fixed presentation channel for the native install-IPC device claim/login
 * exchange. Bound into the capability so a capability minted for the native IPC
 * channel can never be consumed for a different channel.
 */
const NATIVE_OWNER_CLAIM_CHANNEL = "install-ipc" as const;

/**
 * Freshness window (epoch-ms) for a minted per-claim capability, aligned with the
 * 300s bootstrap/login nonce TTL. The capability is dead past this instant even if
 * every bound field still matches — expiry ⇒ refusal ⇒ zero state change.
 */
const NATIVE_OWNER_CAPABILITY_TTL_MS = 5 * 60 * 1000;

/**
 * Build the request-derived binding an opaque `VerifiedNativeOwnerClaimContext`
 * must be bound to. Every field comes from THIS request's authoritative context —
 * never from the capability's own self-assertion.
 */
function buildNativeOwnerClaimBinding(input: {
  hubId: string;
  installId: string;
  osUser: string;
  origin: string;
  action: string;
  nonce: string;
  nowMs: number;
  deviceId: string;
  devicePublicKeyHash: string;
}): NativeOwnerClaimBinding {
  return {
    hubId: input.hubId,
    installId: input.installId,
    osUser: input.osUser,
    origin: input.origin,
    channel: NATIVE_OWNER_CLAIM_CHANNEL,
    action: input.action,
    nonce: input.nonce,
    expiresAtMs: input.nowMs + NATIVE_OWNER_CAPABILITY_TTL_MS,
    deviceId: input.deviceId,
    devicePublicKeyHash: input.devicePublicKeyHash,
    artifactRole: OWNER_DEVICE_ARTIFACT_ROLE,
  };
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
  // CR-1 Option C: the SOLE device-owner authority is now an OPAQUE, per-claim
  // `VerifiedNativeOwnerClaimContext` resolved from the native IPC accept boundary
  // — NOT a global boolean. The default resolver is honestly ABSENT on this
  // dev/CI tree (returns null → every device claim/login fails closed with ZERO
  // state change). Production wires a resolver backed by the Companion Unix-socket
  // peercred+codesign accept boundary; tests inject a resolver that runs the REAL
  // mint over injected native-evidence doubles (the brand makes a forged literal
  // impossible, so no request/env/test seam can fabricate authority).
  const resolveNativeOwnerClaimContext: NativeOwnerClaimContextResolver =
    deps.resolveNativeOwnerClaimContext ?? createAbsentNativeOwnerClaimResolver();
  // Presence signal for getBootstrapStatus ONLY — reports whether the native claim
  // surface currently exists, WITHOUT minting or authorizing any request. Defaults
  // to false (no native surface on this tree).
  const nativeOwnerClaimSurfaceAvailable =
    deps.nativeOwnerClaimSurfaceAvailable ?? (() => false);
  // CR-1 Option C (finding #6): on a fresh RELEASE profile, passphrase bootstrap is
  // NOT offered (device-native only). Gates ONLY the creation of a fresh passphrase
  // owner — legacy passphrase LOGIN + migration/recovery stay available. Defaults
  // to false (dev/CI: passphrase bootstrap allowed).
  const releaseProfileNativeOnly = deps.releaseProfileNativeOnly ?? (() => false);
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

  /**
   * SEC-APPROVAL-AUTHORITY-001 · CORE-A CR-2 (Option B*): resolve the durable
   * owner↔device binding SERVER-SIDE for an authenticated user, WITHOUT changing
   * token minting (`principalId` stays `user.id`). Reads the user's
   * `users.password_hash`; if it is the device-owner sentinel
   * (`device-owner$v1$<sha256Hex(SPKI-DER base64 string)>`) it returns the bound
   * device's sentinel hash (the `<hash>` portion), else `null` (no device binding —
   * e.g. a passphrase owner or a first-boot NULL slot). The provider-approval seam
   * consumes this to bind a device-authored approval to the authenticated owner's
   * REGISTERED device using the SAME hashing convention `deviceKeyLogin` already
   * trusts (`sha256Hex(devicePublicKey)`), so no NEW hash is introduced. This never
   * mints, never grants, and never touches the SEC-SETUP claim/login/nonce hashing.
   */
  function resolveBoundDeviceOwnerSentinelHash(userId: string): string | null {
    const trimmed = userId.trim();
    if (!trimmed) return null;
    const user = findUserById(trimmed);
    const storedHash = user?.password_hash;
    if (!storedHash || !storedHash.startsWith(DEVICE_OWNER_HASH_PREFIX)) {
      return null;
    }
    const boundKeyHash = storedHash.slice(DEVICE_OWNER_HASH_PREFIX.length).trim();
    return boundKeyHash.length > 0 ? boundKeyHash : null;
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

  /**
   * Mint a real session for an authenticated user (session row + rotating refresh
   * token + registered access token + last_login stamp). Shared by the passphrase/
   * email login path and the device-key login path so BOTH mint identically — a
   * device-key login is not a weaker session, it is the SAME session anchored on a
   * different possession proof.
   */
  /**
   * Perform the session-mint WRITES against an ALREADY-OPEN write transaction
   * (session row + rotating refresh token + registered access token + last_login
   * stamp) and return the login response. Extracted from `mintSession` so a caller
   * that must mint ATOMICALLY with another write (e.g. the device-key login's
   * single-use login-challenge CAS-consume) can run both in ONE transaction — a
   * rollback then unwinds BOTH the consume and the mint together.
   */
  function mintSessionWrites(
    db: Database.Database,
    user: FridayUserRow,
    ip?: string,
    userAgent?: string,
  ): FridayLoginResponse {
    const now = deps.nowIso();
    const sessionId = deps.idGenerator();
    const { accessToken, refreshToken, accessTokenClaims } = generateTokenPair(user, sessionId);
    const refreshHash = hashToken(refreshToken);
    const expiresAt = new Date(
      new Date(now).getTime() + deps.refreshTokenTtlSec * 1000,
    ).toISOString();

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
  }

  function mintSession(
    user: FridayUserRow,
    ip?: string,
    userAgent?: string,
  ): FridayLoginResponse {
    return deps.db.withWriteTransaction((db) => mintSessionWrites(db, user, ip, userAgent));
  }

  /**
   * SEC-SETUP-BOOTSTRAP-001 (CR-1): device-key login mint. A machine whose owner
   * slot was claimed by a device (users.password_hash = the non-scrypt device
   * sentinel `device-owner$v1$<sha256Hex(devicePublicKey)>`) authenticates by
   * proving possession of the BOUND private key — signing a fresh canonical
   * transcript minted for action `owner-login`. On success it mints a real session
   * mirroring the passphrase path.
   *
   * Cross-path safety (both directions):
   *   - The device sentinel is NOT a valid scrypt/legacy hash, so the passphrase
   *     path (`verifyPassword`) rejects it — a device owner can never be logged in
   *     with a passphrase.
   *   - This path REQUIRES the sentinel prefix, so a scrypt/legacy passphrase owner
   *     (or a first-boot NULL slot) can never be logged in via the device path.
   *
   * Honesty gate (Option C): possession of a SOFTWARE device key is insufficient
   * to mint a session. Minting requires an OPAQUE per-claim
   * `VerifiedNativeOwnerClaimContext` bound to THIS request, resolved from the
   * native IPC accept boundary and CONSUMED atomically with the login-challenge CAS
   * + session mint. On this dev/CI tree the boundary is honestly absent → the
   * resolver returns null → the consume fails closed (DEVICE_AUTHORITY_DISABLED)
   * with the challenge STILL LIVE. Nothing global authorizes; it starts minting the
   * moment a real native accept boundary is wired, WITHOUT this code faking it.
   */
  function deviceKeyLogin(
    request: FridayLoginRequest,
    ip?: string,
    userAgent?: string,
  ): FridayLoginResponse {
    // Loopback-only, consistent with the device-claim family.
    if (!isLocalhostAddress(ip)) {
      throw new FridayAuthError(
        "INVALID_CREDENTIALS",
        "Device-key login is only allowed from localhost.",
      );
    }

    const localUser = findLocalUser();
    if (!localUser) {
      throw new FridayAuthError("USER_NOT_FOUND", "No local user configured");
    }
    const lockoutKey = `device:${localUser.id}`;
    checkLockout(lockoutKey, ip);

    // ── Cross-path guard: ONLY a device-claimed owner may device-login ──
    // The AUTHORITATIVE, durable owner<->device binding is users.password_hash =
    // the device sentinel (the consumed install-nonce row is reaped on a retention
    // horizon and is NOT relied upon here). A scrypt/legacy passphrase owner or a
    // first-boot NULL slot is refused, so this path can never authenticate a
    // passphrase owner.
    const storedHash = localUser.password_hash;
    if (!storedHash || !storedHash.startsWith(DEVICE_OWNER_HASH_PREFIX)) {
      recordFailure(lockoutKey, ip);
      throw new FridayAuthError(
        "INVALID_CREDENTIALS",
        "No device-bound owner is configured for this machine.",
      );
    }
    const boundKeyHash = storedHash.slice(DEVICE_OWNER_HASH_PREFIX.length);

    const devicePublicKey = (request.devicePublicKey ?? "").trim();
    const deviceId = (request.deviceId ?? "").trim();
    const origin = (request.origin ?? "").trim();
    if (!devicePublicKey || !deviceId || !origin) {
      recordFailure(lockoutKey, ip);
      throw new FridayAuthError(
        "INVALID_CREDENTIALS",
        "devicePublicKey, deviceId and origin are required for device-key login.",
      );
    }

    // ── Bind the presented key to the durable owner<->device binding ──
    // The presented key MUST hash to the sentinel-bound value (the SAME sha256Hex
    // the claim path wrote), so a possession-proof for a DIFFERENT key cannot log
    // in this owner.
    if (sha256Hex(devicePublicKey) !== boundKeyHash) {
      recordFailure(lockoutKey, ip);
      throw new FridayAuthError(
        "INVALID_CREDENTIALS",
        "Presented device key is not the bound owner device key.",
      );
    }

    // ── Proof-of-possession over a FRESH owner-login transcript ──
    const proof = coerceDeviceClaimProof(request.deviceLoginProof);
    if (!proof) {
      recordFailure(lockoutKey, ip);
      throw new FridayAuthError(
        "INVALID_CREDENTIALS",
        "Device-key login requires a proof-of-possession (signed transcript + signature).",
      );
    }
    // Bind the signed transcript to THIS login request.
    if (proof.transcript.origin !== origin || proof.transcript.deviceId !== deviceId) {
      recordFailure(lockoutKey, ip);
      throw new FridayAuthError(
        "INVALID_CREDENTIALS",
        "Proof-of-possession transcript does not match the login request.",
      );
    }
    // Domain-separate the login intent: the transcript MUST be minted FOR
    // owner-login. Because `action` is bound into the signed bytes, a proof minted
    // for owner-claim / owner-migrate / owner-readback can NEVER be replayed here.
    if (proof.transcript.action !== LOGIN_TRANSCRIPT_ACTION) {
      recordFailure(lockoutKey, ip);
      throw new FridayAuthError(
        "INVALID_CREDENTIALS",
        "Proof-of-possession transcript was not minted for device-key login.",
      );
    }
    // ── Require a SERVER-ISSUED single-use login-challenge nonce (Advisor #1628
    // finding #2) ── The signed transcript MUST carry the nonce from a fresh
    // `device_login_challenge` (issued by issueLoginChallenge). A blank/absent nonce
    // is refused up-front; the AUTHORITATIVE single-use gate is the CAS-consume in
    // the mint transaction below (a value that does not match a LIVE challenge for
    // THIS device/origin yields changes=0 there). This is the PRIMARY anti-replay
    // control — a captured owner-login transcript can never be replayed to mint a
    // second session.
    const loginNonce = proof.transcript.nonce.trim();
    if (!loginNonce) {
      recordFailure(lockoutKey, ip);
      throw new FridayAuthError(
        "INVALID_CREDENTIALS",
        "Device-key login requires a server-issued single-use challenge nonce.",
      );
    }
    const pop = ownerClaimPoPVerifier.verifyPossession({
      transcript: proof.transcript,
      devicePublicKey: { encoding: "spki-der-base64", value: devicePublicKey },
      signature: proof.signature,
      nowMs: Date.parse(deps.nowIso()),
    });
    if (!pop.ok) {
      recordFailure(lockoutKey, ip);
      throw new FridayAuthError(
        "INVALID_CREDENTIALS",
        `Device proof-of-possession failed: ${pop.reason}.`,
      );
    }

    // ── Server-side max-TTL clamp (login freshness) ──
    const nowMs = Date.parse(deps.nowIso());
    const expiryMs = Date.parse(proof.transcript.expiresAt);
    if (!Number.isFinite(expiryMs) || expiryMs - nowMs > LOGIN_MAX_TRANSCRIPT_TTL_MS) {
      recordFailure(lockoutKey, ip);
      throw new FridayAuthError(
        "INVALID_CREDENTIALS",
        "Proof-of-possession transcript expiry exceeds the maximum allowed TTL.",
      );
    }

    // ── OPAQUE PER-CLAIM NATIVE-OWNER CAPABILITY GATE (Option C) ──
    // A cryptographically VALID software-key PoP is NOT sufficient to mint a
    // session: the login must ALSO present a `VerifiedNativeOwnerClaimContext`
    // bound to THIS exact request (hub/install/os-user/origin/channel/action/nonce/
    // device/key/role + accepted native connection), minted ONLY inside the native
    // IPC accept boundary from real peercred + code-sign attestation + release-
    // trusted key custody. Nothing global authorizes. On this dev/CI tree the
    // boundary is honestly absent → the resolver returns null → the consume below
    // fails closed (DEVICE_AUTHORITY_DISABLED) with the login challenge STILL LIVE.
    const loginBinding = buildNativeOwnerClaimBinding({
      hubId: bootstrapHubId,
      installId: proof.transcript.installId.trim(),
      osUser: proof.transcript.osUser.trim(),
      origin,
      action: LOGIN_TRANSCRIPT_ACTION,
      nonce: loginNonce,
      nowMs,
      deviceId,
      devicePublicKeyHash: boundKeyHash,
    });
    const loginCapability = resolveNativeOwnerClaimContext(loginBinding);

    // ── PRIMARY anti-replay: capability consume ⊗ single-use login-challenge
    // CAS-consume ⊗ session mint, ATOMICALLY in ONE write transaction ──
    // The capability is consumed FIRST; a refusal throws BEFORE the nonce CAS, so
    // the whole unit ROLLS BACK with the challenge STILL LIVE (an attestation-
    // disabled build never burns the nonce). Past it, the login-challenge nonce is
    // CAS-consumed BEFORE the session is minted, in the SAME transaction: the first
    // valid login flips exactly one row (changes=1) and mints; a REPLAY finds the
    // challenge consumed → changes=0 → throw → the whole unit rolls back with NO
    // second token pair / session / last_login write (ZERO state change). The nonce
    // gate binds origin + deviceId + devicePublicKeyHash, so a nonce minted for a
    // different device/origin/key never consumes here.
    const now = deps.nowIso();
    const loginNonceHash = sha256Hex(loginNonce);
    let response: FridayLoginResponse;
    try {
      response = deps.db.withWriteTransaction((db) => {
        const cap = consumeVerifiedNativeOwnerClaimContext(loginCapability, {
          binding: loginBinding,
          expectedConnectionId: deriveNativeOwnerExchangeConnectionId(loginBinding),
          nowMs: Date.parse(now),
        });
        if (!cap.ok) {
          // No valid per-claim capability for THIS request → fail closed. Not a
          // credential failure (the PoP was valid) → no lockout increment. The
          // throw precedes the nonce CAS, so the challenge stays live.
          throw new FridayAuthError(
            "DEVICE_AUTHORITY_DISABLED",
            "Device-key login requires a verified native-owner capability for this request (native-IPC attestation unavailable or unverified).",
          );
        }
        const consumed = bootstrapNonceRepo.consumeLoginChallengeNonce(db, {
          nonceHash: loginNonceHash,
          origin,
          nowIso: now,
          deviceId,
          // Equals sha256Hex(devicePublicKey); already asserted == the sentinel-bound
          // owner key hash above, so a login for a non-owner key never reaches here.
          devicePublicKeyHash: boundKeyHash,
        });
        if (consumed !== 1) {
          throw new FridayAuthError(
            "INVALID_CREDENTIALS",
            "Login challenge is invalid, expired, cross-origin, bound to a different device, or already used.",
          );
        }
        return mintSessionWrites(db, localUser, ip, userAgent);
      });
    } catch (err) {
      // A consumed/replayed/expired challenge is a rejected login → record the
      // failure (rate-limit a replay attacker) and re-throw. The mint writes never
      // throw INVALID_CREDENTIALS, so this only fires for the CAS refusal.
      if (err instanceof FridayAuthError && err.code === "INVALID_CREDENTIALS") {
        recordFailure(lockoutKey, ip);
      }
      throw err;
    }

    resetFailures(lockoutKey, ip);
    return response;
  }

  return {
    resolveBoundDeviceOwnerSentinelHash,
    getBootstrapStatus(): FridayAuthBootstrapStatusResponse {
      const localUser = findLocalUser();
      const bootstrapRequired = Boolean(
        localUser &&
        !localUser.password_hash,
      );
      return {
        bootstrapRequired,
        // CR-1 Option C: report ONLY whether the native device-claim SURFACE is
        // present for the current native surface — this is a presence signal, it
        // does NOT authorize any later request (authorization is the per-claim
        // capability, resolved+consumed at claim/login time). False on this tree →
        // the UI honestly keeps the passphrase gate. NEVER derived from a global
        // authority boolean.
        deviceClaimAvailable: nativeOwnerClaimSurfaceAvailable(),
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

      // Option C (finding #6): a fresh RELEASE is device-native only — passphrase
      // bootstrap is NOT offered and there is NO silent fallback. Legacy passphrase
      // LOGIN and migration/recovery remain available; only CREATING a fresh
      // passphrase owner is retired here. Dev/CI (non-release) is unaffected.
      if (releaseProfileNativeOnly()) {
        throw new FridayDomainError(
          "AUTH_BOOTSTRAP_PASSPHRASE_RETIRED",
          "A fresh release is device-native only; passphrase bootstrap is not offered. Use device-owner claim, or recover an existing passphrase owner.",
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

    issueLoginChallenge(
      request: FridayAuthLoginChallengeRequest,
      ip?: string,
    ): FridayAuthLoginChallengeResponse {
      // Loopback-only, mirroring the bootstrap-challenge ingress boundary.
      if (!isLocalhostAddress(ip)) {
        throw new FridayDomainError(
          "AUTH_LOGIN_CHALLENGE_NOT_ALLOWED",
          "Login challenge is only allowed from localhost.",
          { httpStatus: 403 },
        );
      }

      const installId = (request.installId ?? "").trim();
      const osUser = (request.osUser ?? "").trim();
      const origin = (request.origin ?? "").trim();
      const deviceId = (request.deviceId ?? "").trim();
      const devicePublicKey = (request.devicePublicKey ?? "").trim();
      const action =
        (request.action ?? LOGIN_TRANSCRIPT_ACTION).trim() || LOGIN_TRANSCRIPT_ACTION;
      if (!installId || !osUser || !origin || !deviceId || !devicePublicKey) {
        throw new FridayDomainError(
          "VALIDATION_ERROR",
          "installId, osUser, origin, deviceId and devicePublicKey are required to issue a login challenge",
          { httpStatus: 400 },
        );
      }

      const now = deps.nowIso();
      const expiresAt = new Date(
        new Date(now).getTime() + bootstrapNonceTtlSec * 1000,
      ).toISOString();
      const challengeId = deps.idGenerator();
      // Raw nonce is returned ONCE; only its hash is persisted. The device binding
      // (deviceId + key hash) is stamped at ISSUE so the consume CAS gates on it —
      // a challenge minted for device A can never be consumed by a login presenting
      // device B or a different key, even if the raw nonce leaked.
      const nonce = generateBootstrapNonce();
      const nonceHash = sha256Hex(nonce);
      const devicePublicKeyHash = sha256Hex(devicePublicKey);

      deps.db.withWriteTransaction((db) => {
        bootstrapNonceRepo.insertLoginChallengeNonce(db, {
          id: challengeId,
          nonceHash,
          hubId: bootstrapHubId,
          installId,
          osUser,
          origin,
          action,
          deviceId,
          devicePublicKey,
          devicePublicKeyHash,
          createdAt: now,
          expiresAt,
        });
      });

      return {
        challengeId,
        nonce,
        kind: "device_login_challenge",
        hubId: bootstrapHubId,
        installId,
        osUser,
        origin,
        action,
        deviceId,
        devicePublicKeyHash,
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
      // Reverse cross-intent guard: a proof minted FOR device readback
      // ("owner-readback") must NEVER be replayed into the owner-claim leg. NEGATIVE
      // guard only — any existing non-canonical claim action still passes.
      if (proof.transcript.action === READBACK_TRANSCRIPT_ACTION) {
        throw new FridayDomainError(
          "AUTH_BOOTSTRAP_POP_INVALID",
          "Proof-of-possession transcript was minted for device readback, not owner-claim.",
          { httpStatus: 401 },
        );
      }
      // POSITIVE own-action assertion (defence-in-depth, ON TOP of the negative
      // readback guard above): the transcript MUST have been minted FOR owner-claim.
      // Because `action` is bound into the signed bytes, a proof minted for ANY other
      // intent (migration, readback, or an arbitrary label) can never be replayed into
      // the owner-claim leg — closing the residual gap the negative-only guard left.
      if (proof.transcript.action !== CLAIM_TRANSCRIPT_ACTION) {
        throw new FridayDomainError(
          "AUTH_BOOTSTRAP_POP_INVALID",
          "Proof-of-possession transcript was not minted for owner-claim.",
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
      const nowMs = Date.parse(now);
      const nonceHash = sha256Hex(nonce);
      const devicePublicKeyHash = sha256Hex(devicePublicKey);
      const ownerSentinel = deviceOwnerSentinel(devicePublicKeyHash);

      // ── OPAQUE PER-CLAIM NATIVE-OWNER CAPABILITY (Option C — LIVE-DEFECT FIX) ──
      // Writing the durable device-owner sentinel is an AUTHORITY-bearing act: it
      // seizes the single owner slot for a device key. It therefore REQUIRES a
      // `VerifiedNativeOwnerClaimContext` bound to THIS request (minted only inside
      // the native IPC accept boundary from real peercred + code-sign + release-
      // trusted custody). WITHOUT a capability the claim is REFUSED with ZERO state
      // change — no nonce consumed, no owner written. This closes the head defect
      // where a valid software-key PoP wrote `device-owner$v1$…` + consumed the
      // nonce with no native authority. Resolved OUTSIDE the txn (the native
      // exchange must not hold the write lock); CONSUMED INSIDE it, atomically with
      // the nonce CAS + owner CAS.
      const claimBinding = buildNativeOwnerClaimBinding({
        hubId: bootstrapHubId,
        installId: (request.installId ?? "").trim(),
        osUser: (request.osUser ?? "").trim(),
        origin,
        action: CLAIM_TRANSCRIPT_ACTION,
        nonce,
        nowMs,
        deviceId,
        devicePublicKeyHash,
      });
      const claimCapability = resolveNativeOwnerClaimContext(claimBinding);

      // Atomic, crash-safe claim: capability consume + BOTH writes run in ONE write
      // transaction, so a crash / thrown error mid-claim rolls back the whole unit —
      // the nonce stays unconsumed AND the owner slot stays NULL (never a partial
      // owner, never an authority-less write).
      //   0. CONSUME the per-claim capability. Absent/drift/expired/replayed =>
      //      refuse, ZERO state change (thrown BEFORE the nonce CAS).
      //   1. CAS-consume the nonce (origin/expiry/single-use gate). changes=0 =>
      //      replay / expired / cross-origin => reject, ZERO state change.
      //   2. CAS-claim the owner slot (password_hash IS NULL). changes=0 =>
      //      already claimed => 409, ZERO state change (nonce consume rolls back).
      let grantedKeyProtection: FridayDeviceKeyProtection;
      try {
        grantedKeyProtection = deps.db.withWriteTransaction((db) => {
          const cap = consumeVerifiedNativeOwnerClaimContext(claimCapability, {
            binding: claimBinding,
            expectedConnectionId: deriveNativeOwnerExchangeConnectionId(claimBinding),
            nowMs,
          });
          if (!cap.ok) {
            throw new FridayDomainError(
              "AUTH_BOOTSTRAP_DEVICE_AUTHORITY_UNVERIFIED",
              "Device owner-claim requires a verified native-owner capability for this request; refused with no state change (no owner written, no nonce consumed).",
              { httpStatus: 401 },
            );
          }

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
          return cap.keyProtection;
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
        // Authoritative readback: the key-protection posture the consumed capability
        // carried (release-trusted native custody), and — since a capability was
        // consumed — this device binding now carries owner authority for THIS build.
        keyProtection: grantedKeyProtection,
        deviceAuthorityEnabled: isReleaseTrustedKeyProtection(grantedKeyProtection),
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
      // Reverse cross-intent guard: a proof minted FOR device readback
      // ("owner-readback") must NEVER be replayed into the migration leg. NEGATIVE
      // guard only — any existing non-canonical migration action still passes.
      if (proof.transcript.action === READBACK_TRANSCRIPT_ACTION) {
        throw new FridayDomainError(
          "AUTH_MIGRATE_POP_INVALID",
          "Proof-of-possession transcript was minted for device readback, not migration.",
          { httpStatus: 401 },
        );
      }
      // POSITIVE own-action assertion (defence-in-depth, ON TOP of the negative
      // readback guard above): the transcript MUST have been minted FOR migration.
      // Because `action` is bound into the signed bytes, a proof minted for ANY other
      // intent (owner-claim, readback, or an arbitrary label) can never be replayed
      // into the migration leg — closing the residual gap the negative-only guard left.
      if (proof.transcript.action !== MIGRATE_TRANSCRIPT_ACTION) {
        throw new FridayDomainError(
          "AUTH_MIGRATE_POP_INVALID",
          "Proof-of-possession transcript was not minted for migration.",
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
        // Option C: this path grants ZERO owner authority (a provisional migration
        // binding / an activated dual-read binding / a read-only posture never
        // seizes owner login). Authority is ONLY the per-claim native capability
        // consumed at claim/login — never a global boolean. Always false here.
        deviceAuthorityEnabled: false,
      };
    },

    confirmDeviceReadback(
      request: FridayAuthDeviceReadbackRequest,
      principal: FridayAuthPrincipal | null,
      ip?: string,
    ): FridayAuthDeviceReadbackResponse {
      // Loopback-only guard (identical ingress boundary to the migrate legs).
      if (!isLocalhostAddress(ip)) {
        throw new FridayDomainError(
          "AUTH_READBACK_NOT_ALLOWED",
          "Device readback is only allowed from localhost.",
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
      // Authenticated-owner gate (the session is the proof-of-passphrase). Refuses
      // the synthetic public principal (401) and any non-owner identity/role (403).
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

      // ── Proof-of-possession gate (identical posture to migrateOwnerToDeviceKey) ──
      // The device MUST prove fresh PRIVATE-key possession by signing the canonical
      // transcript. A PoP failure activates NOTHING (the binding stays provisional).
      // Anti-replay is INTRINSIC: freshness comes from the transcript's own
      // expiresAt (verified below), and a replayed activation flips 0 rows at the
      // provisional→active compare-and-set — so NO install nonce is consumed here
      // and NO migration is required.
      const proof = coerceDeviceClaimProof(request.deviceClaimProof);
      if (!proof) {
        throw new FridayDomainError(
          "AUTH_READBACK_POP_REQUIRED",
          "Device readback requires a proof-of-possession (signed transcript + signature).",
          { httpStatus: 400 },
        );
      }
      if (
        proof.transcript.nonce !== nonce ||
        proof.transcript.origin !== origin ||
        proof.transcript.deviceId !== deviceId
      ) {
        throw new FridayDomainError(
          "AUTH_READBACK_POP_INVALID",
          "Proof-of-possession transcript does not match the readback request.",
          { httpStatus: 401 },
        );
      }
      // ── (a) Domain-separate the readback intent ──
      // The transcript MUST have been minted FOR device readback. `action` is bound
      // into the signed bytes, so a proof minted for a different intent (e.g.
      // "owner-migrate") that happens to share this readback's nonce/origin/deviceId
      // can NEVER be replayed here to activate the binding.
      if (proof.transcript.action !== READBACK_TRANSCRIPT_ACTION) {
        throw new FridayDomainError(
          "AUTH_READBACK_POP_INVALID",
          "Proof-of-possession transcript was not minted for device readback.",
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
          "AUTH_READBACK_POP_INVALID",
          `Device proof-of-possession failed: ${pop.reason}.`,
          { httpStatus: 401 },
        );
      }

      // ── (b) Server-side max-TTL clamp (readback only) ──
      // Freshness is bound in the transcript's own expiresAt (verified above), but
      // the PoP verifier imposes NO upper bound. Reject a proof whose expiry is
      // non-finite or lies further in the future than the maximum allowed readback
      // TTL, so a far-future transcript can never be minted once and replayed.
      const readbackNowMs = Date.parse(deps.nowIso());
      const readbackExpiryMs = Date.parse(proof.transcript.expiresAt);
      if (
        !Number.isFinite(readbackExpiryMs) ||
        readbackExpiryMs - readbackNowMs > READBACK_MAX_TRANSCRIPT_TTL_MS
      ) {
        throw new FridayDomainError(
          "AUTH_READBACK_POP_INVALID",
          "Proof-of-possession transcript expiry exceeds the maximum allowed TTL.",
          { httpStatus: 401 },
        );
      }

      // The binding stores sha256(devicePublicKey base64) — recompute the SAME
      // hash the migrate leg persisted, from the possession-proven presented key,
      // so we activate the exact provisional row that migration created.
      const devicePublicKeyHash = sha256Hex(devicePublicKey);
      const now = deps.nowIso();

      // Single write transaction: read-guard + CAS-activate are atomic. NEVER
      // touches users.password_hash (the passphrase stays authoritative — no
      // lockout) and writes NO tombstone (Stage 5 is deferred).
      let bindingId: string;
      try {
        bindingId = deps.db.withWriteTransaction((db) => {
          // Defence-in-depth (migration-free, writes nothing): if the legacy
          // credential has already been tombstoned (a later stage's terminal state),
          // refuse to (re-)activate. This satisfies "tombstoned cannot re-activate"
          // WITHOUT activating the Stage-5 tombstone-write path.
          if (bindingRepo.findActiveTombstone(db, localUser.id)) {
            throw new FridayDomainError(
              "AUTH_READBACK_TOMBSTONED",
              "The legacy credential has been retired; the device binding cannot be re-activated.",
              { httpStatus: 409 },
            );
          }

          const binding = bindingRepo.findBindingByUserAndKeyHash(
            db,
            localUser.id,
            devicePublicKeyHash,
          );
          if (!binding) {
            // No binding for this owner+key — cross-owner, unknown key, or migration
            // never ran. Fail closed with ZERO state change.
            throw new FridayDomainError(
              "AUTH_READBACK_NO_BINDING",
              "No device binding to activate for this owner and device key.",
              { httpStatus: 409 },
            );
          }

          // Provisional → active compare-and-set. changes===1 only when the row was
          // provisional; a revoked binding, an already-active binding (replay), or a
          // concurrent flip all return 0 ⇒ fail closed, NO second active row.
          const changed = bindingRepo.activateBinding(db, binding.id, localUser.id, now);
          if (changed !== 1) {
            throw new FridayDomainError(
              "AUTH_READBACK_NOT_PROVISIONAL",
              "The device binding is not in a provisional state and cannot be activated.",
              { httpStatus: 409 },
            );
          }
          return binding.id;
        });
      } catch (error) {
        // ── (c) Graceful 409 on the active-binding UNIQUE (never a raw 500) ──
        // The only UNIQUE that can fire is the partial UNIQUE(user_id) WHERE
        // state='active': an existing/concurrent active binding for this owner makes
        // the provisional→active flip a UNIQUE violation. Surface it as a clean
        // fail-closed 409. Narrowed to the SPECIFIC active-binding uniqueness
        // violation (not any SQLITE_CONSTRAINT*) so a future different constraint on
        // this table is not mismapped to 409 — it propagates. The in-txn
        // FridayDomainErrors (tombstone / no-binding / not-provisional) are NOT
        // constraint errors, so they re-throw unchanged with their original codes.
        if (isActiveBindingUniqueViolation(error)) {
          throw new FridayDomainError(
            "AUTH_READBACK_ALREADY_ACTIVE",
            "A device binding is already active for this owner.",
            { httpStatus: 409 },
          );
        }
        throw error;
      }

      return {
        activated: true,
        state: "active",
        bindingId,
        activatedAt: now,
        userId: localUser.id,
        deviceId,
        devicePublicKeyHash,
        // The passphrase is still the working owner credential — no lockout.
        passphraseStillActive: true,
        // ALWAYS false in release/default — activation grants ZERO authority until
        // native-IPC precondition (b) lands.
        // Option C: this path grants ZERO owner authority (a provisional migration
        // binding / an activated dual-read binding / a read-only posture never
        // seizes owner login). Authority is ONLY the per-claim native capability
        // consumed at claim/login — never a global boolean. Always false here.
        deviceAuthorityEnabled: false,
      };
    },

    getDeviceBindingState(
      principal: FridayAuthPrincipal | null,
      ip?: string,
    ): FridayAuthDeviceBindingStateResponse {
      // Loopback-only (consistent with the rest of the migrate/device family).
      if (!isLocalhostAddress(ip)) {
        throw new FridayDomainError(
          "AUTH_READBACK_NOT_ALLOWED",
          "Device binding state is only readable from localhost.",
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
      assertAuthenticatedLocalOwner(principal, localUser);

      const row = deps.db.withReadConnection((db) => {
        const active = bindingRepo.findActiveBindingByUser(db, localUser.id);
        if (active) return active;
        // Fall back to the newest binding in any state (provisional/revoked) so the
        // caller can observe a not-yet-activated bind.
        return bindingRepo.findBindingsByUser(db, localUser.id)[0] ?? null;
      });

      return {
        userId: localUser.id,
        hasActiveBinding: row?.state === "active",
        state: row?.state ?? "none",
        bindingId: row?.id ?? null,
        deviceId: row?.device_id ?? null,
        devicePublicKeyHash: row?.device_public_key_hash ?? null,
        createdAt: row?.created_at ?? null,
        activatedAt: row?.activated_at ?? null,
        revokedAt: row?.revoked_at ?? null,
        passphraseStillActive: true,
        // Option C: this path grants ZERO owner authority (a provisional migration
        // binding / an activated dual-read binding / a read-only posture never
        // seizes owner login). Authority is ONLY the per-claim native capability
        // consumed at claim/login — never a global boolean. Always false here.
        deviceAuthorityEnabled: false,
      };
    },

    login(request, ip, userAgent) {
      // SEC-SETUP-BOOTSTRAP-001 (CR-1): a genuine (non-null) device-login proof
      // selects the device-key login path (proof-of-possession of the bound
      // device key), which mints a session ONLY when device-owner authority is
      // enabled. Requiring non-null means a stray null proof cannot hijack a
      // passphrase/email request; the device path never touches that logic below.
      if (request.deviceLoginProof !== undefined && request.deviceLoginProof !== null) {
        return deviceKeyLogin(request, ip, userAgent);
      }

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

      return mintSession(user, ip, userAgent);
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
