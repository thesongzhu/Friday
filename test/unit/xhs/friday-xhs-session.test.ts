import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createXhsSessionManager,
  XHS_SESSION_CONSTANTS,
} from "#xhs";
import type { XhsCookie, XhsSessionManager } from "#xhs";
import type { FridaySqliteLayer } from "#state";
import { resetMasterKeyCache } from "#providers";

// ─── Mock SQLite layer ───

function createMockSqliteLayer(): FridaySqliteLayer {
  const store = new Map<string, Record<string, unknown>>();

  const mockDb = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      return {
        run: vi.fn().mockImplementation((...params: unknown[]) => {
          if (sql.includes("INSERT")) {
            const [id, accountName, cookiesJson, cookiesEncrypted, userAgent, lastUsedAt, createdAt] = params as string[];
            store.set(id!, {
              id,
              account_name: accountName,
              cookies_json: cookiesJson,
              cookies_encrypted: cookiesEncrypted ?? null,
              user_agent: userAgent,
              last_used_at: lastUsedAt,
              created_at: createdAt,
            });
          } else if (sql.includes("UPDATE") && sql.includes("cookies_encrypted")) {
            const [cookiesEncrypted, id] = params as string[];
            const row = store.get(id!);
            if (row) row.cookies_encrypted = cookiesEncrypted;
          } else if (sql.includes("UPDATE")) {
            const [lastUsedAt, id] = params as string[];
            const row = store.get(id!);
            if (row) row.last_used_at = lastUsedAt;
          } else if (sql.includes("DELETE")) {
            const [id] = params as string[];
            store.delete(id!);
          }
        }),
        get: vi.fn().mockImplementation((...params: unknown[]) => {
          const [id] = params as string[];
          return store.get(id!) ?? undefined;
        }),
        all: vi.fn().mockImplementation(() => {
          return Array.from(store.values());
        }),
      };
    }),
  };

  return {
    dbPath: ":memory:",
    writer: mockDb as never,
    reads: { size: 1, withReadConnection: vi.fn(), close: vi.fn() },
    withWriteTransaction: vi.fn().mockImplementation((fn) => fn(mockDb)),
    withReadConnection: vi.fn().mockImplementation((fn) => fn(mockDb)),
    checkpoint: vi.fn(),
    close: vi.fn(),
  };
}

// ─── Test cookies ───

function validCookies(): XhsCookie[] {
  return [
    { name: "a1", value: "abc123", domain: ".xiaohongshu.com", path: "/" },
    { name: "web_session", value: "session456", domain: ".xiaohongshu.com", path: "/" },
    { name: "xsecappid", value: "xhs-pc-web", domain: ".xiaohongshu.com", path: "/" },
  ];
}

function incompleteCookies(): XhsCookie[] {
  return [
    { name: "xsecappid", value: "xhs-pc-web", domain: ".xiaohongshu.com", path: "/" },
  ];
}

// ─── Tests ───

