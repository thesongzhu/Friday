// ─── SEC-SETUP-BOOTSTRAP-001 · Slice 3 — device-principal fail-closed precondition ───
//
// This module is the SINGLE server-derived source of truth for whether a
// device-bound owner principal may carry ANY real owner data/control authority
// in the release/default profile. It is deliberately additive and fail-closed:
// it grants nothing, mints no token, and treats every device principal as
// DISABLED until BOTH preconditions land —
//   (a) S2a proof-of-possession verify  [MERGED — src/api/auth/device-attest]
//   (b) trusted native-app IPC caller-identity  [ABSENT today]
//
// Because (b) is absent, the switch below is HARD-WIRED off (a config flag
// cannot flip it) and the only reachable keyProtection state is "unverified" —
// which fails closed. NOTHING here labels an arbitrary key as Secure Enclave,
// hardcodes attestation-passed, or lets nonce/config/request facts assert a
// trusted device. See the types file in device-attest for the crypto contract.

import type { FridayAuthPrincipal } from "../api/model/friday-api-auth.types.js";
import type { FridayScope } from "../api/model/friday-api-auth.types.js";

// ─── Device principal identity constants ───

/**
 * The principal-type discriminator for a device-bound owner principal. The
 * enforcement floors key on THIS value (not on "the id is not public:default")
 * so a device principal cannot slip through by merely being non-synthetic.
 */
export const DEVICE_OWNER_PRINCIPAL_TYPE = "device" as const;

/**
 * Stable principalId prefix for a device-bound owner principal. The
 * conversational session-dispatch gate (which only sees a string actorId) refuses
 * any actor id carrying this prefix while the device authority switch is off.
 */
export const DEVICE_OWNER_PRINCIPAL_ID_PREFIX = "device-owner:";

export function deviceOwnerPrincipalId(devicePublicKeyHash: string): string {
  return `${DEVICE_OWNER_PRINCIPAL_ID_PREFIX}${devicePublicKeyHash}`;
}

export function isDeviceOwnerPrincipalId(actorId: string | null | undefined): boolean {
  return typeof actorId === "string" && actorId.startsWith(DEVICE_OWNER_PRINCIPAL_ID_PREFIX);
}

// ─── (b) native-IPC honesty anchor — RETIRED AS AN AUTHORITY SOURCE (Option C) ───
//
// This compile-time constant is RETIRED as an authority source (Advisor Option C).
// It is DELIBERATELY LEFT in place as a truthful honesty anchor — it remains
// `false` on this unsigned dev/CI tree and is NEVER read to authorize anything —
// but NO code path derives authority from it any longer. The Advisor rejected any
// global boolean ("once true on a real release it authorizes EVERY HTTP caller, not
// just the attested peer"); authority now flows ONLY through the opaque, per-claim
// `VerifiedNativeOwnerClaimContext`
// (src/security/attestation/friday-verified-native-owner-claim-context.ts), minted
// solely inside the native IPC accept boundary. It is NEVER flipped `true`.
export const NATIVE_IPC_ATTESTATION_AVAILABLE = false as const;

// ─── Emergency kill switch (can force OFF; can NEVER force ON) ───

/**
 * Protected emergency kill switch. When engaged it FORCES device-owner authority
 * OFF (mint + consume of every per-claim capability refuse). There is NO
 * counterpart that forces authority ON — the Option-C flagless-positive contract
 * means no env / config / header / body / test seam can make a capability mint;
 * only real native attestation can. This env is read ONLY from the process
 * environment, never from request data.
 */
export const DEVICE_OWNER_AUTHORITY_KILL_SWITCH_ENV = "FRIDAY_DEVICE_OWNER_AUTHORITY_KILL_SWITCH";

const KILL_SWITCH_ENGAGED_VALUES: ReadonlySet<string> = new Set([
  "1",
  "true",
  "on",
  "engage",
  "engaged",
  "disable",
  "disabled",
]);

/**
 * True iff the emergency kill switch is engaged (forces device-owner authority
 * OFF). Case-insensitive, trimmed. Consulted by the capability mint + consume.
 */
export function isDeviceOwnerAuthorityKillSwitchEngaged(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[DEVICE_OWNER_AUTHORITY_KILL_SWITCH_ENV]?.trim().toLowerCase();
  return raw !== undefined && KILL_SWITCH_ENGAGED_VALUES.has(raw);
}

