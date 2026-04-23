import { describe, expect, it } from "vitest";

import {
  createFridayRealtimeFrameCrypto,
  isFridayRealtimeEncryptedFrameEnvelope,
  type FridayRealtimeClientFrame,
  type FridayRealtimeServerFrame,
} from "#api";

describe("FridayRealtimeFrameCrypto", () => {
  it("encrypts and decrypts client and server frames with authenticated envelopes", () => {
    const frameKeyMaterial = ["frame", "secret"].join("-");
    const crypto = createFridayRealtimeFrameCrypto({
      secret: frameKeyMaterial,
      keyId: "test-key",
      randomBytes: (size) => Buffer.alloc(size, 7),
    });

    const clientFrame: FridayRealtimeClientFrame = { type: "ping", at: "2026-03-07T12:00:00.000Z" };
    const encryptedClient = crypto.encryptClientFrame(clientFrame);
    expect(isFridayRealtimeEncryptedFrameEnvelope(encryptedClient)).toBe(true);
    expect(encryptedClient).toMatchObject({
      type: "encrypted",
      envelopeVersion: 1,
      alg: "A256GCM",
      keyId: "test-key",
    });
    expect(JSON.stringify(encryptedClient)).not.toContain("ping");
    expect(crypto.decryptClientFrame(encryptedClient)).toEqual(clientFrame);

    const serverFrame: FridayRealtimeServerFrame = { type: "pong", at: "2026-03-07T12:00:01.000Z" };
    const encryptedServer = crypto.encryptServerFrame(serverFrame);
    expect(crypto.decryptServerFrame(encryptedServer)).toEqual(serverFrame);
  });

  it("rejects tampered ciphertext", () => {
    const frameKeyMaterial = ["frame", "secret"].join("-");
    const crypto = createFridayRealtimeFrameCrypto({
      secret: frameKeyMaterial,
      keyId: "test-key",
      randomBytes: (size) => Buffer.alloc(size, 4),
    });
    const encrypted = crypto.encryptClientFrame({ type: "ping", at: "2026-03-07T12:00:00.000Z" });

    expect(() =>
      crypto.decryptClientFrame({
        ...encrypted,
        ciphertext: Buffer.from("tampered", "utf8").toString("base64"),
      }),
    ).toThrow();
  });
});
