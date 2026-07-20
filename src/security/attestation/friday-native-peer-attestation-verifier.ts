// ─── SEC-NATIVE-PEER-ATTESTATION-001 · CORE-A CR-1 (SLICE 4) — VERIFIER SEAM ───
//
// PREREQUISITE for the native-IPC caller-identity precondition (Advisor #1628,
// finding #1). A SIGNED release proves the connecting UI peer is the genuine
// owner device by checking TWO kernel/OS-vouched facts about the AF_UNIX peer on
// the other end of the local socket:
//
//   (a) the peer's process credential (LOCAL_PEERCRED: pid/uid/gid), read from
//       the kernel — NOT self-reported by the caller, and
//   (b) that peer binary's code signature, verified by the OS to be VALID and to
//       carry EXACTLY the expected release signing identity.
//
// This module is PURE VERIFY. It holds NO signing key and NO secret: it mints no
// identity, issues no token, and imports no crypto. Durable owner-key custody
// (Secure Enclave) is a PHYSICAL operator leaf that lives elsewhere; here we only
// *check a connecting peer*. There is deliberately NO import of `node:crypto`.
//
// HONESTY on this dev/CI SOURCE tree:
//   - Node's `net` layer exposes no `getsockopt(LOCAL_PEERCRED)`, so a genuine
//     peer-credential read needs a native addon that is NOT present here. The
//     DEFAULT provider therefore returns `null` → the verifier is honestly
//     `attested:false, reason:NATIVE_PROVIDER_ABSENT`. We NEVER fabricate a
//     peercred value.
//   - This tree is UNSIGNED, so the DEFAULT codesign verifier returns `null`; a
//     signed release wires `createMacosCodesignPeerVerifier` instead.
//   - Consequently `attested:true` is UNREACHABLE on source/dev/CI. It becomes
//     reachable ONLY when a real native provider AND a valid, identity-matching
//     codesign verifier are BOTH supplied (a signed-release/native slice) — and
//     is exercised in tests solely through injected doubles.
//
// This seam is standalone. It does NOT flip, shadow, wire, or depend on the
// operator-locked honesty anchor
// `src/security/friday-device-owner-authority-precondition.ts` →
// `NATIVE_IPC_ATTESTATION_AVAILABLE`. Wiring is a pending operator decision.

import { spawnSync } from "node:child_process";
import type { Socket } from "node:net";

// ─── Public value objects ─────────────────────────────────────────────────

/**
 * Kernel-vouched credential of the connecting AF_UNIX peer (LOCAL_PEERCRED).
 * Every field is a non-negative safe integer supplied by the OS — NOT a value
 * the peer self-reports over the wire.
 */
