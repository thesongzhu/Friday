import { describe, expect, it } from "vitest";

import {
  buildChatSessionKey,
  coercePersistedChatSessionKey,
  isSessionAlreadyCreatedError,
  isTerminalChatRunStatus,
  resolveImmediateChatResponse,
} from "../../../ui/src/hooks/use-chat-session";
import { ApiError } from "../../../ui/src/lib/api/types";

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

  it("detects terminal chat run statuses", () => {
    expect(isTerminalChatRunStatus("completed")).toBe(true);
    expect(isTerminalChatRunStatus("failed")).toBe(true);
    expect(isTerminalChatRunStatus("executing")).toBe(false);
  });

  it("treats existing remote chat sessions as successful ensure calls", () => {
    expect(isSessionAlreadyCreatedError(
      new ApiError("SESSION_ALREADY_EXISTS", "Session already exists for key 'chat:default:abc'", 409),
    )).toBe(true);
    expect(isSessionAlreadyCreatedError(
      new ApiError("ALREADY_EXISTS", "Already exists", 409),
    )).toBe(true);
    expect(isSessionAlreadyCreatedError(
      new ApiError("CONFLICT", "Session already exists for key 'chat:default:abc'", 409),
    )).toBe(true);
    expect(isSessionAlreadyCreatedError(
      new ApiError("CONFLICT", "Different conflict", 409),
    )).toBe(false);
  });

  it("extracts immediate completed responses for chat", () => {
    expect(resolveImmediateChatResponse({
      status: "completed",
      response: "Immediate answer",
    })).toBe("Immediate answer");

    expect(resolveImmediateChatResponse({
      status: "completed",
      response: "",
      finalResponse: "Final immediate answer",
    })).toBe("Final immediate answer");

    expect(resolveImmediateChatResponse({
      status: "executing",
      response: "Should wait for SSE",
    })).toBeNull();
  });
});
