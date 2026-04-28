import { describe, expect, it } from "vitest";

import {
  formatFridayChannelOutboundSendOptions,
  formatFridayChannelOutboundText,
} from "#channels";

describe("Friday channel outbound formatting", () => {
  it("strips unsupported markdown strong markers for plain-text channels", () => {
    const text = [
      "**已就绪（可直接用）：**",
      "保留 `**code**` 和 fenced block:",
      "```",
      "**do-not-strip**",
      "```",
      "__English heading__",
    ].join("\n");

    expect(formatFridayChannelOutboundText("lark", text)).toBe([
      "已就绪（可直接用）：",
      "保留 `**code**` 和 fenced block:",
      "```",
      "**do-not-strip**",
      "```",
      "English heading",
    ].join("\n"));
  });

  it("preserves double-asterisk markdown for Discord", () => {
    expect(formatFridayChannelOutboundText("discord", "**Ready**")).toBe("**Ready**");
  });

  it("converts double-asterisk markdown to platform-native single-asterisk bold", () => {
    expect(formatFridayChannelOutboundText("slack", "**Ready** and __set__")).toBe("*Ready* and *set*");
    expect(formatFridayChannelOutboundText("whatsapp", "**Ready**")).toBe("*Ready*");
  });

  it("does not rewrite native approval card payloads", () => {
    const options = {
      chatId: "chat-1",
      text: "**Approval**",
      approval: {
        shortId: "A1",
        toolName: "tool",
        reason: "**needs context**",
        expiresAt: "2026-04-28T19:00:00.000Z",
      },
    };

    expect(formatFridayChannelOutboundSendOptions("lark", options)).toBe(options);
  });
});
