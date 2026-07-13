// ─── XHS Session Manager — cookie-based session persistence ───

import type { FridaySqliteLayer } from "#state";
import { safeJsonParse } from "#utilities";
import { decryptSecret, decryptSecretWithMigration, encryptSecret, getStrictMasterKey } from "#providers";
import type { FridayEncryptedEnvelope, FridaySecretAadContext } from "#providers";
import { xhsRandomUserAgent } from "./friday-xhs-stealth.js";

/**
 * Canonical AAD binding context for an xhs session's encrypted cookies.
 * Binds the session's stable primary key (`id`), so a cookie blob cannot be
 * transplanted to another session row.
 */
function xhsCookiesAadContext(sessionId: string): FridaySecretAadContext {
  return { store: "friday-xhs", ref: sessionId, field: "cookies" };
}

// ─── Types ───

export interface XhsSessionRow {
  id: string;
  account_name: string;
  user_agent: string;
  last_used_at: string;
  created_at: string;
}

export interface XhsCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface XhsSessionManager {
  saveCookies(sessionId: string, accountName: string, cookies: XhsCookie[]): void;
  loadCookies(sessionId: string): XhsCookie[] | undefined;
  isSessionValid(sessionId: string): boolean;
  getSession(sessionId: string): XhsSessionRow | undefined;
  deleteSession(sessionId: string): void;
  listSessions(): XhsSessionRow[];
  touchSession(sessionId: string): void;
}

export interface CreateXhsSessionManagerDeps {
  sqlite: FridaySqliteLayer;
  nowIso?: () => string;
}

// ─── Constants ───

/** Sessions older than 7 days without use are considered expired. */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** XHS login cookie names that must be present for a valid session. */
const REQUIRED_COOKIE_NAMES = ["a1", "web_session"];

/** Placeholder stored in cookies_json column — plaintext cookies must NEVER be persisted. */
const REDACTED_COOKIES_JSON = "[REDACTED]";

// ─── Factory ───

export function createXhsSessionManager(deps: CreateXhsSessionManagerDeps): XhsSessionManager {
  const { sqlite, nowIso = () => new Date().toISOString() } = deps;

  function saveCookies(sessionId: string, accountName: string, cookies: XhsCookie[]): void {
    const now = nowIso();
    const userAgent = xhsRandomUserAgent();
    const plaintext = JSON.stringify(cookies);
    const encrypted = JSON.stringify(
      encryptSecret(plaintext, getStrictMasterKey(), xhsCookiesAadContext(sessionId)),
    );

    sqlite.withWriteTransaction((db) => {
      db.prepare(`
        INSERT INTO xhs_sessions (id, account_name, cookies_json, cookies_encrypted, user_agent, last_used_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cookies_json = excluded.cookies_json,
          cookies_encrypted = excluded.cookies_encrypted,
          user_agent = excluded.user_agent,
          last_used_at = excluded.last_used_at
      `).run(sessionId, accountName, REDACTED_COOKIES_JSON, encrypted, userAgent, now, now);
    });
  }

  function loadCookies(sessionId: string): XhsCookie[] | undefined {
    const row = sqlite.withReadConnection((db) =>
      db.prepare(`
        SELECT cookies_encrypted FROM xhs_sessions WHERE id = ?
      `).get(sessionId) as { cookies_encrypted: string | null } | undefined,
    );

    if (!row?.cookies_encrypted) return undefined;

    try {
      const envelope = safeJsonParse(row.cookies_encrypted) as FridayEncryptedEnvelope;
      const { plaintext, rewrapped } = decryptSecretWithMigration(
        envelope,
        getStrictMasterKey(),
        xhsCookiesAadContext(sessionId),
      );
      if (rewrapped) {
        // Read-repair (SEC-SECRET-AAD-001): migrate legacy v1 cookies to v2.
        try {
          sqlite.withWriteTransaction((db) => {
            db.prepare(`UPDATE xhs_sessions SET cookies_encrypted = ? WHERE id = ?`).run(
              JSON.stringify(rewrapped),
              sessionId,
            );
          });
        } catch {
          // Non-fatal: the read already succeeded.
        }
      }
      return safeJsonParse(plaintext) as XhsCookie[];
    } catch (err) {
      console.warn("[friday][xhs-session] cookie decryption failed:", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  function isSessionValid(sessionId: string): boolean {
    return sqlite.withReadConnection((db) => {
      const row = db.prepare(`
        SELECT cookies_encrypted, last_used_at FROM xhs_sessions WHERE id = ?
      `).get(sessionId) as { cookies_encrypted: string | null; last_used_at: string } | undefined;

      if (!row?.cookies_encrypted) return false;

      const lastUsed = new Date(row.last_used_at).getTime();
      const nowMs = new Date(nowIso()).getTime();
      if (!Number.isFinite(lastUsed) || !Number.isFinite(nowMs)) return false;
      if (nowMs - lastUsed > SESSION_MAX_AGE_MS) return false;

      let cookies: XhsCookie[];
      try {
        const envelope = safeJsonParse(row.cookies_encrypted) as FridayEncryptedEnvelope;
        const plaintext = decryptSecret(envelope, getStrictMasterKey(), xhsCookiesAadContext(sessionId));
        cookies = safeJsonParse(plaintext) as XhsCookie[];
      } catch (err) {
        console.warn("[friday][xhs-session] session validation cookie parse failed:", err instanceof Error ? err.message : String(err));
        return false;
      }

      const cookieNames = new Set(cookies.map((c) => c.name));
      return REQUIRED_COOKIE_NAMES.every((name) => cookieNames.has(name));
    });
  }

  function getSession(sessionId: string): XhsSessionRow | undefined {
    return sqlite.withReadConnection((db) => {
      return db.prepare(`
        SELECT id, account_name, user_agent, last_used_at, created_at
        FROM xhs_sessions WHERE id = ?
      `).get(sessionId) as XhsSessionRow | undefined;
    });
  }

  function deleteSession(sessionId: string): void {
    sqlite.withWriteTransaction((db) => {
      db.prepare(`DELETE FROM xhs_sessions WHERE id = ?`).run(sessionId);
    });
  }

  function listSessions(): XhsSessionRow[] {
    return sqlite.withReadConnection((db) => {
      return db.prepare(`
        SELECT id, account_name, user_agent, last_used_at, created_at
        FROM xhs_sessions ORDER BY last_used_at DESC
      `).all() as XhsSessionRow[];
    });
  }

  function touchSession(sessionId: string): void {
    const now = nowIso();
    sqlite.withWriteTransaction((db) => {
      db.prepare(`
        UPDATE xhs_sessions SET last_used_at = ? WHERE id = ?
      `).run(now, sessionId);
    });
  }

  return {
    saveCookies,
    loadCookies,
    isSessionValid,
    getSession,
    deleteSession,
    listSessions,
    touchSession,
  };
}

// ─── Exported constants for testing ───

export const XHS_SESSION_CONSTANTS = {
  SESSION_MAX_AGE_MS,
  REQUIRED_COOKIE_NAMES,
} as const;