/**
 * RETIRED (Option C): there is NO global "device authority enabled" switch any
 * more. Authority is conferred per-claim by a `VerifiedNativeOwnerClaimContext`,
 * never by a process-wide boolean. This predicate is kept ONLY as a fail-closed
 * floor signal — it is ALWAYS `false` (no env / config / request can flip it),
 * so every enforcement floor that consults it continues to treat a device
 * principal as unauthenticated. It takes NO request-derived input by design.
 */
export function isDeviceOwnerAuthorityEnabled(
  _env: NodeJS.ProcessEnv = process.env,
): boolean {
  // No global enable exists under Option C. Fail closed, always.
  return false;
}

// ─── keyProtection — server-derived 4-state (NEVER request-reported) ───

/**
 * Device key-protection posture, derived SERVER-SIDE only. NEVER read from the
 * request body / self-reported by the caller.
 *   - `secure_enclave_os_verified` / `keychain_acl_verified` — release-trusted,
 *     but UNREACHABLE today (no OS attestation bridge exists yet).
 *   - `software_dev_only` / `unverified` — fail closed in the release profile.
 */
export type FridayDeviceKeyProtection =
  | "secure_enclave_os_verified"
  | "keychain_acl_verified"
  | "software_dev_only"
  | "unverified";

const RELEASE_TRUSTED_KEY_PROTECTION: ReadonlySet<FridayDeviceKeyProtection> = new Set<
  FridayDeviceKeyProtection
>(["secure_enclave_os_verified", "keychain_acl_verified"]);

/**
 * True iff the derived key-protection posture is release-trusted. `unverified`
 * and `software_dev_only` return `false` (fail closed).
 */
export function isReleaseTrustedKeyProtection(kp: FridayDeviceKeyProtection): boolean {
  return RELEASE_TRUSTED_KEY_PROTECTION.has(kp);
}

/**
 * The custody kind reported by a native key-custody provider (see
 * src/security/attestation/friday-native-key-custody-provider.ts). This is
 * OS-derived evidence, NEVER a request-reported or global posture.
 */
export type NativeKeyCustodyKind =
  | "secure_enclave"
  | "keychain_acl"
  | "webcrypto_software";

/**
 * Verified native key-custody evidence CONSUMED by {@link deriveDeviceKeyProtection}.
 * A signed release supplies this from the OS (Secure Enclave / Keychain ACL); the
 * WebCrypto dev seam supplies `webcrypto_software`, which can NEVER be
 * release-trusted. There is no field a caller can set to self-report a hardware
 * posture — `osVerified` is only ever true when the OS itself vouched for it.
 */
export interface NativeKeyCustodyEvidence {
  readonly custody: NativeKeyCustodyKind;
  /** Only ever `true` when the OS attested the custody (Secure Enclave / ACL). */
  readonly osVerified: boolean;
}

/**
 * Derive the device key-protection posture SERVER-SIDE by CONSUMING verified
 * native key-custody evidence (Option C, finding #4). It NEVER returns/accepts a
 * self-reported or global posture:
 *   - absent evidence (`null`/`undefined`) → `"unverified"` (honest-absent on this
 *     unsigned dev/CI tree — fails closed);
 *   - `secure_enclave` + OS-verified → `"secure_enclave_os_verified"` (release-trusted);
 *   - `keychain_acl` + OS-verified → `"keychain_acl_verified"` (release-trusted);
 *   - `webcrypto_software` (or any non-OS-verified custody) → `"software_dev_only"`
 *     — a dev/negative seam that is NEVER release-trusted.
 * WebCrypto can therefore never yield a release-trusted keyProtection.
 */
export function deriveDeviceKeyProtection(
  evidence?: NativeKeyCustodyEvidence | null,
): FridayDeviceKeyProtection {
  if (!evidence) {
    return "unverified";
  }
  if (evidence.custody === "secure_enclave" && evidence.osVerified === true) {
    return "secure_enclave_os_verified";
  }
  if (evidence.custody === "keychain_acl" && evidence.osVerified === true) {
    return "keychain_acl_verified";
  }
  // WebCrypto software keys, and any custody the OS did NOT verify, are dev-only.
  return "software_dev_only";
}

