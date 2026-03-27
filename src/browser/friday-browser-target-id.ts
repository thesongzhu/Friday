/**
 * Browser Target-ID Resolver — resolves targetId strings to session/tab pairs.
 *
 * Target IDs follow the format: "sessionId" or "sessionId:tabId".
 * When only a session is specified, the active tab is used.
 * Supports profile-based disambiguation for multi-profile environments.
 */

import { FridayDomainError } from "#errors";
import type { BrowserSession, FridayBrowserManager } from "./friday-browser-manager.js";

// ─── Types ───

export interface ResolvedBrowserTarget {
  sessionId: string;
  tabId: string;
  session: BrowserSession;
}

export interface BrowserTargetIdResolveOptions {
  /** Explicit session ID. Takes precedence over targetId parsing. */
  sessionId?: string;
  /** Target ID in "sessionId" or "sessionId:tabId" format. */
  targetId?: string;
  /** Explicit tab ID. Takes precedence over targetId parsing. */
  tabId?: string;
  /** Profile name. Used to disambiguate sessions by profile. */
  profile?: string;
}

// ─── Parsing ───

/**
 * Parse a targetId string into session and tab components.
 * Format: "sessionId" or "sessionId:tabId"
 */
export function parseBrowserTargetId(
  targetId: string,
): { sessionId: string; tabId?: string } {
  const colonIndex = targetId.indexOf(":");
  if (colonIndex === -1) {
    return { sessionId: targetId };
  }
  return {
    sessionId: targetId.slice(0, colonIndex),
    tabId: targetId.slice(colonIndex + 1),
  };
}

/**
 * Format a session/tab pair into a targetId string.
 */
export function formatBrowserTargetId(sessionId: string, tabId?: string): string {
  if (tabId) {
    return `${sessionId}:${tabId}`;
  }
  return sessionId;
}

// ─── Resolution ───

/**
 * Resolve target options to a concrete session + tab.
 *
 * Priority:
 * 1. Explicit sessionId + tabId
 * 2. targetId parsed into sessionId + tabId
 * 3. Profile-based session lookup (first session matching profile)
 *
 * Throws if the session or tab cannot be found.
 */
export function resolveBrowserTarget(
  manager: FridayBrowserManager,
  options: BrowserTargetIdResolveOptions,
): ResolvedBrowserTarget {
  let sessionId = options.sessionId;
  let tabId = options.tabId;

  // Parse targetId if no explicit session
  if (!sessionId && options.targetId) {
    const parsed = parseBrowserTargetId(options.targetId);
    sessionId = parsed.sessionId;
    if (!tabId && parsed.tabId) {
      tabId = parsed.tabId;
    }
  }

  // Profile-based lookup if no session resolved yet
  if (!sessionId && options.profile) {
    // Use stored profile metadata for resolution instead of naming convention
    const profileSessions = manager.getSessionsByProfile(options.profile);
    if (profileSessions.length > 0) {
      sessionId = profileSessions[0]!.sessionId;
    }
    if (!sessionId) {
      throw new FridayDomainError("NOT_FOUND", `No session found for profile "${options.profile}". Launch a browser session first.`, { httpStatus: 404 });
    }
  }

  if (!sessionId) {
    throw new FridayDomainError("VALIDATION_ERROR", "No session specified. Provide sessionId, targetId, or profile.", { httpStatus: 400 });
  }

  const session = manager.getSession(sessionId);
  if (!session) {
    throw new FridayDomainError("NOT_FOUND", `Session "${sessionId}" not found. Use "open" action first.`, { httpStatus: 404 });
  }

  // Resolve tab
  const resolvedTabId = tabId ?? session.activeTabId;
  if (!session.tabs.has(resolvedTabId)) {
    throw new FridayDomainError("NOT_FOUND", `Tab "${resolvedTabId}" not found in session "${sessionId}".`, { httpStatus: 404 });
  }

  return { sessionId, tabId: resolvedTabId, session };
}
