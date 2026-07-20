// ─── SEC-APPROVAL-AUTHORITY-001 · CORE-A CR-2 ───
//
// Proof of the device-authored provider-approval PoP verifier + the UI⇄server
// canonical encoder byte-match. Every keypair/signature here is a SOFTWARE dev
// key; it drives the REAL production verifier through positive + adversarial paths.

import { describe, it, expect } from "vitest";

import {
  createFridayProviderApprovalPoPVerifier,
  encodeProviderApprovalTranscript as serverEncode,
} from "../../../../../src/api/auth/device-attest/index.js";
import type { ProviderApprovalTranscript } from "../../../../../src/api/auth/device-attest/index.js";
import {
  createWebCryptoDeviceKeyProvider,
  deviceOwnerPrincipalId,
  encodeProviderApprovalTranscript as uiEncode,
  type ProviderApprovalTranscript as UiProviderApprovalTranscript,
} from "../../../../../ui/src/lib/auth/device-key.js";
import {
  generateTestDeviceKey,
  makeApprovalProof,
  makeApprovalTranscript,
  makeHighSApprovalProof,
} from "../../../../helpers/friday-provider-approval-test-kit.js";

const NOW_MS = Date.parse("2026-07-20T00:00:00.000Z");
const ACTION_DIGEST = "a".repeat(64);

