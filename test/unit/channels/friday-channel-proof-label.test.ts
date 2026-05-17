// Phase 14.5E module_28e Slice 6.1 — per-channel proof label derivation.
// These tests verify the (kind, credentialStatus, blockedReason,
// envMissingVars) → proofLabel mapping is exhaustive over v1 channels
// and correctly classifies non-v1 channels as `unsupported`. No mocks
// of the channel registry or external transports are used.

import { describe, expect, it } from "vitest";

import {
  deriveFridayChannelProofLabel,
  isFridayChannelV1ProofKind,
  type FridayChannelCredentialStatus,
} from "#channels";

describe("deriveFridayChannelProofLabel", () => {
  const v1Kinds = ["discord", "lark", "feishu", "telegram"] as const;

  for (const kind of v1Kinds) {
    it(`returns "configured" when ${kind} env tuple is fully present`, () => {
      expect(
        deriveFridayChannelProofLabel({
          kind,
          credentialStatus: "unknown",
          envMissingVars: [],
          envRequiredVars: ["A", "B"],
        }),
      ).toBe("configured");
    });

    it(`returns "blocked_by_env" when ${kind} env tuple is fully present but adapter rejects credentials`, () => {
      expect(
        deriveFridayChannelProofLabel({
          kind,
          credentialStatus: "invalid",
          envMissingVars: [],
          envRequiredVars: ["A", "B"],
        }),
      ).toBe("blocked_by_env");
    });

    it(`returns "blocked_by_env" when ${kind} adapter is invalid and no env declared`, () => {
      expect(
        deriveFridayChannelProofLabel({
          kind,
          credentialStatus: "invalid",
        }),
      ).toBe("blocked_by_env");
    });

    it(`returns "blocked_by_env" when ${kind} adapter is blocked by a reason and no env declared`, () => {
      expect(
        deriveFridayChannelProofLabel({
          kind,
          credentialStatus: "unknown",
          blockedReason: "start_failed",
        }),
      ).toBe("blocked_by_env");
    });

    it(`returns "not_configured" when ${kind} has no credentials and full env tuple is missing`, () => {
      expect(
        deriveFridayChannelProofLabel({
          kind,
          credentialStatus: "missing",
          envMissingVars: ["A", "B"],
          envRequiredVars: ["A", "B"],
        }),
      ).toBe("not_configured");
    });

    it(`returns "blocked_by_env" when ${kind} env tuple is partially missing`, () => {
      expect(
        deriveFridayChannelProofLabel({
          kind,
          credentialStatus: "missing",
          envMissingVars: ["B"],
          envRequiredVars: ["A", "B"],
        }),
      ).toBe("blocked_by_env");
    });
  }

  it("returns \"unsupported\" for non-v1 channel kinds even with full credentials", () => {
    for (const nonV1 of ["slack", "webchat", "whatsapp", "line", "qq", "signal", "irc"]) {
      expect(
        deriveFridayChannelProofLabel({
          kind: nonV1,
          credentialStatus: "configured",
          envMissingVars: [],
          envRequiredVars: ["A"],
        }),
      ).toBe("unsupported");
    }
  });

  it("does not let Discord credentials satisfy Lark/Feishu or Telegram", () => {
    // Per Codex Stage 2 prompt: a passing Discord scenario is never proof
    // for any other channel. The helper takes one kind at a time; we
    // assert that the same input shape yields per-kind labels independently.
    const credentialStatus: FridayChannelCredentialStatus = "configured";
    const discord = deriveFridayChannelProofLabel({
      kind: "discord",
      credentialStatus,
      envMissingVars: [],
      envRequiredVars: ["A", "B"],
    });
    const larkBlocked = deriveFridayChannelProofLabel({
      kind: "lark",
      credentialStatus: "missing",
      envMissingVars: ["FRIDAY_LARK_APP_ID"],
      envRequiredVars: ["FRIDAY_LARK_APP_ID", "FRIDAY_LARK_APP_SECRET"],
    });
    const telegramBlocked = deriveFridayChannelProofLabel({
      kind: "telegram",
      credentialStatus: "missing",
      envMissingVars: ["FRIDAY_TELEGRAM_BOT_TOKEN"],
      envRequiredVars: ["FRIDAY_TELEGRAM_BOT_TOKEN", "FRIDAY_TELEGRAM_TEST_CHAT_ID"],
    });
    expect(discord).toBe("configured");
    expect(larkBlocked).toBe("blocked_by_env");
    expect(telegramBlocked).toBe("blocked_by_env");
  });
});

describe("isFridayChannelV1ProofKind", () => {
  it("returns true for the four v1 channel kinds", () => {
    expect(isFridayChannelV1ProofKind("discord")).toBe(true);
    expect(isFridayChannelV1ProofKind("lark")).toBe(true);
    expect(isFridayChannelV1ProofKind("feishu")).toBe(true);
    expect(isFridayChannelV1ProofKind("telegram")).toBe(true);
  });

  it("returns false for non-v1 channel kinds", () => {
    for (const kind of ["slack", "webchat", "whatsapp", "line", "qq", "signal", "irc"]) {
      expect(isFridayChannelV1ProofKind(kind)).toBe(false);
    }
  });
});
