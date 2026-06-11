//! Session memory NAMESPACE resolution (session-memory slice-3, ownership-binding).
//!
//! A faithful Rust port of the TS oracle
//! `src/sessions/services/friday-session-memory-namespace.ts`
//! (`resolveFridaySessionMemoryNamespace`). The namespace is the memory store SCOPE
//! derived DETERMINISTICALLY from a session's `(accountId, channel, userId)` axes, so a
//! user's memory is isolated PER (account, channel) instead of being shared across every
//! channel for the same user.
//!
//! Format (byte-identical to the TS — including the Unicode-aware lowercasing; the dot-join
//! collision is now CLOSED in BOTH halves by dropping `.` from the segment keep-set, see the
//! normalization note on [`is_kept`]):
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
//! ## Effective-userId fallbacks (owner-wiring lane — now PORTED)
//! The TS `resolveEffectiveUserId` resolves the userId in THREE ways, all now ported:
//!   1. `session.userId` directly — slice-3.
//!   2. (DM conversation) fall back to the `chatId` when `chatKind == "dm"` —
//!      [`resolve_effective_user_id`]. The Rust `agent_session` now models `chat_kind` /
//!      `chat_id` (v23 additive columns); a NON-subagent session with `chat_kind == "dm"`
//!      and a non-empty `chat_id` resolves to that `chat_id`.
//!   3. (subagent) walk the parent-session chain (`parent_session_id`, v23) to the nearest
//!      ancestor with a userId (or a DM-conversation ancestor's `chat_id`) —
//!      [`resolve_effective_user_id`], cycle-safe via a visited set like the TS.
//! Both fallbacks are DETERMINISTIC and FAIL CLOSED when underivable (missing chat_id,
//! unknown/other chat_kind, dangling parent link, exhausted/cyclic chain → no namespace,
//! never a guessed/default scope).
//!
//! HONEST mapping note (Rust vs TS representation, not a semantic change): TS derives the
//! conversation/subagent KIND and the parent link from the structured session KEY
//! (`parseFridaySessionKey`); the Rust `agent_session_id` is opaque, so the Rust port
//! carries those axes as explicit columns. The KIND is carried by the explicit
//! `session_kind` column (the faithful carrier of the TS `parts.kind`): `session_kind ==
//! "subagent"` ⇔ the TS `kind == "subagent"`, `session_kind == "conversation"` ⇔ the TS
//! `kind == "conversation"`; the parent link (`parent_session_id`) is the TS
//! `session.parentSessionKey` leg of its `parentSessionKey ?? parts.parentKey` — a CHAIN
//! POINTER, NOT the discriminant (there is no key-embedded parent to fall back to, so a
//! missing link ends the walk fail-closed). KIND is INTENTIONALLY decoupled from the chain
//! pointer: the prior port inferred subagent-ness from `parent_session_id IS NOT NULL`,
//! which DIVERGED from TS (a subagent's parent can live in its key, so its
//! `parentSessionKey` column may be NULL while its kind is still "subagent") — that
//! divergence opened a cross-user mis-attribution window for a subagent-kind row with a
//! null parent + `chat_kind == "dm"` (it took the DM-chatId leg instead of the walk). With
//! the explicit `session_kind` the DM-chatId fallback is gated on `kind == "conversation"`
//! and the parent-walk on `kind == "subagent"` — faithful to the TS; `None`/unknown kind
//! (legacy/unset) enables NEITHER fallback (fail-closed by construction).
//!
//! Truth label: byte-identical namespace + normalization port; DM-chatId + subagent
//! parent-walk userId fallbacks ported (column-modeled). This improves PARITY only — it
//! does NOT flip any TS-retirement state; the TS extraction path stays LIVE. PROOF-ONLY —
//! NOT a v1 GO.

use friday_storage::agent_session::SessionOwner;
use friday_storage::StorageError;

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

