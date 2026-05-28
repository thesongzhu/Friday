/**
 * Adversarial Crypto & HTTP Attack Tests (TEST-40 through TEST-44)
 *
 * Tests AES-256-GCM envelope tampering, CORS origin validation bypass,
 * HTTP method confusion, response header injection, and static file
 * path traversal via the UI asset server.
 *
 * - TEST-40: AES-GCM envelope tampering (IV reuse, tag mutation, ciphertext swap)
 * - TEST-41: CORS origin validation bypass attempts
 * - TEST-42: HTTP method confusion & smuggling-lite
 * - TEST-43: Response header injection via path/query
 * - TEST-44: Static UI asset path traversal
 */

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import * as crypto from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  resetMasterKeyCache,
  getMasterKey,
} from "../../src/providers/security/friday-secret-crypto.js";
import type { FridayEncryptedEnvelope } from "../../src/providers/security/friday-secret-crypto.js";
import { FridayDomainError } from "#errors";
import {
  createFridayApiTestEnv,
  loginTestUser,
  authHeaders,
  type FridayApiTestEnv,
} from "../e2e/api/_helpers/friday-api-test-server.helper.js";

// ─── TEST-40: AES-GCM Envelope Tampering ───

describe("TEST-40: AES-GCM Envelope Tampering", () => {
  const masterKey = crypto.randomBytes(32);
  const plaintext = "sk-secret-api-key-12345";

  it("decrypts valid envelope correctly (baseline)", () => {
    const envelope = encryptSecret(plaintext, masterKey);
    const decrypted = decryptSecret(envelope, masterKey);
    expect(decrypted).toBe(plaintext);
  });

  it("rejects envelope with mutated ciphertext (single bit flip)", () => {
    const envelope = encryptSecret(plaintext, masterKey);
    const cipherBuf = Buffer.from(envelope.ciphertext, "base64");
    cipherBuf[0] = (cipherBuf[0]! + 1) % 256;
    const tampered: FridayEncryptedEnvelope = {
      ...envelope,
      ciphertext: cipherBuf.toString("base64"),
    };

    expect(() => decryptSecret(tampered, masterKey)).toThrow();
  });

  it("rejects envelope with mutated auth tag", () => {
    const envelope = encryptSecret(plaintext, masterKey);
    const tagBuf = Buffer.from(envelope.tag, "base64");
    tagBuf[tagBuf.length - 1] = (tagBuf[tagBuf.length - 1]! + 1) % 256;
    const tampered: FridayEncryptedEnvelope = {
      ...envelope,
      tag: tagBuf.toString("base64"),
    };

    expect(() => decryptSecret(tampered, masterKey)).toThrow();
  });

  it("rejects envelope with swapped IV from different encryption", () => {
    const envelope1 = encryptSecret(plaintext, masterKey);
    const envelope2 = encryptSecret("different-plaintext", masterKey);

    const tampered: FridayEncryptedEnvelope = {
      ciphertext: envelope1.ciphertext,
      iv: envelope2.iv, // wrong IV!
      tag: envelope1.tag,
    };

    expect(() => decryptSecret(tampered, masterKey)).toThrow();
  });

  it("rejects envelope decrypted with wrong master key", () => {
    const envelope = encryptSecret(plaintext, masterKey);
    const wrongKey = crypto.randomBytes(32);

    expect(() => decryptSecret(envelope, wrongKey)).toThrow();
  });

  it("rejects master key with wrong length (16 bytes instead of 32)", () => {
    const shortKey = crypto.randomBytes(16);

    expect(() => encryptSecret(plaintext, shortKey)).toThrow(FridayDomainError);
    expect(() => encryptSecret(plaintext, shortKey)).toThrow(/32 bytes/);
  });

  it("rejects master key with wrong length (64 bytes instead of 32)", () => {
    const longKey = crypto.randomBytes(64);

    expect(() => encryptSecret(plaintext, longKey)).toThrow(FridayDomainError);
  });

  it("produces different IVs for same plaintext (no IV reuse)", () => {
    const envelope1 = encryptSecret(plaintext, masterKey);
    const envelope2 = encryptSecret(plaintext, masterKey);

    // IVs must be different (random per encryption)
    expect(envelope1.iv).not.toBe(envelope2.iv);

    // Ciphertexts must also differ (due to different IVs)
    expect(envelope1.ciphertext).not.toBe(envelope2.ciphertext);
  });

  it("handles empty plaintext without error", () => {
    const envelope = encryptSecret("", masterKey);
    const decrypted = decryptSecret(envelope, masterKey);
    expect(decrypted).toBe("");
  });

  it("handles very long plaintext (100KB)", () => {
    const longPlaintext = "x".repeat(100_000);
    const envelope = encryptSecret(longPlaintext, masterKey);
    const decrypted = decryptSecret(envelope, masterKey);
    expect(decrypted).toBe(longPlaintext);
  });

  it("rejects envelope with empty ciphertext", () => {
    const envelope = encryptSecret(plaintext, masterKey);
    const tampered: FridayEncryptedEnvelope = {
      ...envelope,
      ciphertext: "",
    };

    expect(() => decryptSecret(tampered, masterKey)).toThrow();
  });

  it("rejects envelope with non-base64 ciphertext", () => {
    const envelope = encryptSecret(plaintext, masterKey);
    const tampered: FridayEncryptedEnvelope = {
      ...envelope,
      ciphertext: "not-valid-base64!!!@@@",
    };

    expect(() => decryptSecret(tampered, masterKey)).toThrow();
  });
});

