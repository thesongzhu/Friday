// ─── SEC-APPROVAL-AUTHORITY-001 · CORE-A CR-2 — device-approval test kit ───
//
// TRUTH LABEL: every keypair + signature here is a SOFTWARE dev/test P-256 key
// generated on the fly with Node crypto. NOT a Secure Enclave key, NOT final
// attestation evidence. It exists ONLY to drive the REAL production verifier +
// gate + confirm route through the device-authored approval model and its
// adversarial negatives. Signing reuses the PRODUCTION canonical encoder
// (`encodeProviderApprovalTranscript`), so the test signs exactly what the Hub
// verifies. It NEVER re-implements ECDSA verification.

import { sign as cryptoSign } from "node:crypto";

import {
  encodeProviderApprovalTranscript,
  PROVIDER_APPROVAL_ALGORITHM,
  PROVIDER_APPROVAL_KIND,
  PROVIDER_APPROVAL_TRANSCRIPT_VERSION,
} from "../../src/api/auth/device-attest/index.js";
import type {
  ProviderApprovalDeviceProof,
  ProviderApprovalTranscript,
} from "../../src/api/auth/device-attest/index.js";
import { deviceOwnerPrincipalId } from "../../src/security/friday-device-owner-authority-precondition.js";
import { generateTestDeviceKey, toHighSTwin, toLowS, type TestDeviceKey } from "../adversarial/_secsetup-s2a.helpers.js";

export { generateTestDeviceKey, toHighSTwin, toLowS };
export type { TestDeviceKey };

/** The device-owner principal id bound to a test device key (device-owner:<hash>). */
export function deviceOwnerPrincipalIdFor(key: TestDeviceKey): string {
  return deviceOwnerPrincipalId(key.publicKeyHash);
}

/** Build a well-formed device-approval transcript bound to `key`, with overrides. */
export function makeApprovalTranscript(
  key: TestDeviceKey,
  input: {
    actionDigest: string;
    decidedByPrincipalId?: string;
    approvalId?: string;
    expiresAt?: string;
  },
  overrides: Partial<ProviderApprovalTranscript> = {},
): ProviderApprovalTranscript {
  return {
    transcriptVersion: PROVIDER_APPROVAL_TRANSCRIPT_VERSION,
    algorithm: PROVIDER_APPROVAL_ALGORITHM,
    kind: PROVIDER_APPROVAL_KIND,
    approvalId: input.approvalId ?? "approval-0001",
    actionDigest: input.actionDigest,
    decidedByPrincipalId: input.decidedByPrincipalId ?? deviceOwnerPrincipalIdFor(key),
    expiresAt: input.expiresAt ?? "2999-01-01T00:00:00.000Z",
    devicePublicKeyHash: key.publicKeyHash,
    ...overrides,
  };
}

/** Raw (un-normalized) P-1363 signature bytes over the canonical transcript. */
export function signApprovalRaw(
  key: TestDeviceKey,
  transcript: ProviderApprovalTranscript,
): Buffer {
  const bytes = encodeProviderApprovalTranscript(transcript);
  return cryptoSign("sha256", Buffer.from(bytes), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
}

/**
 * Build a full device-approval proof (transcript + public key + low-S signature).
 * The `signWith` key may DIFFER from the transcript's bound key so "sign A, present
 * B" attacks are expressible.
 */
export function makeApprovalProof(
  signWith: TestDeviceKey,
  transcript: ProviderApprovalTranscript,
  presentKey: TestDeviceKey = signWith,
): ProviderApprovalDeviceProof {
  const raw = signApprovalRaw(signWith, transcript);
  return {
    transcript,
    devicePublicKey: { encoding: "spki-der-base64", value: presentKey.spkiDerBase64 },
    signature: { encoding: "ieee-p1363-base64", value: toLowS(raw).toString("base64") },
  };
}

/** A high-S (malleable) variant of the proof — the verifier MUST reject it. */
export function makeHighSApprovalProof(
  key: TestDeviceKey,
  transcript: ProviderApprovalTranscript,
): ProviderApprovalDeviceProof {
  const raw = signApprovalRaw(key, transcript);
  return {
    transcript,
    devicePublicKey: { encoding: "spki-der-base64", value: key.spkiDerBase64 },
    signature: { encoding: "ieee-p1363-base64", value: toHighSTwin(raw).toString("base64") },
  };
}