export interface FridayPeerCredential {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

/**
 * Result of an OS code-signature check on the peer binary.
 *   - `valid`    — the OS confirmed the signature is intact and trusted.
 *   - `identity` — the peer binary's signing identity (e.g. its code-sign
 *                  Identifier / designated-requirement id) that must equal the
 *                  expected release identity.
 */
export interface FridayCodesignIdentity {
  readonly identity: string;
  readonly valid: boolean;
}

/**
 * Reads the connecting peer's kernel credential from the socket. On source/dev/CI
 * the DEFAULT implementation returns `null` (no native addon) — see
 * `createAbsentNativePeerAttestationProvider`. A signed release installs a native
 * provider that performs a real `getsockopt(LOCAL_PEERCRED)`.
 */
export interface NativePeerAttestationProvider {
  readPeerCredential(socket: Socket): FridayPeerCredential | null;
}

/**
 * Verifies the code signature of the peer identified by `pid`. Returns `null`
 * when the check cannot be performed (unsigned/dev build, no toolchain). NEVER
 * returns `{ valid: true }` for an unsigned or foreign-identity peer.
 */
export type CodesignPeerVerifier = (pid: number) => FridayCodesignIdentity | null;

// ─── Reason codes ─────────────────────────────────────────────────────────

/**
 * Every terminal outcome of {@link verifyNativePeerAttestation}. Exactly one —
 * `ATTESTED` — accompanies `attested:true`; all others accompany `false`.
 */
export const NATIVE_PEER_ATTESTATION_REASON = {
  /** The one success reason: real peercred + valid codesign + matching identity. */
  ATTESTED: "ATTESTED",
  /** No native LOCAL_PEERCRED provider yielded a credential (default on this tree). */
  NATIVE_PROVIDER_ABSENT: "NATIVE_PROVIDER_ABSENT",
  /** The provider threw while reading the peer credential. */
  PROVIDER_READ_ERROR: "PROVIDER_READ_ERROR",
  /** The peer credential was partial/ill-typed (missing or non-integer field). */
  MALFORMED_PEER_CREDENTIAL: "MALFORMED_PEER_CREDENTIAL",
  /** Caller supplied a blank expected release identity — fail closed. */
  EXPECTED_IDENTITY_MISSING: "EXPECTED_IDENTITY_MISSING",
  /** Codesign check could not run (unsigned/dev build, no toolchain) → null. */
  CODESIGN_UNVERIFIED: "CODESIGN_UNVERIFIED",
  /** Codesign ran but the signature is not valid. */
  CODESIGN_INVALID: "CODESIGN_INVALID",
  /** Codesign is valid but its identity ≠ the expected release identity. */
  CODESIGN_IDENTITY_MISMATCH: "CODESIGN_IDENTITY_MISMATCH",
  /** The codesign verifier threw. */
  CODESIGN_VERIFY_ERROR: "CODESIGN_VERIFY_ERROR",
} as const;

export type NativePeerAttestationReason =
  (typeof NATIVE_PEER_ATTESTATION_REASON)[keyof typeof NATIVE_PEER_ATTESTATION_REASON];

// ─── Verify contract ──────────────────────────────────────────────────────

export interface VerifyNativePeerAttestationInput {
  /** Reads the peer's kernel credential (LOCAL_PEERCRED). */
  readonly provider: NativePeerAttestationProvider;
  /** Verifies the peer binary's code signature. */
  readonly codesignVerifier: CodesignPeerVerifier;
  /** The signing identity a genuine owner-device release binary must carry. */
  readonly expectedReleaseIdentity: string;
  /** The connecting local socket (forwarded to the provider only). */
  readonly socket: Socket;
}

export interface NativePeerAttestationResult {
  /** True IFF real peercred AND valid codesign AND identity === expected. */
  readonly attested: boolean;
  readonly reason: NativePeerAttestationReason;
  /** Present once a well-formed peer credential was read. */
  readonly peerCredential?: FridayPeerCredential;
  /** Present once codesign produced an identity (attested or mismatched). */
  readonly codesignIdentity?: string;
}

function isValidPeerCredential(value: unknown): value is FridayPeerCredential {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const cred = value as Record<string, unknown>;
  return (
    isNonNegativeSafeInteger(cred.pid)
    && cred.pid > 0
    && isNonNegativeSafeInteger(cred.uid)
    && isNonNegativeSafeInteger(cred.gid)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function deny(
  reason: NativePeerAttestationReason,
  extra?: { peerCredential?: FridayPeerCredential; codesignIdentity?: string },
): NativePeerAttestationResult {
  return { attested: false, reason, ...extra };
}

/**
 * PURE verify. Returns `attested:true` ONLY when ALL hold:
 *   1. the native provider yields a well-formed peer credential,
 *   2. the codesign verifier confirms `valid === true`, and
 *   3. that codesign identity equals a non-blank `expectedReleaseIdentity`.
 *
 * Anything else — absent provider, malformed payload, provider/verifier throw,
 * unverified/invalid codesign, identity mismatch, blank expected identity —
 * yields `attested:false` with a precise reason. It NEVER throws and NEVER
 * coerces a failure into `true`. It holds no key and mints no identity.
 */
export function verifyNativePeerAttestation(
  input: VerifyNativePeerAttestationInput,
): NativePeerAttestationResult {
  const { provider, codesignVerifier, expectedReleaseIdentity, socket } = input;

  // Fail closed on a blank expected identity — there is nothing to match against.
  if (typeof expectedReleaseIdentity !== "string" || expectedReleaseIdentity.trim() === "") {
    return deny(NATIVE_PEER_ATTESTATION_REASON.EXPECTED_IDENTITY_MISSING);
  }

  // (a) Read the kernel-vouched peer credential.
  let rawCred: FridayPeerCredential | null;
  try {
    rawCred = provider.readPeerCredential(socket);
  } catch {
    return deny(NATIVE_PEER_ATTESTATION_REASON.PROVIDER_READ_ERROR);
  }
  if (rawCred === null || rawCred === undefined) {
    return deny(NATIVE_PEER_ATTESTATION_REASON.NATIVE_PROVIDER_ABSENT);
  }
  if (!isValidPeerCredential(rawCred)) {
    return deny(NATIVE_PEER_ATTESTATION_REASON.MALFORMED_PEER_CREDENTIAL);
  }
  const peerCredential: FridayPeerCredential = {
    pid: rawCred.pid,
    uid: rawCred.uid,
    gid: rawCred.gid,
  };

  // (b) Verify the peer binary's code signature.
  let codesign: FridayCodesignIdentity | null;
  try {
    codesign = codesignVerifier(peerCredential.pid);
  } catch {
    return deny(NATIVE_PEER_ATTESTATION_REASON.CODESIGN_VERIFY_ERROR, { peerCredential });
  }
  if (codesign === null || codesign === undefined) {
    return deny(NATIVE_PEER_ATTESTATION_REASON.CODESIGN_UNVERIFIED, { peerCredential });
  }
  if (codesign.valid !== true) {
    return deny(NATIVE_PEER_ATTESTATION_REASON.CODESIGN_INVALID, {
      peerCredential,
      codesignIdentity: codesign.identity,
    });
  }
  if (codesign.identity !== expectedReleaseIdentity) {
    return deny(NATIVE_PEER_ATTESTATION_REASON.CODESIGN_IDENTITY_MISMATCH, {
      peerCredential,
      codesignIdentity: codesign.identity,
    });
  }

  // All three facts hold — the peer is the genuine, expected owner-device binary.
  return {
    attested: true,
    reason: NATIVE_PEER_ATTESTATION_REASON.ATTESTED,
    peerCredential,
    codesignIdentity: codesign.identity,
  };
}

// ─── DEFAULT (honest-absent) implementations for source/dev/CI ─────────────

/**
 * The DEFAULT native provider on this tree. Returns `null` because Node's `net`
 * layer exposes no `getsockopt(LOCAL_PEERCRED)` and no native addon is installed
 * — so the verifier is honestly `attested:false, reason:NATIVE_PROVIDER_ABSENT`.
 * We NEVER fabricate a peercred value. A signed release installs a real provider.
 */
export function createAbsentNativePeerAttestationProvider(): NativePeerAttestationProvider {
  return {
    readPeerCredential(_socket: Socket): FridayPeerCredential | null {
      // No native LOCAL_PEERCRED addon present → honestly no credential.
      return null;
    },
  };
}

/**
 * The DEFAULT codesign verifier on this tree. Returns `null` because this source
 * build is UNSIGNED — there is no valid signature to check. A signed release
 * wires {@link createMacosCodesignPeerVerifier} instead.
 */
export function createAbsentCodesignPeerVerifier(): CodesignPeerVerifier {
  return (_pid: number): FridayCodesignIdentity | null => null;
}

// ─── Real macOS codesign verifier (release residual — NOT wired, NOT default) ─

export interface MacosCodesignPeerVerifierOptions {
  /** Path to the `codesign` binary. Default `/usr/bin/codesign`. */
  readonly codesignPath?: string;
  /** Path to the `ps` binary (peer pid → executable path). Default `/bin/ps`. */
  readonly psPath?: string;
  /** Hard timeout for each shelled command, in ms. Default 4000. */
  readonly timeoutMs?: number;
}

/** Extract the `Identifier=…` line from `codesign -dvvv` (printed to stderr). */
function parseCodesignIdentifier(codesignDisplayOutput: string): string | null {
  const match = /^Identifier=(.+)$/m.exec(codesignDisplayOutput);
  if (match === null) {
    return null;
  }
  const identity = match[1].trim();
  return identity.length > 0 ? identity : null;
}

/**
 * A REAL macOS codesign verifier that a SIGNED release would wire in place of the
 * absent default. It resolves the peer's executable from its pid (`ps -o comm=`)
 * and asks the OS to verify the code signature (`codesign --verify --strict`) and
 * report its signing identifier (`codesign -dvvv`).
 *
 * It is deliberately NOT the default and is NOT wired to any live socket path in
 * this slice. It never throws (returns `null` on any error) and can only return
 * `{ valid: true }` when the OS itself confirms a valid signature — so on this
 * UNSIGNED dev/CI tree it yields `null`/`{ valid:false }`, keeping the composed
 * verifier honestly `attested:false`. It holds no key: the OS performs the
 * cryptographic verification; this function only reads its verdict.
 */
export function createMacosCodesignPeerVerifier(
  options: MacosCodesignPeerVerifierOptions = {},
): CodesignPeerVerifier {
  const codesignPath = options.codesignPath ?? "/usr/bin/codesign";
  const psPath = options.psPath ?? "/bin/ps";
  const timeoutMs = options.timeoutMs ?? 4_000;

  return (pid: number): FridayCodesignIdentity | null => {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return null;
    }
    try {
      // Resolve the peer's executable path from its pid (BSD `ps` prints the full
      // path with `-o comm=`).
      const ps = spawnSync(psPath, ["-p", String(pid), "-o", "comm="], {
        timeout: timeoutMs,
        encoding: "utf8",
      });
      if (ps.status !== 0 || ps.error) {
        return null;
      }
      const executablePath = (ps.stdout ?? "").trim();
      if (executablePath.length === 0) {
        return null;
      }

      // Ask the OS to verify the signature (strict) — exit 0 iff valid & trusted.
      const verify = spawnSync(codesignPath, ["--verify", "--strict", executablePath], {
        timeout: timeoutMs,
        encoding: "utf8",
      });
      const valid = verify.status === 0 && !verify.error;

      // Read the signing identifier (codesign prints display info to stderr).
      const display = spawnSync(codesignPath, ["-dvvv", executablePath], {
        timeout: timeoutMs,
        encoding: "utf8",
      });
      const identity = parseCodesignIdentifier(display.stderr ?? "");
      if (identity === null) {
        // Unsigned / adhoc / unreadable → no trustworthy identity.
        return { identity: "", valid: false };
      }
      return { identity, valid };
    } catch {
      return null;
    }
  };
}
