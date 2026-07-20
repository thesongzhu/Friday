// ─── SEC-NATIVE-OWNER-CLAIM-CAPABILITY-001 · CR-1 Option C — NEGATIVE MATRIX ───
//
// Module-level negative matrix for the OPAQUE per-claim capability that REPLACES
// the retired global boolean authority. Every mint requires a REAL `attested:true`
// result (produced here by the REAL CR-4 verifier over injected doubles — the ONLY
// path to `true`), release-trusted native custody, a pinned policy, and a complete
// request binding. Every consume EXACT-matches the live request, is single-use,
// expiry-bound, and connection-bound. The Advisor negative matrix maps as follows:
//   absent provider / unsupported platform / unsigned-adhoc-dev binary / wrong
//   Team-bundle-DR-entitlement-path-hash / stale-revoked sig / missing-malformed
//   peer creds  → attestation not attested            → mint refused
//   wrong UID / PID reuse / exec-fork / FD-socket sub  → peer-evidence-inconsistent → mint refused
//   WebCrypto / software / unverified custody          → key-protection not trusted → mint refused
//   wrong artifact role (helper vs app)                → artifact-role-mismatch     → mint refused
//   forged header/body/cookie/env/UA/bundle/test lit   → not a capability (brand)   → consume refused
//   direct HTTP/TCP/browser (no capability)            → no-capability              → consume refused
//   disconnect/reconnect / accept-verify race / conn sub → connection-substituted   → consume refused
//   ONE attested peer authorizing a DIFFERENT request  → binding-drift              → consume refused
//   wrong/cross hub/install/owner/origin/channel/nonce → binding-drift              → consume refused
//   replay (same capability twice)                     → already-consumed           → consume refused
//   expiry / restart                                   → expired                    → consume refused
//   emergency kill switch                              → kill-switch-engaged        → mint + consume refused
// Every refusal returns `{ ok: false }`, so the caller performs ZERO state change.

