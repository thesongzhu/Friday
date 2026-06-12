import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { FridayDomainError } from "#errors";
import {
  resolveFridaySessionMemoryNamespace,
  resolveFridaySessionMemoryNamespaceCandidates,
  isFridayNamespaceHardeningEnabled,
  FRIDAY_NS_HARDENING_ENV_FLAG,
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

    it("replaces special characters in userId (FLAG-OFF: dot PRESERVED — byte-identical to pre-#661)", () => {
      // The hardening flag is DEFAULT-OFF, so the legacy keep-set keeps `.`. This is the
      // exact pre-hardening behavior: NO re-scope of an email-shaped userId.
      expect(isFridayNamespaceHardeningEnabled()).toBe(false);
      const session = makeSession({ userId: "user@example.com" });
      const ns = resolveFridaySessionMemoryNamespace(session);
      expect(ns).toBe("tenant.default.channel.discord.user.user-example.com.shared");
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

  // ─── F5.5 dot-join collision hardening (FLAG-GATED, DEFAULT-OFF) + dual-read ───

  describe("namespace hardening flag + dual-read", () => {
    const PRIOR = process.env[FRIDAY_NS_HARDENING_ENV_FLAG];
    beforeEach(() => {
      delete process.env[FRIDAY_NS_HARDENING_ENV_FLAG];
    });
    afterEach(() => {
      if (PRIOR === undefined) {
        delete process.env[FRIDAY_NS_HARDENING_ENV_FLAG];
      } else {
        process.env[FRIDAY_NS_HARDENING_ENV_FLAG] = PRIOR;
      }
    });

    it("FLAG-OFF: the flag is off by default and only exactly '1' enables it", () => {
      expect(isFridayNamespaceHardeningEnabled()).toBe(false);
      for (const v of ["", "0", "true", "yes", "2", " 1 "]) {
        // " 1 " trims to "1" so it IS on; assert the trim explicitly.
        process.env[FRIDAY_NS_HARDENING_ENV_FLAG] = v;
        expect(isFridayNamespaceHardeningEnabled()).toBe(v.trim() === "1");
      }
      process.env[FRIDAY_NS_HARDENING_ENV_FLAG] = "1";
      expect(isFridayNamespaceHardeningEnabled()).toBe(true);
    });

    it("FLAG-OFF: a dotted userId is NOT re-scoped (byte-identical to legacy)", () => {
      // No re-scope/data-downgrade when the flag is off: the dot stays in the segment.
      const session = makeSession({ userId: "alice.jr@example.com" });
      expect(resolveFridaySessionMemoryNamespace(session)).toBe(
        "tenant.default.channel.discord.user.alice.jr-example.com.shared",
      );
    });

    it("FLAG-OFF: candidates is the SINGLE legacy namespace (one query, no behavior change)", () => {
      const session = makeSession({ userId: "user@example.com" });
      const candidates = resolveFridaySessionMemoryNamespaceCandidates(session);
      expect(candidates).toEqual(["tenant.default.channel.discord.user.user-example.com.shared"]);
    });

    it("FLAG-ON: the dotted segment is hardened (dot -> '-')", () => {
      process.env[FRIDAY_NS_HARDENING_ENV_FLAG] = "1";
      const session = makeSession({ userId: "user@example.com" });
      expect(resolveFridaySessionMemoryNamespace(session)).toBe(
        "tenant.default.channel.discord.user.user-example-com.shared",
      );
    });

    it("FLAG-ON: dual-read returns [hardened, legacy] so legacy memory is still recalled", () => {
      process.env[FRIDAY_NS_HARDENING_ENV_FLAG] = "1";
      const session = makeSession({ userId: "user@example.com" });
      const candidates = resolveFridaySessionMemoryNamespaceCandidates(session);
      expect(candidates).toEqual([
        "tenant.default.channel.discord.user.user-example-com.shared", // hardened (new writes)
        "tenant.default.channel.discord.user.user-example.com.shared", // legacy (pre-flip rows)
      ]);
      // The LEGACY candidate is byte-identical to what the FLAG-OFF write path persisted —
      // this is the link that makes flag-on recall find pre-flip memory.
      delete process.env[FRIDAY_NS_HARDENING_ENV_FLAG];
      expect(resolveFridaySessionMemoryNamespace(session)).toBe(candidates[1]);
    });

    it("FLAG-ON, DEDUP-COLLAPSE: a non-dotted segment yields ONE candidate (zero extra reads)", () => {
      process.env[FRIDAY_NS_HARDENING_ENV_FLAG] = "1";
      // No `.` in any segment ⇒ hardened === legacy ⇒ the dual-read list collapses to one.
      const session = makeSession({ userId: "user-abc" });
      const candidates = resolveFridaySessionMemoryNamespaceCandidates(session);
      expect(candidates).toEqual(["tenant.default.channel.discord.user.user-abc.shared"]);
    });

    it("FLAG-ON: the dot-join cross-tuple collision is closed for NEW (hardened) writes", () => {
      process.env[FRIDAY_NS_HARDENING_ENV_FLAG] = "1";
      // Pre-fix both DISTINCT tuples produced `tenant.a.channel.b.user.x.user.y.shared`.
      // Hardened: the embedded `.user.` maps to `-user-`, so they are DISTINCT.
      const forged = resolveFridaySessionMemoryNamespace(
        makeSession({ accountId: "a", channel: "b", userId: "x.user.y" }),
      );
      const victim = resolveFridaySessionMemoryNamespace(
        makeSession({ accountId: "a", channel: "b.user.x", userId: "y" }),
      );
      expect(forged).not.toBe(victim);
      expect(forged).toBe("tenant.a.channel.b.user.x-user-y.shared");
      expect(victim).toBe("tenant.a.channel.b-user-x.user.y.shared");
      // Injectivity by construction: exactly 7 dot-parts, no payload segment carries a dot.
      const parts = forged.split(".");
      expect(parts.length).toBe(7);
      expect([parts[0], parts[2], parts[4], parts[6]]).toEqual(["tenant", "channel", "user", "shared"]);
      for (const payload of [parts[1], parts[3], parts[5]]) {
        expect(payload).not.toContain(".");
      }
    });

    it("HONEST: the LEGACY dual-read bucket still carries the pre-hardening collision", () => {
      process.env[FRIDAY_NS_HARDENING_ENV_FLAG] = "1";
      // The two distinct tuples write to DISTINCT hardened namespaces (collision closed for
      // new writes), but they STILL share ONE legacy bucket on the dual-read tail — so
      // hardening does NOT retroactively split already-colliding legacy rows. Dual-read is
      // strictly >= the pre-#661 state (no data loss), not a retroactive fix. Documented,
      // not "fixed" (structurally impossible to split one shared bucket).
      const forgedLegacy = resolveFridaySessionMemoryNamespaceCandidates(
        makeSession({ accountId: "a", channel: "b", userId: "x.user.y" }),
      )[1];
      const victimLegacy = resolveFridaySessionMemoryNamespaceCandidates(
        makeSession({ accountId: "a", channel: "b.user.x", userId: "y" }),
      )[1];
      expect(forgedLegacy).toBe("tenant.a.channel.b.user.x.user.y.shared");
      expect(victimLegacy).toBe("tenant.a.channel.b.user.x.user.y.shared");
      expect(forgedLegacy).toBe(victimLegacy);
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
