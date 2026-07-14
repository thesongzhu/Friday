// ─── SEC-SETUP-BOOTSTRAP-001 · Slice 2a — §5 red-first evidence ───
//
// For each core guard (malleability / transcript-field binding / expiry / replay)
// this proves the assertion goes RED when the guard is NEUTRALIZED and GREEN with
// the REAL production guard. The "neutralized" foils reuse production primitives
// (canonical encoder, Node crypto.verify) minus exactly one guard — they are
// mutation-testing controls, NOT a re-implementation of ECDSA verification.
//
// Evidence artifacts are written to test/adversarial/evidence/secsetup-s2a-*.txt.
// All keys/signatures are software dev/test material (see helpers).

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import {
  createFridayOwnerClaimPoPVerifier,
  createInMemoryOwnerClaimNonceConsumer,
  encodeOwnerClaimTranscript,
  verifyOwnerClaimPresentation,
} from "../../src/api/auth/device-attest/index.js";
import type { OwnerClaimTranscript } from "../../src/api/auth/device-attest/index.js";
import {
  generateTestDeviceKey,
  makeTranscript,
  signTranscriptLowS,
  signTranscriptRaw,
  toHighSTwin,
  toLowS,
} from "./_secsetup-s2a.helpers.js";

const verifier = createFridayOwnerClaimPoPVerifier();
const NOW = Date.parse("2025-01-01T00:00:00.000Z");
const EVIDENCE_DIR = resolve("test/adversarial/evidence");

function writeEvidence(name: string, lines: string[]): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const header = [
    `# ${name}`,
    `# SEC-SETUP-BOOTSTRAP-001 Slice 2a — red-first (mutation) evidence`,
    `# generated: ${new Date().toISOString()}`,
    `# keys/signatures: SOFTWARE dev/test material (Node crypto) — NOT attestation evidence`,
    "",
  ];
  writeFileSync(resolve(EVIDENCE_DIR, name), header.concat(lines).join("\n") + "\n");
}

// Length-prefixed helper mirroring the production framing, for the neutralized
// field-binding foil only.
function lp(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([prefix, body]);
}

/** NEUTRALIZED encoder: identical to production BUT omits hubId from the bytes. */
function encodeDroppingHubId(t: OwnerClaimTranscript): Buffer {
  return Buffer.concat([
    lp("friday.owner-claim.transcript"),
    lp(t.transcriptVersion),
    lp(t.algorithm),
    lp(t.kind),
    // hubId intentionally DROPPED — this is the removed guard.
    lp(t.installId),
    lp(t.osUser),
    lp(t.deviceId),
    lp(t.action),
    lp(t.origin),
    lp(t.channel),
    lp(t.nonce),
    lp(t.expiresAt),
    lp(t.devicePublicKeyHash),
  ]);
}

