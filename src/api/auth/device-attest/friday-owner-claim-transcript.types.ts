// ─── SEC-SETUP-BOOTSTRAP-001 · Slice 2a ───
//
// Server-side proof-of-possession (PoP) verifier types for the device-bound
// owner-claim transcript.
//
// SCOPE (binding, per operator): this module verifies a CANONICAL owner-claim
// transcript + a P-256 ECDSA signature over it. It proves that the signer holds
// the private key for the presented public key, and that the signed transcript
// binds every claim field (hub / install / os-user / device / action / origin /
// channel / nonce / expiry / public-key-hash). It does NOT — and MUST NOT —
// assert key protection (Secure Enclave / Keychain / attestation), grant owner
// authority, mutate any store, or treat nonce-possession alone as identity. Key
// protection is derived server-side by a FUTURE slice with a native bridge; here
// it is always reported as `"unverified"`.

// ─── Algorithm + version allowlists (value constants live in the impl) ───

/** The single canonical transcript encoding version accepted by this verifier. */
export type OwnerClaimTranscriptVersion = "friday-owner-claim-v1";

/**
 * The single canonical signature algorithm accepted by this verifier:
 * ECDSA over the NIST P-256 (secp256r1 / prime256v1) curve with SHA-256, using
 * the IEEE P-1363 fixed-width raw (r‖s, 32+32 bytes) signature encoding and an
 * enforced low-S (canonical) form.
 */
export type OwnerClaimSignatureAlgorithm = "ECDSA_P256_SHA256";

// ─── Key protection (NEVER inferred here) ───

/**
 * Key-protection posture. This verifier ALWAYS returns `"unverified"`: a valid
 * signature proves possession, NOT that the key lives in the Secure Enclave or a
 * Keychain ACL. A later slice + native attestation bridge derives the real
 * posture server-side. Downstream code MUST NOT treat `"unverified"` as any form
 * of hardware-backed assurance.
 */
export type OwnerClaimKeyProtection = "unverified";

// ─── Canonical transcript fields ───

/**
 * The full set of fields bound by the canonical owner-claim transcript. The
 * signature is computed over the deterministic encoding of ALL of these; a
 * change to ANY field changes the signed bytes and therefore fails verification.
 */
export interface OwnerClaimTranscript {
  /** Explicit, allow-listed transcript-encoding version. */
  transcriptVersion: OwnerClaimTranscriptVersion;
  /** Explicit, allow-listed signature algorithm (bound INTO the transcript). */
  algorithm: OwnerClaimSignatureAlgorithm;
  /** Fixed claim kind discriminator. */
  kind: "install_owner_claim";
  /** Hub identity the claim is bound to. */
  hubId: string;
  /** Stable installation id for this hub install. */
  installId: string;
  /** OS user the install runs as. */
  osUser: string;
  /** Device identity bound to the owner. */
  deviceId: string;
  /** Bound action label (e.g. "owner-claim"). */
  action: string;
  /** Loopback origin the claim is presented from. */
  origin: string;
  /** Presentation channel (e.g. "install-ipc"). */
  channel: string;
  /** Raw single-use challenge nonce previously issued by the hub. */
  nonce: string;
  /** Absolute expiry (ISO-8601) after which the claim is stale. */
  expiresAt: string;
  /**
   * SHA-256 hex digest of the canonical SPKI DER of the device public key. The
   * verifier recomputes this from the presented key and rejects on mismatch, so
   * the signed transcript is cryptographically bound to a specific public key.
   */
  devicePublicKeyHash: string;
}

// ─── Presented public key ───

/**
 * The device public key presented alongside the transcript + signature. Encodings
 * accepted: SPKI DER (base64 or base64url) or SPKI PEM. The verifier normalizes
 * to canonical SPKI DER before hashing + verifying, so alternate encodings of the
 * SAME key are equivalent, and a non-P-256 key is rejected.
 */
