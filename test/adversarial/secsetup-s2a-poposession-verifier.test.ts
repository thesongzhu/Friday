// ─── SEC-SETUP-BOOTSTRAP-001 · Slice 2a ───
//
// Adversarial + property suite for the production owner-claim proof-of-possession
// verifier. Every test drives the REAL production verifier (never a re-implemented
// algorithm). All keys/signatures are software dev/test material (see helpers) and
// are NOT final-product attestation evidence.
//
// Core assertion across all negatives: the presentation is ZERO-EFFECT — it
// returns a typed rejection and grants NO owner authority (the verifier is a pure
// function with no state and no authority-bearing output).

import { describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  createFridayOwnerClaimPoPVerifier,
  createInMemoryOwnerClaimNonceConsumer,
  encodeOwnerClaimTranscript,
  ownerClaimTranscriptDigestHex,
  verifyOwnerClaimPresentation,
} from "../../src/api/auth/device-attest/index.js";
import type {
  OwnerClaimPoPResult,
  OwnerClaimTranscript,
} from "../../src/api/auth/device-attest/index.js";
import {
  generateTestDeviceKey,
  makeTranscript,
  signTranscriptDerBase64,
  signTranscriptLowS,
  signTranscriptRaw,
  toHighSTwin,
  toLowS,
  type TestDeviceKey,
} from "./_secsetup-s2a.helpers.js";

const verifier = createFridayOwnerClaimPoPVerifier();
const NOW = Date.parse("2025-01-01T00:00:00.000Z");

/** Verify a transcript signed by `key`, presenting `key`'s SPKI DER. */
function verifySigned(
  key: TestDeviceKey,
  signed: OwnerClaimTranscript,
  presented: OwnerClaimTranscript = signed,
  signatureB64: string = signTranscriptLowS(key, signed),
  nowMs: number = NOW,
): OwnerClaimPoPResult {
  return verifier.verifyPossession({
    transcript: presented,
    devicePublicKey: { encoding: "spki-der-base64", value: key.spkiDerBase64 },
    signature: { encoding: "ieee-p1363-base64", value: signatureB64 },
    nowMs,
  });
}

function expectReject(result: OwnerClaimPoPResult, reason: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

// ─── Happy path ───

describe("SEC-SETUP-S2a · positive proof-of-possession", () => {
  it("verifies a well-formed transcript + canonical signature", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    const result = verifySigned(key, t);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.algorithm).toBe("ECDSA_P256_SHA256");
      expect(result.transcriptVersion).toBe("friday-owner-claim-v1");
      expect(result.devicePublicKeyHash).toBe(key.publicKeyHash);
      expect(result.transcriptDigestHex).toBe(ownerClaimTranscriptDigestHex(t));
    }
  });

  it("NEVER asserts key protection — always 'unverified' on success", () => {
    const key = generateTestDeviceKey();
    const result = verifySigned(key, makeTranscript(key));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyProtection).toBe("unverified");
      // No owner-authority / enclave / attestation field is emitted.
      expect(Object.keys(result).sort()).toEqual(
        [
          "algorithm",
          "devicePublicKeyHash",
          "keyProtection",
          "ok",
          "transcriptDigestHex",
          "transcriptVersion",
        ].sort(),
      );
      expect(result).not.toHaveProperty("userId");
      expect(result).not.toHaveProperty("owner");
    }
  });

  it("is a pure function — verifying twice yields an identical result and no state", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    const sig = signTranscriptLowS(key, t);
    const a = verifySigned(key, t, t, sig);
    const b = verifySigned(key, t, t, sig);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });
});

// ─── Field-binding negatives (each mutated field breaks the signature) ───

