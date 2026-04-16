import { describe, it, expect } from "vitest";
import { FridayDomainError } from "#errors";
import {
  buildFridaySessionKey,
  buildFridayDmSessionKey,
  buildFridaySubagentSessionKey,
  parseFridaySessionKey,
  validateFridaySessionKey,
  normalizeFridaySessionKey,
  canonicalizeFridaySessionKey,
  FRIDAY_SESSION_ERROR_CODES,
} from "#sessions";

function expectSessionError(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.fail("Expected FridayDomainError to be thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(FridayDomainError);
    expect((err as FridayDomainError).code).toBe(code);
  }
}

describe("FridaySessionKey", () => {
  // ─── buildFridaySessionKey ───

  describe("buildFridaySessionKey", () => {
    it("builds canonical key with channel, accountId, chatId", () => {
      expect(buildFridaySessionKey("discord", "chat123", "default")).toBe("discord:default:chat123");
    });

    it("defaults accountId to 'default'", () => {
      expect(buildFridaySessionKey("discord", "chat123")).toBe("discord:default:chat123");
    });

    it("normalizes segments to lowercase", () => {
      expect(buildFridaySessionKey("Discord", "Chat123", "Default")).toBe("discord:default:chat123");
    });

    it("replaces invalid characters with hyphens", () => {
      expect(buildFridaySessionKey("my channel", "chat id")).toBe("my-channel:default:chat-id");
    });

    it("throws on empty channel", () => {
      expectSessionError(
        () => buildFridaySessionKey("", "chat"),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });

    it("throws on empty chatId", () => {
      expectSessionError(
        () => buildFridaySessionKey("discord", ""),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });
  });

  // ─── buildFridayDmSessionKey ───

  describe("buildFridayDmSessionKey", () => {
    it("collapses DM to userId", () => {
      expect(buildFridayDmSessionKey("discord", "user123")).toBe("discord:default:user123");
    });

    it("normalizes userId", () => {
      expect(buildFridayDmSessionKey("discord", "User 123")).toBe("discord:default:user-123");
    });

    it("same user on same channel always maps to same key", () => {
      const key1 = buildFridayDmSessionKey("discord", "user-abc");
      const key2 = buildFridayDmSessionKey("discord", "user-abc");
      expect(key1).toBe(key2);
    });

    it("different channels produce different keys", () => {
      const key1 = buildFridayDmSessionKey("discord", "user-abc");
      const key2 = buildFridayDmSessionKey("slack", "user-abc");
      expect(key1).not.toBe(key2);
    });
  });

  // ─── buildFridaySubagentSessionKey ───

  describe("buildFridaySubagentSessionKey", () => {
    it("builds subagent key from parent + taskId", () => {
      const key = buildFridaySubagentSessionKey("discord:default:user1", "task-abc");
      expect(key).toBe("subagent:discord:default:user1:task-abc");
    });

    it("supports recursive nesting", () => {
      const parent = buildFridaySubagentSessionKey("discord:default:user1", "task-1");
      const nested = buildFridaySubagentSessionKey(parent, "task-2");
      expect(nested).toBe("subagent:subagent:discord:default:user1:task-1:task-2");
    });

    it("throws on invalid parent key", () => {
      expectSessionError(
        () => buildFridaySubagentSessionKey("invalid", "task-1"),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });

    it("normalizes taskId", () => {
      const key = buildFridaySubagentSessionKey("discord:default:user1", "Task ABC");
      expect(key).toBe("subagent:discord:default:user1:task-abc");
    });
  });

  // ─── parseFridaySessionKey ───

  describe("parseFridaySessionKey", () => {
    it("parses conversation key", () => {
      const parts = parseFridaySessionKey("discord:default:user1");
      expect(parts.kind).toBe("conversation");
      expect(parts.channel).toBe("discord");
      expect(parts.accountId).toBe("default");
      expect(parts.chatId).toBe("user1");
      expect(parts.canonicalKey).toBe("discord:default:user1");
    });

    it("parses legacy channel-scoped key as the real channel kind", () => {
      const parts = parseFridaySessionKey("channel:irc:friday-codex-audit");
      expect(parts.kind).toBe("conversation");
      expect(parts.channel).toBe("irc");
      expect(parts.accountId).toBe("default");
      expect(parts.chatId).toBe("friday-codex-audit");
      expect(parts.canonicalKey).toBe("channel:irc:friday-codex-audit");
    });

    it("parses legacy system-scoped key into canonical conversation parts", () => {
      const parts = parseFridaySessionKey("system:heartbeat");
      expect(parts.kind).toBe("conversation");
      expect(parts.channel).toBe("system");
      expect(parts.accountId).toBe("default");
      expect(parts.chatId).toBe("heartbeat");
      expect(parts.canonicalKey).toBe("system:default:heartbeat");
    });

    it("parses subagent key", () => {
      const parts = parseFridaySessionKey("subagent:discord:default:user1:task-1");
      expect(parts.kind).toBe("subagent");
      expect(parts.parentKey).toBe("discord:default:user1");
      expect(parts.taskId).toBe("task-1");
      expect(parts.channel).toBe("discord");
      expect(parts.accountId).toBe("default");
      expect(parts.chatId).toBe("user1");
    });

    it("parses nested subagent key", () => {
      const parts = parseFridaySessionKey("subagent:subagent:discord:default:user1:task-1:task-2");
      expect(parts.kind).toBe("subagent");
      expect(parts.taskId).toBe("task-2");
      expect(parts.parentKey).toBe("subagent:discord:default:user1:task-1");
    });

    it("throws on empty key", () => {
      expectSessionError(
        () => parseFridaySessionKey(""),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });

    it("throws on key with wrong segment count", () => {
      expectSessionError(
        () => parseFridaySessionKey("discord:default"),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });

    it("throws on key with 4 segments (not subagent)", () => {
      expectSessionError(
        () => parseFridaySessionKey("a:b:c:d"),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });

    it("throws on subagent key missing taskId", () => {
      expectSessionError(
        () => parseFridaySessionKey("subagent:"),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });

    it("rejects deeply nested subagent keys exceeding max depth", () => {
      // Build a key with 12 levels of subagent nesting (max is 10)
      let key = "discord:default:chat";
      for (let i = 0; i < 12; i++) {
        key = `subagent:${key}:task-${i}`;
      }
      expectSessionError(
        () => parseFridaySessionKey(key),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });

    it("accepts subagent keys at max allowed depth", () => {
      // Build a key with exactly 10 levels (should pass)
      let key = "discord:default:chat";
      for (let i = 0; i < 10; i++) {
        key = `subagent:${key}:task-${i}`;
      }
      const parsed = parseFridaySessionKey(key);
      expect(parsed.kind).toBe("subagent");
      expect(parsed.channel).toBe("discord");
    });
  });

  // ─── validateFridaySessionKey ───

  describe("validateFridaySessionKey", () => {
    it("does not throw on valid key", () => {
      expect(() => validateFridaySessionKey("discord:default:user1")).not.toThrow();
    });

    it("throws on invalid key", () => {
      expectSessionError(
        () => validateFridaySessionKey("bad"),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });
  });

  describe("canonicalizeFridaySessionKey", () => {
    it("normalizes legacy system-scoped keys to 3 segments", () => {
      expect(canonicalizeFridaySessionKey("system:heartbeat")).toBe("system:default:heartbeat");
    });
  });

  // ─── normalizeFridaySessionKey ───

  describe("normalizeFridaySessionKey", () => {
    it("collapses DM to userId when chatKind is dm", () => {
      const key = normalizeFridaySessionKey({
        channel: "discord",
        chatId: "some-chat-id",
        userId: "user123",
        chatKind: "dm",
      });
      expect(key).toBe("discord:default:user123");
    });

    it("uses chatId for group chats", () => {
      const key = normalizeFridaySessionKey({
        channel: "discord",
        chatId: "group-chat-id",
        userId: "user123",
        chatKind: "group",
      });
      expect(key).toBe("discord:default:group-chat-id");
    });

    it("uses chatId when chatKind is not dm", () => {
      const key = normalizeFridaySessionKey({
        channel: "discord",
        chatId: "channel-id",
        chatKind: "channel",
      });
      expect(key).toBe("discord:default:channel-id");
    });

    it("uses chatId when no chatKind is provided", () => {
      const key = normalizeFridaySessionKey({
        channel: "discord",
        chatId: "chat-id",
      });
      expect(key).toBe("discord:default:chat-id");
    });

    it("group isolation: different chatIds produce different keys", () => {
      const key1 = normalizeFridaySessionKey({
        channel: "discord",
        chatId: "group-1",
        userId: "user-a",
        chatKind: "group",
      });
      const key2 = normalizeFridaySessionKey({
        channel: "discord",
        chatId: "group-2",
        userId: "user-a",
        chatKind: "group",
      });
      expect(key1).not.toBe(key2);
    });

    it("DM collapse: same userId different chatIds produce same key", () => {
      const key1 = normalizeFridaySessionKey({
        channel: "discord",
        chatId: "dm-chat-1",
        userId: "user-a",
        chatKind: "dm",
      });
      const key2 = normalizeFridaySessionKey({
        channel: "discord",
        chatId: "dm-chat-2",
        userId: "user-a",
        chatKind: "dm",
      });
      expect(key1).toBe(key2);
    });
  });

  // ─── canonicalizeFridaySessionKey ───

  describe("canonicalizeFridaySessionKey", () => {
    it("normalizes a conversation key", () => {
      expect(canonicalizeFridaySessionKey("Discord:Default:Chat123")).toBe("discord:default:chat123");
    });

    it("normalizes a legacy channel-scoped key without changing its persisted shape", () => {
      expect(canonicalizeFridaySessionKey("channel:IRC:#Friday Codex Audit"))
        .toBe("channel:irc:friday-codex-audit");
    });

    it("collapses legacy channel thread keys into a 3-segment canonical slot", () => {
      expect(canonicalizeFridaySessionKey("channel:Discord:C 1:thread:T 42"))
        .toBe("channel:discord:c-1--thread--t-42");
    });

    it("normalizes segments with special characters", () => {
      expect(canonicalizeFridaySessionKey("dis cord:def ault:chat 123")).toBe("dis-cord:def-ault:chat-123");
    });

    it("is idempotent on already-canonical keys", () => {
      const key = "discord:default:chat123";
      expect(canonicalizeFridaySessionKey(key)).toBe(key);
    });

    it("normalizes a subagent key", () => {
      const raw = "subagent:Discord:Default:chat123:task1";
      const canonical = canonicalizeFridaySessionKey(raw);
      expect(canonical).toBe("subagent:discord:default:chat123:task1");
    });

    it("throws on empty key", () => {
      expectSessionError(
        () => canonicalizeFridaySessionKey(""),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });

    it("throws on wrong segment count", () => {
      expectSessionError(
        () => canonicalizeFridaySessionKey("just:two"),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });

    it("throws on four segments (non-subagent)", () => {
      expectSessionError(
        () => canonicalizeFridaySessionKey("a:b:c:d"),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });
  });
});
