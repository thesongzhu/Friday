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
 * The DEFAULT-OFF env flag that governs whether the dot-join COLLISION HARDENING
 * (F5.5) is active. ON only when `FRIDAY_NS_HARDENING_ENABLED` is exactly `"1"`
 * (after trimming). UNSET / empty / `"0"` / any other value ⇒ OFF — the unchanged,
 * pre-hardening (legacy) derivation.
 *
 * WHY default-off matters for data safety: when OFF the segment keep-set still
 * includes `.` exactly as it did before this change, so every namespace this
 * resolver produces is BYTE-IDENTICAL to the legacy derivation. No existing memory
 * is re-scoped/orphaned. When ON, the WRITE path emits the hardened namespace AND
 * the READ path dual-reads BOTH the hardened and legacy namespaces (see
 * {@link resolveFridaySessionMemoryNamespaceCandidates}), so nothing is lost on
 * flip — there is NO one-way destructive re-key.
 *
 * PARITY: the Rust half reads the SAME flag name under the SAME `"1"` semantics
 * (`session_namespace::ns_hardening_enabled`).
 */
export const FRIDAY_NS_HARDENING_ENV_FLAG = "FRIDAY_NS_HARDENING_ENABLED";

/**
 * Read the DEFAULT-OFF {@link FRIDAY_NS_HARDENING_ENV_FLAG}. Narrow + explicit (exact
 * trimmed `"1"`) so the hardening cannot be enabled by accident.
 */
export function isFridayNamespaceHardeningEnabled(): boolean {
  return (process.env[FRIDAY_NS_HARDENING_ENV_FLAG] ?? "").trim() === "1";
}

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
 *
 * COLLISION HARDENING (F5.5, FLAG-GATED): the `hardened` derivation drops `.` from
 * the segment keep-set so the dot (the segment joiner) can never be forged inside a
 * segment. It is governed by the DEFAULT-OFF {@link FRIDAY_NS_HARDENING_ENV_FLAG}.
 * The optional `options.hardened` override is for tests/candidate-derivation; when
 * omitted the flag decides. This function returns the PRIMARY (write) namespace; the
 * READ path must use {@link resolveFridaySessionMemoryNamespaceCandidates} so a
 * flag-on flip never orphans legacy-written memory.
 */
export function resolveFridaySessionMemoryNamespace(
  session: FridaySessionRecord,
  sessionLookup?: FridaySessionLookupFn,
  options?: { hardened?: boolean },
): string {
  const userId = resolveEffectiveUserId(session, sessionLookup);

  if (!userId) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.MEMORY_NAMESPACE_UNRESOLVABLE,
      `Cannot resolve memory namespace for session '${session.key}': no userId available`,
      { httpStatus: 400 },
    );
  }

  const hardened = options?.hardened ?? isFridayNamespaceHardeningEnabled();
  return buildNamespace(session.accountId || "default", session.channel || "unknown", userId, hardened);
}

/**
 * Resolve the ORDERED, DEDUPED set of namespaces to consult on the READ (recall)
 * path — the non-destructive substitute for re-keying existing memory.
 *
 * - Hardening OFF (default): `[legacy]` — a SINGLE namespace, byte-identical to
 *   today. Recall is one query, no behavior change.
 * - Hardening ON: `[hardened, legacy]` deduped. The hardened namespace is consulted
 *   first (new writes land there); the legacy namespace is consulted too so memory
 *   written before the flip (or by a peer still on legacy) is STILL recalled.
 *
 * DEDUP-COLLAPSE: when no segment contains a `.`, the hardened and legacy
 * derivations are IDENTICAL, so the list collapses to ONE entry even with the flag
 * ON — i.e. the common (non-dotted) case has zero extra reads. Only a segment that
 * legitimately contains a `.` (an email-shaped userId, a dotted account/channel)
 * produces two distinct reads.
 *
 * HONEST scope of the collision fix (see also the Rust mirror): the LEGACY namespace
 * IS the colliding string, so dual-reading it re-reads the pre-hardening collision
 * bucket. The hardening closes the cross-tuple collision for NEW (hardened) WRITES
 * only; legacy data retains its pre-F5.5 collision semantics (the same accepted
 * behavior under the single-owner v1 threat model, where userIds are not
 * adversarially controlled). Dual-read is strictly ≥ the pre-#661 state — it can
 * never lose data — but it does NOT retroactively disambiguate already-colliding
 * legacy rows (structurally impossible: one shared bucket cannot be split).
 */