/// Resolve the EFFECTIVE userId for a session — the faithful port of the TS
/// `resolveEffectiveUserId` (owner-wiring lane; closes the slice-3 deferred-parity gap):
///
/// 1. **Direct**: `owner.user_id` (JS-falsy: an empty string counts as absent).
/// 2. **DM-chatId fallback**: a CONVERSATION (`session_kind == "conversation"`) session
///    with `chat_kind == "dm"` resolves to its `chat_id`. The TS condition is
///    `parts.kind === "conversation" && session.chatKind === "dm"` → `parts.chatId`; the
///    Rust port keys on the explicit `session_kind` discriminant (NOT on
///    `parent_session_id` presence). A DM with no stored `chat_id` is UNDERIVABLE → `None`
///    (fail-closed, no guessing).
/// 3. **Subagent parent-walk**: a subagent (`session_kind == "subagent"`) walks its
///    parent chain via `lookup` (following the `parent_session_id` pointer), returning the
///    FIRST ancestor `user_id` — or, for a conversation DM ancestor, its `chat_id` —
///    exactly like the TS walk. Cycle-safe via a visited set (TS `visited`); a dangling
///    link (`lookup` → `None`) ends the walk (TS `if (!parentSession) break`). Exhausted
///    chain → `None`. A subagent with a NULL `parent_session_id` simply has no chain to
///    walk ⇒ `None` (fail-closed) — it NEVER falls through to the DM-chatId leg.
/// 4. **Neither (fail-closed by construction)**: any other `session_kind` — `None`
///    (legacy/unset), an empty string, or any unknown value — enables NO fallback; only a
///    direct `user_id` could have resolved (step 1), else `None`. This is the structural
///    property that makes the contradictory shape (a subagent-kind row with a null parent
///    + `chat_kind == "dm"`) and any un-kinded row fail closed rather than DM-attribute.
///
/// DETERMINISTIC: the result depends only on the stored owner rows reachable through
/// `lookup`. FAIL-CLOSED: every underivable shape returns `Ok(None)` (the caller's
/// namespace resolution then fails closed); a `lookup` STORAGE error PROPAGATES (it is
/// never swallowed as "no parent", which could silently widen to fail-open elsewhere).
pub fn resolve_effective_user_id<F>(
    owner: &SessionOwner,
    lookup: &mut F,
) -> Result<Option<String>, StorageError>
where
    F: FnMut(&str) -> Result<Option<SessionOwner>, StorageError>,
{
    // 1. Direct userId (TS `if (session.userId) return session.userId`).
    if let Some(u) = non_empty(owner.user_id.as_deref()) {
        return Ok(Some(u.to_string()));
    }

    // 2. DM-chatId fallback (TS `parts.kind === "conversation" && chatKind === "dm"`).
    //    Gated on the EXPLICIT `session_kind == "conversation"` discriminant (faithful to
    //    the TS `parts.kind`), NOT on `parent_session_id` presence — a subagent-kind row
    //    NEVER reaches this leg even if its own `chat_kind == "dm"`. EXACT `"dm"` match
    //    only; any other / unknown chat_kind gets no fallback.
    if is_conversation(owner) && is_dm(owner) {
        if let Some(c) = non_empty(owner.chat_id.as_deref()) {
            return Ok(Some(c.to_string()));
        }
        // DM with no stored chat_id: underivable → fail closed (the TS key always carries
        // a chatId segment; the Rust column may be NULL — we never substitute a default).
        return Ok(None);
    }

    // 3. Subagent parent-walk (TS `parts.kind === "subagent" && sessionLookup`). Gated on
    //    the EXPLICIT `session_kind == "subagent"` discriminant; the walk FOLLOWS the
    //    `parent_session_id` chain pointer (TS `parentSessionKey ?? parts.parentKey` — the
    //    Rust column is the only modeled link, so a NULL pointer simply has no chain to walk
    //    and falls through to the fail-closed end state, NEVER to the DM-chatId leg above).
    if is_subagent(owner) {
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut current = owner.parent_session_id.clone();
        while let Some(key) = current {
            // Cycle guard (TS `visited`): a revisited key ends the walk fail-closed.
            if !visited.insert(key.clone()) {
                break;
            }
            // Dangling soft link: no such session → walk ends (TS `if (!parent) break`).
            let parent = match lookup(&key)? {
                Some(p) => p,
                None => break,
            };
            if let Some(u) = non_empty(parent.user_id.as_deref()) {
                return Ok(Some(u.to_string()));
            }
            // A conversation DM ancestor resolves to its chat_id (TS
            // `parentParts.kind === "conversation" && parent.chatKind === "dm"`) — gated on
            // the parent's OWN explicit kind, not on its parent-link presence.
            if is_conversation(&parent) && is_dm(&parent) {
                if let Some(c) = non_empty(parent.chat_id.as_deref()) {
                    return Ok(Some(c.to_string()));
                }
            }
            // Move up (TS `currentKey = parent.parentSessionKey ?? parentParts.parentKey`;
            // the Rust column is the only modeled link — None ends the walk fail-closed).
            current = parent.parent_session_id;
        }
    }

    // 4. Neither conversation-DM nor subagent (incl. `session_kind` None/unknown): no
    //    fallback derivable → fail closed (TS falls through to `return undefined`).
    Ok(None)
}