describe("SEC-SETUP-S2a · transcript-field binding (zero-effect)", () => {
  const boundFields: Array<[string, Partial<OwnerClaimTranscript>]> = [
    ["wrong Hub", { hubId: "hub-evil" }],
    ["wrong install", { installId: "install-evil" }],
    ["wrong OS user", { osUser: "root" }],
    ["wrong device", { deviceId: "device-evil" }],
    ["wrong action", { action: "delete-owner" }],
    ["wrong origin", { origin: "https://evil.example" }],
    ["wrong channel", { channel: "public-web" }],
    ["wrong nonce", { nonce: "nonce-evil" }],
  ];

  for (const [label, mutation] of boundFields) {
    it(`rejects ${label} presented over a signature for the original`, () => {
      const key = generateTestDeviceKey();
      const signed = makeTranscript(key);
      const presented = { ...signed, ...mutation };
      // Sign the ORIGINAL, present the MUTATED transcript.
      expectReject(verifySigned(key, signed, presented), "signature_mismatch");
    });
  }

  it("rejects a wrong-digest signature (signed a different transcript)", () => {
    const key = generateTestDeviceKey();
    const signedOther = makeTranscript(key, { action: "something-else" });
    const presented = makeTranscript(key, { action: "owner-claim" });
    const sig = signTranscriptLowS(key, signedOther);
    expectReject(verifySigned(key, presented, presented, sig), "signature_mismatch");
  });
});

// ─── Key negatives ───

describe("SEC-SETUP-S2a · key binding + possession (zero-effect)", () => {
  it("rejects a wrong key (signature by another key, hash-bound to presented)", () => {
    const signer = generateTestDeviceKey();
    const other = generateTestDeviceKey();
    // Bind the transcript's key-hash to `other`, but sign with `signer`.
    const t = makeTranscript(other);
    const sig = signTranscriptLowS(signer, t);
    // Present `other`'s public key: hash-binding passes, possession fails.
    expectReject(
      verifier.verifyPossession({
        transcript: t,
        devicePublicKey: { encoding: "spki-der-base64", value: other.spkiDerBase64 },
        signature: { encoding: "ieee-p1363-base64", value: sig },
        nowMs: NOW,
      }),
      "signature_mismatch",
    );
  });

  it("rejects a public-key-hash mismatch (hash bound to a different key)", () => {
    const key = generateTestDeviceKey();
    const other = generateTestDeviceKey();
    const t = makeTranscript(key, { devicePublicKeyHash: other.publicKeyHash });
    // Sign so the signature itself is valid over these bytes; hash-binding gates first.
    expectReject(verifySigned(key, t), "public_key_hash_mismatch");
  });

  it("rejects a non-P-256 key (secp256k1)", () => {
    const p256 = generateTestDeviceKey();
    const t = makeTranscript(p256);
    const sig = signTranscriptLowS(p256, t);
    // Wrong-curve EC public key (secp256k1) presented in place of the P-256 key.
    const wrongCurve = generateKeyPairSync("ec", { namedCurve: "secp256k1" }).publicKey;
    const spki = Buffer.from(wrongCurve.export({ format: "der", type: "spki" })).toString("base64");
    expectReject(
      verifier.verifyPossession({
        transcript: t,
        devicePublicKey: { encoding: "spki-der-base64", value: spki },
        signature: { encoding: "ieee-p1363-base64", value: sig },
        nowMs: NOW,
      }),
      "unsupported_key",
    );
  });

  it("rejects an unparseable public key", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    const sig = signTranscriptLowS(key, t);
    expectReject(
      verifier.verifyPossession({
        transcript: t,
        devicePublicKey: { encoding: "spki-der-base64", value: "not-a-real-key!!" },
        signature: { encoding: "ieee-p1363-base64", value: sig },
        nowMs: NOW,
      }),
      "invalid_public_key",
    );
  });
});

// ─── Expiry ───

describe("SEC-SETUP-S2a · expiry (zero-effect)", () => {
  it("rejects an expired transcript even with a valid signature", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key, { expiresAt: "2020-01-01T00:00:00.000Z" });
    // nowMs (2025) is after the (2020) expiry.
    expectReject(verifySigned(key, t), "expired");
  });

  it("accepts the SAME transcript+signature when the clock is before expiry", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key, { expiresAt: "2025-06-01T00:00:00.000Z" });
    const sig = signTranscriptLowS(key, t);
    // Confirms the rejection above is driven solely by the expiry guard.
    const before = verifySigned(key, t, t, sig, Date.parse("2025-05-01T00:00:00.000Z"));
    const after = verifySigned(key, t, t, sig, Date.parse("2025-07-01T00:00:00.000Z"));
    expect(before.ok).toBe(true);
    expectReject(after, "expired");
  });

  it("rejects a malformed expiry string", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key, { expiresAt: "not-a-date" });
    expectReject(verifySigned(key, t), "malformed_transcript");
  });
});