export type OwnerClaimPresentedPublicKey =
  | { encoding: "spki-der-base64"; value: string }
  | { encoding: "spki-pem"; value: string };

// ─── Presented signature ───

/**
 * The canonical signature encoding: IEEE P-1363 fixed-width raw (r‖s), exactly 64
 * bytes, base64 or base64url. DER / alternate encodings are rejected as malformed.
 */
export interface OwnerClaimPresentedSignature {
  encoding: "ieee-p1363-base64";
  value: string;
}

// ─── Verifier input ───

export interface VerifyOwnerClaimPossessionInput {
  transcript: OwnerClaimTranscript;
  devicePublicKey: OwnerClaimPresentedPublicKey;
  signature: OwnerClaimPresentedSignature;
  /** Wall-clock epoch milliseconds used for the freshness (expiry) gate. */
  nowMs: number;
}

// ─── Typed failure reasons (discriminated, never thrown strings) ───

export type OwnerClaimPoPRejectReason =
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

export interface OwnerClaimPoPSuccess {
  ok: true;
  /** ALWAYS "unverified" — possession proven, protection NOT inferred. */
  keyProtection: OwnerClaimKeyProtection;
  algorithm: OwnerClaimSignatureAlgorithm;
  transcriptVersion: OwnerClaimTranscriptVersion;
  /** SHA-256 hex of the canonical transcript bytes that were verified. */
  transcriptDigestHex: string;
  /** SHA-256 hex of the canonical SPKI DER of the verified public key. */
  devicePublicKeyHash: string;
}

export interface OwnerClaimPoPFailure {
  ok: false;
  reason: OwnerClaimPoPRejectReason;
  /**
   * Non-sensitive diagnostic detail. NEVER contains the nonce, signature, or any
   * key material.
   */
  detail?: string;
}

export type OwnerClaimPoPResult = OwnerClaimPoPSuccess | OwnerClaimPoPFailure;

// ─── Stable verifier seam (later slices plug in without copying crypto) ───

export interface FridayOwnerClaimPoPVerifier {
  /**
   * Stateless verification of transcript-field binding + P-256 ECDSA
   * proof-of-possession. Pure: no side effects, grants NO authority.
   */
  verifyPossession(input: VerifyOwnerClaimPossessionInput): OwnerClaimPoPResult;
}

// ─── Single-use nonce seam (replay / restart survival) ───

/** Outcome of attempting to consume a single-use owner-claim nonce. */
export type OwnerClaimNonceConsumeOutcome = "fresh" | "replayed";

/**
 * The single-use nonce seam. Production wires the durable, atomic DB-backed
 * nonce repository (SEC-SETUP-BOOTSTRAP-001 Slice 1) here; this module ships an
 * in-memory REFERENCE implementation for tests + composition demos only.
 */
export interface OwnerClaimNonceConsumer {
  /**
   * Consume a nonce exactly once. Returns "fresh" the first time and "replayed"
   * on every subsequent presentation of the same nonce (including after a
   * state-reload / restart).
   */
  consume(nonce: string): OwnerClaimNonceConsumeOutcome;
}

// ─── Composed presentation seam (S3 integration plug-point) ───

export type OwnerClaimPresentationRejectReason =
  | OwnerClaimPoPRejectReason
  | "nonce_replayed";

export interface OwnerClaimPresentationSuccess extends OwnerClaimPoPSuccess {
  nonceConsumed: true;
}

export interface OwnerClaimPresentationFailure {
  ok: false;
  reason: OwnerClaimPresentationRejectReason;
  detail?: string;
}

export type OwnerClaimPresentationResult =
  | OwnerClaimPresentationSuccess
  | OwnerClaimPresentationFailure;

export interface VerifyOwnerClaimPresentationInput
  extends VerifyOwnerClaimPossessionInput {
  verifier: FridayOwnerClaimPoPVerifier;
  nonceConsumer: OwnerClaimNonceConsumer;
}
