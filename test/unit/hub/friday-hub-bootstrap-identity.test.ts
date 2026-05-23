import { describe, expect, it } from "vitest";
import {
  canResolveFridayChannelApprovalFromMessage,
  createFridayChannelToolApprovalShortId,
  evaluateFridayChannelApprovalExpiry,
  parseFridayChannelIdentityMap,
  resolveFridayChannelApprovalPrincipalId,
  resolveFridayChannelDisabledToolNames,
  resolveFridayChannelSessionKey,
} from "#hub";
import type { FridayChannelMessage } from "#channels";

function makeMessage(overrides?: Partial<FridayChannelMessage>): FridayChannelMessage {
  return {
    id: "msg-1",
    channelKind: "discord",
    senderId: "u-1",
    chatId: "c-1",
    chatType: "direct",
    text: "hello",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("cross-channel identity mapping", () => {
  it("parses flat and nested identity maps", () => {
    const parsed = parseFridayChannelIdentityMap(JSON.stringify({
      "discord:u-1": "Alice",
      telegram: {
        "88": "alice",
      },
    }));

    expect(parsed["discord:u-1"]).toBe("alice");
    expect(parsed["telegram:88"]).toBe("alice");
  });

  it("returns channel-scoped session key when mapping is disabled", () => {
    const key = resolveFridayChannelSessionKey(makeMessage(), {
      crossChannelIdentityEnabled: false,
      identityMap: { "discord:u-1": "alice" },
    });
    expect(key).toBe("channel:discord:c-1");
  });

  it("routes direct messages to omni session when identity mapping exists", () => {
    const key = resolveFridayChannelSessionKey(makeMessage(), {
      crossChannelIdentityEnabled: true,
      identityMap: { "discord:u-1": "alice" },
    });
    expect(key).toBe("omni:default:alice");
  });

  it("keeps group messages channel-scoped even when mapping exists", () => {
    const key = resolveFridayChannelSessionKey(makeMessage({ chatType: "group" }), {
      crossChannelIdentityEnabled: true,
      identityMap: { "discord:u-1": "alice" },
    });
    expect(key).toBe("channel:discord:c-1");
  });

  it("adds thread segment when threadId is present", () => {
    const key = resolveFridayChannelSessionKey(
      makeMessage({ chatType: "group", threadId: "t-42" }),
      {
        crossChannelIdentityEnabled: false,
        identityMap: {},
      },
    );
    expect(key).toBe("channel:discord:c-1-thread-t-42");
  });

  it("does not disable any tools regardless of channel kind", () => {
    expect(resolveFridayChannelDisabledToolNames("discord")).toEqual([]);
    expect(resolveFridayChannelDisabledToolNames("webchat")).toEqual([]);
    expect(resolveFridayChannelDisabledToolNames("telegram")).toEqual([]);
  });

  it("builds channel approval principals from the actual sender", () => {
    expect(resolveFridayChannelApprovalPrincipalId({
      channelKind: "Discord",
      chatId: "Room 1",
      senderId: "User 9",
    })).toBe("channel:discord:room-1:sender:user-9");
  });

  it("allows channel approval resolution only from the original sender", () => {
    const route = {
      channelKind: "discord",
      chatId: "group-1",
      senderId: "user-1",
    };

    expect(canResolveFridayChannelApprovalFromMessage({
      route,
      message: makeMessage({
        chatType: "group",
        chatId: "group-1",
        senderId: "user-1",
      }),
    })).toBe(true);
    expect(canResolveFridayChannelApprovalFromMessage({
      route,
      message: makeMessage({
        chatType: "group",
        channelKind: "telegram",
        chatId: "group-1",
        senderId: "user-1",
      }),
    })).toBe(false);
    expect(canResolveFridayChannelApprovalFromMessage({
      route,
      message: makeMessage({
        chatType: "group",
        chatId: "group-2",
        senderId: "user-1",
      }),
    })).toBe(false);
    expect(canResolveFridayChannelApprovalFromMessage({
      route,
      message: makeMessage({
        chatType: "group",
        chatId: "group-1",
        senderId: "user-2",
      }),
    })).toBe(false);
  });

  it("requires channel approval codes to be unexpired", () => {
    expect(evaluateFridayChannelApprovalExpiry({
      expiresAt: "2026-05-21T10:15:00.000Z",
      nowIso: "2026-05-21T10:14:59.000Z",
    })).toEqual({ expired: false });

    expect(evaluateFridayChannelApprovalExpiry({
      expiresAt: "2026-05-21T10:15:00.000Z",
      nowIso: "2026-05-21T10:15:00.000Z",
    })).toEqual({ expired: true, reason: "approval_expired" });

    expect(evaluateFridayChannelApprovalExpiry({
      expiresAt: "not-a-date",
      nowIso: "2026-05-21T10:15:00.000Z",
    })).toEqual({ expired: true, reason: "approval_expiration_invalid" });
  });

  it("derives stable channel tool approval short codes from run and tool call ids", () => {
    expect(createFridayChannelToolApprovalShortId("run-abc-123456", "tool-xyz-999999")).toBe("999999");
    expect(createFridayChannelToolApprovalShortId("!!!", "***")).toBe("ACTION");
  });
});