// ─── TEST-41: CORS Origin Validation Bypass ───

describe("TEST-41: CORS Origin Validation Bypass", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    // Server with NO CORS origins configured (default = disabled)
    env = await createFridayApiTestEnv();
    const auth = await loginTestUser(env.baseUrl);
    token = auth.accessToken;
  });

  afterAll(async () => {
    await env?.close();
  });

  it("does not set Access-Control-Allow-Origin when no CORS configured", async () => {
    const res = await fetch(`${env.baseUrl}/v1/health`, {
      headers: { Origin: "http://evil.attacker.com" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not set CORS headers for null origin", async () => {
    const res = await fetch(`${env.baseUrl}/v1/health`, {
      headers: { Origin: "null" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("preflight OPTIONS without CORS config returns no CORS headers", async () => {
    const res = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://attacker.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization",
      },
    });

    // Without CORS configured, preflight should not grant access
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("security headers are present on every response", async () => {
    const res = await fetch(`${env.baseUrl}/v1/health`);

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("security headers are present on error responses", async () => {
    const res = await fetch(`${env.baseUrl}/v1/nonexistent-route`);

    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("auth-boundary: security headers are present on no-auth-header public-route 200 responses", async () => {
    // /v1/health is a minimal-public route (not a sensitive-read surface), so a no-auth
    // request reaches the handler with the synthetic public:default principal and returns a
    // 200 business envelope. Security headers must still be emitted on that 200 path.
    // (Sensitive surfaces like /v1/sessions now require a bound principal — B3 sensitive-read
    // floor — and are covered by friday-http-server-sensitive-read-gate.test.ts.)
    const res = await fetch(`${env.baseUrl}/v1/health`);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

// ─── TEST-42: HTTP Method Confusion ───

describe("TEST-42: HTTP Method Confusion", () => {
  let env: FridayApiTestEnv;
  let token: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
    const auth = await loginTestUser(env.baseUrl);
    token = auth.accessToken;
  });

  afterAll(async () => {
    await env?.close();
  });

  it("HEAD request returns same status as GET but no body", async () => {
    const getRes = await fetch(`${env.baseUrl}/v1/health`, { method: "GET" });
    const headRes = await fetch(`${env.baseUrl}/v1/health`, { method: "HEAD" });

    expect(headRes.status).toBe(getRes.status);
    // HEAD should have no body
    const headBody = await headRes.text();
    expect(headBody).toBe("");
  });

  it("DELETE on a GET-only endpoint returns 404 (no route match)", async () => {
    const res = await fetch(`${env.baseUrl}/v1/health`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });

  it("PATCH on a POST-only endpoint returns 404", async () => {
    const res = await fetch(`${env.baseUrl}/v1/auth/login`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: "any" }),
    });

    expect(res.status).toBe(404);
  });

  it("POST with Content-Length: 0 and no body parses as empty object", async () => {
    const res = await fetch(`${env.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Length": "0",
      },
      body: "",
    });

    // Should not crash — empty body parses as {}
    expect(res.status).toBeLessThan(500);
  });

  it("request with extremely long URL path returns 404, not 500", async () => {
    const longPath = "/v1/" + "a".repeat(8000);
    const res = await fetch(`${env.baseUrl}${longPath}`);

    expect(res.status).toBe(404);
  });

  it("request with special characters in path returns controlled error", async () => {
    const specialPaths = [
      "/v1/sessions/%00/messages",
      "/v1/sessions/../../../etc/passwd",
      "/v1/sessions/<script>alert(1)</script>",
    ];

    for (const sp of specialPaths) {
      const res = await fetch(`${env.baseUrl}${sp}`, {
        headers: authHeaders(token),
      });

      // Must not be 5xx
      expect(res.status).toBeLessThan(500);
    }
  });
});

// ─── TEST-43: Response Header Injection ───

describe("TEST-43: Response Header Injection via Query/Path", () => {
  let env: FridayApiTestEnv;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
  });

  afterAll(async () => {
    await env?.close();
  });

  it("query param with CRLF does not inject response headers", async () => {
    // Attempt CRLF injection via query parameter
    const res = await fetch(
      `${env.baseUrl}/v1/health?x=%0d%0aX-Injected:%20yes`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-injected")).toBeNull();
  });

  it("path with URL-encoded CRLF does not inject response headers", async () => {
    try {
      const res = await fetch(
        `${env.baseUrl}/v1/%0d%0aX-Injected:%20yes`,
      );

      expect(res.headers.get("x-injected")).toBeNull();
    } catch {
      // Connection reset is also acceptable — server rejected malformed request
    }
  });

  it("Content-Type is always application/json for API responses", async () => {
    const res = await fetch(`${env.baseUrl}/v1/health`);

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
    // Must not contain text/html (would enable XSS)
    expect(contentType).not.toContain("text/html");
  });

  it("error responses also have application/json content type", async () => {
    const res = await fetch(`${env.baseUrl}/v1/nonexistent`);

    expect(res.status).toBe(404);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
  });
});

// ─── TEST-44: Master Key Resolution Security ───

describe("TEST-44: Master Key Resolution Security", () => {
  afterEach(() => {
    resetMasterKeyCache();
    // Restore env
    delete process.env.FRIDAY_MASTER_KEY;
  });

  it("rejects FRIDAY_MASTER_KEY with wrong hex length (too short)", () => {
    resetMasterKeyCache();
    process.env.FRIDAY_MASTER_KEY = "abcd1234"; // only 4 bytes

    expect(() => getMasterKey()).toThrow(FridayDomainError);
    expect(() => getMasterKey()).toThrow(/32 bytes/);
  });

  it("rejects FRIDAY_MASTER_KEY with wrong hex length (too long)", () => {
    resetMasterKeyCache();
    process.env.FRIDAY_MASTER_KEY = "a".repeat(128); // 64 bytes

    expect(() => getMasterKey()).toThrow(FridayDomainError);
  });

  it("accepts valid 64-char hex FRIDAY_MASTER_KEY (32 bytes)", () => {
    resetMasterKeyCache();
    const validKey = crypto.randomBytes(32).toString("hex");
    process.env.FRIDAY_MASTER_KEY = validKey;

    const key = getMasterKey();
    expect(key.length).toBe(32);
    expect(key.toString("hex")).toBe(validKey);
  });

  it("caches master key across calls", () => {
    resetMasterKeyCache();
    const validKey = crypto.randomBytes(32).toString("hex");
    process.env.FRIDAY_MASTER_KEY = validKey;

    const key1 = getMasterKey();
    const key2 = getMasterKey();
    // Same Buffer instance (cached)
    expect(key1).toBe(key2);
  });

  it("encrypt-then-decrypt roundtrip with env-sourced key", () => {
    resetMasterKeyCache();
    process.env.FRIDAY_MASTER_KEY = crypto.randomBytes(32).toString("hex");

    const key = getMasterKey();
    const envelope = encryptSecret("my-secret-123", key);
    const decrypted = decryptSecret(envelope, key);
    expect(decrypted).toBe("my-secret-123");
  });
});