// ─── Fail-closed device-owner mint seam ───
//
// The seam a future slice would call (AFTER PoP-verify) to mint a device-bound
// owner principal. Today it ALWAYS fails closed: it issues no token and returns
// no authority-bearing principal, because the switch is off and keyProtection is
// not release-trusted. It never fabricates a Secure-Enclave label or authority.

export interface DeviceOwnerMintInput {
  readonly deviceId: string;
  /** Canonical (SPKI-DER) hash of the verified device public key. */
  readonly devicePublicKeyHash: string;
  readonly ownerUserId: string;
  readonly tenantId: string;
  /** Server-derived posture (never from the request). */
  readonly keyProtection: FridayDeviceKeyProtection;
  /** Result of the S2a PoP verifier — possession of the private key was proven. */
  readonly popVerified: boolean;
  /** Owner scopes the device WOULD receive once enabled (post-preconditions). */
  readonly ownerScopes: readonly FridayScope[];
  readonly env?: NodeJS.ProcessEnv;
}

export type DeviceOwnerMintDisabledReason =
  | "pop-unverified"
  | "device-owner-authority-disabled-pending-native-ipc"
  | "key-protection-not-release-trusted";

export interface DeviceOwnerMintDisabled {
  readonly ok: false;
  readonly disabled: true;
  readonly reason: DeviceOwnerMintDisabledReason;
  readonly keyProtection: FridayDeviceKeyProtection;
  /** Always false in the release/default profile — the requirement is NOT passed. */
  readonly deviceAuthorityEnabled: false;
}

export interface DeviceOwnerMintEnabled {
  readonly ok: true;
  readonly principal: FridayAuthPrincipal;
  readonly deviceAuthorityEnabled: true;
}

export type DeviceOwnerMintResult = DeviceOwnerMintDisabled | DeviceOwnerMintEnabled;

function disabled(
  reason: DeviceOwnerMintDisabledReason,
  keyProtection: FridayDeviceKeyProtection,
): DeviceOwnerMintDisabled {
  return { ok: false, disabled: true, reason, keyProtection, deviceAuthorityEnabled: false };
}

/**
 * Fail-closed device-owner mint seam. Returns a DISABLED result (no token, no
 * authority) unless EVERY precondition holds:
 *   1. PoP was verified (possession of the private key proven — S2a).
 *   2. The server-derived authority switch is enabled (requires (b) native IPC).
 *   3. keyProtection is release-trusted (hardware-backed, OS-verified).
 * In the current build (2) is impossible ((b) absent) and (3) is unreachable, so
 * this NEVER returns an authority-bearing principal. The enabled branch is the
 * future plug point; it grants authority only when all three hold.
 */
export function mintDeviceOwnerPrincipal(input: DeviceOwnerMintInput): DeviceOwnerMintResult {
  const { keyProtection } = input;

  // Defense-in-depth: never mint from mere nonce/claim possession.
  if (!input.popVerified) {
    return disabled("pop-unverified", keyProtection);
  }
  // (b) native-IPC + explicit server opt-in — off by default, hard-wired off today.
  if (!isDeviceOwnerAuthorityEnabled(input.env)) {
    return disabled("device-owner-authority-disabled-pending-native-ipc", keyProtection);
  }
  // keyProtection must be hardware-backed + OS-verified (unreachable today).
  if (!isReleaseTrustedKeyProtection(keyProtection)) {
    return disabled("key-protection-not-release-trusted", keyProtection);
  }

  // Future plug point (post-preconditions): mint the device-bound owner principal.
  // Reached ONLY when all three fail-closed gates above pass — never in this build.
  const principal: FridayAuthPrincipal = {
    principalType: DEVICE_OWNER_PRINCIPAL_TYPE,
    principalId: deviceOwnerPrincipalId(input.devicePublicKeyHash),
    tenantId: input.tenantId,
    userId: input.ownerUserId,
    role: "owner",
    scopes: [...input.ownerScopes],
    tokenId: input.devicePublicKeyHash,
    tokenKind: "access",
    issuedAt: new Date().toISOString(),
  };
  return { ok: true, principal, deviceAuthorityEnabled: true };
}
