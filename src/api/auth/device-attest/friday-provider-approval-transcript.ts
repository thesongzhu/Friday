// ─── SEC-APPROVAL-AUTHORITY-001 · CORE-A CR-2 ───
//
// Canonical device-authored provider-approval transcript encoding + P-256
// proof-of-possession verifier.
//
// The encoding is a DETERMINISTIC, length-prefixed binary framing with a fixed
// field order and a domain-separation prefix (distinct from the owner-claim
// domain, so a signature over one transcript kind can never be replayed as the
// other). All EC math is delegated to Node's `crypto.verify` — there is no
// hand-rolled curve arithmetic; the low-level parsing/hashing/curve-check
// primitives are REUSED from the owner-claim module.
//
// This module verifies signature + possession + transcript-field binding ONLY.
// It NEVER asserts key protection, NEVER grants owner authority, NEVER mutates
// state, and NEVER binds the transcript to the request/owner — the mutating-action
// gate + confirm route do that with the returned verified fields.

import { createHash, verify as cryptoVerify, type KeyObject } from "node:crypto";

import {
  canonicalDevicePublicKeyHash,
  decodeFlexibleBase64,
  importPresentedPublicKey,
  isLowS,
  isP256PublicKey,
  parseCanonicalP1363Signature,
} from "./friday-owner-claim-transcript.js";
import type {
  FridayProviderApprovalPoPVerifier,
  ProviderApprovalPoPFailure,
  ProviderApprovalPoPResult,
  ProviderApprovalSignatureAlgorithm,
  ProviderApprovalTranscript,
  ProviderApprovalTranscriptVersion,
  VerifyProviderApprovalPossessionInput,
} from "./friday-provider-approval-transcript.types.js";

// ─── Allowlists (value constants) ───

export const PROVIDER_APPROVAL_TRANSCRIPT_VERSION: ProviderApprovalTranscriptVersion =
  "friday-provider-approval-v1";

export const PROVIDER_APPROVAL_ALGORITHM: ProviderApprovalSignatureAlgorithm =
  "ECDSA_P256_SHA256";

export const PROVIDER_APPROVAL_ALLOWED_TRANSCRIPT_VERSIONS: ReadonlySet<string> =
  new Set([PROVIDER_APPROVAL_TRANSCRIPT_VERSION]);

export const PROVIDER_APPROVAL_ALLOWED_ALGORITHMS: ReadonlySet<string> = new Set([
  PROVIDER_APPROVAL_ALGORITHM,
]);

/** Fixed claim-kind discriminator that MUST appear in every transcript. */
export const PROVIDER_APPROVAL_KIND = "provider_mutation_approval" as const;

// ─── Domain separation (distinct from the owner-claim domain) ───

const TRANSCRIPT_DOMAIN = "friday.provider-approval.transcript";

// ─── Canonical encoding ───

function lengthPrefixed(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([prefix, body]);
}

/**
 * Deterministically encode a transcript to its canonical bytes:
 * `LP(domain) ‖ LP(field_0) ‖ … ‖ LP(field_n)` where LP(x) = u32be(len) ‖ utf8(x).
 *
 * The field order below is part of the wire contract and MUST NOT be reordered
 * without bumping the transcript version. Fields are listed EXPLICITLY (no dynamic
 * property access) so the exact signed layout is auditable at a glance. The UI
 * device-key encoder mirrors this byte-for-byte (asserted by a cross-encoder test).
 */
export function encodeProviderApprovalTranscript(
  transcript: ProviderApprovalTranscript,
): Buffer {
  return Buffer.concat([
    lengthPrefixed(TRANSCRIPT_DOMAIN),
    lengthPrefixed(transcript.transcriptVersion),
    lengthPrefixed(transcript.algorithm),
    lengthPrefixed(transcript.kind),
    lengthPrefixed(transcript.approvalId),
    lengthPrefixed(transcript.actionDigest),
    lengthPrefixed(transcript.decidedByPrincipalId),
    lengthPrefixed(transcript.expiresAt),
    lengthPrefixed(transcript.devicePublicKeyHash),
  ]);
}

/** SHA-256 hex digest of the canonical transcript bytes. */
export function providerApprovalTranscriptDigestHex(
  transcript: ProviderApprovalTranscript,
): string {
  return createHash("sha256")
    .update(encodeProviderApprovalTranscript(transcript))
    .digest("hex");
}

// ─── Verification pipeline ───

function reject(
  reason: ProviderApprovalPoPFailure["reason"],
  detail?: string,
): ProviderApprovalPoPFailure {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Return the name of the first required transcript field that is missing/empty,
 * or null when all are present. Checked EXPLICITLY (no dynamic indexing).
 */
function firstMissingField(transcript: ProviderApprovalTranscript): string | null {
  if (!isNonEmptyString(transcript.approvalId)) return "approvalId";
  if (!isNonEmptyString(transcript.actionDigest)) return "actionDigest";
  if (!isNonEmptyString(transcript.decidedByPrincipalId)) return "decidedByPrincipalId";
  if (!isNonEmptyString(transcript.expiresAt)) return "expiresAt";
  if (!isNonEmptyString(transcript.devicePublicKeyHash)) return "devicePublicKeyHash";
  return null;
}

function verifyPossession(
  input: VerifyProviderApprovalPossessionInput,
): ProviderApprovalPoPResult {
  const { transcript, devicePublicKey, signature, nowMs } = input;

  // 1. Transcript-version allowlist.
  if (!PROVIDER_APPROVAL_ALLOWED_TRANSCRIPT_VERSIONS.has(transcript.transcriptVersion)) {
    return reject("unsupported_transcript_version", String(transcript.transcriptVersion));
  }

  // 2. Algorithm allowlist (bound INTO the transcript, so substitution changes bytes).
  if (!PROVIDER_APPROVAL_ALLOWED_ALGORITHMS.has(transcript.algorithm)) {
    return reject("unsupported_algorithm", String(transcript.algorithm));
  }

  // 3. Kind discriminator + required non-empty fields.
  if (transcript.kind !== PROVIDER_APPROVAL_KIND) {
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
  const canonicalBytes = encodeProviderApprovalTranscript(transcript);
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

  // Possession proven. The caller binds actionDigest/owner/device to the request.
  return {
    ok: true,
    algorithm: PROVIDER_APPROVAL_ALGORITHM,
    transcriptVersion: transcript.transcriptVersion,
    transcriptDigestHex: providerApprovalTranscriptDigestHex(transcript),
    devicePublicKeyHash: actualKeyHash,
    approvalId: transcript.approvalId,
    actionDigest: transcript.actionDigest,
    decidedByPrincipalId: transcript.decidedByPrincipalId,
    expiresAt: transcript.expiresAt,
  };
}

// ─── Factory (stable seam) ───

export function createFridayProviderApprovalPoPVerifier(): FridayProviderApprovalPoPVerifier {
  return { verifyPossession };
}
