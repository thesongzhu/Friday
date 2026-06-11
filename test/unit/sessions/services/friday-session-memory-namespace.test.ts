import { describe, it, expect } from "vitest";
import { FridayDomainError } from "#errors";
import {
  resolveFridaySessionMemoryNamespace,
  buildFridaySessionMemorySource,
  buildFridaySessionMemoryMetadata,
  FRIDAY_SESSION_ERROR_CODES,
} from "#sessions";
import type { FridaySessionRecord } from "#sessions";

function makeSession(overrides: Partial<FridaySessionRecord> = {}): FridaySessionRecord {
  return {
    id: "sess-1",
    key: "discord:default:user1",
    channel: "discord",
    accountId: "default",
    chatId: "user1",
    chatKind: "dm",
    status: "active",
    metadata: {},
    contextInputTokens: 0,
    contextOutputTokens: 0,
    contextTotalTokens: 0,
    messageCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("FridaySessionMemoryNamespace", () => {
  // ─── resolveFridaySessionMemoryNamespace ───

  describe("resolveFridaySessionMemoryNamespace", () => {
    it("resolves namespace from userId", () => {
      const session = makeSession({ userId: "user-abc" });
      const ns = resolveFridaySessionMemoryNamespace(session);
      expect(ns).toBe("tenant.default.channel.discord.user.user-abc.shared");
    });

    it("normalizes userId to lowercase", () => {
      const session = makeSession({ userId: "User-ABC" });
      const ns = resolveFridaySessionMemoryNamespace(session);
      expect(ns).toBe("tenant.default.channel.discord.user.user-abc.shared");
    });

    it("same userId across channels resolves to different namespaces", () => {
      const discordSession = makeSession({
        key: "discord:default:user-x",
        channel: "discord",
        userId: "user-x",
      });
      const slackSession = makeSession({
        key: "slack:default:user-x",
        channel: "slack",
        userId: "user-x",
      });

      const ns1 = resolveFridaySessionMemoryNamespace(discordSession);
      const ns2 = resolveFridaySessionMemoryNamespace(slackSession);
      expect(ns1).toBe("tenant.default.channel.discord.user.user-x.shared");
      expect(ns2).toBe("tenant.default.channel.slack.user.user-x.shared");
      expect(ns1).not.toBe(ns2);
    });

    it("different userIds resolve to different namespaces", () => {
      const session1 = makeSession({ userId: "user-a" });
      const session2 = makeSession({ userId: "user-b" });

      const ns1 = resolveFridaySessionMemoryNamespace(session1);
      const ns2 = resolveFridaySessionMemoryNamespace(session2);
      expect(ns1).not.toBe(ns2);
    });

    it("falls back to chatId for DM sessions without userId", () => {
      const session = makeSession({ userId: undefined, chatKind: "dm", chatId: "user1" });
      const ns = resolveFridaySessionMemoryNamespace(session);
      expect(ns).toBe("tenant.default.channel.discord.user.user1.shared");
    });

    it("throws when namespace cannot be resolved (no userId, not DM)", () => {
      const session = makeSession({
        userId: undefined,
        chatKind: "group",
        key: "discord:default:group1",
        chatId: "group1",
      });

      try {
        resolveFridaySessionMemoryNamespace(session);
        expect.fail("Expected FridayDomainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(FridayDomainError);
        expect((err as FridayDomainError).code).toBe(FRIDAY_SESSION_ERROR_CODES.MEMORY_NAMESPACE_UNRESOLVABLE);
      }
    });

    it("replaces special characters in userId (including the dot — F5.5 hardening)", () => {
      // F5.5 collision hardening: '@' AND the literal '.' both map to '-'. The dot is the
      // segment joiner and is no longer kept inside a segment.
      const session = makeSession({ userId: "user@example.com" });
      const ns = resolveFridaySessionMemoryNamespace(session);
      expect(ns).toBe("tenant.default.channel.discord.user.user-example-com.shared");
    });

    it("closes the dot-join collision: distinct tuples never collide (F5.5)", () => {
      // The joiner-INJECTION vector: a userId / accountId literally containing the joiner
      // word `.user.` could, when `.` was kept intra-segment, forge a DIFFERENT
      // (account, channel, user) tuple's composite string — and that string IS the memory
      // principal_id SCOPE, so distinct users would share one scope.
      //
      // Pre-fix both of these DISTINCT tuples produced
      //   `tenant.a.channel.b.user.x.user.y.shared`  ← a real cross-tuple collision.
      // Post-fix the embedded `.`s map to `-`, so they are DISTINCT.
      const forged = resolveFridaySessionMemoryNamespace(
        makeSession({ accountId: "a", channel: "b", userId: "x.user.y" }),
      );
      const victim = resolveFridaySessionMemoryNamespace(
        makeSession({ accountId: "a", channel: "b.user.x", userId: "y" }),
      );
      expect(forged).not.toBe(victim);
      expect(forged).toBe("tenant.a.channel.b.user.x-user-y.shared");
      expect(victim).toBe("tenant.a.channel.b-user-x.user.y.shared");

      // INJECTIVITY by construction: with `.` dropped from every segment, the composite
      // splits into EXACTLY the seven fixed-position parts; no payload segment contains a dot.
      const parts = forged.split(".");
      expect(parts.length).toBe(7);
      expect([parts[0], parts[2], parts[4], parts[6]]).toEqual(["tenant", "channel", "user", "shared"]);
      for (const payload of [parts[1], parts[3], parts[5]]) {
        expect(payload).not.toContain(".");
      }
    });

    it("normalizes account and channel segments", () => {
      const session = makeSession({
        accountId: "Ops Team",
        channel: "Slack Connect",
        userId: "User-ABC",
      });
      const ns = resolveFridaySessionMemoryNamespace(session);
      expect(ns).toBe("tenant.ops-team.channel.slack-connect.user.user-abc.shared");
    });

    // ─── Subagent parent walking ───

    it("walks parent chain for subagent without userId", () => {
      const parentSession = makeSession({
        key: "discord:default:user1",
        userId: "user-abc",
      });

      const subagentSession = makeSession({
        key: "subagent:discord:default:user1:task-1",
        userId: undefined,
        chatKind: "dm",
        parentSessionKey: "discord:default:user1",
      });

      const lookup = (key: string): FridaySessionRecord | null => {
        if (key === "discord:default:user1") return parentSession;
        return null;
      };

      const ns = resolveFridaySessionMemoryNamespace(subagentSession, lookup);
      expect(ns).toBe("tenant.default.channel.discord.user.user-abc.shared");
    });

    it("walks multi-level parent chain for nested subagent", () => {
      const rootSession = makeSession({
        key: "discord:default:user1",
        userId: "deep-user",
      });

      const midSession = makeSession({
        key: "subagent:discord:default:user1:task-a",
        userId: undefined,
        chatKind: "group",
        parentSessionKey: "discord:default:user1",
      });

      const leafSession = makeSession({
        key: "subagent:subagent:discord:default:user1:task-a:task-b",
        userId: undefined,
        chatKind: "group",
        parentSessionKey: "subagent:discord:default:user1:task-a",
      });

      const lookup = (key: string): FridaySessionRecord | null => {
        if (key === "discord:default:user1") return rootSession;
        if (key === "subagent:discord:default:user1:task-a") return midSession;
        return null;
      };

      const ns = resolveFridaySessionMemoryNamespace(leafSession, lookup);
      expect(ns).toBe("tenant.default.channel.discord.user.deep-user.shared");
    });

    it("throws when subagent parent chain has no userId and no DM fallback", () => {
      const parentSession = makeSession({
        key: "discord:default:group1",
        userId: undefined,
        chatKind: "group",
      });

      const subagentSession = makeSession({
        key: "subagent:discord:default:group1:task-1",
        userId: undefined,
        chatKind: "group",
        parentSessionKey: "discord:default:group1",
      });

      const lookup = (key: string): FridaySessionRecord | null => {
        if (key === "discord:default:group1") return parentSession;
        return null;
      };

      try {
        resolveFridaySessionMemoryNamespace(subagentSession, lookup);
        expect.fail("Expected FridayDomainError");
      } catch (err) {
        expect(err).toBeInstanceOf(FridayDomainError);
        expect((err as FridayDomainError).code).toBe(FRIDAY_SESSION_ERROR_CODES.MEMORY_NAMESPACE_UNRESOLVABLE);
      }
    });
  });

  // ─── buildFridaySessionMemorySource ───

  describe("buildFridaySessionMemorySource", () => {
    it("builds source tag from session key", () => {
      const source = buildFridaySessionMemorySource("discord:default:user1");
      expect(source).toBe("session:discord:default:user1");
    });

    it("works with subagent keys", () => {
      const source = buildFridaySessionMemorySource("subagent:discord:default:user1:task-1");
      expect(source).toBe("session:subagent:discord:default:user1:task-1");
    });
  });

  // ─── buildFridaySessionMemoryMetadata ───

  describe("buildFridaySessionMemoryMetadata", () => {
    it("builds metadata from session record", () => {
      const session = makeSession();
      const meta = buildFridaySessionMemoryMetadata(session);

      expect(meta).toEqual({
        sessionKey: "discord:default:user1",
        channel: "discord",
        accountId: "default",
        chatId: "user1",
      });
    });
  });
});
