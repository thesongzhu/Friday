import { describe, expect, it } from "vitest";
import {
  parseFridayChannelIdentityMap,
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
      "discord:u-1": "Jarvis",
      telegram: {
        "88": "jarvis",
      },
    }));

    expect(parsed["discord:u-1"]).toBe("jarvis");
    expect(parsed["telegram:88"]).toBe("jarvis");
  });

  it("returns legacy channel session key when mapping is disabled", () => {
    const key = resolveFridayChannelSessionKey(makeMessage(), {
      crossChannelIdentityEnabled: false,
      identityMap: { "discord:u-1": "jarvis" },
    });
    expect(key).toBe("channel:discord:c-1");
  });

  it("routes direct messages to omni session when identity mapping exists", () => {
    const key = resolveFridayChannelSessionKey(makeMessage(), {
      crossChannelIdentityEnabled: true,
      identityMap: { "discord:u-1": "jarvis" },
    });
    expect(key).toBe("omni:default:jarvis");
  });

  it("keeps group messages channel-scoped even when mapping exists", () => {
    const key = resolveFridayChannelSessionKey(makeMessage({ chatType: "group" }), {
      crossChannelIdentityEnabled: true,
      identityMap: { "discord:u-1": "jarvis" },
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
    expect(key).toBe("channel:discord:c-1:thread:t-42");
  });

  it("does not disable any tools regardless of channel kind", () => {
    expect(resolveFridayChannelDisabledToolNames("discord")).toEqual([]);
    expect(resolveFridayChannelDisabledToolNames("webchat")).toEqual([]);
    expect(resolveFridayChannelDisabledToolNames("telegram")).toEqual([]);
  });
});
