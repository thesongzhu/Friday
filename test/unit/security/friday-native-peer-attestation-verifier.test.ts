// ─── SEC-NATIVE-PEER-ATTESTATION-001 · CORE-A CR-1 (SLICE 4) — VERIFIER SEAM (RED-FIRST) ───
//
// A signed release proves the connecting UI peer is the genuine owner device by
// (a) reading the AF_UNIX peer's kernel-vouched credential (LOCAL_PEERCRED) and
// (b) verifying that peer binary's code signature equals the expected release
// identity. This suite drives the STANDALONE verifier seam through injected test
// doubles — the ONLY path to `attested:true`. It NEVER wires the seam into any
// live socket path and NEVER flips the operator-locked honesty anchor
// `NATIVE_IPC_ATTESTATION_AVAILABLE` (asserted still-false below).
//
// TRUTH LABEL: this dev/CI source tree has NO native LOCAL_PEERCRED addon and is
// UNSIGNED, so the DEFAULT provider + DEFAULT codesign verifier both yield
// nothing → the verifier is honestly `attested:false` here. The `true` branch is
// reachable ONLY via injected doubles, exactly as a signed-release/native slice
// would supply the real provider + a valid codesign check.

import { readFileSync } from "node:fs";
import type { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { NATIVE_IPC_ATTESTATION_AVAILABLE } from "../../../src/security/friday-device-owner-authority-precondition.js";
import {
  NATIVE_PEER_ATTESTATION_REASON,
  createAbsentCodesignPeerVerifier,
  createAbsentNativePeerAttestationProvider,
  createMacosCodesignPeerVerifier,
  verifyNativePeerAttestation,
} from "../../../src/security/attestation/friday-native-peer-attestation-verifier.js";
import type {
  CodesignPeerVerifier,
  FridayCodesignIdentity,
  FridayPeerCredential,
  NativePeerAttestationProvider,
} from "../../../src/security/attestation/friday-native-peer-attestation-verifier.js";

const EXPECTED_IDENTITY = "com.friday.owner-device.release";
// A fake socket handle — the pure verifier only forwards it to the provider.
const FAKE_SOCKET = {} as unknown as Socket;

/** Inject a provider that yields a fixed peer credential (or a thrown error). */
function providerYielding(
  cred: FridayPeerCredential | null,
  opts: { throwErr?: boolean } = {},
): NativePeerAttestationProvider {
  return {
    readPeerCredential(): FridayPeerCredential | null {
      if (opts.throwErr) {
        throw new Error("simulated native provider read failure");
      }
      return cred;
    },
  };
}

/** Inject a codesign verifier that returns a fixed result (or throws). */
function codesignYielding(
  result: FridayCodesignIdentity | null,
  opts: { throwErr?: boolean } = {},
): CodesignPeerVerifier {
  return (_pid: number): FridayCodesignIdentity | null => {
    if (opts.throwErr) {
      throw new Error("simulated codesign verify failure");
    }
    return result;
  };
}

const GOOD_CRED: FridayPeerCredential = { pid: 4242, uid: 501, gid: 20 };

describe("FridayNativePeerAttestationVerifier", () => {
  // ── HONESTY ANCHOR (read-only; NEVER flipped) ─────────────────────────────
  it("HONESTY: NATIVE_IPC_ATTESTATION_AVAILABLE remains false (anchor untouched)", () => {
    expect(NATIVE_IPC_ATTESTATION_AVAILABLE).toBe(false);
  });

  // ── DEFAULTS on this source/dev/CI tree are honestly empty ────────────────
  it("DEFAULT native provider returns null (no LOCAL_PEERCRED addon installed)", () => {
    const provider = createAbsentNativePeerAttestationProvider();
    expect(provider.readPeerCredential(FAKE_SOCKET)).toBeNull();
  });

  it("DEFAULT codesign verifier returns null (unsigned dev/CI build)", () => {
    const verifier = createAbsentCodesignPeerVerifier();
    expect(verifier(GOOD_CRED.pid)).toBeNull();
  });

  it("DEFAULTS composed → attested:false NATIVE_PROVIDER_ABSENT (honest-false here)", () => {
    const result = verifyNativePeerAttestation({
      provider: createAbsentNativePeerAttestationProvider(),
      codesignVerifier: createAbsentCodesignPeerVerifier(),
      expectedReleaseIdentity: EXPECTED_IDENTITY,
      socket: FAKE_SOCKET,
    });
    expect(result.attested).toBe(false);
    expect(result.reason).toBe(NATIVE_PEER_ATTESTATION_REASON.NATIVE_PROVIDER_ABSENT);
  });

  // ── NEGATIVE MATRIX ───────────────────────────────────────────────────────
  it("native provider absent → attested:false NATIVE_PROVIDER_ABSENT", () => {
    const result = verifyNativePeerAttestation({
      provider: providerYielding(null),
      codesignVerifier: codesignYielding({ identity: EXPECTED_IDENTITY, valid: true }),
      expectedReleaseIdentity: EXPECTED_IDENTITY,
      socket: FAKE_SOCKET,
    });
    expect(result.attested).toBe(false);
    expect(result.reason).toBe(NATIVE_PEER_ATTESTATION_REASON.NATIVE_PROVIDER_ABSENT);
    expect(result.codesignIdentity).toBeUndefined();
  });

  it("peer credential present but codesign UNVERIFIED (null) → attested:false CODESIGN_UNVERIFIED", () => {
    const result = verifyNativePeerAttestation({
      provider: providerYielding(GOOD_CRED),
      codesignVerifier: codesignYielding(null),
      expectedReleaseIdentity: EXPECTED_IDENTITY,
      socket: FAKE_SOCKET,
    });
    expect(result.attested).toBe(false);
    expect(result.reason).toBe(NATIVE_PEER_ATTESTATION_REASON.CODESIGN_UNVERIFIED);
    expect(result.peerCredential).toEqual(GOOD_CRED);
  });

  it("peer credential present but codesign INVALID → attested:false CODESIGN_INVALID", () => {
    const result = verifyNativePeerAttestation({
      provider: providerYielding(GOOD_CRED),
      codesignVerifier: codesignYielding({ identity: EXPECTED_IDENTITY, valid: false }),
      expectedReleaseIdentity: EXPECTED_IDENTITY,
      socket: FAKE_SOCKET,
    });
    expect(result.attested).toBe(false);
    expect(result.reason).toBe(NATIVE_PEER_ATTESTATION_REASON.CODESIGN_INVALID);
  });

  it("codesign valid but identity ≠ expected → attested:false CODESIGN_IDENTITY_MISMATCH", () => {
    const result = verifyNativePeerAttestation({
      provider: providerYielding(GOOD_CRED),
      codesignVerifier: codesignYielding({ identity: "com.someone.else.debug", valid: true }),
      expectedReleaseIdentity: EXPECTED_IDENTITY,
      socket: FAKE_SOCKET,
    });
    expect(result.attested).toBe(false);
    expect(result.reason).toBe(NATIVE_PEER_ATTESTATION_REASON.CODESIGN_IDENTITY_MISMATCH);
  });

  it("blank expectedReleaseIdentity fails closed → attested:false EXPECTED_IDENTITY_MISSING", () => {
    const result = verifyNativePeerAttestation({
      provider: providerYielding(GOOD_CRED),
      codesignVerifier: codesignYielding({ identity: "", valid: true }),
      expectedReleaseIdentity: "   ",
      socket: FAKE_SOCKET,
    });
    expect(result.attested).toBe(false);
    expect(result.reason).toBe(NATIVE_PEER_ATTESTATION_REASON.EXPECTED_IDENTITY_MISSING);
  });

  // Malformed / partial peer-credential payloads must be REJECTED, never throw,
  // never coerced into a `true`.
  const MALFORMED: ReadonlyArray<{ label: string; cred: unknown }> = [
    { label: "missing uid", cred: { pid: 4242, gid: 20 } },
    { label: "missing gid", cred: { pid: 4242, uid: 501 } },
    { label: "missing pid", cred: { uid: 501, gid: 20 } },
    { label: "NaN pid", cred: { pid: Number.NaN, uid: 501, gid: 20 } },
    { label: "negative uid", cred: { pid: 4242, uid: -1, gid: 20 } },
    { label: "non-integer pid", cred: { pid: 42.5, uid: 501, gid: 20 } },
    { label: "string pid", cred: { pid: "4242", uid: 501, gid: 20 } },
    { label: "empty object", cred: {} },
  ];
  for (const { label, cred } of MALFORMED) {
    it(`malformed peer credential (${label}) → attested:false MALFORMED_PEER_CREDENTIAL (no throw)`, () => {
      let result!: ReturnType<typeof verifyNativePeerAttestation>;
      expect(() => {
        result = verifyNativePeerAttestation({
          provider: providerYielding(cred as FridayPeerCredential),
          codesignVerifier: codesignYielding({ identity: EXPECTED_IDENTITY, valid: true }),
          expectedReleaseIdentity: EXPECTED_IDENTITY,
          socket: FAKE_SOCKET,
        });
      }).not.toThrow();
      expect(result.attested).toBe(false);
      expect(result.reason).toBe(NATIVE_PEER_ATTESTATION_REASON.MALFORMED_PEER_CREDENTIAL);
    });
  }

  it("provider read throws → attested:false PROVIDER_READ_ERROR (never throws)", () => {
    let result!: ReturnType<typeof verifyNativePeerAttestation>;
    expect(() => {
      result = verifyNativePeerAttestation({
        provider: providerYielding(null, { throwErr: true }),
        codesignVerifier: codesignYielding({ identity: EXPECTED_IDENTITY, valid: true }),
        expectedReleaseIdentity: EXPECTED_IDENTITY,
        socket: FAKE_SOCKET,
      });
    }).not.toThrow();
    expect(result.attested).toBe(false);
    expect(result.reason).toBe(NATIVE_PEER_ATTESTATION_REASON.PROVIDER_READ_ERROR);
  });

  it("codesign verifier throws → attested:false CODESIGN_VERIFY_ERROR (never throws)", () => {
    let result!: ReturnType<typeof verifyNativePeerAttestation>;
    expect(() => {
      result = verifyNativePeerAttestation({
        provider: providerYielding(GOOD_CRED),
        codesignVerifier: codesignYielding(null, { throwErr: true }),
        expectedReleaseIdentity: EXPECTED_IDENTITY,
        socket: FAKE_SOCKET,
      });
    }).not.toThrow();
    expect(result.attested).toBe(false);
    expect(result.reason).toBe(NATIVE_PEER_ATTESTATION_REASON.CODESIGN_VERIFY_ERROR);
  });

  // ── THE ONLY PATH TO true — real peercred + valid codesign + matching id ──
  it("ONLY real peercred + valid codesign + matching identity (injected) → attested:true", () => {
    const result = verifyNativePeerAttestation({
      provider: providerYielding(GOOD_CRED),
      codesignVerifier: codesignYielding({ identity: EXPECTED_IDENTITY, valid: true }),
      expectedReleaseIdentity: EXPECTED_IDENTITY,
      socket: FAKE_SOCKET,
    });
    expect(result.attested).toBe(true);
    expect(result.reason).toBe(NATIVE_PEER_ATTESTATION_REASON.ATTESTED);
    expect(result.peerCredential).toEqual(GOOD_CRED);
    expect(result.codesignIdentity).toBe(EXPECTED_IDENTITY);
  });

  // ── VERIFY-ONLY: the module holds NO signing key and NO secret ─────────────
  it("holds no key/secret — module source imports no node:crypto and has no signing primitive", () => {
    const source = readFileSync(
      new URL(
        "../../../src/security/attestation/friday-native-peer-attestation-verifier.ts",
        import.meta.url,
      ),
      "utf8",
    );
    // No secret/key custody: verify-only. (Note: "codesign" intentionally allowed.)
    expect(source).not.toMatch(/["']node:crypto["']/);
    expect(source).not.toMatch(/\bcreateHmac\b/);
    expect(source).not.toMatch(/\bcreateSign\b/);
    expect(source).not.toMatch(/\bcreateHash\b/);
    expect(source).not.toMatch(/\bprivateKey\b/);
    expect(source).not.toMatch(/\btokenSecret\b/);
    expect(source).not.toMatch(/\bKeyObject\b/);
  });

  // ── LIVE honest-false proof on this real, unsigned dev machine (darwin) ────
  // The macOS codesign verifier is REAL (shells to codesign) but is NOT wired to
  // any socket path and is NOT the default. Against the current process with a
  // bogus expected identity, the composed verifier MUST stay attested:false —
  // proving it can never fabricate a pass on an unsigned/foreign-identity peer.
  it.skipIf(process.platform !== "darwin")(
    "LIVE (darwin): macOS codesign verifier never fabricates a pass on this build",
    () => {
      const livePid = process.pid;
      const macosCodesign = createMacosCodesignPeerVerifier();
      const liveProvider: NativePeerAttestationProvider = {
        readPeerCredential(): FridayPeerCredential {
          return {
            pid: livePid,
            uid: typeof process.getuid === "function" ? process.getuid() : 0,
            gid: typeof process.getgid === "function" ? process.getgid() : 0,
          };
        },
      };
      const result = verifyNativePeerAttestation({
        provider: liveProvider,
        codesignVerifier: macosCodesign,
        expectedReleaseIdentity: "com.friday.owner-device.release.BOGUS-NEVER-MATCHES",
        socket: FAKE_SOCKET,
      });
      expect(result.attested).toBe(false);
    },
  );
});
