// ─── SEC-NATIVE-KEY-CUSTODY-001 · CORE-A CR-1 (Advisor Option C, finding #4) ───
//
// The SEAM for durable native device-key custody: native P-256 key generation +
// signing whose private key lives in the Secure Enclave (or, where the Enclave is
// unavailable, a Keychain ACL-guarded key), attested by the OS. This module holds
// the PROVIDER INTERFACE and the honest-absent defaults; the actual Secure-Enclave
// binding activates ONLY on a signed release running on a physical device — that is
// the EXTERNAL leaf (EXT-MAC-PHYSICAL-INSTALL-LIFECYCLE-001), honest-false/absent
// on this dev/CI tree.
//
// `deriveDeviceKeyProtection` (in the authority-precondition module) CONSUMES the
// evidence this provider yields. A WebCrypto/browser key is a NEGATIVE/dev seam
// only: it yields `webcrypto_software` custody, which can NEVER be release-trusted.

import type {
  FridayDeviceKeyProtection,
  NativeKeyCustodyEvidence,
} from "../friday-device-owner-authority-precondition.js";
import { deriveDeviceKeyProtection } from "../friday-device-owner-authority-precondition.js";

/**
 * A durable native key-custody provider. `attestCustody` returns OS-vouched
 * evidence about where the device signing key lives, or `null` when no native
 * custody is available (unsigned/dev/CI). It NEVER fabricates a hardware posture.
 */
export interface NativeKeyCustodyProvider {
  /** The device public key (SPKI-DER, base64) whose custody is being attested. */
  attestCustody(devicePublicKeyHash: string): NativeKeyCustodyEvidence | null;
}

/**
 * The DEFAULT provider on this source/dev/CI tree: no native custody bridge is
 * installed, so it yields `null` → `deriveDeviceKeyProtection` returns
 * `"unverified"` (fails closed). We NEVER fabricate a Secure-Enclave label.
 */
export function createAbsentNativeKeyCustodyProvider(): NativeKeyCustodyProvider {
  return {
    attestCustody(_devicePublicKeyHash: string): NativeKeyCustodyEvidence | null {
      return null;
    },
  };
}

/**
 * The WebCrypto/browser dev seam. It reports `webcrypto_software` custody, which
 * `deriveDeviceKeyProtection` maps to `"software_dev_only"` — NEVER release-trusted.
 * This exists only so a non-release/dev profile can exercise the device flows with
 * a software key; it must NEVER be wired on a release profile (the caller gates it
 * on `!isFridayCanonicalGateProtectedProfile(env)`).
 */
export function createWebCryptoDevKeyCustodyProvider(): NativeKeyCustodyProvider {
  return {
    attestCustody(_devicePublicKeyHash: string): NativeKeyCustodyEvidence | null {
      // Honest dev posture: a software key the OS did NOT vouch for.
      return { custody: "webcrypto_software", osVerified: false };
    },
  };
}

/**
 * The macOS Secure-Enclave custody provider SEAM (release residual — NOT wired,
 * NOT the default). On this dev/CI tree there is no Secure Enclave binding and no
 * signed release, so it honestly yields `null` (→ `"unverified"`). The real
 * SecKeyCreateRandomKey(kSecAttrTokenIDSecureEnclave) + LAContext ACL binding is
 * the physical external leaf; this function is where a signed release plugs it in.
 * It never fabricates an OS-verified posture on an unsigned/dev tree.
 */
export function createMacosSecureEnclaveKeyCustodyProvider(): NativeKeyCustodyProvider {
  return {
    attestCustody(_devicePublicKeyHash: string): NativeKeyCustodyEvidence | null {
      // No Secure Enclave binding is reachable from this dev/CI process — a signed
      // release on a physical device replaces this body with a real SecKey +
      // LAContext attestation. Until then: honestly absent (fails closed).
      return null;
    },
  };
}

/**
 * Convenience: resolve the release keyProtection posture from a provider by
 * consuming its evidence. Absent custody → `"unverified"` (fails closed).
 */
export function resolveDeviceKeyProtection(
  provider: NativeKeyCustodyProvider,
  devicePublicKeyHash: string,
): FridayDeviceKeyProtection {
  return deriveDeviceKeyProtection(provider.attestCustody(devicePublicKeyHash));
}
