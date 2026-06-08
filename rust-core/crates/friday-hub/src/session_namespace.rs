//! Session memory NAMESPACE resolution (session-memory slice-3, ownership-binding).
//!
//! A faithful Rust port of the TS oracle
//! `src/sessions/services/friday-session-memory-namespace.ts`
//! (`resolveFridaySessionMemoryNamespace`). The namespace is the memory store SCOPE
//! derived DETERMINISTICALLY from a session's `(accountId, channel, userId)` axes, so a
//! user's memory is isolated PER (account, channel) instead of being shared across every
//! channel for the same user.
//!
//! Format (byte-identical to the TS — including the Unicode-aware lowercasing; see the
//! normalization note on the dot-join residual that is SHARED with the TS oracle):
//! ```text
//! tenant.<accountId>.channel.<channel>.user.<normalizedUserId>.shared
//! ```
//!
//! ## How this binds to the Rust recall axis
//! The Rust memory recall axis is a single `principal_id` string
//! (`friday_storage::memory::recall_confirmed` filters `WHERE principal_id = ?`).
//! `MemoryScope` is a coarse enum and is NOT a namespace. So slice-3 sets the Rust
//! **`principal_id` := this composite namespace string**, preserving per-(account,
//! channel, user) isolation on the existing recall axis (`scope` stays
//! `MemoryScope::Session`). The extraction derives this from the SESSION owner, NOT from a
//! caller-supplied principal — faithful to the TS production model where extraction is
//! job-driven and the session is the source of truth.
//!
//! ## Fail-closed on missing userId (PARITY, not just hardening)
//! The TS throws `MEMORY_NAMESPACE_UNRESOLVABLE` when no `userId` is available. This port
//! mirrors that with the typed [`NamespaceError::UnresolvableNoUserId`]: a session with no
//! `user_id` (or an empty one) CANNOT produce a namespace, so its extraction FAILS CLOSED
//! — it is never silently bound to a default/anonymous scope.
//!
//! ## Deferred-parity gaps (HONEST — documented, not implemented this slice)
//! The TS `resolveEffectiveUserId` resolves the userId in THREE ways:
//!   1. `session.userId` directly — **ported here**.
//!   2. (DM conversation) fall back to the `chatId` when `chatKind == "dm"` — **DEFERRED**.
//!   3. (subagent) walk the parent-session chain to find a userId — **DEFERRED**.
//! The Rust `agent_session` does not yet model `chatKind` / `chatId` / `parentSession`, so
//! cases (2) and (3) are not representable here. Until a follow-on slice adds those axes, a
//! session whose userId would ONLY have been resolvable via the DM-chatId fallback or the
//! subagent parent-walk will FAIL CLOSED here rather than resolve — which is the
//! conservative direction (no wrong-scope binding), but is a real parity gap vs the TS.
//!
//! Truth label: byte-identical namespace + normalization port for the DIRECT-userId case;
//! DM-chatId + subagent parent-walk userId fallbacks are DEFERRED-PARITY. PROOF-ONLY —
//! NOT a v1 GO; the TS extraction path stays LIVE pending full parity.

/// Namespace segment constants — ported from `src/sessions/friday-session.constants.ts`
/// (`FRIDAY_SESSION_MEMORY_NAMESPACE_*_SEGMENT`).
const TENANT_SEGMENT: &str = "tenant";
const CHANNEL_SEGMENT: &str = "channel";
const USER_SEGMENT: &str = "user";
const SHARED_SEGMENT: &str = "shared";

/// The TS account/channel defaults (`session.accountId || "default"`,
/// `session.channel || "unknown"`). NOTE: these defaults go THROUGH
/// [`normalize_namespace_segment`] afterward (which leaves them unchanged, but the order
/// is faithful to the TS).
const DEFAULT_ACCOUNT_ID: &str = "default";
const DEFAULT_CHANNEL: &str = "unknown";

/// The empty-result fallback of [`normalize_namespace_segment`] (TS: `"default"`).
const NORMALIZE_EMPTY_FALLBACK: &str = "default";

/// A typed namespace-resolution error. The single variant mirrors the TS
/// `FRIDAY_SESSION_ERROR_CODES.MEMORY_NAMESPACE_UNRESOLVABLE`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NamespaceError {
    /// No `userId` was available to resolve a namespace (the session has no `user_id`, or
    /// it is empty). FAIL CLOSED — parity with the TS throw.
    UnresolvableNoUserId,
}

impl std::fmt::Display for NamespaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NamespaceError::UnresolvableNoUserId => write!(
                f,
                "memory namespace unresolvable: no userId available for session"
            ),
        }
    }
}

impl std::error::Error for NamespaceError {}

