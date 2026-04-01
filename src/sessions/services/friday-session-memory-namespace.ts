import { FridayDomainError } from "#errors";

import {
  FRIDAY_SESSION_ERROR_CODES,
  FRIDAY_SESSION_MEMORY_NAMESPACE_CHANNEL_SEGMENT,
  FRIDAY_SESSION_MEMORY_NAMESPACE_SHARED_SEGMENT,
  FRIDAY_SESSION_MEMORY_NAMESPACE_TENANT_SEGMENT,
  FRIDAY_SESSION_MEMORY_NAMESPACE_USER_SEGMENT,
  FRIDAY_SESSION_MEMORY_SOURCE_PREFIX,
} from "../friday-session.constants.js";
import type { FridaySessionRecord } from "../model/friday-session.types.js";
import { parseFridaySessionKey } from "./friday-session-key.js";

/** Optional session lookup function for walking parent chains. */
export type FridaySessionLookupFn = (key: string) => FridaySessionRecord | null;

/**
 * Resolve a memory namespace for a session.
 *
 * The namespace is deterministic by account/channel/user so that
 * memory is isolated per channel instead of being shared across all
 * channels for the same user.
 *
 * For subagent sessions without a userId, walks the parent chain to find one.
 *
 * Format: `tenant.<accountId>.channel.<channel>.user.<normalizedUserId>.shared`
 */
export function resolveFridaySessionMemoryNamespace(
  session: FridaySessionRecord,
  sessionLookup?: FridaySessionLookupFn,
): string {
  const userId = resolveEffectiveUserId(session, sessionLookup);

  if (!userId) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.MEMORY_NAMESPACE_UNRESOLVABLE,
      `Cannot resolve memory namespace for session '${session.key}': no userId available`,
      { httpStatus: 400 },
    );
  }

  const normalizedAccountId = normalizeNamespaceSegment(session.accountId || "default");
  const normalizedChannel = normalizeNamespaceSegment(session.channel || "unknown");
  const normalizedUserId = normalizeNamespaceSegment(userId);

  return [
    FRIDAY_SESSION_MEMORY_NAMESPACE_TENANT_SEGMENT,
    normalizedAccountId,
    FRIDAY_SESSION_MEMORY_NAMESPACE_CHANNEL_SEGMENT,
    normalizedChannel,
    FRIDAY_SESSION_MEMORY_NAMESPACE_USER_SEGMENT,
    normalizedUserId,
    FRIDAY_SESSION_MEMORY_NAMESPACE_SHARED_SEGMENT,
  ].join(".");
}

/**
 * Build a memory source tag for session-scoped writes.
 *
 * Format: `session:<sessionKey>`
 */
export function buildFridaySessionMemorySource(sessionKey: string): string {
  return `${FRIDAY_SESSION_MEMORY_SOURCE_PREFIX}:${sessionKey}`;
}

/**
 * Build memory metadata for session-scoped writes.
 */
export function buildFridaySessionMemoryMetadata(session: FridaySessionRecord): Record<string, string> {
  return {
    sessionKey: session.key,
    channel: session.channel,
    accountId: session.accountId,
    chatId: session.chatId,
  };
}

// ─── Helpers ───

/**
 * Resolve the effective userId for a session.
 * For subagent sessions without userId, walks up the parent chain.
 */
function resolveEffectiveUserId(
  session: FridaySessionRecord,
  sessionLookup?: FridaySessionLookupFn,
): string | undefined {
  if (session.userId) {
    return session.userId;
  }

  // For DM sessions, the chatId might be the userId
  const parts = parseFridaySessionKey(session.key);
  if (parts.kind === "conversation" && session.chatKind === "dm") {
    return parts.chatId;
  }

  // For subagent sessions, walk parent chain to find userId
  if (parts.kind === "subagent" && sessionLookup) {
    const visited = new Set<string>();
    let currentKey = session.parentSessionKey ?? parts.parentKey;

    while (currentKey && !visited.has(currentKey)) {
      visited.add(currentKey);
      const parentSession = sessionLookup(currentKey);
      if (!parentSession) {
        break;
      }
      if (parentSession.userId) {
        return parentSession.userId;
      }
      // Check if parent is a DM conversation
      const parentParts = parseFridaySessionKey(parentSession.key);
      if (parentParts.kind === "conversation" && parentSession.chatKind === "dm") {
        return parentParts.chatId;
      }
      // Move up
      currentKey = parentSession.parentSessionKey ?? parentParts.parentKey;
    }
  }

  return undefined;
}

function normalizeNamespaceSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized.length > 0 ? normalized : "default";
}
