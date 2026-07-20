// ─── SEC-APPROVAL-AUTHORITY-001 · CORE-A CR-2 ───
//
// Server-side proof-of-possession (PoP) verifier types for the DEVICE-AUTHORED
// provider-mutation approval transcript.
//
// SCOPE (binding): this module verifies a CANONICAL provider-approval transcript
// + a P-256 ECDSA signature over it. It proves the signer holds the private key
// for the presented public key and that the signed transcript binds every
// approval field (approvalId / actionDigest / decidedByPrincipalId / expiry /
// public-key-hash). It does NOT — and MUST NOT — assert key protection, grant
// owner authority, mutate any store, or bind the transcript to the request/owner:
// the CALLER (the mutating-action gate + the confirm route) performs the
// action-digest / owner-device binding after this pure PoP check succeeds.
//
// The Hub holds NO signing key on this path. The approval is authored (signed) by
// the owner's protected device key; the Hub can ONLY verify it with the presented
// PUBLIC key. This is the SEC-APPROVAL-AUTHORITY-001 verify-only Hub contract —
// the symmetric-HMAC "Hub self-sign" minter is removed from the confirm path.

/** The single canonical transcript encoding version accepted by this verifier. */
export type ProviderApprovalTranscriptVersion = "friday-provider-approval-v1";

/**
 * The single canonical signature algorithm: ECDSA over NIST P-256 with SHA-256,
 * IEEE P-1363 fixed-width raw (r‖s) encoding, low-S (canonical) enforced.
 */
export type ProviderApprovalSignatureAlgorithm = "ECDSA_P256_SHA256";

// ─── Canonical transcript fields ───

/**
 * The full set of fields bound by the canonical provider-approval transcript. The
 * signature is computed over the deterministic encoding of ALL of these; a change
 * to ANY field changes the signed bytes and therefore fails verification.
 */
export interface ProviderApprovalTranscript {
  /** Explicit, allow-listed transcript-encoding version. */
  transcriptVersion: ProviderApprovalTranscriptVersion;
  /** Explicit, allow-listed signature algorithm (bound INTO the transcript). */
  algorithm: ProviderApprovalSignatureAlgorithm;
  /** Fixed claim-kind discriminator. */
  kind: "provider_mutation_approval";
  /** Unique id the owner device assigns to this single approval. */
  approvalId: string;
  /**
   * The EXACT mutating-action digest being approved. The gate recomputes this
   * server-side from the request that actually arrives; a drift changes the
   * digest and the signature no longer covers it (fail closed).
   */
  actionDigest: string;
  /**
   * The owner principal that authored the approval. MUST equal the authenticated
   * owner AND (via the device-owner principal id) the hash of the signing key.
   */
  decidedByPrincipalId: string;
  /** Absolute expiry (ISO-8601) after which the approval is stale. */
  expiresAt: string;
  /**
   * SHA-256 hex digest of the canonical SPKI DER of the device public key. The
   * verifier recomputes this from the presented key and rejects on mismatch, so
   * the signed transcript is cryptographically bound to a specific public key.
   */
  devicePublicKeyHash: string;
}

// ─── Presented public key + signature ───

/**
 * The device public key presented alongside the transcript + signature. SPKI DER
 * (base64/base64url) or SPKI PEM. Normalized to canonical SPKI DER before hashing
 * + verifying; a non-P-256 key is rejected.
 */
export type ProviderApprovalPresentedPublicKey =
  | { encoding: "spki-der-base64"; value: string }
  | { encoding: "spki-pem"; value: string };

/**
 * The canonical signature encoding: IEEE P-1363 fixed-width raw (r‖s), exactly 64
 * bytes, base64/base64url. DER / alternate encodings are rejected as malformed.
 */
export interface ProviderApprovalPresentedSignature {
  encoding: "ieee-p1363-base64";
  value: string;
}

/**
 * The self-describing device proof: the signed transcript + the public key that
 * signed it + the raw P-1363 signature. This is what the client sends and what
 * the Hub verifies with the PUBLIC key only.
 */
export interface ProviderApprovalDeviceProof {
  transcript: ProviderApprovalTranscript;
  devicePublicKey: ProviderApprovalPresentedPublicKey;
  signature: ProviderApprovalPresentedSignature;
}

// ─── Verifier input ───

export interface VerifyProviderApprovalPossessionInput {
  transcript: ProviderApprovalTranscript;
  devicePublicKey: ProviderApprovalPresentedPublicKey;
  signature: ProviderApprovalPresentedSignature;
  /** Wall-clock epoch milliseconds used for the freshness (expiry) gate. */
  nowMs: number;
}

// ─── Typed failure reasons (discriminated, never thrown strings) ───

export type ProviderApprovalPoPRejectReason =
  | "unsupported_transcript_version"
  | "unsupported_algorithm"
  | "malformed_transcript"
  | "expired"
  | "invalid_public_key"
  | "unsupported_key"
  | "public_key_hash_mismatch"
  | "malformed_signature"
  | "non_canonical_signature"
  | "signature_mismatch";

// ─── Verifier result (discriminated union) ───

export interface ProviderApprovalPoPSuccess {
  ok: true;
  algorithm: ProviderApprovalSignatureAlgorithm;
  transcriptVersion: ProviderApprovalTranscriptVersion;
  /** SHA-256 hex of the canonical transcript bytes that were verified. */
  transcriptDigestHex: string;
  /** SHA-256 hex of the canonical SPKI DER of the verified public key. */
  devicePublicKeyHash: string;
  /** The verified approval fields (trusted ONLY after crypto verification). */
  approvalId: string;
  actionDigest: string;
  decidedByPrincipalId: string;
  expiresAt: string;
}

export interface ProviderApprovalPoPFailure {
  ok: false;
  reason: ProviderApprovalPoPRejectReason;
  /** Non-sensitive diagnostic detail. NEVER contains key material or a signature. */
  detail?: string;
}

export type ProviderApprovalPoPResult =
  | ProviderApprovalPoPSuccess
  | ProviderApprovalPoPFailure;

// ─── Stable verifier seam ───

export interface FridayProviderApprovalPoPVerifier {
  /**
   * Stateless verification of transcript-field binding + P-256 ECDSA
   * proof-of-possession. Pure: no side effects, grants NO authority, performs NO
   * request/owner binding (the caller does that with the returned fields).
   */
  verifyPossession(
    input: VerifyProviderApprovalPossessionInput,
  ): ProviderApprovalPoPResult;
}
