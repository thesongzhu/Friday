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

// ─── (b) native-IPC caller-identity precondition (ABSENT today) ───
//
// This is a compile-time constant, NOT a config flag. It flips to `true` ONLY in
// the future slice that lands a trusted native-app IPC caller-identity bridge
// (SO_PEERCRED / signed-shell attestation). Until then, no amount of env / header
// / request / loopback fact can make a device principal trusted.
export const NATIVE_IPC_ATTESTATION_AVAILABLE = false as const;

// ─── Server-derived, off-by-default authority switch ───

/**
 * Explicit server-side opt-in env var. Even when set, it does NOT enable device
 * authority on its own — precondition (b) (`NATIVE_IPC_ATTESTATION_AVAILABLE`)
 * must ALSO be present. This var is read ONLY from the process environment; it is
 * never derived from a request body, header, Origin, cookie, User-Agent,
 * bundle-id, loopback fact, or any nonce-holding process.
 */
export const DEVICE_OWNER_AUTHORITY_ENABLED_ENV = "FRIDAY_DEVICE_OWNER_AUTHORITY_ENABLED";

/**
 * True IFF a device-bound owner principal may carry release-profile owner
 * authority. Server-derived and fail-closed: requires BOTH the explicit
 * server-side env opt-in AND the native-IPC precondition (b). Because (b) is a
 * hard-wired `false` today, this ALWAYS returns `false` in the current build —
 * the truthful state of the requirement (NOT "passed").
 *
 * Takes NO request-derived input by design: there is structurally no way for a
 * caller to flip it via request data.
 */
export function isDeviceOwnerAuthorityEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!NATIVE_IPC_ATTESTATION_AVAILABLE) {
    // Precondition (b) absent — fail closed regardless of any config.
    return false;
  }
  return env[DEVICE_OWNER_AUTHORITY_ENABLED_ENV] === "1";
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
 * Derive the device key-protection posture SERVER-SIDE. Today there is no OS
 * attestation bridge, so the only honest, reachable value is `"unverified"` —
 * which fails closed. A FUTURE native slice sets the hardware-backed states here
 * from a verified OS attestation, never from the request.
 */
export function deriveDeviceKeyProtection(): FridayDeviceKeyProtection {
  return "unverified";
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
