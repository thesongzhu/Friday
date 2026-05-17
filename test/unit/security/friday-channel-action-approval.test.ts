// Phase 14.5E module_28e Slice 6.4 — owner-signed approval token verifier
// and `channel.action.high_risk.approve` gate. These tests cover:
//   - refusal of `source: "channel"` outright;
//   - acceptance with `source: "api"` and a valid owner-signed token;
//   - acceptance with `source: "session"` and a valid owner-signed token;
//   - refusal on expired token;
//   - refusal on context mismatch (actionId/channelId/principalId);
//   - refusal on tampered signature.

import { describe, expect, it } from "vitest";

import {
  FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES,
  assertBoundPrincipalForOperation,
} from "../../../src/security/friday-owner-session-channel-capability.js";
import {
  FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES,
  signFridayChannelActionApprovalToken,
  verifyFridayChannelActionApprovalToken,
} from "../../../src/security/friday-channel-action-approval.js";
import type { FridayAuthPrincipal } from "../../../src/api/model/friday-api-auth.types.js";

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
    issuedAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

const SIGNING_KEY = "phase-14-5e-test-signing-key";

describe("channel.action.high_risk gate", () => {
  it("refuses source: \"channel\" outright for the approve operation", () => {
    let thrown: unknown;
    try {
      assertBoundPrincipalForOperation(
        realPrincipal(),
        "channel.action.high_risk.approve",
        "channel",
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.CHANNEL_HIGH_RISK_SOURCE_REFUSED,
    );
  });

  it("refuses source: \"channel\" outright for the execute operation", () => {
    let thrown: unknown;
    try {
      assertBoundPrincipalForOperation(
        realPrincipal(),
        "channel.action.high_risk.execute",
        "channel",
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_OWNER_SESSION_CHANNEL_ERROR_CODES.CHANNEL_HIGH_RISK_SOURCE_REFUSED,
    );
  });

  it("accepts source: \"api\" with a bound principal", () => {
    const bound = assertBoundPrincipalForOperation(
      realPrincipal(),
      "channel.action.high_risk.approve",
      "api",
    );
    expect(bound.source).toBe("api");
    expect(bound.principalId).toBe("user-real-1");
  });

  it("accepts source: \"session\" with a bound principal", () => {
    const bound = assertBoundPrincipalForOperation(
      realPrincipal(),
      "channel.action.high_risk.approve",
      "session",
    );
    expect(bound.source).toBe("session");
  });

  it("does not change the gate for unrelated operations from source: \"channel\"", () => {
    const bound = assertBoundPrincipalForOperation(
      realPrincipal(),
      "task.workflow.evidence.attach",
      "channel",
    );
    expect(bound.source).toBe("channel");
  });
});

describe("verifyFridayChannelActionApprovalToken", () => {
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const baseTokenInput = {
    actionId: "act-1",
    channelId: "discord:chat-1",
    principalId: "user-real-1",
    riskLevel: "high" as const,
    expiresAt,
    signingKey: SIGNING_KEY,
  };

  it("verifies a freshly signed token end-to-end", () => {
    const token = signFridayChannelActionApprovalToken(baseTokenInput);
    const payload = verifyFridayChannelActionApprovalToken({
      token,
      actionId: "act-1",
      channelId: "discord:chat-1",
      principalId: "user-real-1",
      nowIso: "2026-05-17T00:00:00.000Z",
      signingKey: SIGNING_KEY,
    });
    expect(payload.actionId).toBe("act-1");
    expect(payload.channelId).toBe("discord:chat-1");
    expect(payload.principalId).toBe("user-real-1");
    expect(payload.expiresAt).toBe(expiresAt);
  });

  it("refuses on expired timestamp", () => {
    const token = signFridayChannelActionApprovalToken({
      ...baseTokenInput,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    let thrown: unknown;
    try {
      verifyFridayChannelActionApprovalToken({
        token,
        actionId: "act-1",
        channelId: "discord:chat-1",
        principalId: "user-real-1",
        nowIso: "2026-05-17T00:00:00.000Z",
        signingKey: SIGNING_KEY,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_EXPIRED,
    );
  });

  it("refuses on actionId mismatch", () => {
    const token = signFridayChannelActionApprovalToken(baseTokenInput);
    let thrown: unknown;
    try {
      verifyFridayChannelActionApprovalToken({
        token,
        actionId: "act-other",
        channelId: "discord:chat-1",
        principalId: "user-real-1",
        nowIso: "2026-05-17T00:00:00.000Z",
        signingKey: SIGNING_KEY,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_CONTEXT_MISMATCH,
    );
  });

  it("refuses on channelId mismatch", () => {
    const token = signFridayChannelActionApprovalToken(baseTokenInput);
    let thrown: unknown;
    try {
      verifyFridayChannelActionApprovalToken({
        token,
        actionId: "act-1",
        channelId: "telegram:chat-1",
        principalId: "user-real-1",
        nowIso: "2026-05-17T00:00:00.000Z",
        signingKey: SIGNING_KEY,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_CONTEXT_MISMATCH,
    );
  });

  it("refuses on tampered signature", () => {
    const token = signFridayChannelActionApprovalToken(baseTokenInput);
    const [payload, signature] = token.split(".");
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
    const tampered = `${payload}.${signature.replace(/[0-9a-f]/, (c) => (c === "0" ? "1" : "0"))}`;
    let thrown: unknown;
    try {
      verifyFridayChannelActionApprovalToken({
        token: tampered,
        actionId: "act-1",
        channelId: "discord:chat-1",
        principalId: "user-real-1",
        nowIso: "2026-05-17T00:00:00.000Z",
        signingKey: SIGNING_KEY,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_SIGNATURE_INVALID,
    );
  });

  it("refuses tokens with malformed wire format", () => {
    let thrown: unknown;
    try {
      verifyFridayChannelActionApprovalToken({
        token: "not-a-token",
        actionId: "act-1",
        channelId: "discord:chat-1",
        principalId: "user-real-1",
        nowIso: "2026-05-17T00:00:00.000Z",
        signingKey: SIGNING_KEY,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe(
      FRIDAY_CHANNEL_ACTION_APPROVAL_ERROR_CODES.TOKEN_MALFORMED,
    );
  });
});
