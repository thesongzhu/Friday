import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridaySessionRepository, createFridaySessionMessageRepository } from "#sessions";

describe("FridaySessionMessageRepository", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;
  const NOW = "2026-02-18T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  function createSession(key: string) {
    const sessionRepo = createFridaySessionRepository();
    return db.withWriteTransaction((writer) =>
      sessionRepo.insert(writer, {
        key,
        channel: "discord",
        chatId: "user1",
        chatKind: "dm",
        nowIso: NOW,
        idGenerator,
      }),
    );
  }

  // ─── append ───

  describe("append", () => {
    it("appends a message with auto-incrementing sequence", () => {
      const session = createSession("discord:default:user1");
      const repo = createFridaySessionMessageRepository();

      const { record: msg, isNew } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"hello"',
          contentText: "hello",
          tokenCount: 5,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(isNew).toBe(true);
      expect(msg.role).toBe("user");
      expect(msg.contentText).toBe("hello");
      expect(msg.sequence).toBe(1);
      expect(msg.tokenCount).toBe(5);
      expect(msg.memoryExtractStatus).toBe("pending");
    });

    it("auto-increments sequence across messages", () => {
      const session = createSession("discord:default:seq1");
      const repo = createFridaySessionMessageRepository();

      const { record: msg1 } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"first"',
          contentText: "first",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      const { record: msg2 } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "assistant",
          contentJson: '"second"',
          contentText: "second",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(msg1.sequence).toBe(1);
      expect(msg2.sequence).toBe(2);
    });

    it("stores tool calls JSON", () => {
      const session = createSession("discord:default:tools1");
      const repo = createFridaySessionMessageRepository();

      const toolCalls = [{ name: "search", args: { q: "test" } }];
      const { record: msg } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "assistant",
          contentJson: '"using tools"',
          contentText: "using tools",
          toolCallsJson: JSON.stringify(toolCalls),
          tokenCount: 10,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(msg.toolCalls).toEqual(toolCalls);
    });

    // ─── Idempotency ───

    it("returns existing message on duplicate idempotencyKey", () => {
      const session = createSession("discord:default:idem1");
      const repo = createFridaySessionMessageRepository();

      const { record: msg1, isNew: isNew1 } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"hello"',
          contentText: "hello",
          tokenCount: 5,
          idempotencyKey: "idem-key-1",
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      const { record: msg2, isNew: isNew2 } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"different content"',
          contentText: "different content",
          tokenCount: 10,
          idempotencyKey: "idem-key-1",
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(isNew1).toBe(true);
      expect(isNew2).toBe(false);
      // Should return the same message
      expect(msg2.id).toBe(msg1.id);
      expect(msg2.contentText).toBe("hello");
      expect(msg2.sequence).toBe(msg1.sequence);
    });

    it("appends different messages with different idempotencyKeys", () => {
      const session = createSession("discord:default:idem2");
      const repo = createFridaySessionMessageRepository();

      const { record: msg1 } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"first"',
          contentText: "first",
          tokenCount: 0,
          idempotencyKey: "key-a",
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      const { record: msg2 } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"second"',
          contentText: "second",
          tokenCount: 0,
          idempotencyKey: "key-b",
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(msg1.id).not.toBe(msg2.id);
    });

    it("appends without idempotencyKey (always inserts)", () => {
      const session = createSession("discord:default:noidem");
      const repo = createFridaySessionMessageRepository();

      const { record: msg1 } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"hello"',
          contentText: "hello",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      const { record: msg2 } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"hello"',
          contentText: "hello",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(msg1.id).not.toBe(msg2.id);
    });
  });

  // ─── inherited columns ───

  describe("inherited columns", () => {
    it("stores and returns inherited flags", () => {
      const session = createSession("discord:default:inherit1");
      const repo = createFridaySessionMessageRepository();

      const { record: msg } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"inherited hello"',
          contentText: "inherited hello",
          tokenCount: 5,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
          isInherited: true,
          inheritedFromSessionKey: "discord:default:parent",
          inheritedFromMessageId: "parent-msg-1",
          memoryExtractStatus: "skipped",
        }),
      );

      expect(msg.inherited).toBe(true);
      expect(msg.inheritedFromSessionKey).toBe("discord:default:parent");
      expect(msg.inheritedFromMessageId).toBe("parent-msg-1");
      expect(msg.memoryExtractStatus).toBe("skipped");
    });

    it("non-inherited messages have inherited undefined", () => {
      const session = createSession("discord:default:noinherit1");
      const repo = createFridaySessionMessageRepository();

      const { record: msg } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"normal"',
          contentText: "normal",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(msg.inherited).toBeUndefined();
      expect(msg.inheritedFromSessionKey).toBeUndefined();
      expect(msg.inheritedFromMessageId).toBeUndefined();
    });
  });

  // ─── getBySessionAndId ───

  describe("getBySessionAndId", () => {
    it("returns message when found", () => {
      const session = createSession("discord:default:getid1");
      const repo = createFridaySessionMessageRepository();

      const { record: msg } = db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"find me"',
          contentText: "find me",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      const found = db.withReadConnection((reader) =>
        repo.getBySessionAndId(reader, { sessionKey: session.key, messageId: msg.id }),
      );
      expect(found).not.toBeNull();
      expect(found!.id).toBe(msg.id);
    });

    it("returns null for nonexistent message", () => {
      const repo = createFridaySessionMessageRepository();
      const result = db.withReadConnection((reader) =>
        repo.getBySessionAndId(reader, { sessionKey: "discord:default:nope", messageId: "nonexistent" }),
      );
      expect(result).toBeNull();
    });
  });

  // ─── listForkContextWindow ───

  describe("listForkContextWindow", () => {
    it("returns non-inherited messages in chronological order", () => {
      const session = createSession("discord:default:ctx1");
      const repo = createFridaySessionMessageRepository();

      db.withWriteTransaction((writer) => {
        // Add an inherited message (should be excluded)
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"inherited"',
          contentText: "inherited",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
          isInherited: true,
          inheritedFromSessionKey: "discord:default:other",
          inheritedFromMessageId: "other-msg",
          memoryExtractStatus: "skipped",
        });
        // Add non-inherited messages
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"first"',
          contentText: "first",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        });
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "assistant",
          contentJson: '"second"',
          contentText: "second",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        });
      });

      const results = db.withReadConnection((reader) =>
        repo.listForkContextWindow(reader, { sessionKey: session.key, limit: 10 }),
      );

      expect(results).toHaveLength(2);
      expect(results[0].contentText).toBe("first");
      expect(results[1].contentText).toBe("second");
    });

    it("respects maxSequence parameter", () => {
      const session = createSession("discord:default:ctx2");
      const repo = createFridaySessionMessageRepository();

      db.withWriteTransaction((writer) => {
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"msg1"',
          contentText: "msg1",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        });
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "assistant",
          contentJson: '"msg2"',
          contentText: "msg2",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        });
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"msg3"',
          contentText: "msg3",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        });
      });

      const results = db.withReadConnection((reader) =>
        repo.listForkContextWindow(reader, { sessionKey: session.key, limit: 10, maxSequence: 2 }),
      );

      expect(results).toHaveLength(2);
      expect(results[0].contentText).toBe("msg1");
      expect(results[1].contentText).toBe("msg2");
    });

    it("respects limit parameter", () => {
      const session = createSession("discord:default:ctx3");
      const repo = createFridaySessionMessageRepository();

      db.withWriteTransaction((writer) => {
        for (let i = 0; i < 5; i++) {
          repo.append(writer, {
            sessionId: session.id,
            sessionKey: session.key,
            role: "user",
            contentJson: `"msg-${i}"`,
            contentText: `msg-${i}`,
            tokenCount: 0,
            metadataJson: "{}",
            occurredAt: NOW,
            nowIso: NOW,
            idGenerator,
          });
        }
      });

      const results = db.withReadConnection((reader) =>
        repo.listForkContextWindow(reader, { sessionKey: session.key, limit: 2 }),
      );

      expect(results).toHaveLength(2);
    });
  });

  // ─── findByIdempotency ───

  describe("findByIdempotency", () => {
    it("returns null when no match", () => {
      const repo = createFridaySessionMessageRepository();
      const result = db.withReadConnection((reader) =>
        repo.findByIdempotency(reader, { sessionKey: "discord:default:nope", idempotencyKey: "xyz" }),
      );
      expect(result).toBeNull();
    });

    it("returns matching message", () => {
      const session = createSession("discord:default:find1");
      const repo = createFridaySessionMessageRepository();

      db.withWriteTransaction((writer) =>
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"test"',
          contentText: "test",
          tokenCount: 0,
          idempotencyKey: "find-key",
          metadataJson: "{}",
          occurredAt: NOW,
          nowIso: NOW,
          idGenerator,
        }),
      );

      const result = db.withReadConnection((reader) =>
        repo.findByIdempotency(reader, { sessionKey: session.key, idempotencyKey: "find-key" }),
      );
      expect(result).not.toBeNull();
      expect(result!.contentText).toBe("test");
    });
  });

  // ─── listBySessionKey ───

  describe("listBySessionKey", () => {
    it("returns empty array for nonexistent session", () => {
      const repo = createFridaySessionMessageRepository();
      const results = db.withReadConnection((reader) =>
        repo.listBySessionKey(reader, { sessionKey: "nonexistent:key:here", limit: 50 }),
      );
      expect(results).toEqual([]);
    });

    it("returns messages in chronological order", () => {
      const session = createSession("discord:default:list1");
      const repo = createFridaySessionMessageRepository();

      db.withWriteTransaction((writer) => {
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"first"',
          contentText: "first",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: "2026-02-18T10:00:00.000Z",
          nowIso: NOW,
          idGenerator,
        });
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "assistant",
          contentJson: '"second"',
          contentText: "second",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: "2026-02-18T10:01:00.000Z",
          nowIso: NOW,
          idGenerator,
        });
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"third"',
          contentText: "third",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: "2026-02-18T10:02:00.000Z",
          nowIso: NOW,
          idGenerator,
        });
      });

      const results = db.withReadConnection((reader) =>
        repo.listBySessionKey(reader, { sessionKey: session.key, limit: 50 }),
      );

      expect(results).toHaveLength(3);
      expect(results[0].contentText).toBe("first");
      expect(results[1].contentText).toBe("second");
      expect(results[2].contentText).toBe("third");
    });

    it("respects limit", () => {
      const session = createSession("discord:default:limit1");
      const repo = createFridaySessionMessageRepository();

      db.withWriteTransaction((writer) => {
        for (let i = 0; i < 5; i++) {
          repo.append(writer, {
            sessionId: session.id,
            sessionKey: session.key,
            role: "user",
            contentJson: `"msg-${i}"`,
            contentText: `msg-${i}`,
            tokenCount: 0,
            metadataJson: "{}",
            occurredAt: NOW,
            nowIso: NOW,
            idGenerator,
          });
        }
      });

      const results = db.withReadConnection((reader) =>
        repo.listBySessionKey(reader, { sessionKey: session.key, limit: 3 }),
      );

      // Should return last 3 messages (most recent) in chronological order
      expect(results).toHaveLength(3);
    });

    it("supports before cursor for pagination", () => {
      const session = createSession("discord:default:before1");
      const repo = createFridaySessionMessageRepository();

      db.withWriteTransaction((writer) => {
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"old"',
          contentText: "old",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: "2026-02-18T08:00:00.000Z",
          nowIso: NOW,
          idGenerator,
        });
        repo.append(writer, {
          sessionId: session.id,
          sessionKey: session.key,
          role: "user",
          contentJson: '"new"',
          contentText: "new",
          tokenCount: 0,
          metadataJson: "{}",
          occurredAt: "2026-02-18T10:00:00.000Z",
          nowIso: NOW,
          idGenerator,
        });
      });

      const results = db.withReadConnection((reader) =>
        repo.listBySessionKey(reader, {
          sessionKey: session.key,
          limit: 50,
          before: "2026-02-18T09:00:00.000Z",
        }),
      );

      expect(results).toHaveLength(1);
      expect(results[0].contentText).toBe("old");
    });
  });
});
