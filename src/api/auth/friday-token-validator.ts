import * as crypto from "node:crypto";
import { FridayDomainError } from "#errors";
import type {
  FridayAccessTokenClaims,
  FridayAuthPrincipal,
  FridayValidatedToken,
} from "../model/friday-api-auth.types.js";
import type { FridayPrincipalType } from "../model/friday-api-principal.types.js";

// ─── Interface ───

export interface FridayTokenValidator {
  validate(rawToken: string): FridayValidatedToken;
}

export interface CreateFridayTokenValidatorDeps {
  tokenSecret: string;
  nowMs: () => number;
  lookupTokenRevocation: (tokenId: string) => boolean;
  lookupSessionTokenState?: (claims: FridayAccessTokenClaims) => "active" | "revoked" | "unknown";
  lookupSatelliteTokenVersion?: (satelliteId: string) => number | null;
  resolveTenantId?: (claims: FridayAccessTokenClaims) => string | null | undefined;
}

function normalizeTenantId(value: string | null | undefined): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

// ─── Token encoding (HMAC-SHA256 based, NOT JWT — simpler for local-first) ───

export function encodeToken(claims: FridayAccessTokenClaims, secret: string): string {
  const payloadJson = JSON.stringify(claims);
  const payloadB64 = Buffer.from(payloadJson).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

// ─── Factory ───

export function createFridayTokenValidator(
  deps: CreateFridayTokenValidatorDeps,
): FridayTokenValidator {
  return {
    validate(rawToken: string): FridayValidatedToken {
      const parts = rawToken.split(".");
      if (parts.length !== 2) {
        throw new FridayTokenValidationError("INVALID_FORMAT", "Token format is invalid");
      }

      const [payloadB64, sig] = parts;
      const expectedSig = crypto
        .createHmac("sha256", deps.tokenSecret)
        .update(payloadB64)
        .digest("base64url");

      const sigBuf = Buffer.from(sig);
      const expectedSigBuf = Buffer.from(expectedSig);
      if (sigBuf.length !== expectedSigBuf.length || !crypto.timingSafeEqual(sigBuf, expectedSigBuf)) {
        throw new FridayTokenValidationError("INVALID_SIGNATURE", "Token signature verification failed");
      }

      const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
      let claims: FridayAccessTokenClaims;
      try {
        claims = JSON.parse(payloadJson) as FridayAccessTokenClaims;
      } catch (err) {
        console.warn("[friday][token-validator] token payload parse failed:", err instanceof Error ? err.message : String(err));
        throw new FridayTokenValidationError("INVALID_FORMAT", "Token payload is invalid JSON");
      }

      // Expiry check — tokens without an exp claim are rejected
      if (claims.exp === undefined || claims.exp === null) {
        throw new FridayTokenValidationError("TOKEN_MISSING_EXP", "Token is missing required exp claim");
      }
      const nowSec = Math.floor(deps.nowMs() / 1000);
      if (claims.exp < nowSec) {
        throw new FridayTokenValidationError("TOKEN_EXPIRED", "Token has expired");
      }

      // Revocation check
      if (deps.lookupTokenRevocation(claims.tokenId)) {
        throw new FridayTokenValidationError("TOKEN_REVOKED", "Token has been revoked");
      }

      if (deps.lookupSessionTokenState && claims.sid) {
        const sessionTokenState = deps.lookupSessionTokenState(claims);
        if (sessionTokenState === "revoked") {
          throw new FridayTokenValidationError("TOKEN_REVOKED", "Token session has been revoked");
        }
        if (sessionTokenState === "unknown") {
          throw new FridayTokenValidationError(
            "TOKEN_UNTRACKED",
            "Token was issued before access-token tracking was enabled and must be reissued",
          );
        }
      }

      // Satellite token version check
      if (
        claims.principalType === "satellite" &&
        claims.ver !== undefined &&
        deps.lookupSatelliteTokenVersion
      ) {
        const currentVersion = deps.lookupSatelliteTokenVersion(claims.principalId);
        if (currentVersion !== null && claims.ver < currentVersion) {
          throw new FridayTokenValidationError(
            "TOKEN_VERSION_MISMATCH",
            "Satellite token version is outdated",
          );
        }
      }

      const principal: FridayAuthPrincipal = {
        principalType: claims.principalType as FridayPrincipalType,
        principalId: claims.principalId,
        tenantId: normalizeTenantId(deps.resolveTenantId?.(claims))
          ?? normalizeTenantId(claims.tenantId)
          ?? claims.principalId,
        userId: claims.userId,
        role: claims.role,
        scopes: claims.scopes,
        tokenId: claims.tokenId,
        tokenKind: "access",
        issuedAt: new Date(claims.iat * 1000).toISOString(),
        expiresAt: claims.exp !== undefined ? new Date(claims.exp * 1000).toISOString() : undefined,
        sessionId: claims.sid,
        tokenVersion: claims.ver,
      };

      return { principal, rawToken, claims };
    },
  };
}

// ─── Error class ───

export class FridayTokenValidationError extends FridayDomainError {
  override readonly name = "FridayTokenValidationError";
  constructor(code: string, message: string) {
    super(code, message, { httpStatus: 401 });
  }
}
