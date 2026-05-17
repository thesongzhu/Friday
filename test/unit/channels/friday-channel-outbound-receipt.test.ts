// Phase 14.5E module_28e Slice 6.5 — channel-triggered closeout receipt
// helper. The helper does NOT modify the closeout-gate synthesizer; it
// just produces a deterministic, user-facing `nonReversibleReason`
// string for outbound channel sends. The rollback class for
// `channel_event` evidence refs continues to come from the Phase 14.5D
// registry; this test asserts the helper's class field reads from the
// registry rather than hard-coding the value.

import { describe, expect, it } from "vitest";

import { buildFridayChannelOutboundReceiptSummary } from "#channels";
import { FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE } from "../../../src/task-workflows/friday-task-workflow.types.js";

describe("buildFridayChannelOutboundReceiptSummary", () => {
  it("returns rollbackClass non_reversible_external for channel sends", () => {
    const summary = buildFridayChannelOutboundReceiptSummary({
      channelKind: "discord",
      chatId: "chat-1",
      messageId: "msg-1",
    });
    expect(summary.rollbackClass).toBe("non_reversible_external");
    expect(summary.evidenceRefSource).toBe("channel_event");
  });

  it("includes the channelKind:chatId composite in the nonReversibleReason", () => {
    const summary = buildFridayChannelOutboundReceiptSummary({
      channelKind: "telegram",
      chatId: "chat-9999",
      messageId: "msg-1",
    });
    expect(summary.nonReversibleReason).toBe(
      "Channel outbound message delivered to telegram:chat-9999; external delivery not reversible.",
    );
  });

  it("delegates rollback class to the Phase 14.5D registry", () => {
    const summary = buildFridayChannelOutboundReceiptSummary({
      channelKind: "lark",
      chatId: "chat-1",
      messageId: "msg-1",
    });
    expect(summary.rollbackClass).toBe(
      FRIDAY_TASK_WORKFLOW_ROLLBACK_CLASS_BY_REF_SOURCE.channel_event,
    );
  });

  it("rejects empty channelKind, chatId, or messageId", () => {
    expect(() => buildFridayChannelOutboundReceiptSummary({
      channelKind: "",
      chatId: "chat-1",
      messageId: "msg-1",
    })).toThrow();
    expect(() => buildFridayChannelOutboundReceiptSummary({
      channelKind: "discord",
      chatId: "",
      messageId: "msg-1",
    })).toThrow();
    expect(() => buildFridayChannelOutboundReceiptSummary({
      channelKind: "discord",
      chatId: "chat-1",
      messageId: "",
    })).toThrow();
  });
});