describe("SEC-SETUP-S2a · red-first evidence", () => {
  it("malleability guard: high-S twin is RED (accepted) neutralized, GREEN (rejected) guarded", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    const highS = toHighSTwin(toLowS(signTranscriptRaw(key, t)));
    const canonicalBytes = encodeOwnerClaimTranscript(t);

    // NEUTRALIZED: raw crypto.verify with no low-S check accepts the malleated twin.
    const neutralizedAccepts = cryptoVerify(
      "sha256",
      canonicalBytes,
      { key: key.publicKey, dsaEncoding: "ieee-p1363" },
      highS,
    );

    // GUARDED: the real verifier rejects it as non-canonical.
    const guarded = verifier.verifyPossession({
      transcript: t,
      devicePublicKey: { encoding: "spki-der-base64", value: key.spkiDerBase64 },
      signature: { encoding: "ieee-p1363-base64", value: highS.toString("base64") },
      nowMs: NOW,
    });

    expect(neutralizedAccepts).toBe(true); // RED without the guard
    expect(guarded.ok).toBe(false); // GREEN with the guard
    if (!guarded.ok) expect(guarded.reason).toBe("non_canonical_signature");

    writeEvidence("secsetup-s2a-malleability.txt", [
      "GUARD: low-S canonical-signature enforcement (ECDSA malleability)",
      "ATTACK: present the high-S twin (r, n-s) of a valid low-S signature",
      `NEUTRALIZED (no low-S check, raw crypto.verify): accepted=${neutralizedAccepts}  => RED`,
      `GUARDED   (production verifier)                : ok=${guarded.ok} reason=${guarded.ok ? "-" : guarded.reason}  => GREEN`,
    ]);
  });

  it("field-binding guard: cross-hub swap is RED neutralized, GREEN guarded", () => {
    const key = generateTestDeviceKey();
    const tA = makeTranscript(key, { hubId: "hub-A" });
    const tB = makeTranscript(key, { hubId: "hub-B" });

    // NEUTRALIZED: encoder drops hubId, so a signature over tA verifies for tB.
    const droppedA = encodeDroppingHubId(tA);
    const droppedB = encodeDroppingHubId(tB);
    const sigOverDroppedA = signOverBytes(key, droppedA);
    const neutralizedAccepts = cryptoVerify(
      "sha256",
      droppedB,
      { key: key.publicKey, dsaEncoding: "ieee-p1363" },
      sigOverDroppedA,
    );

    // GUARDED: production encoder includes hubId — sign tA, present tB → mismatch.
    const guarded = verifier.verifyPossession({
      transcript: tB,
      devicePublicKey: { encoding: "spki-der-base64", value: key.spkiDerBase64 },
      signature: { encoding: "ieee-p1363-base64", value: signTranscriptLowS(key, tA) },
      nowMs: NOW,
    });

    expect(neutralizedAccepts).toBe(true); // RED: cross-hub forgery passes without hubId in bytes
    expect(guarded.ok).toBe(false); // GREEN
    if (!guarded.ok) expect(guarded.reason).toBe("signature_mismatch");
    expect(droppedA.equals(droppedB)).toBe(true); // collision proof

    writeEvidence("secsetup-s2a-field-binding.txt", [
      "GUARD: hubId (and every field) bound into the canonical signed bytes",
      "ATTACK: sign a claim for hub-A, present it as a claim for hub-B",
      `NEUTRALIZED (encoder drops hubId): digests collide=${droppedA.equals(droppedB)}, cross-hub accepted=${neutralizedAccepts}  => RED`,
      `GUARDED   (production encoder)    : ok=${guarded.ok} reason=${guarded.ok ? "-" : guarded.reason}  => GREEN`,
    ]);
  });

  it("expiry guard: expired claim is RED neutralized, GREEN guarded", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key, { expiresAt: "2020-01-01T00:00:00.000Z" });
    const sig = signTranscriptRaw(key, t);
    const canonicalBytes = encodeOwnerClaimTranscript(t);

    // NEUTRALIZED: verify the signature but skip the expiry gate → expired passes.
    const neutralizedAccepts = cryptoVerify(
      "sha256",
      canonicalBytes,
      { key: key.publicKey, dsaEncoding: "ieee-p1363" },
      sig,
    );

    // GUARDED: real verifier rejects the expired claim (now=2025 > expiry=2020).
    const guarded = verifier.verifyPossession({
      transcript: t,
      devicePublicKey: { encoding: "spki-der-base64", value: key.spkiDerBase64 },
      signature: { encoding: "ieee-p1363-base64", value: toLowS(sig).toString("base64") },
      nowMs: NOW,
    });

    expect(neutralizedAccepts).toBe(true); // RED without expiry gate
    expect(guarded.ok).toBe(false); // GREEN
    if (!guarded.ok) expect(guarded.reason).toBe("expired");

    writeEvidence("secsetup-s2a-expiry.txt", [
      "GUARD: freshness — reject when nowMs >= transcript.expiresAt",
      "ATTACK: present a signature-valid but EXPIRED transcript",
      `NEUTRALIZED (skip expiry gate): signature-accepted=${neutralizedAccepts}  => RED`,
      `GUARDED   (production verifier): ok=${guarded.ok} reason=${guarded.ok ? "-" : guarded.reason}  => GREEN`,
    ]);
  });

  it("replay guard: second use is RED without the nonce consumer, GREEN with it", () => {
    const key = generateTestDeviceKey();
    const t = makeTranscript(key);
    const input = {
      transcript: t,
      devicePublicKey: { encoding: "spki-der-base64" as const, value: key.spkiDerBase64 },
      signature: { encoding: "ieee-p1363-base64" as const, value: signTranscriptLowS(key, t) },
      nowMs: NOW,
    };

    // NEUTRALIZED: stateless possession verify has no single-use guard — replays pass.
    const neutralizedFirst = verifier.verifyPossession(input);
    const neutralizedSecond = verifier.verifyPossession(input);

    // GUARDED: composed presentation with the single-use nonce consumer.
    const consumer = createInMemoryOwnerClaimNonceConsumer();
    const guardedFirst = verifyOwnerClaimPresentation({ ...input, verifier, nonceConsumer: consumer });
    const guardedSecond = verifyOwnerClaimPresentation({ ...input, verifier, nonceConsumer: consumer });

    expect(neutralizedFirst.ok).toBe(true);
    expect(neutralizedSecond.ok).toBe(true); // RED: replay accepted without the guard
    expect(guardedFirst.ok).toBe(true);
    expect(guardedSecond.ok).toBe(false); // GREEN: replay rejected
    if (!guardedSecond.ok) expect(guardedSecond.reason).toBe("nonce_replayed");

    writeEvidence("secsetup-s2a-replay.txt", [
      "GUARD: single-use nonce consumer (replay defense) composed over possession",
      "ATTACK: present the SAME valid nonce+signature twice",
      `NEUTRALIZED (possession-only, stateless): 1st ok=${neutralizedFirst.ok}, 2nd ok=${neutralizedSecond.ok}  => RED`,
      `GUARDED   (with single-use consumer)    : 1st ok=${guardedFirst.ok}, 2nd ok=${guardedSecond.ok} reason=${guardedSecond.ok ? "-" : guardedSecond.reason}  => GREEN`,
    ]);
  });
});

// Local signer over arbitrary bytes (for the field-binding neutralized foil).
function signOverBytes(
  key: ReturnType<typeof generateTestDeviceKey>,
  bytes: Buffer,
): Buffer {
  return toLowS(cryptoSign("sha256", bytes, { key: key.privateKey, dsaEncoding: "ieee-p1363" }));
}
