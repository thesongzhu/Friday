import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridaySessionService, FRIDAY_SESSION_ERROR_CODES } from "#sessions";
import type { FridaySessionService } from "#sessions";

async function expectSessionError(fn: Promise<unknown>, code: string): Promise<void> {
  try {
    await fn;
    expect.fail("Expected FridayDomainError to be thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(FridayDomainError);
    expect((err as FridayDomainError).code).toBe(code);
  }
}

describe("FridaySessionService", () => {
  let db: FridaySqliteLayer;
  let service: FridaySessionService;
  const NOW = "2026-02-18T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    service = createFridaySessionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      // TS-R4/G3: opt in to the legacy sweep so the sweepLifecycle suites
      // exercise the real path. Default/live runtime leaves this unset
      // (fail-closed) — see the dedicated retirement-guard suite below.
      allowTestOnlySessionExecution: true,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── createSession ───

  describe("createSession", () => {
    it("creates a new session", async () => {
      const session = await service.createSession({ channel: "discord", chatId: "user1" });
      expect(session.channel).toBe("discord");
      expect(session.status).toBe("active");
    });

    it("creates session with userId", async () => {
      const session = await service.createSession({ channel: "discord", chatId: "user-abc", userId: "user-abc" });
      expect(session.key).toContain("discord");
    });

    it("applies DM collapse when chatKind is dm and userId is provided", async () => {
      const session = await service.createSession({
        channel: "discord",
        chatId: "some-chat-id",
        userId: "user-abc",
        chatKind: "dm",
      });
      // DM collapse: chatId in key becomes the userId
      expect(session.key).toBe("discord:default:user-abc");
    });

    it("does not collapse for group chatKind", async () => {
      const session = await service.createSession({
        channel: "discord",
        chatId: "group-chat-123",
        chatKind: "group",
      });
      expect(session.key).toBe("discord:default:group-chat-123");
      expect(session.chatKind).toBe("group");
    });

    it("passes accountId from input", async () => {
      const session = await service.createSession({
        channel: "discord",
        chatId: "user1",
        accountId: "acme-corp",
      });
      expect(session.key).toBe("discord:acme-corp:user1");
      expect(session.accountId).toBe("acme-corp");
    });

    it("passes metadata from input", async () => {
      const session = await service.createSession({
        channel: "discord",
        chatId: "user1",
        metadata: { foo: "bar" },
      });
      expect(session.metadata).toEqual({ foo: "bar" });
    });

    it("passes sendPolicy from input", async () => {
      const session = await service.createSession({
        channel: "discord",
        chatId: "sp-create",
        sendPolicy: "block",
      });
      expect(session.sendPolicy).toBe("block");

      // Verify it persists on read
      const fetched = await service.getSession("discord:default:sp-create");
      expect(fetched!.sendPolicy).toBe("block");
    });
  });

  // ─── listSessions ───

  describe("listSessions", () => {
    it("returns empty array when no sessions exist", async () => {
      const items = await service.listSessions({});
      expect(items).toEqual([]);
    });

    it("returns all sessions", async () => {
      await service.createSession({ channel: "discord", chatId: "user1" });
      await service.createSession({ channel: "discord", chatId: "user2" });

      const items = await service.listSessions({});
      expect(items).toHaveLength(2);
    });

    it("filters by channel", async () => {
      await service.createSession({ channel: "discord", chatId: "user1" });
      await service.createSession({ channel: "slack", chatId: "user2" });

      const items = await service.listSessions({ channel: "discord" });
      expect(items).toHaveLength(1);
      expect(items[0].channel).toBe("discord");
    });

    it("filters by status", async () => {
      await service.createSession({ channel: "discord", chatId: "active1" });
      await service.createSession({ channel: "discord", chatId: "archived1" });
      await service.archiveSession("discord:default:archived1");

      const items = await service.listSessions({ status: "archived" });
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe("archived");
    });

    it("respects limit", async () => {
      await service.createSession({ channel: "discord", chatId: "user1" });
      await service.createSession({ channel: "discord", chatId: "user2" });
      await service.createSession({ channel: "discord", chatId: "user3" });

      const items = await service.listSessions({ limit: 2 });
      expect(items).toHaveLength(2);
    });

    it("repairs legacy channel rows on service initialization", async () => {
      await service.createSession({ channel: "irc", chatId: "friday-codex-audit" });
      db.withWriteTransaction((writer) => {
        writer.prepare(
          `UPDATE sessions
              SET session_key = ?,
                  root_session_key = ?,
                  channel = 'channel',
                  account_id = 'irc'
            WHERE session_key = ?`,
        ).run(
          "channel:irc:friday-codex-audit",
          "channel:irc:friday-codex-audit",
          "irc:default:friday-codex-audit",
        );
      });

      service = createFridaySessionService({
        db,
        idGenerator: createTestIdGenerator(),
        nowIso: () => NOW,
        allowTestOnlySessionExecution: true,
      });

      const items = await service.listSessions({ channel: "irc" });
      expect(items).toHaveLength(1);
      expect(items[0].key).toBe("channel:irc:friday-codex-audit");
      expect(items[0].channel).toBe("irc");
      expect(items[0].accountId).toBe("default");
    });
  });

  // ─── getSession ───

  describe("getSession", () => {
    it("returns null for nonexistent session", async () => {
      const result = await service.getSession("discord:default:nonexistent");
      expect(result).toBeNull();
    });

    it("returns existing session", async () => {
      await service.createSession({ channel: "discord", chatId: "get1" });
      const result = await service.getSession("discord:default:get1");
      expect(result).not.toBeNull();
      expect(result!.chatId).toBe("get1");
    });

    it("throws on invalid key format", async () => {
      await expectSessionError(
        service.getSession("bad-key"),
        FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
      );
    });
  });

  // ─── getOrCreateSession ───

  describe("getOrCreateSession", () => {
    it("creates session if it does not exist", async () => {
      const session = await service.getOrCreateSession("discord:default:new1");
      expect(session.key).toBe("discord:default:new1");
      expect(session.status).toBe("active");
    });

    it("returns existing session if it exists", async () => {
      await service.createSession({ channel: "discord", chatId: "existing1" });
      const session = await service.getOrCreateSession("discord:default:existing1");
      expect(session.key).toBe("discord:default:existing1");
    });

    it("re-activates idle sessions", async () => {
      await service.createSession({ channel: "discord", chatId: "idle2" });
      db.withWriteTransaction((writer) => {
        writer.prepare(
          "UPDATE sessions SET status = 'idle', idle_at = ? WHERE session_key = ?",
        ).run(NOW, "discord:default:idle2");
      });

      const session = await service.getOrCreateSession("discord:default:idle2");
      expect(session.status).toBe("active");
    });
  });

  describe("alignSessionContext", () => {
    it("updates accountId, userId, and memory namespace for an existing session", async () => {
      await service.getOrCreateSession("chat:default:chat-123");

      const updated = await service.alignSessionContext("chat:default:chat-123", {
        accountId: "admin-001",
        userId: "admin-001",
      });

      expect(updated.accountId).toBe("admin-001");
      expect(updated.userId).toBe("admin-001");
      expect(updated.memoryNamespace).toBe("tenant.admin-001.channel.chat.user.admin-001.shared");
    });

    it("keeps session unchanged when the requested context already matches", async () => {
      await service.createSession({
        channel: "chat",
        chatId: "chat-456",
        accountId: "admin-001",
        userId: "admin-001",
      });

      const updated = await service.alignSessionContext("chat:admin-001:chat-456", {
        accountId: "admin-001",
        userId: "admin-001",
      });

      expect(updated.accountId).toBe("admin-001");
      expect(updated.userId).toBe("admin-001");
    });
  });

  // ─── addMessage ───

  describe("addMessage", () => {
    it("adds a message to an existing session", async () => {
      await service.createSession({ channel: "discord", chatId: "msg1" });
      const msg = await service.addMessage("discord:default:msg1", {
        role: "user",
        content: "hello",
      });

      expect(msg.role).toBe("user");
      expect(msg.contentText).toBe("hello");
      expect(msg.sequence).toBe(1);
    });

    it("auto-creates session on message if session does not exist", async () => {
      const msg = await service.addMessage("discord:default:autocreate1", {
        role: "user",
        content: "hello",
      });

      expect(msg.role).toBe("user");
      const session = await service.getSession("discord:default:autocreate1");
      expect(session).not.toBeNull();
    });

    it("auto-creates legacy channel sessions with the real channel kind", async () => {
      await service.addMessage("channel:irc:#Friday Codex Audit", {
        role: "user",
        content: "hello",
      });

      const session = await service.getSession("channel:irc:#Friday Codex Audit");
      expect(session).not.toBeNull();
      expect(session!.key).toBe("channel:irc:friday-codex-audit");
      expect(session!.channel).toBe("irc");
      expect(session!.accountId).toBe("default");
      expect(session!.chatId).toBe("friday-codex-audit");

      const items = await service.listSessions({ channel: "irc" });
      expect(items.map((item) => item.key)).toContain("channel:irc:friday-codex-audit");
    });

    it("handles idempotency", async () => {
      await service.createSession({ channel: "discord", chatId: "idem1" });

      const msg1 = await service.addMessage("discord:default:idem1", {
        role: "user",
        content: "hello",
        idempotencyKey: "key-1",
      });

      const msg2 = await service.addMessage("discord:default:idem1", {
        role: "user",
        content: "different",
        idempotencyKey: "key-1",
      });

      expect(msg1.id).toBe(msg2.id);
    });

    it("idempotent duplicate does NOT increment counters", async () => {
      await service.createSession({ channel: "discord", chatId: "idem-count" });

      await service.addMessage("discord:default:idem-count", {
        role: "user",
        content: "hello",
        tokenCount: 10,
        idempotencyKey: "dup-key",
      });

      // Send the same message again (duplicate)
      await service.addMessage("discord:default:idem-count", {
        role: "user",
        content: "hello",
        tokenCount: 10,
        idempotencyKey: "dup-key",
      });

      const session = await service.getSession("discord:default:idem-count");
      // Should only have counted once
      expect(session!.messageCount).toBe(1);
      expect(session!.contextTotalTokens).toBe(10);
    });

    it("increments message count", async () => {
      await service.createSession({ channel: "discord", chatId: "count1" });
      await service.addMessage("discord:default:count1", { role: "user", content: "a" });
      await service.addMessage("discord:default:count1", { role: "assistant", content: "b" });

      const session = await service.getSession("discord:default:count1");
      expect(session!.messageCount).toBe(2);
    });

    it("throws on invalid role", async () => {
      await service.createSession({ channel: "discord", chatId: "badrole" });
      await expectSessionError(
        service.addMessage("discord:default:badrole", {
          role: "invalid" as "user",
          content: "hello",
        }),
        FRIDAY_SESSION_ERROR_CODES.MESSAGE_VALIDATION_ERROR,
      );
    });

    it("throws on missing role", async () => {
      await service.createSession({ channel: "discord", chatId: "norole" });
      await expectSessionError(
        service.addMessage("discord:default:norole", {
          role: "" as "user",
          content: "hello",
        }),
        FRIDAY_SESSION_ERROR_CODES.MESSAGE_VALIDATION_ERROR,
      );
    });

    it("re-activates non-active session on message", async () => {
      await service.createSession({ channel: "discord", chatId: "reactivate1" });
      db.withWriteTransaction((writer) => {
        writer.prepare(
          "UPDATE sessions SET status = 'idle', idle_at = ? WHERE session_key = ?",
        ).run(NOW, "discord:default:reactivate1");
      });

      await service.addMessage("discord:default:reactivate1", {
        role: "user",
        content: "wake up",
      });

      const session = await service.getSession("discord:default:reactivate1");
      expect(session!.status).toBe("active");
    });
  });

  // ─── getMessages ───

  describe("getMessages", () => {
    it("returns empty array for session with no messages", async () => {
      await service.createSession({ channel: "discord", chatId: "empty1" });
      const messages = await service.getMessages("discord:default:empty1");
      expect(messages).toEqual([]);
    });

    it("returns messages in chronological order", async () => {
      await service.createSession({ channel: "discord", chatId: "chrono1" });
      await service.addMessage("discord:default:chrono1", { role: "user", content: "first" });
      await service.addMessage("discord:default:chrono1", { role: "assistant", content: "second" });

      const messages = await service.getMessages("discord:default:chrono1");
      expect(messages).toHaveLength(2);
      expect(messages[0].contentText).toBe("first");
      expect(messages[1].contentText).toBe("second");
    });

    it("respects limit parameter", async () => {
      await service.createSession({ channel: "discord", chatId: "lim1" });
      for (let i = 0; i < 10; i++) {
        await service.addMessage("discord:default:lim1", { role: "user", content: `msg-${i}` });
      }

      const messages = await service.getMessages("discord:default:lim1", 5);
      expect(messages).toHaveLength(5);
    });

    it("caps limit at FRIDAY_SESSION_MAX_MESSAGE_LIMIT", async () => {
      await service.createSession({ channel: "discord", chatId: "cap1" });
      const messages = await service.getMessages("discord:default:cap1", 999);
      expect(messages).toEqual([]);
    });
  });

  // ─── archiveSession ───

  describe("archiveSession", () => {
    it("archives an active session", async () => {
      await service.createSession({ channel: "discord", chatId: "arch1" });
      const archived = await service.archiveSession("discord:default:arch1");
      expect(archived.status).toBe("archived");
    });

    it("throws when session not found or wrong status", async () => {
      await expectSessionError(
        service.archiveSession("discord:default:nonexistent"),
        FRIDAY_SESSION_ERROR_CODES.INVALID_STATUS_TRANSITION,
      );
    });

    it("throws on already archived session", async () => {
      await service.createSession({ channel: "discord", chatId: "arch2" });
      await service.archiveSession("discord:default:arch2");
      await expectSessionError(
        service.archiveSession("discord:default:arch2"),
        FRIDAY_SESSION_ERROR_CODES.INVALID_STATUS_TRANSITION,
      );
    });
  });

  // ─── pruneOldSessions ───

  describe("pruneOldSessions", () => {
    it("prunes archived sessions older than threshold", async () => {
      const oldTime = "2026-01-01T00:00:00.000Z";
      const svc = createFridaySessionService({
        db,
        idGenerator: createTestIdGenerator(),
        nowIso: () => oldTime,
        allowTestOnlySessionExecution: true,
      });

      await svc.createSession({ channel: "discord", chatId: "prune1" });
      await svc.archiveSession("discord:default:prune1");

      const result = await service.pruneOldSessions(NOW);
      expect(result.archivedToPrunedCount).toBe(1);
      expect(result.sessionKeys).toContain("discord:default:prune1");
    });

    it("throws on empty olderThan", async () => {
      await expectSessionError(
        service.pruneOldSessions(""),
        FRIDAY_SESSION_ERROR_CODES.PRUNE_VALIDATION_ERROR,
      );
    });
  });

  // ─── sweepLifecycle ───

  describe("sweepLifecycle", () => {
    it("transitions active to idle after timeout", async () => {
      // Create session with old activity time
      const oldTime = "2026-02-18T09:00:00.000Z"; // 1h before NOW
      const oldSvc = createFridaySessionService({
        db,
        idGenerator: createTestIdGenerator(),
        nowIso: () => oldTime,
        allowTestOnlySessionExecution: true,
      });
      await oldSvc.createSession({ channel: "discord", chatId: "sweep1" });

      const result = await service.sweepLifecycle();
      expect(result.idledCount).toBe(1);

      const session = await service.getSession("discord:default:sweep1");
      expect(session!.status).toBe("idle");
    });

    it("returns zero counts when nothing to sweep", async () => {
      const result = await service.sweepLifecycle();
      expect(result.idledCount).toBe(0);
      expect(result.archivedCount).toBe(0);
      expect(result.prunedCount).toBe(0);
      expect(result.hardDeletedCount).toBe(0);
    });
  });

  // ─── getSessionMemoryNamespace ───

  describe("getSessionMemoryNamespace", () => {
    it("returns namespace for session with userId", async () => {
      await service.createSession({ channel: "discord", chatId: "user-ns1", userId: "user-ns1" });
      const ns = await service.getSessionMemoryNamespace("discord:default:user-ns1");
      expect(ns).toBe("tenant.default.channel.discord.user.user-ns1.shared");
    });

    it("throws for nonexistent session", async () => {
      await expectSessionError(
        service.getSessionMemoryNamespace("discord:default:nonexistent"),
        FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
      );
    });

    it("falls back to chatId for DM sessions", async () => {
      await service.createSession({ channel: "discord", chatId: "dmuser" });
      const ns = await service.getSessionMemoryNamespace("discord:default:dmuser");
      expect(ns).toBe("tenant.default.channel.discord.user.dmuser.shared");
    });
  });

  // ─── getSessionMemoryNamespaceCandidates (F5.5 dual-read) ───

  describe("getSessionMemoryNamespaceCandidates", () => {
    const FLAG = "FRIDAY_NS_HARDENING_ENABLED";
    const prior = process.env[FLAG];
    afterEach(() => {
      if (prior === undefined) delete process.env[FLAG];
      else process.env[FLAG] = prior;
    });

    it("FLAG-OFF: returns the SINGLE legacy namespace (byte-identical to getSessionMemoryNamespace)", async () => {
      delete process.env[FLAG];
      await service.createSession({ channel: "discord", chatId: "user-ns1", userId: "user-ns1" });
      const candidates = await service.getSessionMemoryNamespaceCandidates("discord:default:user-ns1");
      const single = await service.getSessionMemoryNamespace("discord:default:user-ns1");
      expect(candidates).toEqual([single]);
      expect(candidates).toEqual(["tenant.default.channel.discord.user.user-ns1.shared"]);
    });

    it("FLAG-ON: a session created/persisted under FLAG-OFF is still recalled via the legacy candidate", async () => {
      // Create the session with the flag OFF — the WRITE path persists the LEGACY
      // (dotted) namespace, the real pre-flip data shape.
      delete process.env[FLAG];
      await service.createSession({
        channel: "discord",
        chatId: "ada.lovelace@example.com",
        userId: "ada.lovelace@example.com",
        chatKind: "dm",
      });
      const key = "discord:default:ada.lovelace@example.com";
      const persistedLegacy = await service.getSessionMemoryNamespace(key);
      expect(persistedLegacy).toBe(
        "tenant.default.channel.discord.user.ada.lovelace-example.com.shared",
      );

      // Now flip the flag ON and read the dual-read candidates. The hardened namespace
      // (new write target) comes first; the LEGACY namespace — byte-identical to what
      // was persisted above — comes second, so the pre-flip memory is still found.
      process.env[FLAG] = "1";
      const candidates = await service.getSessionMemoryNamespaceCandidates(key);
      expect(candidates).toEqual([
        "tenant.default.channel.discord.user.ada-lovelace-example-com.shared", // hardened
        "tenant.default.channel.discord.user.ada.lovelace-example.com.shared", // legacy
      ]);
      expect(candidates[1]).toBe(persistedLegacy);
    });

    it("FLAG-ON dedup-collapse: a non-dotted session yields ONE candidate", async () => {
      process.env[FLAG] = "1";
      await service.createSession({ channel: "discord", chatId: "user-ns1", userId: "user-ns1" });
      const candidates = await service.getSessionMemoryNamespaceCandidates("discord:default:user-ns1");
      expect(candidates).toEqual(["tenant.default.channel.discord.user.user-ns1.shared"]);
    });

    it("throws for nonexistent session", async () => {
      await expectSessionError(
        service.getSessionMemoryNamespaceCandidates("discord:default:nonexistent"),
        FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
      );
    });

    it("ROLLBACK (on->off): recall reads the PERSISTED hardened namespace ALONE — no re-derive regression (review must-fix)", async () => {
      // `getOrCreateSession` (the live runtime path) PERSISTS the resolved `memory_namespace`.
      // Under flag-ON it persists the HARDENED namespace for a dotted userId.
      process.env[FLAG] = "1";
      const key = "discord:default:grace.hopper@example.com";
      await service.getOrCreateSession(key);
      const session = await service.getSession(key);
      const persistedHardened = session?.memoryNamespace;
      expect(persistedHardened).toBe(
        "tenant.default.channel.discord.user.grace-hopper-example-com.shared",
      );

      // Now ROLL BACK the flag (on -> off). Flag-off recall MUST be byte-identical to
      // today (`getSessionMemoryNamespace`): the SINGLE persisted (authoritative)
      // namespace, NOT a blind re-derivation. The persisted value here is the HARDENED
      // namespace (what the rows were written under), so it — and ONLY it — is the
      // recall target. The pre-fix bug demoted this to a defensive tail behind a
      // re-derived legacy primary (an empty bucket searched first); the fix removes the
      // dual-read/re-scope from the flag-off path entirely so there is zero regression
      // regardless of any persisted-vs-re-derived drift.
      delete process.env[FLAG];
      const candidates = await service.getSessionMemoryNamespaceCandidates(key);
      expect(candidates).toEqual([persistedHardened]);
      // Byte-identical to `getSessionMemoryNamespace` (today's single-namespace recall).
      const single = await service.getSessionMemoryNamespace(key);
      expect(candidates).toEqual([single]);
    });

    it("FLAG-OFF (must-fix): persisted namespace DIFFERS from re-derived legacy — recall STILL reads the persisted bucket (no regression)", async () => {
      // Drive the exact reviewer-specified adversarial case at the session-service
      // boundary: a session whose PERSISTED `memory_namespace` differs from what a
      // blind re-derivation of its current axes would produce. We construct this by
      // persisting a HARDENED namespace under flag-on, then reading flag-off — the
      // re-derived legacy (dotted) namespace differs from the persisted hardened one.
      process.env[FLAG] = "1";
      const key = "discord:default:ada.lovelace@example.com";
      await service.getOrCreateSession(key);
      const session = await service.getSession(key);
      const persisted = session?.memoryNamespace;
      expect(persisted).toBe(
        "tenant.default.channel.discord.user.ada-lovelace-example-com.shared",
      );

      // Flag OFF: a blind re-derivation would yield the LEGACY (dotted) namespace, which
      // is a DIFFERENT bucket than the persisted one. The fix guarantees recall uses the
      // PERSISTED bucket (authoritative), never the divergent re-derivation.
      delete process.env[FLAG];
      const reDerivedLegacy = "tenant.default.channel.discord.user.ada.lovelace-example.com.shared";
      expect(persisted).not.toBe(reDerivedLegacy); // confirm the drift is real
      const candidates = await service.getSessionMemoryNamespaceCandidates(key);
      expect(candidates).toEqual([persisted]);
      expect(candidates).not.toContain(reDerivedLegacy);
    });
  });

  // ─── forkSession ───

  describe("forkSession", () => {
    it("creates a fork with default context window", async () => {
      // Create parent and add some messages
      await service.createSession({ channel: "discord", chatId: "fork-parent" });
      for (let i = 0; i < 5; i++) {
        await service.addMessage("discord:default:fork-parent", {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `message-${i}`,
        });
      }

      const result = await service.forkSession("discord:default:fork-parent");

      expect(result.forkSession).toBeDefined();
      expect(result.forkSession.parentSessionKey).toBe("discord:default:fork-parent");
      expect(result.forkSession.rootSessionKey).toBe("discord:default:fork-parent");
      expect(result.inheritedMessageCount).toBe(5);
    });

    it("inherits memory namespace from parent", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-ns", userId: "fork-ns" });
      const result = await service.forkSession("discord:default:fork-ns");

      expect(result.forkSession.memoryNamespace).toBe("tenant.default.channel.discord.user.fork-ns.shared");
    });

    it("creates fork with custom context window count", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-custom" });
      for (let i = 0; i < 10; i++) {
        await service.addMessage("discord:default:fork-custom", {
          role: "user",
          content: `msg-${i}`,
        });
      }

      const result = await service.forkSession("discord:default:fork-custom", {
        inheritMessageCount: 3,
      });

      expect(result.inheritedMessageCount).toBe(3);
    });

    it("creates fork with custom taskId", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-task" });

      const result = await service.forkSession("discord:default:fork-task", {
        taskId: "my-task",
      });

      expect(result.forkSession.key).toContain("my-task");
    });

    it("creates fork with forkFromMessageId", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-point" });
      const msg1 = await service.addMessage("discord:default:fork-point", {
        role: "user",
        content: "first",
      });
      await service.addMessage("discord:default:fork-point", {
        role: "assistant",
        content: "second",
      });
      await service.addMessage("discord:default:fork-point", {
        role: "user",
        content: "third",
      });

      const result = await service.forkSession("discord:default:fork-point", {
        forkFromMessageId: msg1.id,
      });

      // Only msg1 should be inherited (fork point is msg1, so only sequence <= msg1.sequence)
      expect(result.inheritedMessageCount).toBe(1);
      expect(result.forkedFromMessageId).toBe(msg1.id);
    });

    it("inherited messages are marked correctly", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-marked" });
      await service.addMessage("discord:default:fork-marked", {
        role: "user",
        content: "parent message",
      });

      const result = await service.forkSession("discord:default:fork-marked");
      const forkMessages = await service.getMessages(result.forkSession.key);

      expect(forkMessages).toHaveLength(1);
      expect(forkMessages[0].inherited).toBe(true);
      expect(forkMessages[0].inheritedFromSessionKey).toBe("discord:default:fork-marked");
      expect(forkMessages[0].memoryExtractStatus).toBe("skipped");
    });

    it("inherited messages do not change messageCount", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-count" });
      for (let i = 0; i < 5; i++) {
        await service.addMessage("discord:default:fork-count", {
          role: "user",
          content: `msg-${i}`,
        });
      }

      const result = await service.forkSession("discord:default:fork-count");
      expect(result.forkSession.messageCount).toBe(0);
    });

    it("throws FORK_PARENT_NOT_FOUND for nonexistent parent", async () => {
      await expectSessionError(
        service.forkSession("discord:default:nonexistent"),
        FRIDAY_SESSION_ERROR_CODES.FORK_PARENT_NOT_FOUND,
      );
    });

    it("throws FORK_POINT_NOT_FOUND for invalid message id", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-badpoint" });
      await service.addMessage("discord:default:fork-badpoint", {
        role: "user",
        content: "hello",
      });

      await expectSessionError(
        service.forkSession("discord:default:fork-badpoint", {
          forkFromMessageId: "nonexistent-msg-id",
        }),
        FRIDAY_SESSION_ERROR_CODES.FORK_POINT_NOT_FOUND,
      );
    });

    it("throws FORK_CONFLICT when fork key already exists", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-dup" });

      await service.forkSession("discord:default:fork-dup", { taskId: "dup-task" });

      await expectSessionError(
        service.forkSession("discord:default:fork-dup", { taskId: "dup-task" }),
        FRIDAY_SESSION_ERROR_CODES.FORK_CONFLICT,
      );
    });

    it("creates fork with zero inherited messages", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-zero" });
      await service.addMessage("discord:default:fork-zero", {
        role: "user",
        content: "hello",
      });

      const result = await service.forkSession("discord:default:fork-zero", {
        inheritMessageCount: 0,
      });

      expect(result.inheritedMessageCount).toBe(0);
      const forkMessages = await service.getMessages(result.forkSession.key);
      expect(forkMessages).toEqual([]);
    });

    it("persists forkedFromMessageId when inheritMessageCount is 0", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-zero-lineage" });
      const lastMsg = await service.addMessage("discord:default:fork-zero-lineage", {
        role: "user",
        content: "latest message",
      });

      const result = await service.forkSession("discord:default:fork-zero-lineage", {
        inheritMessageCount: 0,
      });

      // forkedFromMessageId should fall back to the latest parent message
      expect(result.forkedFromMessageId).toBe(lastMsg.id);

      // Verify it's persisted on the session record
      const forkSession = await service.getSession(result.forkSession.key);
      expect(forkSession!.forkedFromMessageId).toBe(lastMsg.id);
    });

    it("persists forkedFromMessageId before setForkLineage (default inherit)", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-lineage-order" });
      await service.addMessage("discord:default:fork-lineage-order", {
        role: "user",
        content: "msg-1",
      });
      const lastMsg = await service.addMessage("discord:default:fork-lineage-order", {
        role: "assistant",
        content: "msg-2",
      });

      const result = await service.forkSession("discord:default:fork-lineage-order");

      // Should have resolved forkedFromMessageId to the latest parent message
      expect(result.forkedFromMessageId).toBe(lastMsg.id);

      // Verify persisted on the DB record
      const forkSession = await service.getSession(result.forkSession.key);
      expect(forkSession!.forkedFromMessageId).toBe(lastMsg.id);
    });

    it("persists explicit forkFromMessageId on session record", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-explicit-persist" });
      const msg1 = await service.addMessage("discord:default:fork-explicit-persist", {
        role: "user",
        content: "first",
      });
      await service.addMessage("discord:default:fork-explicit-persist", {
        role: "assistant",
        content: "second",
      });

      const result = await service.forkSession("discord:default:fork-explicit-persist", {
        forkFromMessageId: msg1.id,
      });

      const forkSession = await service.getSession(result.forkSession.key);
      expect(forkSession!.forkedFromMessageId).toBe(msg1.id);
    });

    it("returns undefined forkedFromMessageId when parent has no messages", async () => {
      await service.createSession({ channel: "discord", chatId: "fork-empty-parent" });

      const result = await service.forkSession("discord:default:fork-empty-parent", {
        inheritMessageCount: 0,
      });

      expect(result.forkedFromMessageId).toBeUndefined();
      const forkSession = await service.getSession(result.forkSession.key);
      expect(forkSession!.forkedFromMessageId).toBeUndefined();
    });
  });

  // ─── listForks ───

  describe("listForks", () => {
    it("returns active forks of a parent", async () => {
      await service.createSession({ channel: "discord", chatId: "lfp" });
      await service.forkSession("discord:default:lfp", { taskId: "t1" });
      await service.forkSession("discord:default:lfp", { taskId: "t2" });

      const forks = await service.listForks("discord:default:lfp");
      expect(forks).toHaveLength(2);
    });

    it("returns empty when no forks exist", async () => {
      await service.createSession({ channel: "discord", chatId: "lfp-empty" });
      const forks = await service.listForks("discord:default:lfp-empty");
      expect(forks).toEqual([]);
    });

    it("filters by status", async () => {
      await service.createSession({ channel: "discord", chatId: "lfp-status" });
      const fork = await service.forkSession("discord:default:lfp-status", { taskId: "s1" });
      await service.archiveSession(fork.forkSession.key);

      const activeForks = await service.listForks("discord:default:lfp-status");
      expect(activeForks).toHaveLength(0);

      const archivedForks = await service.listForks("discord:default:lfp-status", { status: "archived" });
      expect(archivedForks).toHaveLength(1);
    });
  });

  // ─── mergeForkSummary ───

  describe("mergeForkSummary", () => {
    it("writes summary to parent and archives fork", async () => {
      await service.createSession({ channel: "discord", chatId: "mrg" });
      const fork = await service.forkSession("discord:default:mrg", { taskId: "merge-task" });

      const result = await service.mergeForkSummary("discord:default:mrg", {
        forkSessionKey: fork.forkSession.key,
        summary: "Task completed successfully",
      });

      expect(result.parentMessage.role).toBe("assistant");
      expect(result.parentMessage.contentText).toBe("Task completed successfully");
      expect(result.forkSession.status).toBe("archived");

      // Verify parent message count increased
      const parent = await service.getSession("discord:default:mrg");
      expect(parent!.messageCount).toBe(1);
    });

    it("validates lineage mismatch", async () => {
      await service.createSession({ channel: "discord", chatId: "mrg-mis1" });
      await service.createSession({ channel: "discord", chatId: "mrg-mis2" });
      const fork = await service.forkSession("discord:default:mrg-mis1", { taskId: "mis-task" });

      await expectSessionError(
        service.mergeForkSummary("discord:default:mrg-mis2", {
          forkSessionKey: fork.forkSession.key,
          summary: "Wrong parent",
        }),
        FRIDAY_SESSION_ERROR_CODES.FORK_LINEAGE_MISMATCH,
      );
    });

    it("throws FORK_PARENT_NOT_FOUND for nonexistent parent", async () => {
      await expectSessionError(
        service.mergeForkSummary("discord:default:nonexistent", {
          forkSessionKey: "subagent:discord:default:nonexistent:task-1",
          summary: "hello",
        }),
        FRIDAY_SESSION_ERROR_CODES.FORK_PARENT_NOT_FOUND,
      );
    });

    it("throws NOT_FOUND for nonexistent fork", async () => {
      await service.createSession({ channel: "discord", chatId: "mrg-nofork" });

      await expectSessionError(
        service.mergeForkSummary("discord:default:mrg-nofork", {
          forkSessionKey: "subagent:discord:default:mrg-nofork:nonexistent",
          summary: "hello",
        }),
        FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
      );
    });

    it("does not archive fork when archiveFork is false", async () => {
      await service.createSession({ channel: "discord", chatId: "mrg-noarch" });
      const fork = await service.forkSession("discord:default:mrg-noarch", { taskId: "na-task" });

      const result = await service.mergeForkSummary("discord:default:mrg-noarch", {
        forkSessionKey: fork.forkSession.key,
        summary: "Summary without archive",
        archiveFork: false,
      });

      expect(result.forkSession.status).toBe("active");
    });

    it("throws FORK_MERGE_VALIDATION_ERROR when summary is empty", async () => {
      await service.createSession({ channel: "discord", chatId: "mrg-empty" });
      const fork = await service.forkSession("discord:default:mrg-empty", { taskId: "empty-task" });

      await expectSessionError(
        service.mergeForkSummary("discord:default:mrg-empty", {
          forkSessionKey: fork.forkSession.key,
          summary: "",
        }),
        FRIDAY_SESSION_ERROR_CODES.FORK_MERGE_VALIDATION_ERROR,
      );
    });

    it("idempotent merge does NOT double-increment parent counters", async () => {
      await service.createSession({ channel: "discord", chatId: "mrg-idem" });
      const fork = await service.forkSession("discord:default:mrg-idem", { taskId: "idem-merge" });

      const mergeInput = {
        forkSessionKey: fork.forkSession.key,
        summary: "Idempotent summary",
        idempotencyKey: "merge-idem-key",
        archiveFork: false,
      };

      const result1 = await service.mergeForkSummary("discord:default:mrg-idem", mergeInput);
      const result2 = await service.mergeForkSummary("discord:default:mrg-idem", mergeInput);

      // Same message returned
      expect(result1.parentMessage.id).toBe(result2.parentMessage.id);

      // Counter should be 1, not 2
      const parent = await service.getSession("discord:default:mrg-idem");
      expect(parent!.messageCount).toBe(1);
    });

    it("merge reactivates idle parent session", async () => {
      await service.createSession({ channel: "discord", chatId: "mrg-reactive" });
      const fork = await service.forkSession("discord:default:mrg-reactive", { taskId: "reactive-merge" });

      // Idle the parent
      db.withWriteTransaction((writer) => {
        writer.prepare(
          "UPDATE sessions SET status = 'idle', idle_at = ? WHERE session_key = ?",
        ).run(NOW, "discord:default:mrg-reactive");
      });

      await service.mergeForkSummary("discord:default:mrg-reactive", {
        forkSessionKey: fork.forkSession.key,
        summary: "Wake up parent",
      });

      const parent = await service.getSession("discord:default:mrg-reactive");
      expect(parent!.status).toBe("active");
    });
  });

  // ─── sweepLifecycle (fork timeout) ───

  describe("sweepLifecycle (fork timeout)", () => {
    it("archives forks after fork timeout", async () => {
      // Create parent and fork with old activity time (3h ago)
      const threeHoursAgo = "2026-02-18T07:00:00.000Z";
      const oldSvc = createFridaySessionService({
        db,
        idGenerator: createTestIdGenerator(),
        nowIso: () => threeHoursAgo,
        // forkSession is now method-fenced (A3 HOLE 2); the legacy fork path this
        // sweep test depends on requires the test-oracle flag, same as the main
        // service above.
        allowTestOnlySessionExecution: true,
      });
      await oldSvc.createSession({ channel: "discord", chatId: "sweep-fork" });
      await oldSvc.forkSession("discord:default:sweep-fork", { taskId: "sweep-task" });

      const result = await service.sweepLifecycle();
      // The fork should be archived due to fork timeout (2h)
      expect(result.archivedCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── subagent lineage ───

  describe("subagent lineage", () => {
    it("populates parentSessionKey and rootSessionKey for subagent sessions", async () => {
      // Create parent session
      await service.createSession({ channel: "discord", chatId: "parent1" });

      // Create subagent session via getOrCreateSession
      const subagentKey = "subagent:discord:default:parent1:task-1";
      const subSession = await service.getOrCreateSession(subagentKey);

      expect(subSession.parentSessionKey).toBe("discord:default:parent1");
      expect(subSession.rootSessionKey).toBe("discord:default:parent1");
    });

    it("populates rootSessionKey walking multi-level subagent chain", async () => {
      // Create root session
      await service.createSession({ channel: "discord", chatId: "root1" });

      // Create level-1 subagent
      const sub1Key = "subagent:discord:default:root1:task-a";
      await service.getOrCreateSession(sub1Key);

      // Create level-2 subagent
      const sub2Key = `subagent:${sub1Key}:task-b`;
      const sub2 = await service.getOrCreateSession(sub2Key);

      expect(sub2.parentSessionKey).toBe(sub1Key);
      expect(sub2.rootSessionKey).toBe("discord:default:root1");
    });

    it("does not warn while resolving memory namespace for a new subagent session", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        await service.createSession({
          channel: "discord",
          chatId: "parent-memory",
          chatKind: "group",
        });

        const subagentKey = "subagent:discord:default:parent-memory:task-memory";
        const subSession = await service.getOrCreateSession(subagentKey);

        expect(subSession.parentSessionKey).toBe("discord:default:parent-memory");
        expect(subSession.rootSessionKey).toBe("discord:default:parent-memory");
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ─── CX-007: addMessage auto-creation preserves subagent lineage ───

  describe("addMessage subagent lineage (CX-007)", () => {
    it("auto-creates subagent session with parentSessionKey and rootSessionKey", async () => {
      // Create the parent session first
      const parentKey = "discord:default:lineage-test";
      await service.createSession({ channel: "discord", chatId: "lineage-test" });

      // addMessage with a subagent key that doesn't exist yet
      const subagentKey = `subagent:${parentKey}:task-lineage`;
      await service.addMessage(subagentKey, {
        role: "assistant",
        content: "Hello from subagent",
      });

      // Verify the auto-created session has lineage
      const subSession = await service.getSession(subagentKey);
      expect(subSession).not.toBeNull();
      expect(subSession!.parentSessionKey).toBe(parentKey);
      expect(subSession!.rootSessionKey).toBe(parentKey);
    });

    it("auto-creates nested subagent with correct rootSessionKey", async () => {
      // Create root session
      const rootKey = "discord:default:nested-root";
      await service.createSession({ channel: "discord", chatId: "nested-root" });

      // Create level-1 subagent via getOrCreateSession
      const sub1Key = `subagent:${rootKey}:level1`;
      await service.getOrCreateSession(sub1Key);

      // Auto-create level-2 subagent via addMessage
      const sub2Key = `subagent:${sub1Key}:level2`;
      await service.addMessage(sub2Key, {
        role: "user",
        content: "Deep nested message",
      });

      const sub2 = await service.getSession(sub2Key);
      expect(sub2).not.toBeNull();
      expect(sub2!.parentSessionKey).toBe(sub1Key);
      expect(sub2!.rootSessionKey).toBe(rootKey);
    });

    it("addMessage on non-subagent key does NOT set parent lineage", async () => {
      // addMessage to a new regular session key (auto-creates)
      const key = "discord:default:regular-auto";
      await service.addMessage(key, {
        role: "user",
        content: "Regular message",
      });

      const session = await service.getSession(key);
      expect(session).not.toBeNull();
      // Regular sessions should NOT have a parentSessionKey
      expect(session!.parentSessionKey).toBeUndefined();
    });
  });

  // ─── session key canonicalization ───

  describe("session key canonicalization", () => {
    it("getSession canonicalizes key with uppercase chars", async () => {
      await service.createSession({ channel: "discord", chatId: "canon1" });
      // Use uppercase key — should still find the session
      const result = await service.getSession("Discord:Default:canon1");
      expect(result).not.toBeNull();
      expect(result!.key).toBe("discord:default:canon1");
    });

    it("getOrCreateSession canonicalizes key", async () => {
      const session = await service.getOrCreateSession("Discord:Default:canon2");
      expect(session.key).toBe("discord:default:canon2");

      // Retrieve with original case
      const found = await service.getSession("discord:default:canon2");
      expect(found).not.toBeNull();
    });

    it("addMessage canonicalizes key", async () => {
      await service.createSession({ channel: "discord", chatId: "canon3" });
      const msg = await service.addMessage("Discord:Default:canon3", {
        role: "user",
        content: "hello canonical",
      });
      expect(msg.sessionKey).toBe("discord:default:canon3");
    });

    it("getMessages canonicalizes key", async () => {
      await service.createSession({ channel: "discord", chatId: "canon4" });
      await service.addMessage("discord:default:canon4", {
        role: "user",
        content: "test",
      });
      const messages = await service.getMessages("Discord:Default:canon4");
      expect(messages).toHaveLength(1);
    });

    it("archiveSession canonicalizes key", async () => {
      await service.createSession({ channel: "discord", chatId: "canon5" });
      const archived = await service.archiveSession("Discord:Default:canon5");
      expect(archived.status).toBe("archived");
    });

    it("resetSession canonicalizes key", async () => {
      await service.createSession({ channel: "discord", chatId: "canon6" });
      await service.addMessage("discord:default:canon6", { role: "user", content: "hi" });
      const reset = await service.resetSession("Discord:Default:canon6");
      expect(reset.messageCount).toBe(0);
    });
  });

  // ─── setSendPolicy / evaluateSendPolicy ───

  describe("setSendPolicy", () => {
    it("sets send policy on a session", async () => {
      await service.createSession({ channel: "discord", chatId: "sp1" });
      const updated = await service.setSendPolicy("discord:default:sp1", "block");
      expect(updated.sendPolicy).toBe("block");
    });

    it("clears send policy when set to null", async () => {
      await service.createSession({ channel: "discord", chatId: "sp2" });
      await service.setSendPolicy("discord:default:sp2", "block");
      const cleared = await service.setSendPolicy("discord:default:sp2", null);
      expect(cleared.sendPolicy).toBeUndefined();
    });

    it("throws for non-existent session", async () => {
      await expectSessionError(
        service.setSendPolicy("discord:default:nonexistent", "block"),
        FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
      );
    });

    it("persists send policy across reads", async () => {
      await service.createSession({ channel: "discord", chatId: "sp3" });
      await service.setSendPolicy("discord:default:sp3", "queue");
      const session = await service.getSession("discord:default:sp3");
      expect(session!.sendPolicy).toBe("queue");
    });
  });

  describe("evaluateSendPolicy", () => {
    it("returns 'allow' by default when no policy set", async () => {
      await service.createSession({ channel: "discord", chatId: "ep1" });
      const policy = await service.evaluateSendPolicy("discord:default:ep1");
      expect(policy).toBe("allow");
    });

    it("returns session override when set", async () => {
      await service.createSession({ channel: "discord", chatId: "ep2" });
      await service.setSendPolicy("discord:default:ep2", "block");
      const policy = await service.evaluateSendPolicy("discord:default:ep2");
      expect(policy).toBe("block");
    });

    it("throws for non-existent session", async () => {
      await expectSessionError(
        service.evaluateSendPolicy("discord:default:nonexistent"),
        FRIDAY_SESSION_ERROR_CODES.NOT_FOUND,
      );
    });
  });

  // ─── resetSession ───

  describe("resetSession", () => {
    it("deletes all messages and resets counters", async () => {
      const key = "discord:default:reset-test";
      await service.createSession({ channel: "discord", chatId: "reset-test" });

      // Add a few messages
      await service.addMessage(key, { role: "user", content: "Message 1" });
      await service.addMessage(key, { role: "assistant", content: "Reply 1" });
      await service.addMessage(key, { role: "user", content: "Message 2" });

      // Verify messages exist
      const messagesBefore = await service.getMessages(key);
      expect(messagesBefore.length).toBe(3);

      const sessionBefore = await service.getSession(key);
      expect(sessionBefore!.messageCount).toBe(3);

      // Reset
      const resetResult = await service.resetSession(key);

      // Verify messages are gone
      const messagesAfter = await service.getMessages(key);
      expect(messagesAfter.length).toBe(0);

      // Verify counters are reset
      expect(resetResult.messageCount).toBe(0);
      expect(resetResult.contextInputTokens).toBe(0);
      expect(resetResult.contextOutputTokens).toBe(0);
      expect(resetResult.contextTotalTokens).toBe(0);
      expect(resetResult.status).toBe("active");
    });

    it("throws for non-existent session", async () => {
      await expect(
        service.resetSession("discord:default:nonexistent"),
      ).rejects.toThrow("not found");
    });

    it("reactivates an idle session", async () => {
      const key = "discord:default:reset-idle";
      await service.createSession({ channel: "discord", chatId: "reset-idle" });
      await service.addMessage(key, { role: "user", content: "Hi" });

      // Archive the session (to test reactivation)
      await service.archiveSession(key);
      const archived = await service.getSession(key);
      expect(archived!.status).toBe("archived");

      // Reset should reactivate
      const resetResult = await service.resetSession(key);
      expect(resetResult.status).toBe("active");
      expect(resetResult.messageCount).toBe(0);
    });
  });

  describe("conversation focus", () => {
    it("persists and reads conversation focus state", async () => {
      await service.createSession({ channel: "discord", chatId: "focus-1" });

      await service.setConversationFocus("discord:default:focus-1", {
        currentTopicFingerprint: "topic-1",
        currentTopicSummary: "How do I bake sourdough bread?",
        currentTopicStartSequence: 3,
        lastAnsweredQuestion: "How do I bake sourdough bread?",
        lastAssistantAskedQuestion: false,
        lastRunId: "run-1",
        lastTurnKind: "new_topic",
        updatedAt: NOW,
      });

      const focus = await service.getConversationFocus("discord:default:focus-1");
      expect(focus).toEqual({
        currentTopicFingerprint: "topic-1",
        currentTopicSummary: "How do I bake sourdough bread?",
        currentTopicStartSequence: 3,
        lastAnsweredQuestion: "How do I bake sourdough bread?",
        lastAssistantAskedQuestion: false,
        lastRunId: "run-1",
        lastTurnKind: "new_topic",
        updatedAt: NOW,
      });
    });

    it("clears conversation focus on resetSession", async () => {
      await service.createSession({ channel: "discord", chatId: "focus-reset" });
      await service.setConversationFocus("discord:default:focus-reset", {
        currentTopicSummary: "Existing topic",
        updatedAt: NOW,
      });

      await service.resetSession("discord:default:focus-reset");

      const focus = await service.getConversationFocus("discord:default:focus-reset");
      expect(focus).toBeNull();
    });
  });
});
