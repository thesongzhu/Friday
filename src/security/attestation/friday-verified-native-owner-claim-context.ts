// ─── SEC-NATIVE-OWNER-CLAIM-CAPABILITY-001 · CORE-A CR-1 (Advisor Option C) ───
//
// An OPAQUE, PER-CLAIM, single-use owner-claim capability. This is the Option-C
// REPLACEMENT for the retired GLOBAL boolean authority
// (`NATIVE_IPC_ATTESTATION_AVAILABLE` + `FRIDAY_DEVICE_OWNER_AUTHORITY_ENABLED`):
// the Advisor rejected any global boolean because "once true on a real release it
// authorizes EVERY HTTP caller, not just the attested peer." Nothing global
// authorizes anymore — THIS capability does, and ONLY for the EXACT request it is
// bound to.
//
// PROVENANCE (mint): a `VerifiedNativeOwnerClaimContext` is minted ONLY from
//   (a) a `NativePeerAttestationResult` with `attested === true` — i.e. real
//       kernel-derived LOCAL_PEERCRED evidence + a valid, identity-matching code
//       signature verified by the OS (the CR-4 verifier), PLUS
//   (b) a PINNED code-sign / artifact-role policy, PLUS
//   (c) release-trusted native key custody (`deriveDeviceKeyProtection` over
//       verified native evidence — never WebCrypto, never self-reported).
// There is structurally NO env / request / header / body / test path to a `true`
// attestation, so there is no way to forge a capability.
//
// OPAQUE: a module-private Symbol brand + a module-private WeakSet single-use
// ledger mean a request body, env var, header, hand-built object literal, or test
// double can NEVER masquerade as a capability — the SOLE constructor is
// {@link mintVerifiedNativeOwnerClaimContext}. Callers receive an opaque handle and
// can only VERIFY/CONSUME it; they cannot read authority out of a self-assertion.
//
// BINDING: the capability is bound to hubId, installId, OS user + UID, origin,
// channel, action, nonce, expiry, deviceId, device public-key hash, the accepted
// native connection/audit-token identity, and the exact artifact role. Consume
// EXACT-matches every request-derived field; any drift, expiry, connection
// substitution, replay (single-use), or "one attested peer authorizing a DIFFERENT
// request" yields a refusal with ZERO authority — the caller then performs ZERO
// state change.

import {
  type FridayDeviceKeyProtection,
  isDeviceOwnerAuthorityKillSwitchEngaged,
  isReleaseTrustedKeyProtection,
} from "../friday-device-owner-authority-precondition.js";
import type { NativePeerAttestationResult } from "./friday-native-peer-attestation-verifier.js";

// ─── Request-derived binding (the EXACT-match subset) ──────────────────────

/**
 * The request-derived fields a capability is bound to and that CONSUME must
 * exact-match. Every field is authoritative context for THIS one claim/login —
 * none of it is trusted from the capability's own self-assertion at consume time;
 * the consumer supplies the expected values from the live request and they must
 * match the values frozen into the capability at mint.
 */
export interface NativeOwnerClaimBinding {
  readonly hubId: string;
  readonly installId: string;
  readonly osUser: string;
  readonly origin: string;
  readonly channel: string;
  /** owner-claim | owner-login | owner-migrate | owner-readback (domain separator). */
  readonly action: string;
  readonly nonce: string;
  /** Absolute expiry (epoch ms). The capability is dead past this instant. */
  readonly expiresAtMs: number;
  readonly deviceId: string;
  readonly devicePublicKeyHash: string;
  /** The exact artifact role the attested peer binary must fill (pinned policy). */
  readonly artifactRole: string;
}

// ─── Native-evidence binding (kernel/OS-derived; never request-asserted) ───

/**
 * Kernel/OS-derived facts about the accepted native peer, frozen into the
 * capability at mint. These are NEVER supplied by the request — they come from the
 * native IPC accept boundary (LOCAL_PEERCRED + the accepted connection identity).
 * `osUid`/`peerPid` MUST equal the verifier's peer credential, and
 * `acceptedConnectionId` binds the capability to the exact accepted connection so a
 * capability minted for connection C1 can never be replayed on connection C2.
 */
export interface NativeOwnerPeerEvidence {
  readonly osUid: number;
  readonly peerPid: number;
  readonly acceptedConnectionId: string;
  /** The audit-token / connection identity vouched by the accept boundary. */
  readonly auditTokenIdentity: string;
  /** The verified code-sign identity of the accepted peer binary. */
  readonly codesignIdentity: string;
}

