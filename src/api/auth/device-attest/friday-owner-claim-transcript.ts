// ─── SEC-SETUP-BOOTSTRAP-001 · Slice 2a ───
//
// Canonical owner-claim transcript encoding + P-256 signature primitives.
//
// The encoding is a DETERMINISTIC, length-prefixed binary framing with a fixed
// field order and a domain-separation prefix. Because the verifier reconstructs
// the bytes from the typed fields (it never parses an attacker-supplied byte
// blob), there is exactly ONE valid encoding of a given transcript — alternate /
// ambiguous encodings cannot exist by construction. The u32 length prefix on
// every field removes field-boundary ambiguity (e.g. it prevents a hubId/installId
// split from colliding with a different split of the same concatenation).

import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import type {
  OwnerClaimSignatureAlgorithm,
  OwnerClaimTranscript,
  OwnerClaimTranscriptVersion,
} from "./friday-owner-claim-transcript.types.js";

// ─── Allowlists (value constants) ───

export const OWNER_CLAIM_TRANSCRIPT_VERSION: OwnerClaimTranscriptVersion =
  "friday-owner-claim-v1";

export const OWNER_CLAIM_ALGORITHM: OwnerClaimSignatureAlgorithm =
  "ECDSA_P256_SHA256";

export const ALLOWED_TRANSCRIPT_VERSIONS: ReadonlySet<string> = new Set([
  OWNER_CLAIM_TRANSCRIPT_VERSION,
]);

export const ALLOWED_ALGORITHMS: ReadonlySet<string> = new Set([
  OWNER_CLAIM_ALGORITHM,
]);

/** Fixed claim-kind discriminator that MUST appear in every transcript. */
export const OWNER_CLAIM_KIND = "install_owner_claim" as const;

// ─── Domain separation ───

const TRANSCRIPT_DOMAIN = "friday.owner-claim.transcript";

// ─── NIST P-256 curve order (n) and n/2 for low-S enforcement ───

export const P256_ORDER_N = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551",
);
export const P256_HALF_ORDER = P256_ORDER_N >> 1n;

/** IEEE P-1363 raw signature length for P-256 (r‖s, 32 + 32). */
export const P256_P1363_SIGNATURE_BYTES = 64;

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
 * without bumping the transcript version. Fields are listed EXPLICITLY (rather
 * than iterated over a key array) so the exact signed layout is auditable at a
 * glance and there is no dynamic property access.
 */
export function encodeOwnerClaimTranscript(
  transcript: OwnerClaimTranscript,
): Buffer {
  return Buffer.concat([
    lengthPrefixed(TRANSCRIPT_DOMAIN),
    lengthPrefixed(transcript.transcriptVersion),
    lengthPrefixed(transcript.algorithm),
    lengthPrefixed(transcript.kind),
    lengthPrefixed(transcript.hubId),
    lengthPrefixed(transcript.installId),
    lengthPrefixed(transcript.osUser),
    lengthPrefixed(transcript.deviceId),
    lengthPrefixed(transcript.action),
    lengthPrefixed(transcript.origin),
    lengthPrefixed(transcript.channel),
    lengthPrefixed(transcript.nonce),
    lengthPrefixed(transcript.expiresAt),
    lengthPrefixed(transcript.devicePublicKeyHash),
  ]);
}

/** SHA-256 hex digest of the canonical transcript bytes. */
export function ownerClaimTranscriptDigestHex(
  transcript: OwnerClaimTranscript,
): string {
  return createHash("sha256").update(encodeOwnerClaimTranscript(transcript)).digest("hex");
}

// ─── Public-key normalization + hashing ───

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Decode a base64 or base64url string to a Buffer (tolerant of either alphabet). */
export function decodeFlexibleBase64(value: string): Buffer {
  const trimmed = value.trim();
  if (BASE64URL_RE.test(trimmed.replace(/=+$/, "")) && /[-_]/.test(trimmed)) {
    return Buffer.from(trimmed, "base64url");
  }
  return Buffer.from(trimmed, "base64");
}

/**
 * Import a presented public key (SPKI DER base64/base64url or SPKI PEM) into a
 * KeyObject. Throws on unparseable input (caller maps to `invalid_public_key`).
 */
export function importPresentedPublicKey(input:
  | { encoding: "spki-der-base64"; value: string }
  | { encoding: "spki-pem"; value: string }): KeyObject {
  if (input.encoding === "spki-pem") {
    return createPublicKey(input.value);
  }
  const der = decodeFlexibleBase64(input.value);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** True iff the KeyObject is an EC key on the NIST P-256 (prime256v1) curve. */
export function isP256PublicKey(key: KeyObject): boolean {
  if (key.asymmetricKeyType !== "ec") return false;
  const named = key.asymmetricKeyDetails?.namedCurve;
  return named === "prime256v1";
}

/**
 * Canonical device-public-key hash: SHA-256 hex over the SPKI DER export of the
 * key. Independent of the presented encoding, so the transcript's bound hash is
 * compared against a normalized representation.
 */
export function canonicalDevicePublicKeyHash(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex");
}

// ─── P-1363 signature parsing + low-S (malleability) enforcement ───

export interface ParsedP1363Signature {
  r: bigint;
  s: bigint;
  raw: Buffer;
}

function bufToBigInt(buf: Buffer): bigint {
  return buf.byteLength === 0 ? 0n : BigInt("0x" + buf.toString("hex"));
}

/**
 * Parse a canonical IEEE P-1363 raw P-256 signature. Returns null for any
 * non-canonical length or out-of-range scalar (r or s not in [1, n-1]). This is
 * the sole accepted signature encoding: DER and every other framing is rejected
 * here as malformed.
 */
export function parseCanonicalP1363Signature(
  raw: Buffer,
): ParsedP1363Signature | null {
  if (raw.byteLength !== P256_P1363_SIGNATURE_BYTES) return null;
  const r = bufToBigInt(raw.subarray(0, 32));
  const s = bufToBigInt(raw.subarray(32, 64));
  if (r <= 0n || r >= P256_ORDER_N) return null;
  if (s <= 0n || s >= P256_ORDER_N) return null;
  return { r, s, raw };
}

/** True iff s is in the low-S (canonical, non-malleable) half: s ≤ n/2. */
export function isLowS(s: bigint): boolean {
  return s <= P256_HALF_ORDER;
}
