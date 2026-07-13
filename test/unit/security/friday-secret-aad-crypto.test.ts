import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";

import {
  encryptSecret,
  decryptSecret,
  decryptSecretWithMigration,
  FRIDAY_SECRET_ENVELOPE_V2,
  type FridayEncryptedEnvelope,
  type FridaySecretAadContext,
} from "#providers";

// SEC-SECRET-AAD-001 — versioned AAD context-binding on the crypto envelope.
// All secret material below is SYNTHETIC.

const KEY = crypto.randomBytes(32);
const SYNTHETIC_SECRET = "synthetic-token-do-not-use-🔑-中文"; // pragma: allowlist secret — synthetic, not a real credential

const ctxA: FridaySecretAadContext = {
  store: "friday-secrets",
  owner: "user-A",
  scope: "provider",
  ref: "secret:provider:openai:apiKey",
  field: "apiKey",
};
// Different OWNER only.
const ctxDifferentOwner: FridaySecretAadContext = { ...ctxA, owner: "user-B" };
// Different REF (row) only.
const ctxDifferentRef: FridaySecretAadContext = { ...ctxA, ref: "secret:provider:anthropic:apiKey" };
// Different FIELD only.
const ctxDifferentField: FridaySecretAadContext = { ...ctxA, field: "refreshToken" };
// Different STORE only.
const ctxDifferentStore: FridaySecretAadContext = { ...ctxA, store: "friday-oauth" };

/**
 * Reproduces the shape a v1 (pre-AAD) envelope would have on disk: raw
 * AES-256-GCM with NO AAD and NO version field. This is exactly what the old
 * `encryptSecret(plaintext, key)` produced.
 */
function makeLegacyV1Envelope(plaintext: string, key: Buffer): FridayEncryptedEnvelope {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: enc.toString("base64"), iv: iv.toString("base64"), tag: tag.toString("base64") };
}

describe("SEC-SECRET-AAD-001 versioned AAD envelope", () => {
  describe("correct-context round-trip (positive)", () => {
    it("encrypt+decrypt with the SAME context returns the plaintext", () => {
      const env = encryptSecret(SYNTHETIC_SECRET, KEY, ctxA);
      expect(env.v).toBe(FRIDAY_SECRET_ENVELOPE_V2);
      expect(decryptSecret(env, KEY, ctxA)).toBe(SYNTHETIC_SECRET);
    });

    it("a fresh structurally-equal context object still decrypts (canonical, order-independent)", () => {
      const env = encryptSecret(SYNTHETIC_SECRET, KEY, ctxA);
      const reordered: FridaySecretAadContext = {
        field: "apiKey",
        ref: "secret:provider:openai:apiKey",
        scope: "provider",
        owner: "user-A",
        store: "friday-secrets",
      };
      expect(decryptSecret(env, KEY, reordered)).toBe(SYNTHETIC_SECRET);
    });
  });

  describe("transplant fails closed (the core guarantee)", () => {
    it.each([
      ["owner", ctxDifferentOwner],
      ["ref (row)", ctxDifferentRef],
      ["field", ctxDifferentField],
      ["store", ctxDifferentStore],
    ])("decrypting a ctxA ciphertext under a different %s THROWS and never returns plaintext", (_label, otherCtx) => {
      const env = encryptSecret(SYNTHETIC_SECRET, KEY, ctxA);
      let returned: string | undefined;
      expect(() => {
        returned = decryptSecret(env, KEY, otherCtx);
      }).toThrow();
      expect(returned).toBeUndefined();
    });
  });

  describe("v2 fail-closed edge cases", () => {
    it("decrypting a v2 envelope with NO context throws (never silently unbound)", () => {
      const env = encryptSecret(SYNTHETIC_SECRET, KEY, ctxA);
      expect(() => decryptSecret(env, KEY)).toThrow(/binding context/i);
    });

    it("stripping the version off a v2 envelope does not downgrade it (still fails closed)", () => {
      const env = encryptSecret(SYNTHETIC_SECRET, KEY, ctxA);
      const stripped: FridayEncryptedEnvelope = { ciphertext: env.ciphertext, iv: env.iv, tag: env.tag };
      // Treated as v1 → decrypt without AAD → GCM tag (computed over AAD) mismatches.
      expect(() => decryptSecret(stripped, KEY)).toThrow();
    });

    it("forging v:2 onto a legacy v1 envelope fails closed", () => {
      const legacy = makeLegacyV1Envelope(SYNTHETIC_SECRET, KEY);
      const forged: FridayEncryptedEnvelope = { ...legacy, v: FRIDAY_SECRET_ENVELOPE_V2 };
      expect(() => decryptSecret(forged, KEY, ctxA)).toThrow();
    });

    it("rejects an unknown envelope version", () => {
      const env = encryptSecret(SYNTHETIC_SECRET, KEY, ctxA);
      expect(() => decryptSecret({ ...env, v: 99 }, KEY, ctxA)).toThrow(/version/i);
    });
  });

  describe("no-degrade migration (v1 legacy survives, re-wraps to v2)", () => {
    it("a legacy v1 envelope decrypts via decryptSecret with a context (context ignored for v1)", () => {
      const legacy = makeLegacyV1Envelope(SYNTHETIC_SECRET, KEY);
      expect(legacy.v).toBeUndefined();
      expect(decryptSecret(legacy, KEY, ctxA)).toBe(SYNTHETIC_SECRET);
    });

    it("decryptSecretWithMigration re-wraps a v1 envelope to a v2 bound to the context", () => {
      const legacy = makeLegacyV1Envelope(SYNTHETIC_SECRET, KEY);
      const { plaintext, rewrapped } = decryptSecretWithMigration(legacy, KEY, ctxA);
      expect(plaintext).toBe(SYNTHETIC_SECRET);
      expect(rewrapped).not.toBeNull();
      expect(rewrapped?.v).toBe(FRIDAY_SECRET_ENVELOPE_V2);
      // Re-wrapped envelope decrypts under the SAME context …
      expect(decryptSecret(rewrapped as FridayEncryptedEnvelope, KEY, ctxA)).toBe(SYNTHETIC_SECRET);
      // … and fails closed under a transplanted context.
      expect(() => decryptSecret(rewrapped as FridayEncryptedEnvelope, KEY, ctxDifferentRef)).toThrow();
    });

    it("decryptSecretWithMigration on an already-v2 envelope does not re-wrap", () => {
      const env = encryptSecret(SYNTHETIC_SECRET, KEY, ctxA);
      const { plaintext, rewrapped } = decryptSecretWithMigration(env, KEY, ctxA);
      expect(plaintext).toBe(SYNTHETIC_SECRET);
      expect(rewrapped).toBeNull();
    });
  });
});