// ─── Algorithm / version allowlist ───

describe("SEC-SETUP-S2a · algorithm + version allowlist (zero-effect)", () => {
  it("rejects a disallowed algorithm", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key, {
      algorithm: "ECDSA_P256_SHA512" as OwnerClaimTranscript["algorithm"],
    });
    expectReject(verifySigned(key, t), "unsupported_algorithm");
  });

  it("rejects a disallowed transcript version", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key, {
      transcriptVersion: "friday-owner-claim-v2" as OwnerClaimTranscript["transcriptVersion"],
    });
    expectReject(verifySigned(key, t), "unsupported_transcript_version");
  });

  it("rejects a wrong kind discriminator", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key, {
      kind: "install_admin_reset" as OwnerClaimTranscript["kind"],
    });
    expectReject(verifySigned(key, t), "malformed_transcript");
  });

  it("rejects an empty required field", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key, { origin: "" });
    expectReject(verifySigned(key, t), "malformed_transcript");
  });
});

// ─── Signature malleability + malformed encodings ───

describe("SEC-SETUP-S2a · signature malleability + malformed (zero-effect)", () => {
  it("rejects the high-S malleable twin of a valid signature", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    // Normalize to canonical low-S, then flip to the high-S twin. Both are
    // ECDSA-valid; only low-S is canonical for this verifier.
    const highS = toHighSTwin(toLowS(signTranscriptRaw(key, t)));
    expectReject(
      verifySigned(key, t, t, highS.toString("base64")),
      "non_canonical_signature",
    );
  });

  it("accepts the low-S form of the same signature (malleability guard is discriminating)", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    // Default helper already normalizes to low-S.
    expect(verifySigned(key, t).ok).toBe(true);
  });

  it("rejects an alternate (DER) signature encoding", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    const der = signTranscriptDerBase64(key, t);
    expectReject(verifySigned(key, t, t, der), "malformed_signature");
  });

  it("rejects a truncated (63-byte) signature", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    const raw = signTranscriptRaw(key, t).subarray(0, 63);
    expectReject(verifySigned(key, t, t, raw.toString("base64")), "malformed_signature");
  });

  it("rejects an oversized (65-byte) signature", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    const raw = Buffer.concat([signTranscriptRaw(key, t), Buffer.from([0x00])]);
    expectReject(verifySigned(key, t, t, raw.toString("base64")), "malformed_signature");
  });

  it("rejects an all-zero (out-of-range r/s) signature", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    expectReject(
      verifySigned(key, t, t, Buffer.alloc(64).toString("base64")),
      "malformed_signature",
    );
  });

  it("rejects a structurally-valid-but-wrong (garbage) signature", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    // Corrupt one byte of r, then normalize to low-S so it clears structural checks
    // but fails the ECDSA math.
    const raw = Buffer.from(signTranscriptRaw(key, t));
    raw[0] = raw[0] ^ 0xff;
    const low = toLowS(raw);
    const result = verifySigned(key, t, t, low.toString("base64"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["signature_mismatch", "malformed_signature"]).toContain(result.reason);
    }
  });
});

// ─── Replay + restart (composed presentation seam) ───

