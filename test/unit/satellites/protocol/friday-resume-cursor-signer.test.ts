import { describe, it, expect } from "vitest";
import { createFridayResumeCursorSigner } from "#satellites";

describe("FridayResumeCursorSigner", () => {
  const secret = "test-secret-key-for-hmac-signing";
  const signer = createFridayResumeCursorSigner(secret);

  const payload = {
    seq: 42,
    streamId: "stream-001",
    epoch: 3,
    issuedAt: "2025-01-15T10:00:00.000Z",
  };

  it("roundtrips sign → verify", () => {
    const cursor = signer.sign(payload);
    const verified = signer.verify(cursor);
    expect(verified).toEqual(payload);
  });

  it("produces a cursor with payload.signature format", () => {
    const cursor = signer.sign(payload);
    expect(cursor).toContain(".");
    const parts = cursor.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]!.length).toBeGreaterThan(0);
    expect(parts[1]!.length).toBeGreaterThan(0);
  });

  it("detects tampered payload", () => {
    const cursor = signer.sign(payload);
    const [payloadB64, sig] = cursor.split(".");
    // Tamper with the payload
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...payload, seq: 999 }),
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${sig}`;
    expect(() => signer.verify(tampered)).toThrow("HMAC verification failed");
  });

  it("detects tampered signature", () => {
    const cursor = signer.sign(payload);
    const [payloadB64] = cursor.split(".");
    const tampered = `${payloadB64}.invalid-signature`;
    expect(() => signer.verify(tampered)).toThrow("HMAC verification failed");
  });

  it("rejects mismatched signature lengths without throwing a buffer-length error", () => {
    const cursor = signer.sign(payload);
    const [payloadB64, sig] = cursor.split(".");
    const shorter = `${payloadB64}.${sig!.slice(0, -4)}`;
    const longer = `${payloadB64}.${sig}abcd`;

    expect(() => signer.verify(shorter)).toThrow("HMAC verification failed");
    expect(() => signer.verify(longer)).toThrow("HMAC verification failed");
  });

  it("rejects cursor without separator", () => {
    expect(() => signer.verify("noseparatorhere")).toThrow("missing signature separator");
  });

  it("different secrets produce different signatures", () => {
    const otherSigner = createFridayResumeCursorSigner("different-secret");
    const cursor1 = signer.sign(payload);
    const cursor2 = otherSigner.sign(payload);
    expect(cursor1).not.toEqual(cursor2);
  });

  it("cursor signed by one secret cannot be verified by another", () => {
    const otherSigner = createFridayResumeCursorSigner("different-secret");
    const cursor = signer.sign(payload);
    expect(() => otherSigner.verify(cursor)).toThrow("HMAC verification failed");
  });
});