// ─── Pinned policy ─────────────────────────────────────────────────────────

/**
 * The pinned code-sign / artifact-role policy the accepted peer must satisfy.
 * `expectedReleaseIdentity` must equal the verifier's attested code-sign identity
 * and `expectedArtifactRole` must equal the binding's artifact role — a peer that
 * is validly signed but for the WRONG artifact role (helper vs. main app) is
 * refused.
 */
export interface PinnedNativeOwnerPolicy {
  readonly expectedReleaseIdentity: string;
  readonly expectedArtifactRole: string;
}

// ─── Opaque capability handle ──────────────────────────────────────────────

const OWNER_CLAIM_CONTEXT_BRAND: unique symbol = Symbol("friday.verified-native-owner-claim-context");

/**
 * OPAQUE per-claim capability. Its fields are readable for audit but carry NO
 * authority on their own — authority is conferred ONLY by having been produced by
 * {@link mintVerifiedNativeOwnerClaimContext} (brand-checked) and by passing
 * {@link consumeVerifiedNativeOwnerClaimContext} against the live request. A plain
 * object literal with the same fields is NOT a capability (no brand) and is
 * refused.
 */
export interface VerifiedNativeOwnerClaimContext {
  readonly [OWNER_CLAIM_CONTEXT_BRAND]: true;
  readonly binding: NativeOwnerClaimBinding;
  readonly evidence: NativeOwnerPeerEvidence;
  readonly keyProtection: FridayDeviceKeyProtection;
}

/** Module-private single-use ledger — a consumed capability can never re-authorize. */
const consumedCapabilities = new WeakSet<VerifiedNativeOwnerClaimContext>();

// ─── Mint outcomes ─────────────────────────────────────────────────────────

export type NativeOwnerClaimMintDenyReason =
  | "kill-switch-engaged"
  | "attestation-not-attested"
  | "codesign-identity-mismatch"
  | "key-protection-not-release-trusted"
  | "artifact-role-mismatch"
  | "peer-evidence-inconsistent"
  | "binding-incomplete"
  | "evidence-incomplete";

export type NativeOwnerClaimMintResult =
  | { readonly ok: true; readonly capability: VerifiedNativeOwnerClaimContext }
  | { readonly ok: false; readonly reason: NativeOwnerClaimMintDenyReason };

