import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  getMasterKey,
  getStrictMasterKey,
  resetMasterKeyCache,
} from "#providers";

describe("FridaySecretCrypto", () => {
  const validKey = crypto.randomBytes(32);

  describe("encryptSecret / decryptSecret", () => {
    it("roundtrips a simple string", () => {
      const plaintext = "sk-test-key-12345";
      const envelope = encryptSecret(plaintext, validKey);
      expect(envelope.ciphertext).toBeTruthy();
      expect(envelope.iv).toBeTruthy();
      expect(envelope.tag).toBeTruthy();

      const decrypted = decryptSecret(envelope, validKey);
      expect(decrypted).toBe(plaintext);
    });

    it("roundtrips an empty string", () => {
      const envelope = encryptSecret("", validKey);
      const decrypted = decryptSecret(envelope, validKey);
      expect(decrypted).toBe("");
    });

    it("roundtrips a long string with special characters", () => {
      const plaintext = "sk-" + "a".repeat(1000) + "-🔑-ñ-中文";
      const envelope = encryptSecret(plaintext, validKey);
      const decrypted = decryptSecret(envelope, validKey);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertexts for same plaintext (unique IV)", () => {
      const plaintext = "same-key";
      const e1 = encryptSecret(plaintext, validKey);
      const e2 = encryptSecret(plaintext, validKey);
      expect(e1.iv).not.toBe(e2.iv);
      expect(e1.ciphertext).not.toBe(e2.ciphertext);
    });

    it("fails to decrypt with wrong key", () => {
      const envelope = encryptSecret("secret", validKey);
      const wrongKey = crypto.randomBytes(32);
      expect(() => decryptSecret(envelope, wrongKey)).toThrow(/authenticat|Unsupported state/i);
    });

    it("fails to decrypt with tampered ciphertext", () => {
      const envelope = encryptSecret("secret", validKey);
      const tampered = {
        ...envelope,
        ciphertext: Buffer.from("tampered").toString("base64"),
      };
      expect(() => decryptSecret(tampered, validKey)).toThrow(/authenticat|Unsupported state/i);
    });

    it("fails to decrypt with tampered tag", () => {
      const envelope = encryptSecret("secret", validKey);
      const tampered = {
        ...envelope,
        tag: Buffer.from("tampered-tag-1234").toString("base64"),
      };
      expect(() => decryptSecret(tampered, validKey)).toThrow(/authenticat|Unsupported state|Invalid authentication tag/i);
    });

    it("rejects master key with wrong length", () => {
      const shortKey = crypto.randomBytes(16);
      expect(() => encryptSecret("test", shortKey)).toThrow(
        "Master key must be 32 bytes",
      );
      expect(() =>
        decryptSecret(
          { ciphertext: "", iv: "", tag: "" },
          shortKey,
        ),
      ).toThrow("Master key must be 32 bytes");
    });
  });

  describe("getMasterKey", () => {
    const originalEnv = process.env.FRIDAY_MASTER_KEY;
    const originalSource = process.env.FRIDAY_MASTER_KEY_SOURCE;

    beforeEach(() => {
      resetMasterKeyCache();
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.FRIDAY_MASTER_KEY = originalEnv;
      } else {
        delete process.env.FRIDAY_MASTER_KEY;
      }
      if (originalSource !== undefined) {
        process.env.FRIDAY_MASTER_KEY_SOURCE = originalSource;
      } else {
        delete process.env.FRIDAY_MASTER_KEY_SOURCE;
      }
      resetMasterKeyCache();
    });

    it("reads from FRIDAY_MASTER_KEY env var (hex-encoded)", () => {
      const key = crypto.randomBytes(32);
      process.env.FRIDAY_MASTER_KEY = key.toString("hex");
      const result = getMasterKey();
      expect(result).toEqual(key);
    });

    it("prefers FRIDAY_MASTER_KEY env var over optional keychain mode", () => {
      const key = crypto.randomBytes(32);
      process.env.FRIDAY_MASTER_KEY_SOURCE = "keychain";
      process.env.FRIDAY_MASTER_KEY = key.toString("hex");
      const result = getMasterKey();
      expect(result).toEqual(key);
    });

    it("does not generate and write a keychain master key through process arguments", () => {
      delete process.env.FRIDAY_MASTER_KEY;
      process.env.FRIDAY_MASTER_KEY_SOURCE = "keychain";

      expect(() => getMasterKey()).toThrow("FRIDAY_MASTER_KEY_SOURCE=keychain");
    });

    it("generates random key when env var not set", () => {
      delete process.env.FRIDAY_MASTER_KEY;
      const key = getMasterKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it("does not let fail-open cached keys satisfy strict runtime resolution", () => {
      delete process.env.FRIDAY_MASTER_KEY;
      delete process.env.FRIDAY_MASTER_KEY_SOURCE;
      const key = getMasterKey();
      expect(key.length).toBe(32);

      expect(() => getStrictMasterKey()).toThrow(/FRIDAY_MASTER_KEY is not configured/);
    });

    it("caches the key across calls", () => {
      delete process.env.FRIDAY_MASTER_KEY;
      const k1 = getMasterKey();
      const k2 = getMasterKey();
      expect(k1).toBe(k2); // Same reference
    });

    it("throws on invalid hex length", () => {
      process.env.FRIDAY_MASTER_KEY = "abcd"; // Only 2 bytes
      expect(() => getMasterKey()).toThrow("32 bytes");
    });
  });
});