export function resolveFridaySessionMemoryNamespaceCandidates(
  session: FridaySessionRecord,
  sessionLookup?: FridaySessionLookupFn,
): string[] {
  const userId = resolveEffectiveUserId(session, sessionLookup);

  if (!userId) {
    throw new FridayDomainError(
      FRIDAY_SESSION_ERROR_CODES.MEMORY_NAMESPACE_UNRESOLVABLE,
      `Cannot resolve memory namespace for session '${session.key}': no userId available`,
      { httpStatus: 400 },
    );
  }

  const account = session.accountId || "default";
  const channel = session.channel || "unknown";
  const legacy = buildNamespace(account, channel, userId, false);

  if (!isFridayNamespaceHardeningEnabled()) {
    return [legacy];
  }

  const hardened = buildNamespace(account, channel, userId, true);
  // Ordered (hardened first) + deduped: when both derivations agree (no dotted
  // segment) the list collapses to a single entry.
  return hardened === legacy ? [hardened] : [hardened, legacy];
}

/**
 * Build the composite namespace from already-resolved axes under an EXPLICIT
 * `hardened` mode (pure; the flag is read by the callers above). The seven
 * fixed-position parts are `.`-joined; with `hardened` the segment normalizer drops
 * `.`, so no payload segment can contain the joiner.
 */
function buildNamespace(account: string, channel: string, userId: string, hardened: boolean): string {
  return [
    FRIDAY_SESSION_MEMORY_NAMESPACE_TENANT_SEGMENT,
    normalizeNamespaceSegment(account, hardened),
    FRIDAY_SESSION_MEMORY_NAMESPACE_CHANNEL_SEGMENT,
    normalizeNamespaceSegment(channel, hardened),
    FRIDAY_SESSION_MEMORY_NAMESPACE_USER_SEGMENT,
    normalizeNamespaceSegment(userId, hardened),
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
 * Pipeline: lowercase → replace every char NOT in the keep-set with `-` → collapse
 * runs of `-` → trim leading/trailing `-` → empty result becomes `default`.
 *
 * COLLISION HARDENING (F5.5, FLAG-GATED): the keep-set depends on `hardened`:
 * - `hardened === false` (LEGACY, default): keep-set `[a-z0-9._-]` — the literal `.`
 *   is KEPT inside a segment, byte-identical to the pre-hardening derivation.
 * - `hardened === true`: keep-set `[a-z0-9_-]` — the literal `.` maps to `-` like any
 *   other punctuation. `.` is the SEGMENT JOINER used by
 *   {@link resolveFridaySessionMemoryNamespace} (`[...].join(".")`), and that
 *   composite string becomes the memory store SCOPE (the Rust `principal_id`). With
 *   `.` stripped from every segment the composite ALWAYS splits into exactly the
 *   seven fixed-position parts, so the mapping is injective over NORMALIZED segment
 *   tuples: a userId such as `alice.channel.evil.user.bob` can no longer FORGE a
 *   different (account, channel, user) tuple's namespace string. The WITHIN-position
 *   normalization stays lossy (`a.b` ≡ `a-b`, the same accepted behavior as `@`→`-`).
 *
 * PARITY: both keep-sets are byte-identical to the Rust port
 * `normalize_namespace_segment` / `is_kept` in
 * `rust-core/crates/friday-hub/src/session_namespace.rs` under the same `hardened`
 * flag. The two MUST stay in lockstep (the Rust half binds the same composite string
 * to its `principal_id` scope).
 */
function normalizeNamespaceSegment(value: string, hardened: boolean): string {
  // Legacy keep-set KEEPS `.`; hardened keep-set DROPS it (`.` → `-`).
  const keepSet = hardened ? /[^a-z0-9_-]/g : /[^a-z0-9._-]/g;
  const normalized = value
    .toLowerCase()
    .replace(keepSet, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized.length > 0 ? normalized : "default";
}