/// Resolve the memory namespace (the composite store scope) for a session from its OWNER
/// axes, mirroring the TS `resolveFridaySessionMemoryNamespace` for the DIRECT-userId case.
///
/// * `account_id`: falsy (`None` or empty) → `"default"`, then normalized.
/// * `channel`: falsy (`None` or empty) → `"unknown"`, then normalized.
/// * `user_id`: falsy (`None` or empty) → FAIL CLOSED ([`NamespaceError::UnresolvableNoUserId`]).
///
/// Returns `tenant.<account>.channel.<channel>.user.<user>.shared`.
pub fn resolve_session_memory_namespace(
    account_id: Option<&str>,
    channel: Option<&str>,
    user_id: Option<&str>,
) -> Result<String, NamespaceError> {
    // FAIL CLOSED when no userId (TS: `if (!userId) throw MEMORY_NAMESPACE_UNRESOLVABLE`).
    // JS `!userId` is falsy on `undefined` AND the empty string, so an empty `user_id`
    // also fails here.
    let user_id = match user_id {
        Some(u) if !u.is_empty() => u,
        _ => return Err(NamespaceError::UnresolvableNoUserId),
    };

    // TS: `session.accountId || "default"` and `session.channel || "unknown"`. JS `||` is
    // falsy on the empty string too, so `Some("")` takes the default — NOT a naive
    // `unwrap_or` (which would only handle `None`). Then each goes THROUGH the normalizer.
    let account = falsy_or(account_id, DEFAULT_ACCOUNT_ID);
    let chan = falsy_or(channel, DEFAULT_CHANNEL);

    let normalized_account = normalize_namespace_segment(account);
    let normalized_channel = normalize_namespace_segment(chan);
    let normalized_user = normalize_namespace_segment(user_id);

    Ok([
        TENANT_SEGMENT,
        &normalized_account,
        CHANNEL_SEGMENT,
        &normalized_channel,
        USER_SEGMENT,
        &normalized_user,
        SHARED_SEGMENT,
    ]
    .join("."))
}

/// The JS `value || fallback` semantics: a `None` or empty-string value takes the
/// fallback (JS treats `""` as falsy, unlike a naive `Option::unwrap_or`).
fn falsy_or<'a>(value: Option<&'a str>, fallback: &'a str) -> &'a str {
    match value {
        Some(v) if !v.is_empty() => v,
        _ => fallback,
    }
}

/// Byte-identical port of the TS `normalizeNamespaceSegment`:
/// ```js
/// value.toLowerCase()
///   .replace(/[^a-z0-9._-]/g, "-")
///   .replace(/-+/g, "-")
///   .replace(/^-|-$/g, "");
/// // empty result -> "default"
/// ```
///
/// We implement it with explicit char filtering (no `regex` dependency needed) and verify
/// equivalence with the ported TS test vectors (`tests` below).
///
/// LOWERCASING (byte-parity with JS `String.toLowerCase()`): Step 1 uses Rust
/// `str::to_lowercase()`, which — like JS `.toLowerCase()` — implements the Unicode
/// DEFAULT case mapping (NOT plain ASCII lowering). So a non-ASCII char that JS lowercases
/// INTO a kept ASCII char also lowers here BEFORE the keep-set filter, and is therefore
/// kept identically: e.g. the Kelvin sign `K` (U+212A) → `k`, which is in `[a-z0-9._-]` and
/// survives in BOTH impls (closing the earlier `to_ascii_lowercase` divergence where Rust
/// would have mapped it to `-` and merged it with a plain `user` id — an isolation MERGE in
/// the dangerous direction). Any char that lowers to something OUTSIDE the keep-set (most
/// non-ASCII, e.g. `é`, CJK) maps to `-` in both. Both use Unicode default case mapping, so
/// they agree on the single-codepoint mappings relevant to the keep-set; this is now a
/// faithful port, not a documented gap.
///
/// Residual (genuinely shared with the TS, not a Rust divergence): the dot is in the
/// keep-set and segments are `.`-joined, so an id literally containing the joiner/segment
/// words could in principle collide with a different (account, channel, user) triple. This
/// is byte-faithful to the TS oracle (same unescaped join + same keep-set), so it is NOT a
/// Rust regression; closing it is a SHARED TS+Rust hardening follow-on (segment-escape /
/// dot-reject), out of scope for this parity slice.
pub fn normalize_namespace_segment(value: &str) -> String {
    // Step 1: toLowerCase() then replace each char NOT in [a-z0-9._-] with '-'. Use the
    // Unicode-aware `to_lowercase` (matches JS `.toLowerCase()`), NOT `to_ascii_lowercase`,
    // so a non-ASCII char JS folds into a kept ASCII char (e.g. Kelvin U+212A -> 'k') is
    // kept identically here instead of collapsing to '-'.
    let lowered = value.to_lowercase();
    let mut mapped = String::with_capacity(lowered.len());
    for ch in lowered.chars() {
        if is_kept(ch) {
            mapped.push(ch);
        } else {
            // Any character outside the keep-set (including multi-byte/non-ASCII) becomes a
            // SINGLE '-', exactly as the JS regex replaces each unmatched char with "-".
            mapped.push('-');
        }
    }

    // Step 2: replace(/-+/g, "-") — collapse runs of '-' to one.
    let mut collapsed = String::with_capacity(mapped.len());
    let mut prev_dash = false;
    for ch in mapped.chars() {
        if ch == '-' {
            if !prev_dash {
                collapsed.push('-');
            }
            prev_dash = true;
        } else {
            collapsed.push(ch);
            prev_dash = false;
        }
    }

    // Step 3: replace(/^-|-$/g, "") — trim a single leading and a single trailing '-'.
    // The JS alternation `^-|-$` removes AT MOST one leading and one trailing dash; after
    // the `-+ -> -` collapse there can be at most one of each, so trimming all leading and
    // trailing dashes here is equivalent.
    let trimmed = collapsed.trim_matches('-');

    // Step 4: empty -> "default".
    if trimmed.is_empty() {
        NORMALIZE_EMPTY_FALLBACK.to_string()
    } else {
        trimmed.to_string()
    }
}