describe("device-authored provider-approval PoP verifier", () => {
  const verifier = createFridayProviderApprovalPoPVerifier();

  // ── Encoder byte-match (UI signs what the server verifies) ──

  it("the UI canonical encoder is byte-identical to the server encoder", () => {
    const key = generateTestDeviceKey();
    const t = makeApprovalTranscript(key, { actionDigest: ACTION_DIGEST });
    const ui = Buffer.from(uiEncode(t as unknown as UiProviderApprovalTranscript));
    const server = serverEncode(t);
    expect(ui.equals(server)).toBe(true);
  });

  it("a WebCrypto (UI) signature verifies against the real server verifier", async () => {
    const provider = createWebCryptoDeviceKeyProvider();
    const key = await provider.getOrCreateDeviceKey();
    const transcript: UiProviderApprovalTranscript = {
      transcriptVersion: "friday-provider-approval-v1",
      algorithm: "ECDSA_P256_SHA256",
      kind: "provider_mutation_approval",
      approvalId: "approval-ui-1",
      actionDigest: ACTION_DIGEST,
      decidedByPrincipalId: deviceOwnerPrincipalId(key.devicePublicKeyHash),
      expiresAt: "2999-01-01T00:00:00.000Z",
      devicePublicKeyHash: key.devicePublicKeyHash,
    };
    const signature = await provider.signApprovalTranscript(transcript);
    const result = verifier.verifyPossession({
      transcript: transcript as unknown as ProviderApprovalTranscript,
      devicePublicKey: { encoding: "spki-der-base64", value: key.devicePublicKeySpkiBase64 },
      signature,
      nowMs: NOW_MS,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actionDigest).toBe(ACTION_DIGEST);
      expect(result.devicePublicKeyHash).toBe(key.devicePublicKeyHash);
    }
  });

  // ── Positive ──

  it("verifies a well-formed device proof and returns the bound fields", () => {
    const key = generateTestDeviceKey();
    const transcript = makeApprovalTranscript(key, { actionDigest: ACTION_DIGEST });
    const proof = makeApprovalProof(key, transcript);
    const result = verifier.verifyPossession({ ...proof, nowMs: NOW_MS });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actionDigest).toBe(ACTION_DIGEST);
      expect(result.decidedByPrincipalId).toBe(transcript.decidedByPrincipalId);
      expect(result.devicePublicKeyHash).toBe(key.publicKeyHash);
      expect(result.expiresAt).toBe(transcript.expiresAt);
    }
  });

  // ── Adversarial negatives ──

  it("rejects an unsupported transcript version", () => {
    const key = generateTestDeviceKey();
    const transcript = makeApprovalTranscript(key, { actionDigest: ACTION_DIGEST }, {
      transcriptVersion: "friday-provider-approval-v2" as ProviderApprovalTranscript["transcriptVersion"],
    });
    const proof = makeApprovalProof(key, transcript);
    const result = verifier.verifyPossession({ ...proof, nowMs: NOW_MS });
    expect(result).toMatchObject({ ok: false, reason: "unsupported_transcript_version" });
  });

  it("rejects an unsupported algorithm (bound INTO the transcript)", () => {
    const key = generateTestDeviceKey();
    const transcript = makeApprovalTranscript(key, { actionDigest: ACTION_DIGEST }, {
      algorithm: "RSA_PSS_SHA256" as ProviderApprovalTranscript["algorithm"],
    });
    const proof = makeApprovalProof(key, transcript);
    const result = verifier.verifyPossession({ ...proof, nowMs: NOW_MS });
    expect(result).toMatchObject({ ok: false, reason: "unsupported_algorithm" });
  });

  it("rejects a malformed transcript (missing actionDigest)", () => {
    const key = generateTestDeviceKey();
    const transcript = makeApprovalTranscript(key, { actionDigest: ACTION_DIGEST }, { actionDigest: "" });
    const proof = makeApprovalProof(key, transcript);
    const result = verifier.verifyPossession({ ...proof, nowMs: NOW_MS });
    expect(result).toMatchObject({ ok: false, reason: "malformed_transcript" });
  });

  it("rejects an EXPIRED transcript", () => {
    const key = generateTestDeviceKey();
    const transcript = makeApprovalTranscript(key, {
      actionDigest: ACTION_DIGEST,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const proof = makeApprovalProof(key, transcript);
    const result = verifier.verifyPossession({ ...proof, nowMs: NOW_MS });
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  it("rejects a public-key-hash mismatch (transcript bound to a different key)", () => {
    const key = generateTestDeviceKey();
    const other = generateTestDeviceKey();
    const transcript = makeApprovalTranscript(key, { actionDigest: ACTION_DIGEST }, {
      devicePublicKeyHash: other.publicKeyHash,
    });
    // Sign with `key` (whose hash the transcript now lies about) and present `key`.
    const proof = makeApprovalProof(key, transcript);
    const result = verifier.verifyPossession({ ...proof, nowMs: NOW_MS });
    expect(result).toMatchObject({ ok: false, reason: "public_key_hash_mismatch" });
  });

  it("rejects a high-S (malleable) signature", () => {
    const key = generateTestDeviceKey();
    const transcript = makeApprovalTranscript(key, { actionDigest: ACTION_DIGEST });
    const proof = makeHighSApprovalProof(key, transcript);
    const result = verifier.verifyPossession({ ...proof, nowMs: NOW_MS });
    expect(result).toMatchObject({ ok: false, reason: "non_canonical_signature" });
  });

  it("rejects a signature over a DIFFERENT action digest (sign A, present B)", () => {
    const key = generateTestDeviceKey();
    const signedTranscript = makeApprovalTranscript(key, { actionDigest: ACTION_DIGEST });
    const presentedTranscript = { ...signedTranscript, actionDigest: "b".repeat(64) };
    // Sign the A-transcript bytes but present the B-transcript.
    const proof = makeApprovalProof(key, signedTranscript);
    const result = verifier.verifyPossession({
      transcript: presentedTranscript,
      devicePublicKey: proof.devicePublicKey,
      signature: proof.signature,
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a proof signed by a DIFFERENT device than the one presented", () => {
    const owner = generateTestDeviceKey();
    const attacker = generateTestDeviceKey();
    const transcript = makeApprovalTranscript(owner, { actionDigest: ACTION_DIGEST });
    // Sign with the attacker key but present the owner's public key + hash.
    const proof = makeApprovalProof(attacker, transcript, owner);
    const result = verifier.verifyPossession({ ...proof, nowMs: NOW_MS });
    expect(result).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });
});
