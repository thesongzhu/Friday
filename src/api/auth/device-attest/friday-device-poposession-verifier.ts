// ─── SEC-SETUP-BOOTSTRAP-001 · Slice 2a ───
//
// Production server-side proof-of-possession verifier for the device-bound
// owner-claim transcript. Crypto is delegated ENTIRELY to Node's built-in
// `node:crypto` (KeyObject + crypto.verify) — there is no hand-rolled EC math.
//
// This module verifies signature + possession only. It NEVER asserts key
// protection, NEVER grants owner authority, and NEVER mutates state. See the
// types file for the full scope contract.

import { verify as cryptoVerify, type KeyObject } from "node:crypto";
import {
  ALLOWED_ALGORITHMS,
  ALLOWED_TRANSCRIPT_VERSIONS,
  canonicalDevicePublicKeyHash,
  decodeFlexibleBase64,
  encodeOwnerClaimTranscript,
  importPresentedPublicKey,
  isLowS,
  isP256PublicKey,
  OWNER_CLAIM_ALGORITHM,
  OWNER_CLAIM_KIND,
  ownerClaimTranscriptDigestHex,
  parseCanonicalP1363Signature,
} from "./friday-owner-claim-transcript.js";
import type {
  FridayOwnerClaimPoPVerifier,
  OwnerClaimPoPFailure,
  OwnerClaimPoPResult,
  OwnerClaimPresentationResult,
  OwnerClaimTranscript,
  VerifyOwnerClaimPossessionInput,
  VerifyOwnerClaimPresentationInput,
} from "./friday-owner-claim-transcript.types.js";

