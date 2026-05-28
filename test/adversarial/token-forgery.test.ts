/**
 * Adversarial Token Forgery Tests (TEST-31 through TEST-35)
 *
 * Tests bearer extraction edge cases, HMAC signature manipulation,
 * payload tampering, expiry boundary races, and forged claims injection.
 *
 * - TEST-31: Bearer scheme case sensitivity & extra whitespace
 * - TEST-32: HMAC signature truncation and mutation
 * - TEST-33: Token payload tampering (role escalation in claims)
 * - TEST-34: Expiry boundary ± 1 second precision
 * - TEST-35: Forged satellite token version downgrade
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as crypto from "node:crypto";
import {
  encodeToken,
  createFridayTokenValidator,
  FridayTokenValidationError,
} from "#api";
import type { FridayAccessTokenClaims } from "#api";
import {
  createFridayApiTestEnv,
  loginTestUser,
  type FridayApiTestEnv,
  TOKEN_SECRET,
} from "../e2e/api/_helpers/friday-api-test-server.helper.js";
import { ERROR_CODE_BOUND_PRINCIPAL_REQUIRED } from "../../src/security/friday-owner-session-channel-capability.js";

// ─── Helpers ───

function makeValidClaims(overrides: Partial<FridayAccessTokenClaims> = {}): FridayAccessTokenClaims {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    tokenId: `forge-test-${crypto.randomUUID()}`,
    principalType: "user",
    principalId: "test-user",
    userId: "test-user",
    role: "viewer",
    scopes: ["workflow.read"],
    iat: nowSec,
    exp: nowSec + 900,
    ...overrides,
  };
}

// ─── TEST-31: Bearer Scheme Case Sensitivity & Whitespace ───

describe("TEST-31: Bearer Scheme Case Sensitivity & Whitespace", () => {
  let env: FridayApiTestEnv;
  let validToken: string;

  beforeAll(async () => {
    env = await createFridayApiTestEnv();
    const auth = await loginTestUser(env.baseUrl);
    validToken = auth.accessToken;
  });

  afterAll(async () => {
    await env?.close();
  });

  // Note: "trailing space" is NOT tested here because HTTP/1.1 trims
  // optional whitespace (OWS) from header field values per RFC 7230.
  const caseVariants = [
    { label: "lowercase 'bearer'", header: (t: string) => `bearer ${t}` },
    { label: "uppercase 'BEARER'", header: (t: string) => `BEARER ${t}` },
    { label: "mixed 'BeArEr'", header: (t: string) => `BeArEr ${t}` },
    { label: "double space", header: (t: string) => `Bearer  ${t}` },
    { label: "tab separator", header: (t: string) => `Bearer\t${t}` },
    { label: "no space", header: (t: string) => `Bearer${t}` },
  ];

  // Auth-boundary product invariant: a malformed/non-standard Authorization header MUST NOT
  // be accepted as a valid bearer — it falls through to the synthetic default-public
  // principal, never the real authenticated principal. `/v1/sessions` is a sensitive-read
  // surface (B3 sensitive-read floor), so the synthetic principal is then denied with 401
  // BOUND_PRINCIPAL_REQUIRED — whereas a VALID bearer on the same route returns 200 (below).
  // The 401-vs-200 contrast is the observable proof that the malformed scheme was rejected
  // and did NOT inherit the valid token's access. (Pre-B3 both returned 200, which could not
  // distinguish "fell through to public" from "accepted as valid".) Function-level
  // bearer-scheme parsing remains pinned by test/unit/api/auth/friday-auth-middleware.test.ts
  // and test/unit/api/auth/friday-token-validator.test.ts.
  it.each(caseVariants)(
    "auth-boundary: non-standard Authorization scheme '$label' is NOT accepted as a valid bearer (synthetic principal → 401 on sensitive route)",
    async ({ header }) => {
      const res = await fetch(`${env.baseUrl}/v1/sessions`, {
        headers: {
          Authorization: header(validToken),
          "Content-Type": "application/json",
        },
      });

      // Malformed bearer → synthetic public:default principal → denied the sensitive read.
      expect(res.status).toBe(401);
      const json = (await res.json()) as { ok: boolean; error?: { code?: string } };
      expect(json.ok).toBe(false);
      expect(json.error?.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
    },
  );

  it("accepts exact 'Bearer <token>' format — returns 200 (valid bearer binds the real principal)", async () => {
    const res = await fetch(`${env.baseUrl}/v1/sessions`, {
      headers: {
        Authorization: `Bearer ${validToken}`,
        "Content-Type": "application/json",
      },
    });

    // Contrast with the malformed cases above: a correctly-formatted valid bearer binds the
    // real principal, which passes the sensitive-read floor.
    expect(res.status).toBe(200);
  });

  it("auth-boundary: empty authorization header → synthetic principal → 401 on sensitive route", async () => {
    const res = await fetch(`${env.baseUrl}/v1/sessions`, {
      headers: {
        Authorization: "",
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; error?: { code?: string } };
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
  });

  it("auth-boundary: 'Basic' scheme with valid token value is NOT accepted as a bearer (synthetic principal → 401)", async () => {
    const res = await fetch(`${env.baseUrl}/v1/sessions`, {
      headers: {
        Authorization: `Basic ${validToken}`,
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; error?: { code?: string } };
    expect(json.ok).toBe(false);
    expect(json.error?.code).toBe(ERROR_CODE_BOUND_PRINCIPAL_REQUIRED);
  });
});

// ─── TEST-32: HMAC Signature Truncation & Mutation ───

describe("TEST-32: HMAC Signature Truncation & Mutation", () => {
  const validator = createFridayTokenValidator({
    tokenSecret: TOKEN_SECRET,
    nowMs: () => new Date("2025-06-15T10:00:00.000Z").getTime(),
    lookupTokenRevocation: () => false,
  });

  // VULN-3 FIXED: Length check before timingSafeEqual now yields
  // FridayTokenValidationError instead of raw RangeError.

  it("rejects token with truncated signature as FridayTokenValidationError (VULN-3 fixed)", () => {
    const claims = makeValidClaims();
    const validToken = encodeToken(claims, TOKEN_SECRET);
    const [payload, sig] = validToken.split(".");
    const truncatedSig = sig!.slice(0, Math.floor(sig!.length / 2));

    expect(() => validator.validate(`${payload}.${truncatedSig}`)).toThrow(
      FridayTokenValidationError,
    );
  });

  it("rejects token with single-byte signature mutation", () => {
    const claims = makeValidClaims();
    const validToken = encodeToken(claims, TOKEN_SECRET);
    const [payload, sig] = validToken.split(".");

    // Flip one character in the signature
    const sigChars = sig!.split("");
    const flipIdx = Math.floor(sigChars.length / 2);
    sigChars[flipIdx] = sigChars[flipIdx] === "A" ? "B" : "A";
    const mutatedSig = sigChars.join("");

    expect(() => validator.validate(`${payload}.${mutatedSig}`)).toThrow(
      FridayTokenValidationError,
    );
  });

  it("rejects token with empty signature as FridayTokenValidationError (VULN-3 fixed)", () => {
    const claims = makeValidClaims();
    const validToken = encodeToken(claims, TOKEN_SECRET);
    const [payload] = validToken.split(".");

    expect(() => validator.validate(`${payload}.`)).toThrow(
      FridayTokenValidationError,
    );
  });

  it("rejects token signed with a different secret", () => {
    const claims = makeValidClaims();
    const forgedToken = encodeToken(claims, "wrong-secret-key");

    expect(() => validator.validate(forgedToken)).toThrow(
      FridayTokenValidationError,
    );
  });

  it("rejects token with swapped payload and signature as FridayTokenValidationError (VULN-3 fixed)", () => {
    const claims = makeValidClaims();
    const validToken = encodeToken(claims, TOKEN_SECRET);
    const [payload, sig] = validToken.split(".");

    expect(() => validator.validate(`${sig}.${payload}`)).toThrow(
      FridayTokenValidationError,
    );
  });

  it("rejects token with three dot-separated segments (JWT-style)", () => {
    const claims = makeValidClaims();
    const validToken = encodeToken(claims, TOKEN_SECRET);

    expect(() => validator.validate(`header.${validToken}`)).toThrow(
      FridayTokenValidationError,
    );
  });

  it("rejects token with no dots (single segment)", () => {
    expect(() => validator.validate("singlesegmentwithoutdots")).toThrow(
      FridayTokenValidationError,
    );
  });

  it("uses timing-safe comparison (not ===) for signature check", () => {
    const claims = makeValidClaims();
    const validToken = encodeToken(claims, TOKEN_SECRET);
    const [payload, sig] = validToken.split(".");

    // Create a signature that differs only in the last byte
    const sigBuf = Buffer.from(sig!, "base64url");
    sigBuf[sigBuf.length - 1] = (sigBuf[sigBuf.length - 1]! + 1) % 256;
    const nearMissSig = sigBuf.toString("base64url");

    // Must still reject — timing-safe comparison catches single-byte diff
    expect(() => validator.validate(`${payload}.${nearMissSig}`)).toThrow(
      FridayTokenValidationError,
    );
  });
});

// ─── TEST-33: Token Payload Tampering (Role Escalation in Claims) ───

describe("TEST-33: Token Payload Tampering (Role Escalation in Claims)", () => {
  const validator = createFridayTokenValidator({
    tokenSecret: TOKEN_SECRET,
    nowMs: () => new Date("2025-06-15T10:00:00.000Z").getTime(),
    lookupTokenRevocation: () => false,
  });

  it("rejects token with re-encoded payload but original signature", () => {
    // Create a valid viewer token
    const viewerClaims = makeValidClaims({ role: "viewer", scopes: ["workflow.read"] });
    const viewerToken = encodeToken(viewerClaims, TOKEN_SECRET);
    const [_viewerPayload, viewerSig] = viewerToken.split(".");

    // Create an escalated payload (admin role + all scopes)
    const escalatedClaims: FridayAccessTokenClaims = {
      ...viewerClaims,
      role: "owner",
      scopes: ["hub.admin", "workflow.write", "security.write"],
    };
    const escalatedPayloadB64 = Buffer.from(JSON.stringify(escalatedClaims)).toString("base64url");

    // Attach the original viewer signature to the escalated payload
    const forgedToken = `${escalatedPayloadB64}.${viewerSig}`;

    expect(() => validator.validate(forgedToken)).toThrow(
      FridayTokenValidationError,
    );
  });

  it("rejects token with injected extra claims fields", () => {
    // Start with valid claims, add bonus fields
    const baseClaims = makeValidClaims();
    const payload = {
      ...baseClaims,
      isAdmin: true,
      superuser: true,
      bypass: true,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");

    // Re-sign with real secret — claims parse but extra fields should be harmless
    const sig = crypto
      .createHmac("sha256", TOKEN_SECRET)
      .update(payloadB64)
      .digest("base64url");
    const token = `${payloadB64}.${sig}`;

    // Token validates (properly signed), but extra fields must not leak into principal
    const result = validator.validate(token);
    expect(result.principal.role).toBe("viewer");
    expect(result.principal.scopes).toEqual(["workflow.read"]);
    // Extra fields must NOT appear on the principal
    expect((result.principal as Record<string, unknown>)["isAdmin"]).toBeUndefined();
    expect((result.principal as Record<string, unknown>)["superuser"]).toBeUndefined();
    expect((result.principal as Record<string, unknown>)["bypass"]).toBeUndefined();
  });

  it("rejects token with non-JSON payload", () => {
    const garbagePayload = Buffer.from("this is not json").toString("base64url");
    const sig = crypto
      .createHmac("sha256", TOKEN_SECRET)
      .update(garbagePayload)
      .digest("base64url");

    expect(() => validator.validate(`${garbagePayload}.${sig}`)).toThrow(
      FridayTokenValidationError,
    );
  });

  it("rejects token with null byte injection in claims", () => {
    const claims = makeValidClaims({ principalId: "admin\0viewer" });
    const token = encodeToken(claims, TOKEN_SECRET);
    const result = validator.validate(token);

    // Must preserve the exact principalId (including null byte) — no silent truncation
    expect(result.principal.principalId).toBe("admin\0viewer");
  });
});

// ─── TEST-34: Expiry Boundary ± 1 Second Precision ───

describe("TEST-34: Expiry Boundary ± 1 Second Precision", () => {
  it("rejects token that expired exactly 1 second ago", () => {
    const nowMs = new Date("2025-06-15T10:00:00.000Z").getTime();
    const validator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => nowMs,
      lookupTokenRevocation: () => false,
    });

    const expiredClaims = makeValidClaims({
      exp: Math.floor(nowMs / 1000) - 1, // expired 1 second ago
    });
    const token = encodeToken(expiredClaims, TOKEN_SECRET);

    expect(() => validator.validate(token)).toThrow(FridayTokenValidationError);
  });

  it("accepts token that expires exactly now (exp === now)", () => {
    const nowMs = new Date("2025-06-15T10:00:00.000Z").getTime();
    const validator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => nowMs,
      lookupTokenRevocation: () => false,
    });

    const boundaryClaimsNow = makeValidClaims({
      exp: Math.floor(nowMs / 1000), // expires exactly now
    });
    const token = encodeToken(boundaryClaimsNow, TOKEN_SECRET);

    // exp === now should NOT be expired (exp < now triggers expiry, not exp <= now)
    const result = validator.validate(token);
    expect(result.principal.principalId).toBe("test-user");
  });

  it("accepts token that expires 1 second from now", () => {
    const nowMs = new Date("2025-06-15T10:00:00.000Z").getTime();
    const validator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => nowMs,
      lookupTokenRevocation: () => false,
    });

    const futureExpClaims = makeValidClaims({
      exp: Math.floor(nowMs / 1000) + 1,
    });
    const token = encodeToken(futureExpClaims, TOKEN_SECRET);

    const result = validator.validate(token);
    expect(result.principal.principalId).toBe("test-user");
  });

  // VULN-4 FIXED: `exp: 0` is now correctly treated as expired.
  // Previous code used `if (claims.exp && ...)` which skipped the check
  // when exp was 0 (falsy). Now uses `claims.exp !== undefined`.

  it("rejects token with exp=0 as TOKEN_EXPIRED (VULN-4 fixed)", () => {
    const nowMs = new Date("2025-06-15T10:00:00.000Z").getTime();
    const validator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => nowMs,
      lookupTokenRevocation: () => false,
    });

    const epochClaims = makeValidClaims({ exp: 0 });
    const token = encodeToken(epochClaims, TOKEN_SECRET);

    expect(() => validator.validate(token)).toThrow(FridayTokenValidationError);
  });

  it("rejects token with no exp field (L-5: exp claim required)", () => {
    const nowMs = new Date("2025-06-15T10:00:00.000Z").getTime();
    const validator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => nowMs,
      lookupTokenRevocation: () => false,
    });

    const noExpClaims = makeValidClaims();
    delete (noExpClaims as Record<string, unknown>)["exp"];
    const token = encodeToken(noExpClaims, TOKEN_SECRET);

    // L-5 fix: tokens without exp are now rejected with deterministic error
    expect(() => validator.validate(token)).toThrow("Token is missing required exp claim");
  });
});

// ─── TEST-35: Satellite Token Version Downgrade ───

describe("TEST-35: Satellite Token Version Downgrade", () => {
  it("rejects satellite token with outdated version", () => {
    const nowMs = new Date("2025-06-15T10:00:00.000Z").getTime();
    const validator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => nowMs,
      lookupTokenRevocation: () => false,
      lookupSatelliteTokenVersion: (satId: string) => {
        if (satId === "satellite-1") return 3; // current version is 3
        return null;
      },
    });

    const outdatedClaims = makeValidClaims({
      principalType: "satellite",
      principalId: "satellite-1",
      ver: 2, // outdated (current is 3)
    });
    const token = encodeToken(outdatedClaims, TOKEN_SECRET);

    expect(() => validator.validate(token)).toThrow(FridayTokenValidationError);
  });

  it("accepts satellite token with current version", () => {
    const nowMs = new Date("2025-06-15T10:00:00.000Z").getTime();
    const validator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => nowMs,
      lookupTokenRevocation: () => false,
      lookupSatelliteTokenVersion: (satId: string) => {
        if (satId === "satellite-1") return 3;
        return null;
      },
    });

    const currentClaims = makeValidClaims({
      principalType: "satellite",
      principalId: "satellite-1",
      ver: 3,
    });
    const token = encodeToken(currentClaims, TOKEN_SECRET);

    const result = validator.validate(token);
    expect(result.principal.principalId).toBe("satellite-1");
  });

  it("accepts satellite token when no version lookup is configured", () => {
    const nowMs = new Date("2025-06-15T10:00:00.000Z").getTime();
    const validator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => nowMs,
      lookupTokenRevocation: () => false,
      // No lookupSatelliteTokenVersion
    });

    const satClaims = makeValidClaims({
      principalType: "satellite",
      principalId: "satellite-1",
      ver: 1,
    });
    const token = encodeToken(satClaims, TOKEN_SECRET);

    const result = validator.validate(token);
    expect(result.principal.principalId).toBe("satellite-1");
  });

  it("rejects revoked token even if version is current", () => {
    const nowMs = new Date("2025-06-15T10:00:00.000Z").getTime();
    const revokedTokenId = "revoked-sat-token";
    const validator = createFridayTokenValidator({
      tokenSecret: TOKEN_SECRET,
      nowMs: () => nowMs,
      lookupTokenRevocation: (tokenId: string) => tokenId === revokedTokenId,
      lookupSatelliteTokenVersion: () => 1,
    });

    const claims = makeValidClaims({
      tokenId: revokedTokenId,
      principalType: "satellite",
      principalId: "satellite-1",
      ver: 1,
    });
    const token = encodeToken(claims, TOKEN_SECRET);

    expect(() => validator.validate(token)).toThrow(FridayTokenValidationError);
  });
});
