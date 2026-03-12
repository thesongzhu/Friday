import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridaySessionRepository } from "#sessions";

describe("FridaySessionRepository", () => {
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

  function createRepo() {
    return createFridaySessionRepository();
  }

  // ─── insert ───

  describe("insert", () => {
    it("inserts a new session with active status", () => {
      const repo = createRepo();
      const session = db.withWriteTransaction((writer) =>
        repo.insert(writer, {
          key: "discord:default:user1",
          channel: "discord",
          chatId: "user1",
          chatKind: "dm",
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(session.key).toBe("discord:default:user1");
      expect(session.channel).toBe("discord");
      expect(session.chatId).toBe("user1");
      expect(session.status).toBe("active");
      expect(session.messageCount).toBe(0);
      expect(session.contextTotalTokens).toBe(0);
    });

    it("sets default accountId to 'default'", () => {
      const repo = createRepo();
      const session = db.withWriteTransaction((writer) =>
        repo.insert(writer, {
          key: "slack:default:chat1",
          channel: "slack",
          chatId: "chat1",
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(session.accountId).toBe("default");
    });

    it("stores metadata as JSON", () => {
      const repo = createRepo();
      const session = db.withWriteTransaction((writer) =>
        repo.insert(writer, {
          key: "discord:default:meta1",
          channel: "discord",
          chatId: "meta1",
          metadata: { foo: "bar" },
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(session.metadata).toEqual({ foo: "bar" });
    });

    it("sets userId when provided", () => {
      const repo = createRepo();
      const session = db.withWriteTransaction((writer) =>
        repo.insert(writer, {
          key: "discord:default:user-x",
          channel: "discord",
          chatId: "user-x",
          userId: "user-x",
          chatKind: "dm",
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(session.userId).toBe("user-x");
    });

    it("throws 409 when session key already exists", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) =>
        repo.insert(writer, {
          key: "discord:default:dup",
          channel: "discord",
          chatId: "dup",
          nowIso: NOW,
          idGenerator,
        }),
      );

      try {
        db.withWriteTransaction((writer) =>
          repo.insert(writer, {
            key: "discord:default:dup",
            channel: "discord",
            chatId: "dup",
            nowIso: NOW,
            idGenerator,
          }),
        );
      } catch (error) {
        expect(error).toBeInstanceOf(FridayDomainError);
        expect((error as FridayDomainError).code).toBe("SESSION_ALREADY_EXISTS");
        return;
      }
      throw new Error("Expected duplicate insert to throw");
    });
  });

  // ─── getByKey ───

  describe("getByKey", () => {
    it("returns null for nonexistent key", () => {
      const repo = createRepo();
      const result = db.withReadConnection((reader) => repo.getByKey(reader, "nonexistent:key:here"));
      expect(result).toBeNull();
    });

    it("returns inserted session", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) =>
        repo.insert(writer, {
          key: "discord:default:get1",
          channel: "discord",
          chatId: "get1",
          nowIso: NOW,
          idGenerator,
        }),
      );

      const session = db.withReadConnection((reader) => repo.getByKey(reader, "discord:default:get1"));
      expect(session).not.toBeNull();
      expect(session!.key).toBe("discord:default:get1");
    });
  });

  // ─── list ───

  describe("list", () => {
    it("returns empty array for no matches", () => {
      const repo = createRepo();
      const results = db.withReadConnection((reader) => repo.list(reader, { channel: "nonexistent" }));
      expect(results).toEqual([]);
    });

    it("filters by channel", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:a", channel: "discord", chatId: "a", nowIso: NOW, idGenerator });
        repo.insert(writer, { key: "slack:default:b", channel: "slack", chatId: "b", nowIso: NOW, idGenerator });
      });

      const results = db.withReadConnection((reader) => repo.list(reader, { channel: "discord" }));
      expect(results).toHaveLength(1);
      expect(results[0].channel).toBe("discord");
    });

    it("filters by status", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:s1", channel: "discord", chatId: "s1", nowIso: NOW, idGenerator });
        const sess = repo.insert(writer, { key: "discord:default:s2", channel: "discord", chatId: "s2", nowIso: NOW, idGenerator });
        repo.updateStatus(writer, { key: sess.key, to: "idle", nowIso: NOW });
      });

      const active = db.withReadConnection((reader) => repo.list(reader, { status: "active" }));
      const idle = db.withReadConnection((reader) => repo.list(reader, { status: "idle" }));
      expect(active).toHaveLength(1);
      expect(idle).toHaveLength(1);
    });

    it("respects limit", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        for (let i = 0; i < 5; i++) {
          repo.insert(writer, { key: `discord:default:lim${i}`, channel: "discord", chatId: `lim${i}`, nowIso: NOW, idGenerator });
        }
      });

      const results = db.withReadConnection((reader) => repo.list(reader, { limit: 3 }));
      expect(results).toHaveLength(3);
    });
  });

  // ─── updateStatus ───

  describe("updateStatus", () => {
    it("transitions status", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:st1", channel: "discord", chatId: "st1", nowIso: NOW, idGenerator });
      });

      const updated = db.withWriteTransaction((writer) =>
        repo.updateStatus(writer, { key: "discord:default:st1", to: "idle", nowIso: NOW }),
      );

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("idle");
      expect(updated!.idleAt).toBe(NOW);
    });

    it("respects from constraint", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:st2", channel: "discord", chatId: "st2", nowIso: NOW, idGenerator });
      });

      // Try to transition from idle (but session is active)
      const result = db.withWriteTransaction((writer) =>
        repo.updateStatus(writer, { key: "discord:default:st2", from: ["idle"], to: "archived", nowIso: NOW }),
      );

      expect(result).toBeNull();
    });

    it("returns null for nonexistent key", () => {
      const repo = createRepo();
      const result = db.withWriteTransaction((writer) =>
        repo.updateStatus(writer, { key: "nonexistent:key:here", to: "idle", nowIso: NOW }),
      );
      expect(result).toBeNull();
    });

    it("sets archived_at on archive", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:arch", channel: "discord", chatId: "arch", nowIso: NOW, idGenerator });
      });

      const updated = db.withWriteTransaction((writer) =>
        repo.updateStatus(writer, { key: "discord:default:arch", to: "archived", nowIso: NOW }),
      );

      expect(updated!.archivedAt).toBe(NOW);
    });

    it("sets pruned_at on prune", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:prn", channel: "discord", chatId: "prn", nowIso: NOW, idGenerator });
      });

      const updated = db.withWriteTransaction((writer) =>
        repo.updateStatus(writer, { key: "discord:default:prn", to: "pruned", nowIso: NOW }),
      );

      expect(updated!.prunedAt).toBe(NOW);
    });
  });

  // ─── touchActivity ───

  describe("touchActivity", () => {
    it("updates last_activity_at", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:touch1", channel: "discord", chatId: "touch1", nowIso: NOW, idGenerator });
      });

      const later = "2026-02-18T11:00:00.000Z";
      const updated = db.withWriteTransaction((writer) =>
        repo.touchActivity(writer, { key: "discord:default:touch1", nowIso: later }),
      );

      expect(updated!.lastActivityAt).toBe(later);
    });

    it("increments token counts", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:tok1", channel: "discord", chatId: "tok1", nowIso: NOW, idGenerator });
      });

      const updated = db.withWriteTransaction((writer) =>
        repo.touchActivity(writer, {
          key: "discord:default:tok1",
          nowIso: NOW,
          tokenDelta: { input: 10, output: 20, total: 30 },
        }),
      );

      expect(updated!.contextInputTokens).toBe(10);
      expect(updated!.contextOutputTokens).toBe(20);
      expect(updated!.contextTotalTokens).toBe(30);
    });

    it("increments message count", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:msg1", channel: "discord", chatId: "msg1", nowIso: NOW, idGenerator });
      });

      const updated = db.withWriteTransaction((writer) =>
        repo.touchActivity(writer, {
          key: "discord:default:msg1",
          nowIso: NOW,
          messageDelta: 1,
        }),
      );

      expect(updated!.messageCount).toBe(1);
    });
  });

  // ─── listByParentSessionKey ───

  describe("listByParentSessionKey", () => {
    it("returns sessions with matching parent", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:parent1", channel: "discord", chatId: "parent1", nowIso: NOW, idGenerator });
        const child = repo.insert(writer, { key: "subagent:discord:default:parent1:t1", channel: "discord", chatId: "parent1", nowIso: NOW, idGenerator });
        repo.setForkLineage(writer, {
          key: child.key,
          parentSessionKey: "discord:default:parent1",
          rootSessionKey: "discord:default:parent1",
        });
      });

      const results = db.withReadConnection((reader) =>
        repo.listByParentSessionKey(reader, { parentSessionKey: "discord:default:parent1" }),
      );
      expect(results).toHaveLength(1);
      expect(results[0].parentSessionKey).toBe("discord:default:parent1");
    });

    it("returns empty when no children exist", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:lonely", channel: "discord", chatId: "lonely", nowIso: NOW, idGenerator });
      });

      const results = db.withReadConnection((reader) =>
        repo.listByParentSessionKey(reader, { parentSessionKey: "discord:default:lonely" }),
      );
      expect(results).toEqual([]);
    });

    it("filters by status", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:p2", channel: "discord", chatId: "p2", nowIso: NOW, idGenerator });
        const c1 = repo.insert(writer, { key: "subagent:discord:default:p2:a", channel: "discord", chatId: "p2", nowIso: NOW, idGenerator });
        repo.setForkLineage(writer, { key: c1.key, parentSessionKey: "discord:default:p2", rootSessionKey: "discord:default:p2" });
        repo.updateStatus(writer, { key: c1.key, to: "archived", nowIso: NOW });

        const c2 = repo.insert(writer, { key: "subagent:discord:default:p2:b", channel: "discord", chatId: "p2", nowIso: NOW, idGenerator });
        repo.setForkLineage(writer, { key: c2.key, parentSessionKey: "discord:default:p2", rootSessionKey: "discord:default:p2" });
      });

      const archivedOnly = db.withReadConnection((reader) =>
        repo.listByParentSessionKey(reader, { parentSessionKey: "discord:default:p2", statuses: ["archived"] }),
      );
      expect(archivedOnly).toHaveLength(1);

      const activeOnly = db.withReadConnection((reader) =>
        repo.listByParentSessionKey(reader, { parentSessionKey: "discord:default:p2", statuses: ["active"] }),
      );
      expect(activeOnly).toHaveLength(1);
    });
  });

  // ─── updateSendPolicy ───

  describe("updateSendPolicy", () => {
    it("sets send policy on a session", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:policy1", channel: "discord", chatId: "policy1", nowIso: NOW, idGenerator });
      });

      const updated = db.withWriteTransaction((writer) =>
        repo.updateSendPolicy(writer, { key: "discord:default:policy1", sendPolicy: "block", nowIso: NOW }),
      );

      expect(updated).not.toBeNull();
      expect(updated!.sendPolicy).toBe("block");
    });

    it("clears send policy when set to null", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:policy2", channel: "discord", chatId: "policy2", nowIso: NOW, idGenerator });
        repo.updateSendPolicy(writer, { key: "discord:default:policy2", sendPolicy: "block", nowIso: NOW });
      });

      const cleared = db.withWriteTransaction((writer) =>
        repo.updateSendPolicy(writer, { key: "discord:default:policy2", sendPolicy: null, nowIso: NOW }),
      );

      expect(cleared).not.toBeNull();
      expect(cleared!.sendPolicy).toBeUndefined();
    });

    it("returns null for nonexistent key", () => {
      const repo = createRepo();
      const result = db.withWriteTransaction((writer) =>
        repo.updateSendPolicy(writer, { key: "nonexistent:key:here", sendPolicy: "block", nowIso: NOW }),
      );
      expect(result).toBeNull();
    });

    it("persists send_policy through insert", () => {
      const repo = createRepo();
      const session = db.withWriteTransaction((writer) =>
        repo.insert(writer, {
          key: "discord:default:policy3",
          channel: "discord",
          chatId: "policy3",
          sendPolicy: "queue",
          nowIso: NOW,
          idGenerator,
        }),
      );

      expect(session.sendPolicy).toBe("queue");

      // Verify via re-read
      const reread = db.withReadConnection((reader) => repo.getByKey(reader, "discord:default:policy3"));
      expect(reread!.sendPolicy).toBe("queue");
    });
  });

  // ─── setForkLineage ───

  describe("setForkLineage", () => {
    it("sets parent and root session keys", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:lineage1", channel: "discord", chatId: "lineage1", nowIso: NOW, idGenerator });
        repo.setForkLineage(writer, {
          key: "discord:default:lineage1",
          parentSessionKey: "discord:default:parent",
          rootSessionKey: "discord:default:root",
          forkedFromMessageId: "msg-42",
          memoryNamespace: "test.ns",
        });
      });

      const session = db.withReadConnection((reader) => repo.getByKey(reader, "discord:default:lineage1"));
      expect(session!.parentSessionKey).toBe("discord:default:parent");
      expect(session!.rootSessionKey).toBe("discord:default:root");
      expect(session!.forkedFromMessageId).toBe("msg-42");
      expect(session!.memoryNamespace).toBe("test.ns");
    });
  });

  // ─── markForkArchivedCandidates ───

  describe("markForkArchivedCandidates", () => {
    it("archives fork sessions past timeout", () => {
      const repo = createRepo();
      const oldTime = "2026-02-18T07:00:00.000Z";
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:fparent", channel: "discord", chatId: "fparent", nowIso: NOW, idGenerator });
        const fork = repo.insert(writer, { key: "subagent:discord:default:fparent:ft", channel: "discord", chatId: "fparent", nowIso: oldTime, idGenerator });
        repo.setForkLineage(writer, { key: fork.key, parentSessionKey: "discord:default:fparent", rootSessionKey: "discord:default:fparent" });
      });

      const count = db.withWriteTransaction((writer) =>
        repo.markForkArchivedCandidates(writer, { forkTimeoutBeforeIso: "2026-02-18T09:00:00.000Z", nowIso: NOW }),
      );

      expect(count).toBe(1);
      const fork = db.withReadConnection((reader) => repo.getByKey(reader, "subagent:discord:default:fparent:ft"));
      expect(fork!.status).toBe("archived");
    });

    it("does not archive non-fork sessions", () => {
      const repo = createRepo();
      const oldTime = "2026-02-18T07:00:00.000Z";
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:nofork", channel: "discord", chatId: "nofork", nowIso: oldTime, idGenerator });
      });

      const count = db.withWriteTransaction((writer) =>
        repo.markForkArchivedCandidates(writer, { forkTimeoutBeforeIso: "2026-02-18T09:00:00.000Z", nowIso: NOW }),
      );

      expect(count).toBe(0);
    });
  });

  // ─── Lifecycle sweeps ───

  describe("markIdleCandidates", () => {
    it("marks active sessions as idle when activity is old enough", () => {
      const repo = createRepo();
      const oldTime = "2026-02-18T09:00:00.000Z";
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:idle1", channel: "discord", chatId: "idle1", nowIso: oldTime, idGenerator });
      });

      const count = db.withWriteTransaction((writer) =>
        repo.markIdleCandidates(writer, { idleBeforeIso: "2026-02-18T09:30:00.000Z", nowIso: NOW }),
      );

      expect(count).toBe(1);
      const session = db.withReadConnection((reader) => repo.getByKey(reader, "discord:default:idle1"));
      expect(session!.status).toBe("idle");
    });
  });

  describe("markArchivedCandidates", () => {
    it("marks idle sessions as archived when idle long enough", () => {
      const repo = createRepo();
      const idleTime = "2026-02-10T09:00:00.000Z";
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:arc1", channel: "discord", chatId: "arc1", nowIso: idleTime, idGenerator });
        repo.updateStatus(writer, { key: "discord:default:arc1", to: "idle", nowIso: idleTime });
      });

      const count = db.withWriteTransaction((writer) =>
        repo.markArchivedCandidates(writer, { archiveBeforeIso: "2026-02-17T00:00:00.000Z", nowIso: NOW }),
      );

      expect(count).toBe(1);
      const session = db.withReadConnection((reader) => repo.getByKey(reader, "discord:default:arc1"));
      expect(session!.status).toBe("archived");
    });
  });

  describe("markPrunedCandidates", () => {
    it("returns keys of pruned sessions", () => {
      const repo = createRepo();
      const archTime = "2026-01-01T00:00:00.000Z";
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:prune1", channel: "discord", chatId: "prune1", nowIso: archTime, idGenerator });
        repo.updateStatus(writer, { key: "discord:default:prune1", to: "archived", nowIso: archTime });
      });

      const keys = db.withWriteTransaction((writer) =>
        repo.markPrunedCandidates(writer, { olderThanIso: NOW, nowIso: NOW }),
      );

      expect(keys).toContain("discord:default:prune1");
    });
  });

  describe("hardDeletePruned", () => {
    it("deletes pruned sessions older than threshold", () => {
      const repo = createRepo();
      const oldTime = "2026-01-01T00:00:00.000Z";
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:del1", channel: "discord", chatId: "del1", nowIso: oldTime, idGenerator });
        repo.updateStatus(writer, { key: "discord:default:del1", to: "pruned", nowIso: oldTime });
      });

      const count = db.withWriteTransaction((writer) =>
        repo.hardDeletePruned(writer, { hardDeleteBeforeIso: NOW }),
      );

      expect(count).toBe(1);
      const session = db.withReadConnection((reader) => repo.getByKey(reader, "discord:default:del1"));
      expect(session).toBeNull();
    });

    it("does not delete recent pruned sessions", () => {
      const repo = createRepo();
      db.withWriteTransaction((writer) => {
        repo.insert(writer, { key: "discord:default:del2", channel: "discord", chatId: "del2", nowIso: NOW, idGenerator });
        repo.updateStatus(writer, { key: "discord:default:del2", to: "pruned", nowIso: NOW });
      });

      const count = db.withWriteTransaction((writer) =>
        repo.hardDeletePruned(writer, { hardDeleteBeforeIso: "2026-02-17T00:00:00.000Z" }),
      );

      expect(count).toBe(0);
    });
  });
});
