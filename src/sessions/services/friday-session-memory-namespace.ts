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

/**
 * Normalize a single namespace SEGMENT.
 *
 * Pipeline: lowercase → replace every char NOT in the keep-set `[a-z0-9_-]` with `-`
 * → collapse runs of `-` → trim leading/trailing `-` → empty result becomes `default`.
 *
 * COLLISION HARDENING (F5.5): the literal `.` is DELIBERATELY EXCLUDED from the keep-set
 * (it maps to `-` like any other punctuation). `.` is the SEGMENT JOINER used by
 * {@link resolveFridaySessionMemoryNamespace} (`[...].join(".")`), and that composite string
 * becomes the memory store SCOPE (the Rust `principal_id`). If a segment could itself
 * contain a `.`, a userId such as `alice.channel.evil.user.bob` could FORGE a different
 * (account, channel, user) tuple's namespace string — a cross-scope memory read/write
 * collision. With `.` stripped from every segment, the composite ALWAYS splits into exactly
 * the seven fixed-position parts, so the mapping is injective over NORMALIZED segment
 * tuples: this closes the CROSS-POSITION joiner-injection (a segment can no longer forge a
 * different account/channel/user split). The WITHIN-position normalization stays lossy
 * (`a.b` ≡ `a-b`, the same accepted behavior as the pre-existing `@` → `-`); that is
 * lower-severity and not exploitable under the single-owner v1 threat model.
 *
 * PARITY: this keep-set is byte-identical to the Rust port `normalize_namespace_segment`
 * / `is_kept` in `rust-core/crates/friday-hub/src/session_namespace.rs`. The two MUST stay
 * in lockstep (the Rust half binds the same composite string to its `principal_id` scope).
 */
function normalizeNamespaceSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized.length > 0 ? normalized : "default";
}