/// The TS keep-set `[a-z0-9._-]` (applied AFTER `toLowerCase`, so uppercase A-Z is already
/// lowered and never reaches here as uppercase).
fn is_kept(ch: char) -> bool {
    ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '.' || ch == '_' || ch == '-'
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Differential vectors ported from
    //     test/unit/sessions/services/friday-session-memory-namespace.test.ts
    //     (the DIRECT-userId cases — the only ones this slice ports). ───

    #[test]
    fn resolves_namespace_from_user_id() {
        // TS: makeSession({ userId: "user-abc" }) on account "default", channel "discord".
        let ns =
            resolve_session_memory_namespace(Some("default"), Some("discord"), Some("user-abc"))
                .unwrap();
        assert_eq!(ns, "tenant.default.channel.discord.user.user-abc.shared");
    }

    #[test]
    fn normalizes_user_id_to_lowercase() {
        // TS: userId "User-ABC" -> "user-abc".
        let ns =
            resolve_session_memory_namespace(Some("default"), Some("discord"), Some("User-ABC"))
                .unwrap();
        assert_eq!(ns, "tenant.default.channel.discord.user.user-abc.shared");
    }

    #[test]
    fn same_user_across_channels_resolves_to_different_namespaces() {
        let ns1 =
            resolve_session_memory_namespace(Some("default"), Some("discord"), Some("user-x"))
                .unwrap();
        let ns2 = resolve_session_memory_namespace(Some("default"), Some("slack"), Some("user-x"))
            .unwrap();
        assert_eq!(ns1, "tenant.default.channel.discord.user.user-x.shared");
        assert_eq!(ns2, "tenant.default.channel.slack.user.user-x.shared");
        assert_ne!(ns1, ns2);
    }

    #[test]
    fn different_user_ids_resolve_to_different_namespaces() {
        let ns1 =
            resolve_session_memory_namespace(Some("default"), Some("discord"), Some("user-a"))
                .unwrap();
        let ns2 =
            resolve_session_memory_namespace(Some("default"), Some("discord"), Some("user-b"))
                .unwrap();
        assert_ne!(ns1, ns2);
    }

    #[test]
    fn fails_closed_when_no_user_id() {
        // TS throws MEMORY_NAMESPACE_UNRESOLVABLE; we return the typed error. This is the
        // parity for the "no userId, not DM" case (and — since DM/subagent fallbacks are
        // DEFERRED here — also covers what TS would have resolved via those paths).
        assert_eq!(
            resolve_session_memory_namespace(Some("default"), Some("discord"), None),
            Err(NamespaceError::UnresolvableNoUserId)
        );
        // An EMPTY user id is also falsy in JS (`!userId`), so it fails closed too.
        assert_eq!(
            resolve_session_memory_namespace(Some("default"), Some("discord"), Some("")),
            Err(NamespaceError::UnresolvableNoUserId)
        );
    }

    #[test]
    fn replaces_special_characters_in_user_id() {
        // TS: "user@example.com" -> "user-example.com" ('@' -> '-', dots PRESERVED).
        let ns = resolve_session_memory_namespace(
            Some("default"),
            Some("discord"),
            Some("user@example.com"),
        )
        .unwrap();
        assert_eq!(
            ns,
            "tenant.default.channel.discord.user.user-example.com.shared"
        );
    }

    #[test]
    fn normalizes_account_and_channel_segments() {
        // TS: accountId "Ops Team" -> "ops-team", channel "Slack Connect" -> "slack-connect",
        // userId "User-ABC" -> "user-abc".
        let ns = resolve_session_memory_namespace(
            Some("Ops Team"),
            Some("Slack Connect"),
            Some("User-ABC"),
        )
        .unwrap();
        assert_eq!(
            ns,
            "tenant.ops-team.channel.slack-connect.user.user-abc.shared"
        );
    }

    // ─── account/channel default behavior (TS `|| "default"` / `|| "unknown"`) ───

    #[test]
    fn empty_or_absent_account_takes_default_and_channel_takes_unknown() {
        // None and Some("") are both falsy in JS — both take the default. (The TS defaults
        // then go THROUGH the normalizer, which leaves "default"/"unknown" unchanged.)
        for account in [None, Some("")] {
            for channel in [None, Some("")] {
                let ns = resolve_session_memory_namespace(account, channel, Some("u")).unwrap();
                assert_eq!(ns, "tenant.default.channel.unknown.user.u.shared");
            }
        }
    }

    // ─── normalize_namespace_segment unit vectors ───

    #[test]
    fn normalize_collapses_runs_and_trims_edges_and_empty_to_default() {
        assert_eq!(normalize_namespace_segment("User-ABC"), "user-abc");
        assert_eq!(normalize_namespace_segment("Ops Team"), "ops-team");
        // Leading/trailing special chars are mapped to '-' then trimmed.
        assert_eq!(normalize_namespace_segment("  spaced  "), "spaced");
        assert_eq!(normalize_namespace_segment("@@@"), "default");
        assert_eq!(normalize_namespace_segment(""), "default");
        // Runs of disallowed chars collapse to ONE '-'.
        assert_eq!(normalize_namespace_segment("a   b---c"), "a-b-c");
        // Dots, underscores, hyphens are KEPT.
        assert_eq!(normalize_namespace_segment("a.b_c-d"), "a.b_c-d");
        // user@example.com (the segment-level vector).
        assert_eq!(
            normalize_namespace_segment("user@example.com"),
            "user-example.com"
        );
        // Non-ASCII is outside the keep-set and becomes '-' (then collapses/trims).
        assert_eq!(normalize_namespace_segment("héllo"), "h-llo");
        assert_eq!(normalize_namespace_segment("名前"), "default");
    }

    #[test]
    fn unicode_lowercasing_matches_js_tolowercase_no_isolation_merge() {
        // REGRESSION GUARD for the closed Rust!=TS divergence: a non-ASCII char that JS
        // `.toLowerCase()` folds INTO a kept ASCII char must be KEPT here too (Unicode-aware
        // `to_lowercase`), NOT mapped to '-'. The Kelvin sign U+212A 'K' lowercases to 'k'.
        // With the old `to_ascii_lowercase` it stayed non-ASCII -> '-' -> "user-k" actually
        // collapsing to merge distinct ids; the fix keeps it as 'k'.
        assert_eq!(normalize_namespace_segment("user\u{212A}"), "userk");
        // It must therefore NOT collide with a plainly-distinct id...
        assert_ne!(
            normalize_namespace_segment("user\u{212A}"), // -> "userk"
            normalize_namespace_segment("user")          // -> "user"
        );
        // ...and it must be IDENTICAL to the already-ASCII spelling JS would have produced.
        assert_eq!(
            normalize_namespace_segment("user\u{212A}"),
            normalize_namespace_segment("userK") // ASCII 'K' -> 'k' -> "userk"
        );
        // End-to-end through the resolver: the Kelvin id and the ASCII 'k' id land in the
        // SAME namespace (correct — they ARE the same user once case-folded), while a plain
        // "user" id stays in a DIFFERENT namespace (no dangerous merge).
        let ns_kelvin = resolve_session_memory_namespace(
            Some("default"),
            Some("discord"),
            Some("user\u{212A}"),
        )
        .unwrap();
        let ns_ascii_k =
            resolve_session_memory_namespace(Some("default"), Some("discord"), Some("userK"))
                .unwrap();
        let ns_plain =
            resolve_session_memory_namespace(Some("default"), Some("discord"), Some("user"))
                .unwrap();
        assert_eq!(ns_kelvin, ns_ascii_k);
        assert_ne!(ns_kelvin, ns_plain);
    }

    #[test]
    fn error_display_is_secret_free_and_coarse() {
        // The error message must never carry a session body — a fixed coarse string.
        let msg = NamespaceError::UnresolvableNoUserId.to_string();
        assert!(msg.contains("unresolvable"));
        assert!(!msg.contains("Bearer"));
    }
}