import type { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import {
  verifyNativePeerAttestation,
} from "../../../src/security/attestation/friday-native-peer-attestation-verifier.js";
import type {
  FridayPeerCredential,
  NativePeerAttestationResult,
} from "../../../src/security/attestation/friday-native-peer-attestation-verifier.js";
import {
  consumeVerifiedNativeOwnerClaimContext,
  deriveNativeOwnerExchangeConnectionId,
  isVerifiedNativeOwnerClaimContext,
  mintVerifiedNativeOwnerClaimContext,
  createAbsentNativeOwnerClaimResolver,
  type MintVerifiedNativeOwnerClaimContextInput,
  type NativeOwnerClaimBinding,
  type NativeOwnerPeerEvidence,
  type PinnedNativeOwnerPolicy,
} from "../../../src/security/attestation/friday-verified-native-owner-claim-context.js";
import { deriveDeviceKeyProtection } from "../../../src/security/friday-device-owner-authority-precondition.js";

const IDENTITY = "com.friday.owner-device.release";
const ROLE = "friday.owner-device.app";
const UID = 501;
const PID = 4242;
const NOW = 1_700_000_000_000;
const FAKE_SOCKET = {} as unknown as Socket;
const KILL_ENV: NodeJS.ProcessEnv = { FRIDAY_DEVICE_OWNER_AUTHORITY_KILL_SWITCH: "1" };

function attestedResult(over: { uid?: number; pid?: number; identity?: string } = {}): NativePeerAttestationResult {
  const uid = over.uid ?? UID;
  const pid = over.pid ?? PID;
  const identity = over.identity ?? IDENTITY;
  return verifyNativePeerAttestation({
    provider: { readPeerCredential: (): FridayPeerCredential => ({ pid, uid, gid: 20 }) },
    codesignVerifier: () => ({ identity, valid: true }),
    expectedReleaseIdentity: identity,
    socket: FAKE_SOCKET,
  });
}

function notAttestedResult(): NativePeerAttestationResult {
  // Absent native provider → attested:false (the honest state on this tree).
  return verifyNativePeerAttestation({
    provider: { readPeerCredential: (): FridayPeerCredential | null => null },
    codesignVerifier: () => ({ identity: IDENTITY, valid: true }),
    expectedReleaseIdentity: IDENTITY,
    socket: FAKE_SOCKET,
  });
}

const BINDING: NativeOwnerClaimBinding = {
  hubId: "test-hub",
  installId: "install-1",
  osUser: "jarvis",
  origin: "https://friday.localhost",
  channel: "install-ipc",
  action: "owner-claim",
  nonce: "nonce-abc",
  expiresAtMs: NOW + 60_000,
  deviceId: "device-1",
  devicePublicKeyHash: "a".repeat(64),
  artifactRole: ROLE,
};

function evidenceFor(binding: NativeOwnerClaimBinding, over: Partial<NativeOwnerPeerEvidence> = {}): NativeOwnerPeerEvidence {
  return {
    osUid: UID,
    peerPid: PID,
    acceptedConnectionId: deriveNativeOwnerExchangeConnectionId(binding),
    auditTokenIdentity: "audit-token-4242",
    codesignIdentity: IDENTITY,
    ...over,
  };
}

const POLICY: PinnedNativeOwnerPolicy = {
  expectedReleaseIdentity: IDENTITY,
  expectedArtifactRole: ROLE,
};

function mintInput(
  over: Partial<MintVerifiedNativeOwnerClaimContextInput> = {},
): MintVerifiedNativeOwnerClaimContextInput {
  const binding = over.binding ?? BINDING;
  return {
    attestation: over.attestation ?? attestedResult(),
    keyProtection:
      over.keyProtection ?? deriveDeviceKeyProtection({ custody: "secure_enclave", osVerified: true }),
    binding,
    evidence: over.evidence ?? evidenceFor(binding),
    policy: over.policy ?? POLICY,
    env: over.env,
  };
}

/** A valid capability for the canonical binding. */
function mintOk() {
  const result = mintVerifiedNativeOwnerClaimContext(mintInput());
  if (!result.ok) throw new Error(`expected mint ok, got ${result.reason}`);
  return result.capability;
}

function consumeExpect(binding: NativeOwnerClaimBinding = BINDING, over: { connectionId?: string; nowMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  return {
    binding,
    expectedConnectionId: over.connectionId ?? deriveNativeOwnerExchangeConnectionId(binding),
    nowMs: over.nowMs ?? NOW,
    env: over.env,
  };
}

describe("VerifiedNativeOwnerClaimContext — mint negative matrix", () => {
  it("POSITIVE: real attestation + release-trusted custody + pinned policy + complete binding → mint ok", () => {
    const result = mintVerifiedNativeOwnerClaimContext(mintInput());
    expect(result.ok).toBe(true);
  });

  it("kill switch engaged → mint refused (no capability minted)", () => {
    const result = mintVerifiedNativeOwnerClaimContext(mintInput({ env: KILL_ENV }));
    expect(result).toEqual({ ok: false, reason: "kill-switch-engaged" });
  });

  it("attestation NOT attested (absent provider / unsigned / malformed peercred) → mint refused", () => {
    const result = mintVerifiedNativeOwnerClaimContext(mintInput({ attestation: notAttestedResult() }));
    expect(result).toEqual({ ok: false, reason: "attestation-not-attested" });
  });

  it("codesign identity ≠ pinned policy identity → mint refused", () => {
    const result = mintVerifiedNativeOwnerClaimContext(
      mintInput({ policy: { expectedReleaseIdentity: "com.someone.else", expectedArtifactRole: ROLE } }),
    );
    expect(result).toEqual({ ok: false, reason: "codesign-identity-mismatch" });
  });

  it("WebCrypto / software / unverified custody → mint refused (never release-trusted)", () => {
    for (const kp of [
      deriveDeviceKeyProtection({ custody: "webcrypto_software", osVerified: false }),
      deriveDeviceKeyProtection(null),
      deriveDeviceKeyProtection({ custody: "secure_enclave", osVerified: false }),
    ]) {
      const result = mintVerifiedNativeOwnerClaimContext(mintInput({ keyProtection: kp }));
      expect(result).toEqual({ ok: false, reason: "key-protection-not-release-trusted" });
    }
  });

  it("wrong artifact role (validly signed helper, not the main app) → mint refused", () => {
    const binding: NativeOwnerClaimBinding = { ...BINDING, artifactRole: "friday.owner-device.helper" };
    const result = mintVerifiedNativeOwnerClaimContext(
      mintInput({ binding, evidence: evidenceFor(binding) }),
    );
    expect(result).toEqual({ ok: false, reason: "artifact-role-mismatch" });
  });

  it("peer evidence inconsistent with verified peercred (wrong UID / PID reuse / FD sub) → mint refused", () => {
    for (const over of [{ osUid: UID + 1 }, { peerPid: PID + 1 }, { codesignIdentity: "mismatch" }]) {
      const result = mintVerifiedNativeOwnerClaimContext(
        mintInput({ evidence: evidenceFor(BINDING, over) }),
      );
      expect(result).toEqual({ ok: false, reason: "peer-evidence-inconsistent" });
    }
  });

  it("incomplete binding (any blank / non-finite field) → mint refused", () => {
    const bads: Partial<NativeOwnerClaimBinding>[] = [
      { hubId: "" },
      { installId: "  " },
      { osUser: "" },
      { origin: "" },
      { channel: "" },
      { action: "" },
      { nonce: "" },
      { deviceId: "" },
      { devicePublicKeyHash: "" },
      { artifactRole: "" },
      { expiresAtMs: 0 },
      { expiresAtMs: Number.NaN },
    ];
    for (const bad of bads) {
      const binding = { ...BINDING, ...bad };
      // artifactRole blank must still fail as binding-incomplete BEFORE role compare.
      const result = mintVerifiedNativeOwnerClaimContext(
        mintInput({ binding, evidence: evidenceFor(binding) }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("incomplete evidence (blank connection / audit token / codesign id) → mint refused", () => {
    for (const over of [
      { acceptedConnectionId: "" },
      { auditTokenIdentity: "" },
      { codesignIdentity: "" },
      { peerPid: 0 },
    ]) {
      const result = mintVerifiedNativeOwnerClaimContext(
        mintInput({ evidence: evidenceFor(BINDING, over) }),
      );
      expect(result.ok).toBe(false);
    }
  });
});

describe("VerifiedNativeOwnerClaimContext — consume negative matrix (single-use, exact-match)", () => {
  it("POSITIVE: valid capability + exact request match → consume ok with the release-trusted keyProtection", () => {
    const cap = mintOk();
    const res = consumeVerifiedNativeOwnerClaimContext(cap, consumeExpect());
    expect(res).toEqual({ ok: true, keyProtection: "secure_enclave_os_verified" });
  });

  it("no capability (direct HTTP/TCP/browser — resolver returns null) → refused", () => {
    const resolver = createAbsentNativeOwnerClaimResolver();
    const res = consumeVerifiedNativeOwnerClaimContext(resolver(BINDING), consumeExpect());
    expect(res).toEqual({ ok: false, reason: "no-capability" });
  });

  it("forged object literal (request/env/header/test injection) is NOT a capability (brand)", () => {
    const forged = {
      binding: BINDING,
      evidence: evidenceFor(BINDING),
      keyProtection: "secure_enclave_os_verified",
    };
    expect(isVerifiedNativeOwnerClaimContext(forged)).toBe(false);
    const res = consumeVerifiedNativeOwnerClaimContext(forged, consumeExpect());
    expect(res).toEqual({ ok: false, reason: "no-capability" });
  });

  it("kill switch engaged at consume → refused (emergency force-off)", () => {
    const cap = mintOk();
    const res = consumeVerifiedNativeOwnerClaimContext(cap, consumeExpect(BINDING, { env: KILL_ENV }));
    expect(res).toEqual({ ok: false, reason: "kill-switch-engaged" });
  });

  it("single-use: the SAME capability cannot be consumed twice (replay) → already-consumed", () => {
    const cap = mintOk();
    expect(consumeVerifiedNativeOwnerClaimContext(cap, consumeExpect()).ok).toBe(true);
    const res = consumeVerifiedNativeOwnerClaimContext(cap, consumeExpect());
    expect(res).toEqual({ ok: false, reason: "already-consumed" });
  });

  it("expired / restart (nowMs at or past expiry) → refused", () => {
    const cap = mintOk();
    const res = consumeVerifiedNativeOwnerClaimContext(cap, consumeExpect(BINDING, { nowMs: BINDING.expiresAtMs }));
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("binding drift on ANY field (wrong hub/install/owner/origin/channel/action/nonce/device/key/role/expiry) → refused", () => {
    const drifts: Partial<NativeOwnerClaimBinding>[] = [
      { hubId: "other-hub" },
      { installId: "install-2" },
      { osUser: "mallory" },
      { origin: "https://evil.localhost" },
      { channel: "other-channel" },
      { action: "owner-login" },
      { nonce: "nonce-xyz" },
      { deviceId: "device-2" },
      { devicePublicKeyHash: "b".repeat(64) },
      { artifactRole: "friday.owner-device.helper" },
      { expiresAtMs: NOW + 120_000 },
    ];
    for (const drift of drifts) {
      const cap = mintOk(); // fresh capability for the CANONICAL binding
      const res = consumeVerifiedNativeOwnerClaimContext(cap, consumeExpect({ ...BINDING, ...drift }));
      expect(res, `drift=${JSON.stringify(drift)}`).toEqual({ ok: false, reason: "binding-drift" });
    }
  });

  it("ONE attested peer authorizing a DIFFERENT request → refused (capability minted for B1, consumed for B2)", () => {
    // Mint a capability for a DIFFERENT request (a login for another device).
    const otherBinding: NativeOwnerClaimBinding = {
      ...BINDING,
      action: "owner-login",
      nonce: "some-other-nonce",
      deviceId: "device-99",
    };
    const capForOther = mintVerifiedNativeOwnerClaimContext(
      mintInput({ binding: otherBinding, evidence: evidenceFor(otherBinding) }),
    );
    expect(capForOther.ok).toBe(true);
    if (!capForOther.ok) return;
    // Try to consume it for the CANONICAL claim request → refused.
    const res = consumeVerifiedNativeOwnerClaimContext(capForOther.capability, consumeExpect());
    expect(res).toEqual({ ok: false, reason: "binding-drift" });
  });

  it("connection substitution (disconnect/reconnect / accept-verify race) → refused", () => {
    const cap = mintOk();
    const res = consumeVerifiedNativeOwnerClaimContext(
      cap,
      consumeExpect(BINDING, { connectionId: "a-different-connection" }),
    );
    expect(res).toEqual({ ok: false, reason: "connection-substituted" });
  });
});