describe("XhsSessionManager", () => {
  let sqlite: FridaySqliteLayer;
  let manager: XhsSessionManager;
  const NOW = "2026-02-20T09:00:00.000Z";
  const previousMasterKey = process.env.FRIDAY_MASTER_KEY;
  const previousMasterKeySource = process.env.FRIDAY_MASTER_KEY_SOURCE;

  beforeEach(() => {
    process.env.FRIDAY_MASTER_KEY = "15".repeat(32);
    delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    resetMasterKeyCache();
    sqlite = createMockSqliteLayer();
    manager = createXhsSessionManager({
      sqlite,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    if (previousMasterKey === undefined) {
      delete process.env.FRIDAY_MASTER_KEY;
    } else {
      process.env.FRIDAY_MASTER_KEY = previousMasterKey;
    }
    if (previousMasterKeySource === undefined) {
      delete process.env.FRIDAY_MASTER_KEY_SOURCE;
    } else {
      process.env.FRIDAY_MASTER_KEY_SOURCE = previousMasterKeySource;
    }
    resetMasterKeyCache();
  });

  // ─── saveCookies + loadCookies roundtrip ───

  describe("saveCookies / loadCookies", () => {
    function readRawRow(sessionId: string): { cookies_json: string; cookies_encrypted: string | null } | undefined {
      return sqlite.withReadConnection((db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }) =>
        db.prepare(`
          SELECT cookies_json, cookies_encrypted FROM xhs_sessions WHERE id = ?
        `).get(sessionId) as { cookies_json: string; cookies_encrypted: string | null } | undefined,
      );
    }

    it("persists and retrieves cookies", () => {
      const cookies = validCookies();
      manager.saveCookies("session-1", "test-account", cookies);

      const loaded = manager.loadCookies("session-1");
      expect(loaded).toEqual(cookies);
    });

    it("fails closed when FRIDAY_MASTER_KEY is not configured", () => {
      delete process.env.FRIDAY_MASTER_KEY;
      delete process.env.FRIDAY_MASTER_KEY_SOURCE;
      resetMasterKeyCache();

      expect(() =>
        manager.saveCookies("session-1", "test-account", validCookies()),
      ).toThrow(/FRIDAY_MASTER_KEY is not configured/);
    });

    it("does not store plaintext cookie payload in cookies_json", () => {
      const cookies = validCookies();
      const plaintext = JSON.stringify(cookies);
      manager.saveCookies("session-1", "test-account", cookies);

      const row = readRawRow("session-1");
      expect(row).toBeDefined();
      expect(row!.cookies_json).not.toBe(plaintext);
      expect(row!.cookies_json).not.toContain("\"name\":\"a1\"");
      expect(row!.cookies_json).not.toContain("\"name\":\"web_session\"");
    });

    it("stores encrypted envelope data (not plaintext JSON)", () => {
      const cookies = validCookies();
      const plaintext = JSON.stringify(cookies);
      manager.saveCookies("session-1", "test-account", cookies);

      const row = readRawRow("session-1");
      expect(row).toBeDefined();
      expect(row!.cookies_encrypted).toBeTruthy();
      expect(row!.cookies_encrypted).not.toBe(plaintext);
      expect(row!.cookies_encrypted).not.toContain("\"name\":\"a1\"");

      const envelope = JSON.parse(row!.cookies_encrypted!) as Record<string, unknown>;
      expect(typeof envelope.ciphertext).toBe("string");
      expect(typeof envelope.iv).toBe("string");
      expect(typeof envelope.tag).toBe("string");
    });

    it("fails closed when encrypted payload is corrupted", () => {
      manager.saveCookies("session-1", "test-account", validCookies());

      // Corrupt the encrypted payload directly in the store
      const row = readRawRow("session-1");
      expect(row).toBeDefined();

      // Directly tamper with the stored data
      sqlite.withWriteTransaction((db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }) => {
        db.prepare(`UPDATE xhs_sessions SET cookies_encrypted = ? WHERE id = ?`)
          .run("{corrupted-json", "session-1");
      });

      expect(manager.loadCookies("session-1")).toBeUndefined();
      expect(manager.isSessionValid("session-1")).toBe(false);
    });

    it("returns undefined for unknown session", () => {
      const loaded = manager.loadCookies("nonexistent");
      expect(loaded).toBeUndefined();
    });

    it("overwrites cookies on re-save", () => {
      manager.saveCookies("session-1", "test-account", validCookies());

      const newCookies: XhsCookie[] = [
        { name: "a1", value: "new-value", domain: ".xiaohongshu.com", path: "/" },
        { name: "web_session", value: "new-session", domain: ".xiaohongshu.com", path: "/" },
      ];
      manager.saveCookies("session-1", "test-account", newCookies);

      const loaded = manager.loadCookies("session-1");
      expect(loaded).toEqual(newCookies);
    });
  });

  // ─── isSessionValid ───

  describe("isSessionValid", () => {
    it("returns true for a session with required cookies", () => {
      manager.saveCookies("session-1", "test-account", validCookies());
      expect(manager.isSessionValid("session-1")).toBe(true);
    });

    it("returns false for nonexistent session", () => {
      expect(manager.isSessionValid("nonexistent")).toBe(false);
    });

    it("returns false when required cookies are missing", () => {
      manager.saveCookies("session-1", "test-account", incompleteCookies());
      expect(manager.isSessionValid("session-1")).toBe(false);
    });

    it("returns false for expired session", () => {
      // Save with old timestamp
      const oldDate = new Date(
        new Date(NOW).getTime() - XHS_SESSION_CONSTANTS.SESSION_MAX_AGE_MS - 1000,
      ).toISOString();
      const oldManager = createXhsSessionManager({
        sqlite,
        nowIso: () => oldDate,
      });
      oldManager.saveCookies("session-old", "test-account", validCookies());

      expect(manager.isSessionValid("session-old")).toBe(false);
    });
  });

  // ─── getSession ───

  describe("getSession", () => {
    it("returns session row when exists", () => {
      manager.saveCookies("session-1", "test-account", validCookies());
      const row = manager.getSession("session-1");
      expect(row).toBeDefined();
      expect(row!.id).toBe("session-1");
      expect(row!.account_name).toBe("test-account");
    });

    it("returns undefined for nonexistent session", () => {
      expect(manager.getSession("nonexistent")).toBeUndefined();
    });
  });

  // ─── deleteSession ───

  describe("deleteSession", () => {
    it("removes the session", () => {
      manager.saveCookies("session-1", "test-account", validCookies());
      manager.deleteSession("session-1");
      expect(manager.loadCookies("session-1")).toBeUndefined();
    });
  });

  // ─── listSessions ───

  describe("listSessions", () => {
    it("returns all sessions", () => {
      manager.saveCookies("session-1", "account-a", validCookies());
      manager.saveCookies("session-2", "account-b", validCookies());
      const sessions = manager.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it("returns empty array when no sessions", () => {
      expect(manager.listSessions()).toEqual([]);
    });
  });

  // ─── touchSession ───

  describe("touchSession", () => {
    it("updates last_used_at timestamp", () => {
      manager.saveCookies("session-1", "test-account", validCookies());
      const laterManager = createXhsSessionManager({
        sqlite,
        nowIso: () => "2026-02-20T12:00:00.000Z",
      });
      laterManager.touchSession("session-1");
      const row = laterManager.getSession("session-1");
      expect(row!.last_used_at).toBe("2026-02-20T12:00:00.000Z");
    });
  });

  // ─── Constants ───

  describe("constants", () => {
    it("has expected required cookie names", () => {
      expect(XHS_SESSION_CONSTANTS.REQUIRED_COOKIE_NAMES).toContain("a1");
      expect(XHS_SESSION_CONSTANTS.REQUIRED_COOKIE_NAMES).toContain("web_session");
    });

    it("has reasonable max age", () => {
      // 7 days in ms
      expect(XHS_SESSION_CONSTANTS.SESSION_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });
});
