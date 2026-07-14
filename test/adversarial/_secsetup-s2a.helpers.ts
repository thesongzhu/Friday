// ─── SEC-SETUP-BOOTSTRAP-001 · Slice 2a — test helpers ───
//
// TRUTH LABEL: every keypair and signature produced here is a SOFTWARE
// development / test key generated on the fly with Node crypto. These are NOT
// Secure Enclave keys and NOT final-product attestation evidence. They exist
// solely to drive the REAL production verifier through positive + adversarial
// paths.
//
// Signing reuses the PRODUCTION canonical encoder (`encodeOwnerClaimTranscript`)
// so the test signs exactly what the verifier verifies. The test never
// re-implements ECDSA verification — it only generates keys, signs, and performs
// deterministic signature-scalar manipulations (low-S normalization, high-S
// twin) to exercise the malleability guard.

import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import {
  P256_ORDER_N,
  canonicalDevicePublicKeyHash,
  encodeOwnerClaimTranscript,
} from "../../src/api/auth/device-attest/index.js";
import type {
  OwnerClaimTranscript,
} from "../../src/api/auth/device-attest/index.js";

export interface TestDeviceKey {
  publicKey: KeyObject;
  privateKey: KeyObject;
  /** Canonical SPKI DER of the public key, base64. */
  spkiDerBase64: string;
  /** SHA-256 hex of the canonical SPKI DER. */
  publicKeyHash: string;
}

/** Generate a fresh software P-256 (prime256v1) dev/test keypair. */
export function generateTestDeviceKey(): TestDeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKey,
    privateKey,
    spkiDerBase64: Buffer.from(der).toString("base64"),
    publicKeyHash: canonicalDevicePublicKeyHash(publicKey),
  };
}

/** Build a well-formed base transcript bound to `key`, with optional overrides. */
export function makeTranscript(
  key: TestDeviceKey,
  overrides: Partial<OwnerClaimTranscript> = {},
): OwnerClaimTranscript {
  return {
    transcriptVersion: "friday-owner-claim-v1",
    algorithm: "ECDSA_P256_SHA256",
    kind: "install_owner_claim",
    hubId: "hub-abc",
    installId: "install-123",
    osUser: "jarvis",
    deviceId: "device-xyz",
    action: "owner-claim",
    origin: "https://127.0.0.1:8765",
    channel: "install-ipc",
    nonce: "nonce-0001",
    expiresAt: "2999-01-01T00:00:00.000Z",
    devicePublicKeyHash: key.publicKeyHash,
    ...overrides,
  };
}

function bufToBigInt(buf: Buffer): bigint {
  return buf.byteLength === 0 ? 0n : BigInt("0x" + buf.toString("hex"));
}

function bigIntTo32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

/** Normalize a raw P-1363 signature to canonical low-S form (s ≤ n/2). */
export function toLowS(raw: Buffer): Buffer {
  const r = raw.subarray(0, 32);
  let s = bufToBigInt(raw.subarray(32, 64));
  if (s > P256_ORDER_N >> 1n) s = P256_ORDER_N - s;
  return Buffer.concat([r, bigIntTo32(s)]);
}

/** Produce the high-S malleable twin (s → n − s) of a raw P-1363 signature. */
export function toHighSTwin(raw: Buffer): Buffer {
  const r = raw.subarray(0, 32);
  const s = bufToBigInt(raw.subarray(32, 64));
  return Buffer.concat([r, bigIntTo32(P256_ORDER_N - s)]);
}

/**
 * Sign a transcript over its PRODUCTION canonical bytes, returning a canonical
 * (low-S) raw P-1363 signature as base64. Signs whatever transcript is given, so
 * "sign A, present B" attacks are expressible by signing one and presenting
 * another.
 */
export function signTranscriptLowS(
  key: TestDeviceKey,
  transcript: OwnerClaimTranscript,
): string {
  const bytes = encodeOwnerClaimTranscript(transcript);
  const raw = cryptoSign("sha256", bytes, {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return toLowS(raw).toString("base64");
}

/** Raw (un-normalized) P-1363 signature bytes over a transcript. */
export function signTranscriptRaw(
  key: TestDeviceKey,
  transcript: OwnerClaimTranscript,
): Buffer {
  const bytes = encodeOwnerClaimTranscript(transcript);
  return cryptoSign("sha256", bytes, {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
}

/** DER-encoded (non-canonical for this verifier) signature over a transcript. */
export function signTranscriptDerBase64(
  key: TestDeviceKey,
  transcript: OwnerClaimTranscript,
): string {
  const bytes = encodeOwnerClaimTranscript(transcript);
  const der = cryptoSign("sha256", bytes, {
    key: key.privateKey,
    dsaEncoding: "der",
  });
  return Buffer.from(der).toString("base64");
}