export interface MintVerifiedNativeOwnerClaimContextInput {
  /** The CR-4 verifier result — MUST be `attested: true` (real peercred + codesign). */
  readonly attestation: NativePeerAttestationResult;
  /** Native key custody posture, derived from verified native evidence. */
  readonly keyProtection: FridayDeviceKeyProtection;
  readonly binding: NativeOwnerClaimBinding;
  readonly evidence: NativeOwnerPeerEvidence;
  readonly policy: PinnedNativeOwnerPolicy;
  /** Env — consulted ONLY for the kill switch (can force FALSE; never TRUE). */
  readonly env?: NodeJS.ProcessEnv;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function bindingComplete(b: NativeOwnerClaimBinding): boolean {
  return (
    nonBlank(b.hubId)
    && nonBlank(b.installId)
    && nonBlank(b.osUser)
    && nonBlank(b.origin)
    && nonBlank(b.channel)
    && nonBlank(b.action)
    && nonBlank(b.nonce)
    && isPositiveSafeInteger(b.expiresAtMs)
    && nonBlank(b.deviceId)
    && nonBlank(b.devicePublicKeyHash)
    && nonBlank(b.artifactRole)
  );
}

function evidenceComplete(e: NativeOwnerPeerEvidence): boolean {
  return (
    isNonNegativeSafeInteger(e.osUid)
    && isPositiveSafeInteger(e.peerPid)
    && nonBlank(e.acceptedConnectionId)
    && nonBlank(e.auditTokenIdentity)
    && nonBlank(e.codesignIdentity)
  );
}

/**
 * Mint an opaque per-claim capability. Returns `{ ok: true, capability }` IFF ALL
 * of the following hold (any failure → `{ ok: false, reason }`, ZERO authority):
 *   1. the authority kill switch is NOT engaged (env / policy);
 *   2. `attestation.attested === true` (real LOCAL_PEERCRED + valid codesign);
 *   3. the attested code-sign identity equals `policy.expectedReleaseIdentity`;
 *   4. `keyProtection` is release-trusted (Secure-Enclave / Keychain-ACL — never
 *      WebCrypto/software/unverified);
 *   5. `binding.artifactRole === policy.expectedArtifactRole`;
 *   6. the native evidence is internally consistent with the verified peercred
 *      (`evidence.osUid === peerCredential.uid`, `evidence.peerPid === .pid`);
 *   7. the binding and evidence are structurally complete (no blank/invalid field).
 *
 * It NEVER reads the request/env for a POSITIVE — the only env input is the kill
 * switch, which can force a refusal but never an authorization.
 */
export function mintVerifiedNativeOwnerClaimContext(
  input: MintVerifiedNativeOwnerClaimContextInput,
): NativeOwnerClaimMintResult {
  const { attestation, keyProtection, binding, evidence, policy, env } = input;

  if (isDeviceOwnerAuthorityKillSwitchEngaged(env ?? process.env)) {
    return { ok: false, reason: "kill-switch-engaged" };
  }
  if (attestation.attested !== true) {
    return { ok: false, reason: "attestation-not-attested" };
  }
  // The verifier already matched identity against expectedReleaseIdentity, but we
  // RE-PIN it here so the capability cannot be minted from an attestation that was
  // verified against a different expected identity than this policy pins.
  if (
    !nonBlank(policy.expectedReleaseIdentity)
    || attestation.codesignIdentity !== policy.expectedReleaseIdentity
  ) {
    return { ok: false, reason: "codesign-identity-mismatch" };
  }
  if (!isReleaseTrustedKeyProtection(keyProtection)) {
    return { ok: false, reason: "key-protection-not-release-trusted" };
  }
  if (!bindingComplete(binding)) {
    return { ok: false, reason: "binding-incomplete" };
  }
  if (!evidenceComplete(evidence)) {
    return { ok: false, reason: "evidence-incomplete" };
  }
  if (!nonBlank(policy.expectedArtifactRole) || binding.artifactRole !== policy.expectedArtifactRole) {
    return { ok: false, reason: "artifact-role-mismatch" };
  }
  // Evidence MUST agree with the kernel-vouched peer credential the verifier read.
  const cred = attestation.peerCredential;
  if (
    !cred
    || cred.uid !== evidence.osUid
    || cred.pid !== evidence.peerPid
    || attestation.codesignIdentity !== evidence.codesignIdentity
  ) {
    return { ok: false, reason: "peer-evidence-inconsistent" };
  }

  const capability: VerifiedNativeOwnerClaimContext = Object.freeze({
    [OWNER_CLAIM_CONTEXT_BRAND]: true as const,
    binding: Object.freeze({ ...binding }),
    evidence: Object.freeze({ ...evidence }),
    keyProtection,
  });
  return { ok: true, capability };
}

// ─── Consume ───────────────────────────────────────────────────────────────

export type NativeOwnerClaimConsumeDenyReason =
  | "no-capability"
  | "kill-switch-engaged"
  | "already-consumed"
  | "expired"
  | "binding-drift"
  | "connection-substituted"
  | "key-protection-not-release-trusted";

export type NativeOwnerClaimConsumeResult =
  | { readonly ok: true; readonly keyProtection: FridayDeviceKeyProtection }
  | { readonly ok: false; readonly reason: NativeOwnerClaimConsumeDenyReason };

/**
 * What the CONSUMER (claim/login) expects THIS request to be. Every field is
 * derived from the live request/connection — NOT from the capability — and must
 * exact-match the capability's frozen binding + accepted-connection identity.
 */
export interface NativeOwnerClaimConsumeExpectation {
  readonly binding: NativeOwnerClaimBinding;
  /** The connection/audit-token identity the live request arrived on. */
  readonly expectedConnectionId: string;
  readonly nowMs: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Derive the stable exchange-connection identity for a request binding. The
 * consumer supplies this as `expectedConnectionId`, and the native-boundary
 * resolver stamps the SAME value into `evidence.acceptedConnectionId`, so a
 * capability minted for one exchange can never be consumed against another
 * (connection substitution → refused). It is an identity string, not a secret.
 */
export function deriveNativeOwnerExchangeConnectionId(binding: NativeOwnerClaimBinding): string {
  return [
    binding.hubId,
    binding.installId,
    binding.origin,
    binding.channel,
    binding.action,
    binding.deviceId,
    binding.devicePublicKeyHash,
    binding.nonce,
  ].join(" ");
}

/** Brand check — the ONLY way to recognize a genuine minted capability. */
export function isVerifiedNativeOwnerClaimContext(
  value: unknown,
): value is VerifiedNativeOwnerClaimContext {
  return (
    typeof value === "object"
    && value !== null
    && (value as Record<PropertyKey, unknown>)[OWNER_CLAIM_CONTEXT_BRAND] === true
  );
}

function bindingsMatch(a: NativeOwnerClaimBinding, b: NativeOwnerClaimBinding): boolean {
  return (
    a.hubId === b.hubId
    && a.installId === b.installId
    && a.osUser === b.osUser
    && a.origin === b.origin
    && a.channel === b.channel
    && a.action === b.action
    && a.nonce === b.nonce
    && a.expiresAtMs === b.expiresAtMs
    && a.deviceId === b.deviceId
    && a.devicePublicKeyHash === b.devicePublicKeyHash
    && a.artifactRole === b.artifactRole
  );
}

/**
 * Verify + atomically consume (single-use) an opaque capability against the live
 * request. Returns `{ ok: true, keyProtection }` IFF the value is a genuine minted
 * capability (brand), the kill switch is off, it has not already been consumed, it
 * is unexpired, its frozen binding EXACT-matches the request-derived expectation,
 * the accepted-connection identity matches the live connection, and its key
 * protection is still release-trusted. On the FIRST success the capability is
 * marked consumed (single-use). ANY other outcome — absent/forged, killed, replayed,
 * expired, field drift (wrong hub/install/owner/origin/channel/action/nonce/device/
 * key/role), connection substitution, or a capability minted for a DIFFERENT
 * request — returns `{ ok: false }`, so the caller performs ZERO state change.
 *
 * Single-use marking happens only on full success, so a caller that verifies inside
 * a DB transaction which then rolls back has NOT burned the capability's ledger for
 * a legitimate retry (the authoritative single-use gate for the DB flows remains the
 * server-issued nonce CAS; this ledger is defence-in-depth against re-presenting the
 * exact same capability object twice).
 */
export function consumeVerifiedNativeOwnerClaimContext(
  capability: unknown,
  expectation: NativeOwnerClaimConsumeExpectation,
): NativeOwnerClaimConsumeResult {
  if (!isVerifiedNativeOwnerClaimContext(capability)) {
    return { ok: false, reason: "no-capability" };
  }
  if (isDeviceOwnerAuthorityKillSwitchEngaged(expectation.env ?? process.env)) {
    return { ok: false, reason: "kill-switch-engaged" };
  }
  if (consumedCapabilities.has(capability)) {
    return { ok: false, reason: "already-consumed" };
  }
  if (
    !isPositiveSafeInteger(capability.binding.expiresAtMs)
    || capability.binding.expiresAtMs <= expectation.nowMs
  ) {
    return { ok: false, reason: "expired" };
  }
  if (!bindingsMatch(capability.binding, expectation.binding)) {
    return { ok: false, reason: "binding-drift" };
  }
  if (
    !nonBlank(expectation.expectedConnectionId)
    || capability.evidence.acceptedConnectionId !== expectation.expectedConnectionId
  ) {
    return { ok: false, reason: "connection-substituted" };
  }
  if (!isReleaseTrustedKeyProtection(capability.keyProtection)) {
    return { ok: false, reason: "key-protection-not-release-trusted" };
  }

  consumedCapabilities.add(capability);
  return { ok: true, keyProtection: capability.keyProtection };
}

// ─── Resolver seam (the native-IPC exchange) ───────────────────────────────

/**
 * The seam by which claim/login OBTAIN a capability for the live request. In
 * production this is backed by the macOS Companion Unix-socket accept boundary: it
 * reads LOCAL_PEERCRED, runs the CR-4 verifier + pinned policy, and exchanges the
 * result for a single-use capability bound to THIS request. On this source/dev/CI
 * tree the native boundary is honestly ABSENT, so the default resolver returns
 * `null` (see {@link createAbsentNativeOwnerClaimResolver}) and every device
 * claim/login fails closed — nothing global authorizes.
 */
export type NativeOwnerClaimContextResolver = (
  binding: NativeOwnerClaimBinding,
) => VerifiedNativeOwnerClaimContext | null;

/**
 * The DEFAULT resolver on this tree: no native IPC boundary is wired, so it mints
 * NOTHING. This is the honest, fail-closed state — a device owner-claim/login is
 * refused with ZERO state change until a signed release wires a real
 * peercred+codesign accept boundary (the external leaf).
 */
export function createAbsentNativeOwnerClaimResolver(): NativeOwnerClaimContextResolver {
  return (_binding: NativeOwnerClaimBinding): VerifiedNativeOwnerClaimContext | null => null;
}