/// Exact-match TS `chatKind === "dm"` (case-sensitive; the TS type is a literal union).
fn is_dm(owner: &SessionOwner) -> bool {
    owner.chat_kind.as_deref() == Some("dm")
}

/// Exact-match TS `parts.kind === "conversation"` — the structural discriminant carried by
/// the explicit `session_kind` column (case-sensitive). `None`/empty/unknown is NOT a
/// conversation (no DM-chatId fallback — fail-closed).
fn is_conversation(owner: &SessionOwner) -> bool {
    owner.session_kind.as_deref() == Some("conversation")
}

/// Exact-match TS `parts.kind === "subagent"` — the structural discriminant carried by the
/// explicit `session_kind` column (case-sensitive), DECOUPLED from `parent_session_id`
/// presence. `None`/empty/unknown is NOT a subagent (no parent-walk — fail-closed).
fn is_subagent(owner: &SessionOwner) -> bool {
    owner.session_kind.as_deref() == Some("subagent")
}

/// `Some` only for a present, non-empty value (JS-falsy parity for `""`).
fn non_empty(v: Option<&str>) -> Option<&str> {
    match v {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    }
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
///   .replace(/[^a-z0-9_-]/g, "-")
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
/// Collision hardening (F5.5 — CLOSED, shared TS+Rust): the dot-join collision is now
/// closed by DROPPING `.` from the keep-set (see [`is_kept`]). Previously `.` was kept AND
/// used as the segment joiner, so an id literally containing the joiner/segment words (e.g.
/// `alice.channel.evil.user.bob`) could forge a different (account, channel, user) triple's
/// namespace string — the composite is the memory `principal_id` SCOPE, so that was a
/// cross-scope read/write collision. With `.` mapped to `-` in every segment, the composite
/// always splits into exactly the seven fixed-position parts, so the mapping is injective
/// over NORMALIZED segment tuples — this closes the CROSS-POSITION joiner-injection. The
/// WITHIN-position normalization stays lossy (`a.b` ≡ `a-b`, same accepted behavior as
/// `@` → `-`), lower-severity and not exploitable under single-owner v1. The change is
/// byte-identical to the LIVE TS oracle (`/[^a-z0-9_-]/g`), preserving the parity contract.
pub fn normalize_namespace_segment(value: &str) -> String {
    // Step 1: toLowerCase() then replace each char NOT in [a-z0-9_-] with '-'. Use the
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

/// The TS keep-set `[a-z0-9_-]` (applied AFTER `toLowerCase`, so uppercase A-Z is already
/// lowered and never reaches here as uppercase).
///
/// COLLISION HARDENING (F5.5): the literal `.` is DELIBERATELY EXCLUDED (it maps to `-` like
/// any other punctuation). `.` is the SEGMENT JOINER used by
/// [`resolve_session_memory_namespace`] (`.join(".")`), and that composite string becomes
/// the memory `principal_id` SCOPE. Stripping `.` from every segment makes the composite
/// always split into exactly the seven fixed-position parts, so the mapping is injective
/// over NORMALIZED segment tuples — a userId literally containing `.` can no longer forge a
/// different tuple's split (the CROSS-POSITION collision). The WITHIN-position normalization
/// stays lossy (`a.b` ≡ `a-b`, same as the accepted `@` → `-`). This keep-set is
/// byte-identical to the LIVE TS oracle `normalizeNamespaceSegment` (`/[^a-z0-9_-]/g`); the
/// two MUST stay in lockstep.
fn is_kept(ch: char) -> bool {
    ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-'
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
    fn dot_join_collision_is_closed_distinct_tuples_never_collide() {
        // F5.5 SHARED collision test (mirrored byte-for-byte in the TS test).
        //
        // The joiner-INJECTION vector: a userId / accountId literally containing the joiner
        // word `.user.` (or `.channel.`) could, when `.` was kept intra-segment, forge a
        // DIFFERENT (account, channel, user) tuple's composite string — and that string is
        // the memory `principal_id` SCOPE, so distinct users would share one scope.
        //
        // Pre-fix these two DISTINCT tuples both produced
        //   `tenant.a.channel.b.user.x.user.y.shared`  ← a real cross-tuple collision.
        // Post-fix the embedded `.`s map to `-`, so they are DISTINCT.
        let forged = resolve_session_memory_namespace(
            Some("a"),
            Some("b"),
            Some("x.user.y"), // a userId that embeds the `.user.` joiner
        )
        .unwrap();
        let victim = resolve_session_memory_namespace(
            Some("a"),
            Some("b.user.x"), // a channel that embeds the `.user.` joiner
            Some("y"),
        )
        .unwrap();
        assert_ne!(
            forged, victim,
            "distinct (account, channel, user) tuples must NEVER produce the same namespace"
        );
        assert_eq!(forged, "tenant.a.channel.b.user.x-user-y.shared");
        assert_eq!(victim, "tenant.a.channel.b-user-x.user.y.shared");

        // INJECTIVITY by construction: with `.` dropped from every segment, the composite
        // splits into EXACTLY the seven fixed-position parts, so the parts (after the fixed
        // tenant/channel/user/shared markers) round-trip the original normalized tuple.
        let parts: Vec<&str> = forged.split('.').collect();
        assert_eq!(parts.len(), 7, "namespace must be exactly 7 dot-parts");
        assert_eq!(parts[0], "tenant");
        assert_eq!(parts[2], "channel");
        assert_eq!(parts[4], "user");
        assert_eq!(parts[6], "shared");
        // The account / channel / user payload positions never contain a `.`.
        for payload in [parts[1], parts[3], parts[5]] {
            assert!(
                !payload.contains('.'),
                "no segment may contain the joiner '.', got {payload:?}"
            );
        }
    }

    #[test]
    fn fails_closed_when_no_user_id() {
        // TS throws MEMORY_NAMESPACE_UNRESOLVABLE; we return the typed error. This is the
        // parity for the "no userId available" case (the DM/subagent fallbacks — now
        // ported in `resolve_effective_user_id` — run BEFORE this resolver; when they
        // also derive nothing, this is the fail-closed end state).
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
        // F5.5 collision hardening: "user@example.com" -> "user-example-com" — '@' AND the
        // literal '.' both map to '-' (the dot is no longer kept; it is the segment joiner).
        let ns = resolve_session_memory_namespace(
            Some("default"),
            Some("discord"),
            Some("user@example.com"),
        )
        .unwrap();
        assert_eq!(
            ns,
            "tenant.default.channel.discord.user.user-example-com.shared"
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
        // F5.5: underscores and hyphens are KEPT; the literal '.' is NOT (it maps to '-',
        // then collapses with adjacent '-'). It is the segment joiner, never an intra-segment
        // char.
        assert_eq!(normalize_namespace_segment("a.b_c-d"), "a-b_c-d");
        // user@example.com (the segment-level vector): '@' and '.' both -> '-'.
        assert_eq!(
            normalize_namespace_segment("user@example.com"),
            "user-example-com"
        );
        // A bare run of dots collapses to ONE '-' then trims to empty -> "default".
        assert_eq!(normalize_namespace_segment("..."), "default");
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

    // ─── resolve_effective_user_id (the TS resolveEffectiveUserId port) ───

    /// Build a `SessionOwner` with an EXPLICIT `session_kind` (the structural discriminant),
    /// NEVER derived from `parent` — re-deriving kind from the parent link would re-import
    /// the exact bug this fix closes into the tests.
    fn owner(
        user_id: Option<&str>,
        chat_kind: Option<&str>,
        chat_id: Option<&str>,
        parent: Option<&str>,
        kind: Option<&str>,
    ) -> SessionOwner {
        SessionOwner {
            account_id: Some("default".into()),
            channel: Some("telegram".into()),
            user_id: user_id.map(str::to_string),
            chat_kind: chat_kind.map(str::to_string),
            chat_id: chat_id.map(str::to_string),
            parent_session_id: parent.map(str::to_string),
            session_kind: kind.map(str::to_string),
        }
    }

    /// A CONVERSATION-kind owner (TS `parts.kind === "conversation"`).
    fn conv(user_id: Option<&str>, chat_kind: Option<&str>, chat_id: Option<&str>) -> SessionOwner {
        owner(user_id, chat_kind, chat_id, None, Some("conversation"))
    }

    /// A SUBAGENT-kind owner (TS `parts.kind === "subagent"`); `parent` is the chain
    /// pointer (may be `None` — a subagent whose parent lives only in its key).
    fn sub(user_id: Option<&str>, parent: Option<&str>) -> SessionOwner {
        owner(user_id, None, None, parent, Some("subagent"))
    }

    /// A lookup over a fixed in-memory map (the TS `sessionLookup` analog).
    fn map_lookup<'a>(
        entries: &'a [(&'a str, SessionOwner)],
    ) -> impl FnMut(&str) -> Result<Option<SessionOwner>, StorageError> + 'a {
        move |key: &str| {
            Ok(entries
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.clone()))
        }
    }

    /// A lookup that PANICS if called — proves the direct/DM paths never walk.
    fn no_lookup(key: &str) -> Result<Option<SessionOwner>, StorageError> {
        panic!("lookup must not be called, got key {key}");
    }

    #[test]
    fn effective_user_direct_user_id_wins_without_lookup() {
        // TS case 1: session.userId returns immediately (no key parse, no walk).
        let o = conv(Some("alice"), Some("dm"), Some("chat-1"));
        let got = resolve_effective_user_id(&o, &mut no_lookup).unwrap();
        assert_eq!(got.as_deref(), Some("alice"));
        // JS-falsy parity: an EMPTY user_id is absent, so the DM fallback applies instead.
        let o = conv(Some(""), Some("dm"), Some("chat-1"));
        let got = resolve_effective_user_id(&o, &mut no_lookup).unwrap();
        assert_eq!(got.as_deref(), Some("chat-1"));
    }

    #[test]
    fn effective_user_dm_falls_back_to_chat_id_only_for_exact_dm_kind() {
        // TS case 2: conversation + chatKind === "dm" → chatId.
        let dm = conv(None, Some("dm"), Some("chat-77"));
        assert_eq!(
            resolve_effective_user_id(&dm, &mut no_lookup)
                .unwrap()
                .as_deref(),
            Some("chat-77")
        );
        // A NON-dm kind gets NO fallback (group/channel/thread chats are multi-user —
        // attributing them to the chat id would merge users into one scope).
        for kind in ["group", "channel", "thread"] {
            let o = conv(None, Some(kind), Some("chat-77"));
            assert_eq!(resolve_effective_user_id(&o, &mut no_lookup).unwrap(), None);
        }
        // Unknown/absent chat_kind: fail closed too.
        let o = conv(None, None, Some("chat-77"));
        assert_eq!(resolve_effective_user_id(&o, &mut no_lookup).unwrap(), None);
        // DM with NO stored chat_id is UNDERIVABLE → fail closed (no guessing).
        let o = conv(None, Some("dm"), None);
        assert_eq!(resolve_effective_user_id(&o, &mut no_lookup).unwrap(), None);
        // A row with NO `session_kind` (legacy/unset) gets NO DM fallback even with
        // `chat_kind == "dm"` and a stored chat_id — fail closed by construction (the
        // structural gate is on the explicit kind, never inferred).
        let unkinded = owner(None, Some("dm"), Some("chat-77"), None, None);
        assert_eq!(
            resolve_effective_user_id(&unkinded, &mut no_lookup).unwrap(),
            None,
            "an un-kinded DM-shaped row must fail closed, never DM-attribute"
        );
    }

    #[test]
    fn effective_user_subagent_walks_to_parent_user_id() {
        // TS case 3: subagent → nearest ancestor userId. One hop...
        let entries = [("p1", conv(Some("alice"), None, None))];
        let child = sub(None, Some("p1"));
        let got = resolve_effective_user_id(&child, &mut map_lookup(&entries)).unwrap();
        assert_eq!(got.as_deref(), Some("alice"));

        // ...and multi-hop through a userId-less intermediate subagent.
        let entries = [
            ("mid", sub(None, Some("root"))),
            ("root", conv(Some("bob"), None, None)),
        ];
        let child = sub(None, Some("mid"));
        let got = resolve_effective_user_id(&child, &mut map_lookup(&entries)).unwrap();
        assert_eq!(got.as_deref(), Some("bob"));
    }

    #[test]
    fn effective_user_subagent_resolves_via_dm_conversation_ancestor() {
        // TS: a conversation-DM PARENT without a userId resolves to ITS chatId.
        let entries = [("p1", conv(None, Some("dm"), Some("chat-9")))];
        let child = sub(None, Some("p1"));
        let got = resolve_effective_user_id(&child, &mut map_lookup(&entries)).unwrap();
        assert_eq!(got.as_deref(), Some("chat-9"));
    }

    #[test]
    fn effective_user_subagent_own_dm_axes_are_not_used() {
        // A SUBAGENT session never uses its own chat axes (TS: its parts.kind is
        // "subagent", not "conversation") — the walk decides, and here it finds nothing.
        let entries = [("p1", sub(None, None))];
        // A subagent that ALSO carries its own dm chat axes — gated out of the DM leg by
        // its explicit `session_kind == "subagent"`.
        let child = owner(
            None,
            Some("dm"),
            Some("chat-self"),
            Some("p1"),
            Some("subagent"),
        );
        let got = resolve_effective_user_id(&child, &mut map_lookup(&entries)).unwrap();
        assert_eq!(got, None, "subagent must not DM-resolve from its own axes");
    }

    #[test]
    fn effective_user_subagent_kind_with_null_parent_and_dm_axes_fails_closed_not_dm() {
        // THE review's exact missing test (MED-1, cross-user mis-attribution window): a row
        // that is SEMANTICALLY a subagent (`session_kind == "subagent"`) but has a NULL
        // parent link AND `chat_kind == "dm"` + a stored chat_id MUST take the parent-walk
        // leg (not the DM-chatId leg) and — with no chain to walk — fail closed. The prior
        // port (inferring subagent-ness from `parent_session_id IS NOT NULL`) treated this
        // shape as a conversation and returned the chat_id "C" — a WRONG-principal namespace
        // write if "C" belongs to a different user than this subagent's true ancestor.
        let null_parent = owner(None, Some("dm"), Some("C"), None, Some("subagent"));
        let got = resolve_effective_user_id(&null_parent, &mut no_lookup).unwrap();
        assert_eq!(
            got, None,
            "a null-parent subagent-kind dm-shaped row must fail closed, NEVER return the chat_id"
        );
        assert_ne!(
            got.as_deref(),
            Some("C"),
            "must NOT DM-attribute the subagent to a foreign chat id (the closed mis-attribution window)"
        );

        // The SIBLING positive control: the SAME subagent shape but WITH a parent link to an
        // ancestor that carries the true userId walks to that ancestor "U" — never to "C".
        let entries = [("anc", conv(Some("U"), None, None))];
        let with_parent = owner(None, Some("dm"), Some("C"), Some("anc"), Some("subagent"));
        let walked = resolve_effective_user_id(&with_parent, &mut map_lookup(&entries)).unwrap();
        assert_eq!(
            walked.as_deref(),
            Some("U"),
            "the subagent resolves to its ancestor userId via the walk, not its own dm chat id"
        );
        assert_ne!(walked.as_deref(), Some("C"));
    }

    #[test]
    fn effective_user_walk_fails_closed_on_dangling_missing_or_cyclic_chain() {
        // Dangling parent link (no such session): fail closed.
        let child = sub(None, Some("ghost"));
        assert_eq!(
            resolve_effective_user_id(&child, &mut map_lookup(&[])).unwrap(),
            None
        );
        // Exhausted chain (ancestors exist but none derivable): fail closed. The
        // intermediate is a subagent-kind group conversation analog (no derivable userId).
        let entries = [
            (
                "p1",
                owner(
                    None,
                    Some("group"),
                    Some("g-1"),
                    Some("p2"),
                    Some("subagent"),
                ),
            ),
            ("p2", sub(None, None)),
        ];
        let child = sub(None, Some("p1"));
        assert_eq!(
            resolve_effective_user_id(&child, &mut map_lookup(&entries)).unwrap(),
            None
        );
        // CYCLE (p1 -> p2 -> p1): the visited set terminates the walk, fail closed.
        let entries = [("p1", sub(None, Some("p2"))), ("p2", sub(None, Some("p1")))];
        let child = sub(None, Some("p1"));
        assert_eq!(
            resolve_effective_user_id(&child, &mut map_lookup(&entries)).unwrap(),
            None
        );
        // SELF-cycle (a session whose parent is itself — pathological but storable).
        let entries = [("s", sub(None, Some("s")))];
        let child = sub(None, Some("s"));
        assert_eq!(
            resolve_effective_user_id(&child, &mut map_lookup(&entries)).unwrap(),
            None
        );
    }

    #[test]
    fn effective_user_lookup_error_propagates_not_swallowed() {
        // A STORAGE error during the walk must propagate (never be treated as "no
        // parent" — that would mis-report a locked/corrupt DB as an unresolvable
        // namespace downstream, the same discipline as load_session_owner's .optional()).
        let child = sub(None, Some("p1"));
        let mut failing = |_key: &str| -> Result<Option<SessionOwner>, StorageError> {
            Err(StorageError::Unsupported("disk on fire".into()))
        };
        assert!(resolve_effective_user_id(&child, &mut failing).is_err());
    }
}