function reject(
  reason: OwnerClaimPoPFailure["reason"],
  detail?: string,
): OwnerClaimPoPFailure {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

// ─── Required-field structural validation ───

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Return the name of the first required transcript field that is missing/empty,
 * or null when all are present. Fields are checked EXPLICITLY (no dynamic
 * indexing) so the required set is auditable and lint-clean.
 */
function firstMissingField(transcript: OwnerClaimTranscript): string | null {
  if (!isNonEmptyString(transcript.hubId)) return "hubId";
  if (!isNonEmptyString(transcript.installId)) return "installId";
  if (!isNonEmptyString(transcript.osUser)) return "osUser";
  if (!isNonEmptyString(transcript.deviceId)) return "deviceId";
  if (!isNonEmptyString(transcript.action)) return "action";
  if (!isNonEmptyString(transcript.origin)) return "origin";
  if (!isNonEmptyString(transcript.channel)) return "channel";
  if (!isNonEmptyString(transcript.nonce)) return "nonce";
  if (!isNonEmptyString(transcript.expiresAt)) return "expiresAt";
  if (!isNonEmptyString(transcript.devicePublicKeyHash)) return "devicePublicKeyHash";
  return null;
}

// ─── Verification pipeline ───

function verifyPossession(
  input: VerifyOwnerClaimPossessionInput,
): OwnerClaimPoPResult {
  const { transcript, devicePublicKey, signature, nowMs } = input;

  // 1. Transcript-version allowlist.
  if (!ALLOWED_TRANSCRIPT_VERSIONS.has(transcript.transcriptVersion)) {
    return reject("unsupported_transcript_version", String(transcript.transcriptVersion));
  }

  // 2. Algorithm allowlist (bound INTO the transcript, so substitution changes bytes).
  if (!ALLOWED_ALGORITHMS.has(transcript.algorithm)) {
    return reject("unsupported_algorithm", String(transcript.algorithm));
  }

  // 3. Kind discriminator + required non-empty fields.
  if (transcript.kind !== OWNER_CLAIM_KIND) {
    return reject("malformed_transcript", "kind");
  }
  const missing = firstMissingField(transcript);
  if (missing) {
    return reject("malformed_transcript", missing);
  }

  // 4. Freshness / expiry (bound in the transcript).
  const expiryMs = Date.parse(transcript.expiresAt);
  if (Number.isNaN(expiryMs)) {
    return reject("malformed_transcript", "expiresAt");
  }
  if (!Number.isFinite(nowMs)) {
    return reject("expired", "invalid-clock");
  }
  if (nowMs >= expiryMs) {
    return reject("expired");
  }

  // 5. Import + curve-check the presented public key.
  let key: KeyObject;
  try {
    key = importPresentedPublicKey(devicePublicKey);
  } catch (err) {
    return reject("invalid_public_key", err instanceof Error ? err.name : "import-failed");
  }
  if (!isP256PublicKey(key)) {
    return reject("unsupported_key", "expected-prime256v1");
  }

  // 6. Bind the transcript's public-key hash to the ACTUAL presented key.
  const actualKeyHash = canonicalDevicePublicKeyHash(key);
  if (actualKeyHash !== transcript.devicePublicKeyHash) {
    return reject("public_key_hash_mismatch");
  }

  // 7. Decode + structurally validate the signature (canonical raw P-1363 only).
  let sigBytes: Buffer;
  try {
    sigBytes = decodeFlexibleBase64(signature.value);
  } catch {
    return reject("malformed_signature", "undecodable");
  }
  const parsed = parseCanonicalP1363Signature(sigBytes);
  if (!parsed) {
    return reject("malformed_signature", "expected-64-byte-raw-in-range");
  }

  // 8. Malleability: enforce low-S canonical form (reject high-S twin).
  if (!isLowS(parsed.s)) {
    return reject("non_canonical_signature", "high-s");
  }

  // 9. Cryptographic ECDSA verification over the canonical transcript bytes.
  const canonicalBytes = encodeOwnerClaimTranscript(transcript);
  let cryptoValid: boolean;
  try {
    cryptoValid = cryptoVerify(
      "sha256",
      canonicalBytes,
      { key, dsaEncoding: "ieee-p1363" },
      parsed.raw,
    );
  } catch (err) {
    return reject("signature_mismatch", err instanceof Error ? err.name : "verify-error");
  }
  if (!cryptoValid) {
    return reject("signature_mismatch");
  }

  // Possession proven. keyProtection is ALWAYS "unverified" — protection is
  // NEVER inferred from a successful signature or from the key type.
  return {
    ok: true,
    keyProtection: "unverified",
    algorithm: OWNER_CLAIM_ALGORITHM,
    transcriptVersion: transcript.transcriptVersion,
    transcriptDigestHex: ownerClaimTranscriptDigestHex(transcript),
    devicePublicKeyHash: actualKeyHash,
  };
}

// ─── Factory (stable seam) ───

export function createFridayOwnerClaimPoPVerifier(): FridayOwnerClaimPoPVerifier {
  return { verifyPossession };
}

// ─── Composed presentation seam (S3 integration plug-point) ───
//
// Composes the single-use nonce guard with possession verification into the
// result S3 wires into the auth service (with the DB-backed nonce repository).
//
// Ordering rationale: possession is verified FIRST (pure, no side effects); the
// nonce is consumed ONLY after possession succeeds — mirroring the atomic
// single-transaction consume+bind of the production nonce repository, where a
// failed claim leaves the nonce un-burned. A replayed VALID presentation is
// still rejected because the second consume returns "replayed".
export function verifyOwnerClaimPresentation(
  input: VerifyOwnerClaimPresentationInput,
): OwnerClaimPresentationResult {
  const { verifier, nonceConsumer, ...possessionInput } = input;

  const possession = verifier.verifyPossession(possessionInput);
  if (!possession.ok) {
    return { ok: false, reason: possession.reason, ...(possession.detail !== undefined ? { detail: possession.detail } : {}) };
  }

  const outcome = nonceConsumer.consume(possessionInput.transcript.nonce);
  if (outcome === "replayed") {
    return { ok: false, reason: "nonce_replayed" };
  }

  return { ...possession, nonceConsumed: true };
}