describe("SEC-SETUP-S2a · replay + restart via single-use nonce seam (zero-effect)", () => {
  it("accepts once, then rejects a replay of the same nonce", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    const consumer = createInMemoryOwnerClaimNonceConsumer();
    const args = {
      verifier,
      nonceConsumer: consumer,
      transcript: t,
      devicePublicKey: { encoding: "spki-der-base64" as const, value: key.spkiDerBase64 },
      signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(key, t) },
      nowMs: NOW,
    };
    const first = verifyOwnerClaimPresentation(args);
    const second = verifyOwnerClaimPresentation(args);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.nonceConsumed).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("nonce_replayed");
  });

  it("survives restart — replay is still rejected after re-reading persisted consumed state", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    const consumer = createInMemoryOwnerClaimNonceConsumer();
    const sig = signTranscriptLowS(key, t);
    const base = {
      verifier,
      transcript: t,
      devicePublicKey: { encoding: "spki-der-base64" as const, value: key.spkiDerBase64 },
      signature: { encoding: "ieee-p1363-base64" as const, value: sig },
      nowMs: NOW,
    };
    expect(verifyOwnerClaimPresentation({ ...base, nonceConsumer: consumer }).ok).toBe(true);

    // Simulate restart: re-read persisted consumed set into a NEW consumer.
    const snapshot = consumer.snapshot();
    const rebuilt = createInMemoryOwnerClaimNonceConsumer(snapshot);
    const afterRestart = verifyOwnerClaimPresentation({ ...base, nonceConsumer: rebuilt });
    expect(afterRestart.ok).toBe(false);
    if (!afterRestart.ok) expect(afterRestart.reason).toBe("nonce_replayed");
  });

  it("presentation with an invalid signature does NOT burn the nonce", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    const consumer = createInMemoryOwnerClaimNonceConsumer();
    const badSig = Buffer.alloc(64).toString("base64");
    const bad = verifyOwnerClaimPresentation({
      verifier,
      nonceConsumer: consumer,
      transcript: t,
      devicePublicKey: { encoding: "spki-der-base64", value: key.spkiDerBase64 },
      signature: { encoding: "ieee-p1363-base64", value: badSig },
      nowMs: NOW,
    });
    expect(bad.ok).toBe(false);
    // Nonce was never consumed, so a subsequent VALID claim still succeeds.
    const good = verifyOwnerClaimPresentation({
      verifier,
      nonceConsumer: consumer,
      transcript: t,
      devicePublicKey: { encoding: "spki-der-base64", value: key.spkiDerBase64 },
      signature: { encoding: "ieee-p1363-base64", value: signTranscriptLowS(key, t) },
      nowMs: NOW,
    });
    expect(good.ok).toBe(true);
  });
});

// ─── Canonical-encoding properties ───

describe("SEC-SETUP-S2a · canonical encoding properties", () => {
  it("is deterministic across repeated encodings", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    expect(encodeOwnerClaimTranscript(t).equals(encodeOwnerClaimTranscript(t))).toBe(true);
  });

  it("has no field-boundary ambiguity (length-prefixing prevents collisions)", () => {
    const key = generateTestDeviceKey();
    const a = makeTranscript(key, { hubId: "a", installId: "bc" });
    const b = makeTranscript(key, { hubId: "ab", installId: "c" });
    expect(ownerClaimTranscriptDigestHex(a)).not.toBe(ownerClaimTranscriptDigestHex(b));
  });
});

// ─── Property fuzz: any single bound-field mutation breaks verification ───

describe("SEC-SETUP-S2a · property — mutation of any bound field fails", () => {
  const mutable: Array<keyof OwnerClaimTranscript> = [
    "hubId",
    "installId",
    "osUser",
    "deviceId",
    "action",
    "origin",
    "channel",
    "nonce",
  ];

  it("freshly-signed transcripts always verify; single-field tamper always fails", () => {
    for (let i = 0; i < 40; i++) {
      const key = generateTestDeviceKey();
      const signed = makeTranscript(key, {
        hubId: `hub-${randomBytes(4).toString("hex")}`,
        installId: `install-${randomBytes(4).toString("hex")}`,
        nonce: `nonce-${randomBytes(6).toString("hex")}`,
      });
      const sig = signTranscriptLowS(key, signed);

      // Positive: the signed transcript verifies.
      expect(verifySigned(key, signed, signed, sig).ok).toBe(true);

      // Negative: tamper one random bound field → signature_mismatch.
      const field = mutable[i % mutable.length];
      const tampered: OwnerClaimTranscript = {
        ...signed,
        [field]: `${signed[field]}-tampered`,
      };
      const result = verifySigned(key, signed, tampered, sig);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("signature_mismatch");
    }
  });
});
