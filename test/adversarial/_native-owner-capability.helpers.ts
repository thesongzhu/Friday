// ─── CR-1 Option C — test helpers: REAL native-owner capability resolvers ───
//
// These helpers mint a GENUINE `VerifiedNativeOwnerClaimContext` by running the
// REAL CR-4 peer-attestation verifier + the REAL capability mint over INJECTED
// native-evidence doubles (a peercred provider double + a codesign verifier
// double), exactly as a signed-release/native slice supplies the real native
// provider + a valid codesign check. This is NOT a forge: the capability brand
// means the ONLY way to obtain a valid capability is this real mint, which REQUIRES
// `attested: true` — there is no env / request / header path to it. Flipping a
// double to a failing state (wrong identity, absent provider, unverified codesign,
// software custody, …) yields NO capability, so the negative matrix is exercised
// through the same real pipeline.

import type { Socket } from "node:net";

import {
  verifyNativePeerAttestation,
} from "../../src/security/attestation/friday-native-peer-attestation-verifier.js";
import type {
  FridayPeerCredential,
} from "../../src/security/attestation/friday-native-peer-attestation-verifier.js";
import {
  deriveNativeOwnerExchangeConnectionId,
  mintVerifiedNativeOwnerClaimContext,
  type NativeOwnerClaimBinding,
  type NativeOwnerClaimContextResolver,
  type VerifiedNativeOwnerClaimContext,
} from "../../src/security/attestation/friday-verified-native-owner-claim-context.js";
import {
  deriveDeviceKeyProtection,
  type NativeKeyCustodyKind,
} from "../../src/security/friday-device-owner-authority-precondition.js";

/** MUST match the auth-service pinned constants (OWNER_DEVICE_ARTIFACT_ROLE). */
export const TEST_OWNER_ARTIFACT_ROLE = "friday.owner-device.app";
export const TEST_OWNER_RELEASE_IDENTITY = "com.friday.owner-device.release";
export const TEST_PEER_UID = 501;
export const TEST_PEER_PID = 4242;

export interface TestNativeOwnerCapabilityOverrides {
  readonly uid?: number;
  readonly pid?: number;
  /** The code-sign identity BOTH the attestation and the pinned policy carry. */
  readonly identity?: string;
  /** A DIFFERENT expected identity to pin (identity-mismatch negative). */
  readonly policyIdentity?: string;
  readonly artifactRole?: string;
  readonly policyArtifactRole?: string;
  readonly custody?: NativeKeyCustodyKind;
  /** Force a non-OS-verified custody (software/dev). */
  readonly osUnverified?: boolean;
  /** Stamp a DIFFERENT accepted connection id (connection-substitution negative). */
  readonly connectionId?: string;
  /** Make the composed attestation NOT attested (absent provider). */
  readonly providerAbsent?: boolean;
  /** Make the codesign check unverified (null). */
  readonly codesignUnverified?: boolean;
  /** Make the codesign check invalid. */
  readonly codesignInvalid?: boolean;
  /** Engage the emergency kill switch for the mint. */
  readonly env?: NodeJS.ProcessEnv;
}

const FAKE_SOCKET = {} as unknown as Socket;

/**
 * Mint a genuine capability for `binding` from injected native doubles, or return
 * `null` if the (possibly-degraded) doubles do not attest / the mint refuses.
 */
export function mintTestNativeOwnerCapability(
  binding: NativeOwnerClaimBinding,
  over: TestNativeOwnerCapabilityOverrides = {},
): VerifiedNativeOwnerClaimContext | null {
  const uid = over.uid ?? TEST_PEER_UID;
  const pid = over.pid ?? TEST_PEER_PID;
  const identity = over.identity ?? TEST_OWNER_RELEASE_IDENTITY;

  const attestation = verifyNativePeerAttestation({
    provider: {
      readPeerCredential(): FridayPeerCredential | null {
        return over.providerAbsent === true ? null : { pid, uid, gid: 20 };
      },
    },
    codesignVerifier: () => {
      if (over.codesignUnverified === true) return null;
      return { identity, valid: over.codesignInvalid !== true };
    },
    expectedReleaseIdentity: identity,
    socket: FAKE_SOCKET,
  });

  const custody: NativeKeyCustodyKind = over.custody ?? "secure_enclave";
  const keyProtection = deriveDeviceKeyProtection({
    custody,
    osVerified: over.osUnverified !== true && custody !== "webcrypto_software",
  });

  const result = mintVerifiedNativeOwnerClaimContext({
    attestation,
    keyProtection,
    binding,
    evidence: {
      osUid: uid,
      peerPid: pid,
      acceptedConnectionId: over.connectionId ?? deriveNativeOwnerExchangeConnectionId(binding),
      auditTokenIdentity: `audit-token-${pid}`,
      codesignIdentity: identity,
    },
    policy: {
      expectedReleaseIdentity: over.policyIdentity ?? identity,
      expectedArtifactRole: over.policyArtifactRole ?? over.artifactRole ?? binding.artifactRole,
    },
    env: over.env,
  });
  return result.ok ? result.capability : null;
}

/**
 * A resolver that mints a genuine capability for the exact request binding it is
 * given. This is what the auth-service consumes; it is the SAME shape a signed
 * release supplies from the Companion Unix-socket accept boundary.
 */
export function createTestNativeOwnerResolver(
  over: TestNativeOwnerCapabilityOverrides = {},
): NativeOwnerClaimContextResolver {
  return (binding) => mintTestNativeOwnerCapability(binding, over);
}

/**
 * A resolver that mints a capability bound to a FIXED (foreign) binding, IGNORING
 * the request's binding — used to prove "one attested peer authorizing a DIFFERENT
 * request" is refused (binding drift → zero state change).
 */
export function createForeignBindingNativeOwnerResolver(
  foreignBinding: NativeOwnerClaimBinding,
  over: TestNativeOwnerCapabilityOverrides = {},
): NativeOwnerClaimContextResolver {
  return () => mintTestNativeOwnerCapability(foreignBinding, over);
}
