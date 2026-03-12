import { describe, it, expect } from "vitest";
import {
  createFridayTokenValidator,
  encodeToken,
  FridayTokenValidationError,
} from "#api";
import type { FridayAccessTokenClaims } from "#api";

describe("FridayTokenValidator", () => {
  const SECRET = "test-secret-key";
  const NOW_SEC = Math.floor(Date.parse("2025-06-15T10:00:00.000Z") / 1000);

  function makeClaims(overrides?: Partial<FridayAccessTokenClaims>): FridayAccessTokenClaims {
    return {
      tokenId: "tok-001",
      principalType: "user",
      principalId: "user-001",
      userId: "user-001",
      role: "admin",
      scopes: ["workflow.read", "workflow.write"],
      iat: NOW_SEC,
      exp: NOW_SEC + 900,
      ...overrides,
    };
  }

  function makeValidator(overrides?: {
    nowMs?: () => number;
    lookupRevoked?: (id: string) => boolean;
    lookupSatVersion?: (id: string) => number | null;
  }) {
    return createFridayTokenValidator({
      tokenSecret: SECRET,
      nowMs: overrides?.nowMs ?? (() => NOW_SEC * 1000),
      lookupTokenRevocation: overrides?.lookupRevoked ?? (() => false),
      lookupSatelliteTokenVersion: overrides?.lookupSatVersion,
    });
  }

  it("validates a well-formed token", () => {
    const claims = makeClaims();
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator();

    const result = validator.validate(token);
    expect(result.principal.principalId).toBe("user-001");
    expect(result.principal.scopes).toContain("workflow.read");
    expect(result.rawToken).toBe(token);
  });

  it("preserves an explicit tenant claim", () => {
    const claims = makeClaims({ tenantId: "tenant-001" });
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator();

    const result = validator.validate(token);
    expect(result.principal.tenantId).toBe("tenant-001");
  });

  it("defaults tenantId to principalId for legacy claims", () => {
    const claims = makeClaims();
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator();

    const result = validator.validate(token);
    expect(result.principal.tenantId).toBe("user-001");
  });

  it("rejects a token with invalid signature", () => {
    const claims = makeClaims();
    const token = encodeToken(claims, "wrong-secret");
    const validator = makeValidator();

    expect(() => validator.validate(token)).toThrow(FridayTokenValidationError);
    try {
      validator.validate(token);
    } catch (e) {
      expect((e as FridayTokenValidationError).code).toBe("INVALID_SIGNATURE");
    }
  });

  it("rejects an expired token", () => {
    const claims = makeClaims({ exp: NOW_SEC - 100 });
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator();

    expect(() => validator.validate(token)).toThrow(FridayTokenValidationError);
    try {
      validator.validate(token);
    } catch (e) {
      expect((e as FridayTokenValidationError).code).toBe("TOKEN_EXPIRED");
    }
  });

  it("rejects a revoked token", () => {
    const claims = makeClaims();
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator({ lookupRevoked: () => true });

    expect(() => validator.validate(token)).toThrow(FridayTokenValidationError);
    try {
      validator.validate(token);
    } catch (e) {
      expect((e as FridayTokenValidationError).code).toBe("TOKEN_REVOKED");
    }
  });

  it("rejects a satellite token with outdated version", () => {
    const claims = makeClaims({
      principalType: "satellite",
      principalId: "sat-001",
      ver: 1,
    });
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator({
      lookupSatVersion: () => 2,
    });

    expect(() => validator.validate(token)).toThrow(FridayTokenValidationError);
    try {
      validator.validate(token);
    } catch (e) {
      expect((e as FridayTokenValidationError).code).toBe("TOKEN_VERSION_MISMATCH");
    }
  });

  it("accepts a satellite token with matching version", () => {
    const claims = makeClaims({
      principalType: "satellite",
      principalId: "sat-001",
      ver: 2,
    });
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator({
      lookupSatVersion: () => 2,
    });

    const result = validator.validate(token);
    expect(result.principal.principalId).toBe("sat-001");
  });

  it("rejects malformed token (no dot)", () => {
    const validator = makeValidator();
    expect(() => validator.validate("no-dot-token")).toThrow(FridayTokenValidationError);
  });

  it("builds correct principal from claims", () => {
    const claims = makeClaims({
      sid: "session-123",
      ver: 3,
    });
    const token = encodeToken(claims, SECRET);
    const validator = makeValidator();

    const result = validator.validate(token);
    expect(result.principal.tokenKind).toBe("access");
    expect(result.principal.sessionId).toBe("session-123");
    expect(result.principal.tokenVersion).toBe(3);
    expect(result.principal.issuedAt).toBeTruthy();
    expect(result.principal.expiresAt).toBeTruthy();
  });
});
