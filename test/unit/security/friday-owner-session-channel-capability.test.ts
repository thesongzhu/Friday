import { describe, expect, it } from "vitest";

import { createFridayDefaultPublicHttpPrincipal } from "../../../src/api/http/friday-default-public-principal.js";
import type { FridayAuthPrincipal } from "../../../src/api/model/friday-api-auth.types.js";
import {
  FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES,
  FRIDAY_WORKFLOW_WEBHOOK_PATH_TOKEN_MIN_LENGTH,
  assertBoundActorForSessionOperation,
  assertBoundPrincipalAuthorityForOperation,
  assertBoundPrincipalForOperation,
  describeWebhookReceiptTrust,
  evaluateWorkflowWebhookGate,
  isUnauthenticatedPublicPrincipal,
  readWorkflowWebhookBearerOnlyAllowlistFromEnv,
  redactSensitiveWebhookHeaders,
  redactWebhookPathTokenInPath,
} from "../../../src/security/friday-owner-session-channel-capability.js";
import { FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID } from "../../../src/api/http/friday-default-public-principal.js";

function realPrincipal(overrides: Partial<FridayAuthPrincipal> = {}): FridayAuthPrincipal {
  return {
    principalType: "user",
    principalId: "user-real-1",
    tenantId: "tenant-1",
    userId: "11111111-1111-1111-1111-111111111111",
    role: "admin",
    scopes: ["agent.write"],
    tokenId: "22222222-2222-2222-2222-222222222222",
    tokenKind: "access",
    issuedAt: "2026-05-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("FridayOwnerSessionChannelCapability", () => {
  describe("isUnauthenticatedPublicPrincipal", () => {
    it("recognizes the synthetic default-public principal as unauthenticated", () => {
      expect(isUnauthenticatedPublicPrincipal(createFridayDefaultPublicHttpPrincipal())).toBe(true);
    });

    it("recognizes a null principal as unauthenticated", () => {
      expect(isUnauthenticatedPublicPrincipal(null)).toBe(true);
      expect(isUnauthenticatedPublicPrincipal(undefined)).toBe(true);
    });

    it("treats a real bearer-backed principal as authenticated", () => {
      expect(isUnauthenticatedPublicPrincipal(realPrincipal())).toBe(false);
    });
  });

  describe("assertBoundPrincipalForOperation", () => {
    it("throws for the synthetic default-public principal", () => {
      let thrown: unknown;
      try {
        assertBoundPrincipalForOperation(
          createFridayDefaultPublicHttpPrincipal(),
          "agent.plan.approve",
          "api",
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
      );
    });

    it("throws for a null principal", () => {
      let thrown: unknown;
      try {
        assertBoundPrincipalForOperation(null, "agent.plan.reject", "api");
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect((thrown as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
      );
    });

    it("returns a bound descriptor for a real principal", () => {
      const bound = assertBoundPrincipalForOperation(realPrincipal(), "agent.tool.approve", "api");
      expect(bound.principalId).toBe("user-real-1");
      expect(bound.source).toBe("api");
      expect(bound.tokenId).toBe("22222222-2222-2222-2222-222222222222");
    });
  });

  describe("assertBoundPrincipalAuthorityForOperation", () => {
    it("throws when a bound principal lacks the required role or scope", () => {
      let thrown: unknown;
      try {
        assertBoundPrincipalAuthorityForOperation(
          realPrincipal({ role: "viewer", scopes: ["workflow.read"] }),
          "workflow.create",
          "api",
          { anyOfScopes: ["workflow.write"], anyOfRoles: ["admin"] },
        );
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_AUTHORITY_REQUIRED,
      );
    });

    it("allows a bound principal with the required write scope", () => {
      const bound = assertBoundPrincipalAuthorityForOperation(
        realPrincipal({ role: "operator", scopes: ["workflow.write"] }),
        "workflow.create",
        "api",
        { anyOfScopes: ["workflow.write"], anyOfRoles: ["admin"] },
      );
      expect(bound.principalId).toBe("user-real-1");
    });
  });

  describe("evaluateWorkflowWebhookGate", () => {
    it("rejects unsigned webhook by default with WORKFLOW_WEBHOOK_HMAC_REQUIRED", () => {
      const decision = evaluateWorkflowWebhookGate({
        pathToken: "weak-token",
        hasSecretRef: false,
      });
      expect(decision).not.toBeNull();
      expect(decision?.errorCode).toBe(FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.WEBHOOK_HMAC_REQUIRED);
      expect(decision?.statusCode).toBe(401);
    });

    it("rejects unsigned opt-in webhook when path token is below the entropy floor", () => {
      const shortToken = "a".repeat(FRIDAY_WORKFLOW_WEBHOOK_PATH_TOKEN_MIN_LENGTH - 1);
      const decision = evaluateWorkflowWebhookGate({
        pathToken: shortToken,
        hasSecretRef: false,
        explicitBearerOnlyAllowlist: new Set([shortToken]),
      });
      expect(decision?.errorCode).toBe(FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.WEBHOOK_PATH_TOKEN_WEAK);
    });

    it("allows unsigned bearer-only webhook when path token is allowlisted and entropy-safe", () => {
      const strongToken = "b".repeat(FRIDAY_WORKFLOW_WEBHOOK_PATH_TOKEN_MIN_LENGTH);
      const decision = evaluateWorkflowWebhookGate({
        pathToken: strongToken,
        hasSecretRef: false,
        explicitBearerOnlyAllowlist: new Set([strongToken]),
      });
      expect(decision).toBeNull();
    });

    it("allows webhook with HMAC secret regardless of allowlist", () => {
      const decision = evaluateWorkflowWebhookGate({
        pathToken: "hook-token-with-hmac",
        hasSecretRef: true,
      });
      expect(decision).toBeNull();
    });
  });

  describe("readWorkflowWebhookBearerOnlyAllowlistFromEnv", () => {
    it("parses comma-separated env values", () => {
      const allowlist = readWorkflowWebhookBearerOnlyAllowlistFromEnv({
        FRIDAY_WORKFLOW_WEBHOOK_BEARER_ONLY_PATH_TOKENS: "alpha, beta ,gamma",
      } as NodeJS.ProcessEnv);
      expect(allowlist.has("alpha")).toBe(true);
      expect(allowlist.has("beta")).toBe(true);
      expect(allowlist.has("gamma")).toBe(true);
      expect(allowlist.size).toBe(3);
    });

    it("returns empty set when env var is missing", () => {
      const allowlist = readWorkflowWebhookBearerOnlyAllowlistFromEnv({} as NodeJS.ProcessEnv);
      expect(allowlist.size).toBe(0);
    });
  });

  describe("redactSensitiveWebhookHeaders", () => {
    it("redacts Authorization, Cookie, Set-Cookie, x-api-key, x-auth-token", () => {
      const redacted = redactSensitiveWebhookHeaders({
        "Content-Type": "application/json",
        Authorization: "Bearer secret-token-do-not-leak",
        cookie: "session=abc",
        "Set-Cookie": "tracking=xyz",
        "X-API-Key": "leak-me-not",
        "x-auth-token": "leak-me-not",
        "x-session-token": "leak-me-not",
        "X-CSRF-Token": "leak-me-not",
        "x-trace-id": "trace-123",
      });
      expect(redacted.Authorization).toBe("[REDACTED]");
      expect(redacted.cookie).toBe("[REDACTED]");
      expect(redacted["Set-Cookie"]).toBe("[REDACTED]");
      expect(redacted["X-API-Key"]).toBe("[REDACTED]");
      expect(redacted["x-auth-token"]).toBe("[REDACTED]");
      expect(redacted["x-session-token"]).toBe("[REDACTED]");
      expect(redacted["X-CSRF-Token"]).toBe("[REDACTED]");
      expect(redacted["Content-Type"]).toBe("application/json");
      expect(redacted["x-trace-id"]).toBe("trace-123");
    });

    it("returns empty object when headers are missing", () => {
      expect(redactSensitiveWebhookHeaders(undefined)).toEqual({});
      expect(redactSensitiveWebhookHeaders(null)).toEqual({});
    });
  });

  describe("redactWebhookPathTokenInPath", () => {
    it("masks the workflow webhook path token segment", () => {
      const masked = redactWebhookPathTokenInPath(
        "/v1/workflow-webhooks/very-secret-token-value?query=ignored",
      );
      expect(masked).toBe("/v1/workflow-webhooks/***?query=ignored");
    });

    it("leaves unrelated paths untouched", () => {
      expect(redactWebhookPathTokenInPath("/v1/agent/runs/abc")).toBe("/v1/agent/runs/abc");
    });
  });

  describe("assertBoundActorForSessionOperation", () => {
    it("throws when actorId is missing", () => {
      let thrown: unknown;
      try {
        assertBoundActorForSessionOperation(undefined, "workflow.approval.approve");
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
      );
    });

    it("throws when actorId is the synthetic public principal id", () => {
      let thrown: unknown;
      try {
        assertBoundActorForSessionOperation(
          FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID,
          "workflow.approval.reject",
        );
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
      );
    });

    it("throws when actorId is the legacy 'system' fallback", () => {
      let thrown: unknown;
      try {
        assertBoundActorForSessionOperation("system", "workflow.approval.approve");
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
      );
    });

    it("returns the actorId when it is a bound user id", () => {
      expect(
        assertBoundActorForSessionOperation("user-real-1", "workflow.approval.approve"),
      ).toBe("user-real-1");
    });

    // Phase 18B CLAW-044: whitespace-only actor IDs were treated as bound
    // principals because `!actorId` returns false for strings like "   ".
    it("throws when actorId is whitespace-only (spaces)", () => {
      let thrown: unknown;
      try {
        assertBoundActorForSessionOperation("   ", "workflow.approval.approve");
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
      );
    });

    it("throws when actorId is whitespace-only (tabs and newlines)", () => {
      let thrown: unknown;
      try {
        assertBoundActorForSessionOperation("\t\n  \r", "workflow.approval.reject");
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
      );
    });

    it("throws when actorId is the empty string", () => {
      let thrown: unknown;
      try {
        assertBoundActorForSessionOperation("", "workflow.approval.approve");
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
      );
    });

    it("throws when actorId is the synthetic public principal id with surrounding whitespace", () => {
      let thrown: unknown;
      try {
        assertBoundActorForSessionOperation(
          `  ${FRIDAY_DEFAULT_PUBLIC_HTTP_PRINCIPAL_ID}  `,
          "workflow.approval.approve",
        );
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
      );
    });

    it("throws when actorId is the legacy 'system' fallback with surrounding whitespace", () => {
      let thrown: unknown;
      try {
        assertBoundActorForSessionOperation("  system\n", "workflow.approval.approve");
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string }).code).toBe(
        FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.BOUND_PRINCIPAL_REQUIRED,
      );
    });

    it("returns a trimmed actorId when surrounded by whitespace", () => {
      expect(
        assertBoundActorForSessionOperation("  user-real-1\t", "workflow.approval.approve"),
      ).toBe("user-real-1");
    });
  });

  describe("describeWebhookReceiptTrust", () => {
    it("labels HMAC-verified receipts", () => {
      expect(
        describeWebhookReceiptTrust({ hadSecret: true, bearerOnlyOptIn: false, pathToken: "x" }),
      ).toBe("hmac-verified");
    });

    it("labels bearer-only opt-in receipts honestly", () => {
      expect(
        describeWebhookReceiptTrust({ hadSecret: false, bearerOnlyOptIn: true, pathToken: "x" }),
      ).toMatch(/bearer-only-opt-in/);
    });

    it("labels rejected receipts as rejected", () => {
      expect(
        describeWebhookReceiptTrust({ hadSecret: false, bearerOnlyOptIn: false, pathToken: "x" }),
      ).toMatch(/rejected/);
    });
  });
});
