import { describe, expect, it } from "vitest";

import {
  buildChatSessionKey,
  coercePersistedChatSessionKey,
} from "../../../ui/src/hooks/use-chat-session";

describe("useChatSession session key handling", () => {
  it("builds canonical three-segment chat session keys", () => {
    expect(buildChatSessionKey("chat-abc123")).toBe("chat:default:chat-abc123");
  });

  it("migrates legacy one-segment chat keys from local storage", () => {
    expect(coercePersistedChatSessionKey("chat-mnee68fu-n7k3by")).toBe(
      "chat:default:chat-mnee68fu-n7k3by",
    );
  });

  it("migrates malformed stored keys by preserving the chat id segment", () => {
    expect(coercePersistedChatSessionKey(":chat-mnee68fu-n7k3by")).toBe(
      "chat:default:chat-mnee68fu-n7k3by",
    );
    expect(coercePersistedChatSessionKey("chat::chat-mnee68fu-n7k3by")).toBe(
      "chat:default:chat-mnee68fu-n7k3by",
    );
  });

  it("preserves canonical chat session keys", () => {
    expect(coercePersistedChatSessionKey("chat:default:chat-xyz")).toBe(
      "chat:default:chat-xyz",
    );
  });
});
