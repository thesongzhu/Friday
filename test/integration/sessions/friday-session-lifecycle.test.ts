import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";
import { createFridaySessionService } from "#sessions";
import type { FridaySessionService } from "#sessions";

describe("Session Lifecycle (Integration)", () => {
  let db: FridaySqliteLayer;
  let service: FridaySessionService;
  const NOW = "2026-02-18T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    service = createFridaySessionService({
      db,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
      // TS-R4/G3: integration tests opt in to retired TS session mutators.
      allowTestOnlySessionExecution: true,
    });
  });

  afterEach(() => {
    db.close();
  });

  // ─── Create → Append → Retrieve lifecycle ───

  describe("create → append messages → retrieve", () => {
    it("creates a session and appends multiple messages", async () => {
      const session = await service.createSession({
        channel: "discord",
        chatId: "lifecycle-user-1",
      });

      expect(session.status).toBe("active");
      expect(session.channel).toBe("discord");

      const msg1 = await service.addMessage(session.key, {
        role: "user",
        content: "Hello Friday",
      });
      const msg2 = await service.addMessage(session.key, {
        role: "assistant",
        content: "Hello! How can I help?",
      });

      expect(msg1.sequence).toBe(1);
      expect(msg2.sequence).toBe(2);
    });

    it("retrieves messages in chronological order", async () => {
      await service.createSession({ channel: "discord", chatId: "chrono-test" });
      const key = "discord:default:chrono-test";

      await service.addMessage(key, { role: "user", content: "first" });
      await service.addMessage(key, { role: "assistant", content: "second" });
      await service.addMessage(key, { role: "user", content: "third" });

      const messages = await service.getMessages(key);
      expect(messages).toHaveLength(3);
      expect(messages[0].contentText).toBe("first");
      expect(messages[1].contentText).toBe("second");
      expect(messages[2].contentText).toBe("third");
    });

    it("session messageCount reflects appended messages", async () => {
      await service.createSession({ channel: "discord", chatId: "count-test" });
      const key = "discord:default:count-test";

      await service.addMessage(key, { role: "user", content: "a" });
      await service.addMessage(key, { role: "assistant", content: "b" });
      await service.addMessage(key, { role: "user", content: "c" });

      const session = await service.getSession(key);
      expect(session!.messageCount).toBe(3);
    });

    it("NEW-30 no-degrade: forked sessions inherit the parent owner user", async () => {
      const parent = await service.createSession({
        channel: "e2e",
        accountId: "tenant-parent",
        chatId: "fork-owner",
        userId: "user-parent",
      });

      const result = await service.forkSession(parent.key, { taskId: "child-owner" });

      expect(result.forkSession.parentSessionKey).toBe(parent.key);
      expect(result.forkSession.accountId).toBe("tenant-parent");
      expect(result.forkSession.userId).toBe("user-parent");
    });
  });

  // ─── Archive session ───

  describe("archive session", () => {
    it("archives an active session", async () => {
      await service.createSession({ channel: "discord", chatId: "archive-1" });
      const archived = await service.archiveSession("discord:default:archive-1");
      expect(archived.status).toBe("archived");
    });

    it("archived session is still retrievable", async () => {
      await service.createSession({ channel: "discord", chatId: "archive-2" });
      await service.addMessage("discord:default:archive-2", {
        role: "user",
        content: "before archive",
      });
      await service.archiveSession("discord:default:archive-2");

      const session = await service.getSession("discord:default:archive-2");
      expect(session).not.toBeNull();
      expect(session!.status).toBe("archived");

      const messages = await service.getMessages("discord:default:archive-2");
      expect(messages).toHaveLength(1);
      expect(messages[0].contentText).toBe("before archive");
    });
  });

  // ─── List sessions with filters ───

  describe("list sessions with filters", () => {
    it("lists all sessions", async () => {
      await service.createSession({ channel: "discord", chatId: "list-1" });
      await service.createSession({ channel: "discord", chatId: "list-2" });
      await service.createSession({ channel: "slack", chatId: "list-3" });

      const all = await service.listSessions({});
      expect(all).toHaveLength(3);
    });

    it("filters by channel", async () => {
      await service.createSession({ channel: "discord", chatId: "fc-1" });
      await service.createSession({ channel: "slack", chatId: "fc-2" });

      const discordOnly = await service.listSessions({ channel: "discord" });
      expect(discordOnly).toHaveLength(1);
      expect(discordOnly[0].channel).toBe("discord");
    });

    it("filters by status", async () => {
      await service.createSession({ channel: "discord", chatId: "fs-active" });
      await service.createSession({ channel: "discord", chatId: "fs-archived" });
      await service.archiveSession("discord:default:fs-archived");

      const activeOnly = await service.listSessions({ status: "active" });
      expect(activeOnly).toHaveLength(1);
      expect(activeOnly[0].status).toBe("active");

      const archivedOnly = await service.listSessions({ status: "archived" });
      expect(archivedOnly).toHaveLength(1);
      expect(archivedOnly[0].status).toBe("archived");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await service.createSession({ channel: "discord", chatId: `limit-${i}` });
      }

      const limited = await service.listSessions({ limit: 3 });
      expect(limited).toHaveLength(3);
    });
  });

  // ─── Cross-cutting: getOrCreate auto-creates ───

  describe("getOrCreateSession", () => {
    it("auto-creates session on first access", async () => {
      const session = await service.getOrCreateSession("discord:default:auto-1");
      expect(session.status).toBe("active");
      expect(session.channel).toBe("discord");
    });

    it("returns existing session on second access", async () => {
      const first = await service.getOrCreateSession("discord:default:auto-2");
      const second = await service.getOrCreateSession("discord:default:auto-2");
      expect(first.id).toBe(second.id);
    });
  });
});
