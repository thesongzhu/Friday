//! Minimal Hub-side agent-loop SESSION store (S5). Hub-only.
//!
//! The Rust agent loop (`friday_hub::run_loop`) runs a SINGLE task with no inbound
//! conversation history. S5 adds a minimal SESSION: an `agent_session` groups runs
//! and stores their prior conversation messages (role + content + refs) keyed by
//! `agent_session_id`, so a later run in the same session can RESUME with the prior
//! multi-turn context.
//!
//! ## Boundary (the refs-only / answer-body discipline is UNCHANGED)
//! A session message's `content` is a BODY kept Hub-side, exactly like
//! [`crate::run_result::RunResult::answer`]. It is fed BACK into the model prompt
//! Hub-side (the loop's existing recall-preamble seam) but is NEVER transported
//! off-Hub: there is no answer-body-over-wire read here (that is the transport
//! lane). The compact event/audit log records only refs (session id + counts),
//! never the message text — the Hub keeps the body, the wire keeps fingerprints.
//!
//! ## Ordering
//! Each message carries a per-session monotonic `seq` (0-based), so
//! [`load_session_messages`] returns the conversation in turn order regardless of
//! insert timing. `UNIQUE(agent_session_id, seq)` makes a duplicate ordinal a
//! fail-closed insert rather than a silent reorder.
//!
//! Truth label: minimal sessions/resume storage substrate + API + tests only.
//! PROOF-ONLY; NOT a v1 GO.

use crate::audit;
use crate::error::{Result, StorageError};
use rusqlite::{params, Connection, OptionalExtension};

/// A conversation message as supplied to [`append_session_message`]. `seq`,
/// `message_id` and `created_at` are assigned by the store, not the caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionMessage {
    /// The speaker role, e.g. `"user"` / `"assistant"`. Free-form but non-empty
    /// (the schema CHECK rejects a blank role).
    pub role: String,
    /// The message text. A BODY kept Hub-side (never an answer-body-over-wire).
    pub content: String,
    /// Optional soft-link ref (e.g. the producing `run_id`). No FK — the `*_ref`
    /// soft-link convention.
    pub refs: Option<String>,
}

impl SessionMessage {
    pub fn new(role: impl Into<String>, content: impl Into<String>, refs: Option<String>) -> Self {
        SessionMessage {
            role: role.into(),
            content: content.into(),
            refs,
        }
    }
}

/// A stored conversation message read back by [`load_session_messages`], including
/// its assigned `seq` and `message_id`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredSessionMessage {
    pub message_id: String,
    pub agent_session_id: String,
    pub seq: i64,
    pub role: String,
    pub content: String,
    pub refs: Option<String>,
    pub created_at: i64,
}

/// The session OWNER axes (slice-3 ownership-binding + owner-wiring conversation axes)
/// — the `agent_session` fields the memory namespace is DERIVED from, mirroring the TS
/// `FridaySessionRecord` `accountId` / `channel` / `userId` plus the `chatKind` /
/// `chatId` / `parentSessionKey` axes the TS `resolveEffectiveUserId` fallbacks key on,
/// AND the structural `session_kind` discriminant (the TS `parseFridaySessionKey(...).kind`).
/// All optional: a pre-slice-3 session (or one created via the no-owner
/// [`ensure_session`]) reads back `None` for each. A `None` (or empty) `user_id` with no
/// derivable fallback (DM-chatId / subagent parent-walk) is what FAILS the
/// memory-namespace resolution closed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionOwner {
    pub account_id: Option<String>,
    pub channel: Option<String>,
    pub user_id: Option<String>,
    /// The TS `chatKind` (`"dm"` / `"group"` / `"channel"` / `"thread"`). Only the EXACT
    /// value `"dm"` enables the DM-chatId userId fallback; `None` (or any other kind)
    /// means no DM fallback (fail-closed). Enforced by a CHECK at the column.
    pub chat_kind: Option<String>,
    /// The TS conversation `chatId`. For a `chat_kind == "dm"` conversation this is the
    /// user-bound chat identity the userId fallback resolves to.
    pub chat_id: Option<String>,
    /// The TS `parentSessionKey`: a SUBAGENT session's soft link to its parent
    /// `agent_session_id` (no FK). The parent-walk userId fallback FOLLOWS this chain (it
    /// is the chain POINTER, the TS `parentSessionKey ?? parts.parentKey`); a
    /// dangling/absent link fails the walk closed. NOTE: this is the chain pointer, NOT
    /// the subagent DISCRIMINANT — that is [`SessionOwner::session_kind`] (see its doc).
    pub parent_session_id: Option<String>,
    /// The STRUCTURAL kind discriminant — the faithful Rust carrier for the TS
    /// `parseFridaySessionKey(session.key).kind` (`"conversation"` / `"subagent"`).
    ///
    /// The TS derives kind from the session KEY's prefix (`subagent:<parentKey>:<taskId>`
    /// ⇒ `"subagent"`, else `"conversation"`); the Rust `agent_session_id` is opaque, so we
    /// carry the kind EXPLICITLY instead of inferring it from `parent_session_id` presence
    /// (which is the chain pointer and is NOT a faithful kind signal — a subagent's key
    /// can carry its parent in the key itself, so `parentSessionKey` may be absent while
    /// the kind is still `"subagent"`).
    ///
    /// FAIL-CLOSED default: only the EXACT value `"conversation"` enables the DM-chatId
    /// fallback (TS line 94) and only `"subagent"` enables the parent-walk (TS line 99).
    /// `None` (unset / legacy / pre-v23) or any unknown value enables NEITHER fallback —
    /// only a direct `user_id` resolves, else the namespace fails closed. This is the
    /// structural property that makes a contradictory shape (a subagent-kind row with a
    /// null parent + `chat_kind == "dm"`) never silently DM-attribute. Enforced by a
    /// vocabulary CHECK at the column.
    pub session_kind: Option<String>,
}

/// Ensure an `agent_session` row exists (idempotent). A new session is created at
/// `now_ms`; an existing session has its `updated_at` bumped. Safe to call at the
/// start of every run in the session.
///
/// This is the OWNER-LESS form (no `account_id`/`channel`/`user_id`): a session created
/// this way reads back [`SessionOwner::default`] (all `None`), so its memory namespace
/// is UNRESOLVABLE (fail-closed) until an owner is set. Callers without an owner in
/// hand (e.g. `run_session_loop` with `session_owner: None`) keep using this unchanged.
/// To bind an owner, use [`ensure_session_with_owner`].
///
/// IMPORTANT: this owner-less form references ONLY the pre-v21 columns (it never names
/// `account_id`/`channel`/`user_id` or the v23 conversation axes), so it works against a
/// DB at ANY version that has the base `agent_session` table — including a v≤20 DB seeded
/// in a migration test BEFORE the owner columns exist. Owner binding is the sole concern
/// of [`ensure_session_with_owner`], which requires the v21 owner columns AND the v23
/// conversation-axis columns.
pub fn ensure_session(conn: &Connection, agent_session_id: &str, now_ms: i64) -> Result<()> {
    if agent_session_id.trim().is_empty() {
        return Err(StorageError::Unsupported(
            "agent_session_id must be non-empty".into(),
        ));
    }
    // INSERT-or-bump in one statement, naming ONLY the base columns: a fresh id INSERTs, an
    // existing id keeps its created_at + any already-bound owner (those columns are not
    // touched here) and only advances updated_at — no row is ever clobbered.
    conn.execute(
        "INSERT INTO agent_session (agent_session_id, created_at, updated_at)
         VALUES (?1, ?2, ?2)
         ON CONFLICT(agent_session_id) DO UPDATE SET updated_at = ?2",
        params![agent_session_id, now_ms],
    )?;
    Ok(())
}

/// Ensure an `agent_session` row exists (idempotent), binding its OWNER axes
/// (slice-3). A fresh id INSERTs with the supplied owner fields; an existing id keeps
/// its `created_at` AND its already-bound owner fields (never clobbered), advancing only
/// `updated_at`. `COALESCE(existing, new)` on conflict means a later no-owner ensure
/// never erases a previously-bound owner, and a later ensure can BACKFILL an owner that
/// was `NULL` (e.g. a session first created owner-less). A blank owner field is stored as
/// `NULL` so the falsy-empty case is represented identically to absent (the namespace
/// resolver treats `None` and `Some("")` the same).
pub fn ensure_session_with_owner(
    conn: &Connection,
    agent_session_id: &str,
    owner: &SessionOwner,
    now_ms: i64,
) -> Result<()> {
    if agent_session_id.trim().is_empty() {
        return Err(StorageError::Unsupported(
            "agent_session_id must be non-empty".into(),
        ));
    }
    // Normalize blank-string owner fields to NULL so "absent" and "empty" are one case.
    let account_id = none_if_blank(owner.account_id.as_deref());
    let channel = none_if_blank(owner.channel.as_deref());
    let user_id = none_if_blank(owner.user_id.as_deref());
    let chat_kind = none_if_blank(owner.chat_kind.as_deref());
    let chat_id = none_if_blank(owner.chat_id.as_deref());
    let parent_session_id = none_if_blank(owner.parent_session_id.as_deref());
    let session_kind = none_if_blank(owner.session_kind.as_deref());
    // INSERT-or-bump in one statement: a fresh id INSERTs with the owner; an existing id
    // keeps its created_at + already-bound owner (COALESCE keeps the existing non-NULL,
    // else accepts the incoming value as a backfill) and only advances updated_at — no row
    // is ever clobbered and no bound owner is ever erased.
    conn.execute(
        "INSERT INTO agent_session
            (agent_session_id, created_at, updated_at, account_id, channel, user_id,
             chat_kind, chat_id, parent_session_id, session_kind)
         VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(agent_session_id) DO UPDATE SET
            updated_at = ?2,
            account_id = COALESCE(account_id, excluded.account_id),
            channel    = COALESCE(channel, excluded.channel),
            user_id    = COALESCE(user_id, excluded.user_id),
            chat_kind  = COALESCE(chat_kind, excluded.chat_kind),
            chat_id    = COALESCE(chat_id, excluded.chat_id),
            parent_session_id = COALESCE(parent_session_id, excluded.parent_session_id),
            session_kind = COALESCE(session_kind, excluded.session_kind)",
        params![
            agent_session_id,
            now_ms,
            account_id,
            channel,
            user_id,
            chat_kind,
            chat_id,
            parent_session_id,
            session_kind
        ],
    )?;
    Ok(())
}

/// Load a session's OWNER axes (slice-3). Returns `None` if the session row is absent
/// (so a caller can distinguish "no such session" from "session with no owner", which is
/// `Some(SessionOwner::default())`). A blank-string column reads back as `None` (matching
/// how [`ensure_session_with_owner`] stores blanks as `NULL`).
pub fn load_session_owner(
    conn: &Connection,
    agent_session_id: &str,
) -> Result<Option<SessionOwner>> {
    // `.optional()` maps ONLY `QueryReturnedNoRows` (absent session) to `Ok(None)` and
    // PROPAGATES any real storage error (locked/corrupt DB) — never swallowing it as
    // "no owner" (which would mis-report as an unresolvable namespace downstream).
    let row = conn
        .query_row(
            "SELECT account_id, channel, user_id, chat_kind, chat_id, parent_session_id,
                    session_kind
             FROM agent_session
             WHERE agent_session_id = ?1",
            [agent_session_id],
            |r| {
                Ok(SessionOwner {
                    account_id: none_if_blank(r.get::<_, Option<String>>(0)?.as_deref()),
                    channel: none_if_blank(r.get::<_, Option<String>>(1)?.as_deref()),
                    user_id: none_if_blank(r.get::<_, Option<String>>(2)?.as_deref()),
                    chat_kind: none_if_blank(r.get::<_, Option<String>>(3)?.as_deref()),
                    chat_id: none_if_blank(r.get::<_, Option<String>>(4)?.as_deref()),
                    parent_session_id: none_if_blank(r.get::<_, Option<String>>(5)?.as_deref()),
                    session_kind: none_if_blank(r.get::<_, Option<String>>(6)?.as_deref()),
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// `None` for an absent or strictly-empty (`""`) value; a whitespace-only value is kept
/// VERBATIM (the strictly-empty check only — normalization/trimming is the namespace
/// resolver's job, not the store's).
fn none_if_blank(v: Option<&str>) -> Option<String> {
    match v {
        Some(s) if !s.is_empty() => Some(s.to_string()),
        _ => None,
    }
}

/// Whether an `agent_session` row exists.
pub fn session_exists(conn: &Connection, agent_session_id: &str) -> Result<bool> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_session WHERE agent_session_id = ?1)",
        [agent_session_id],
        |r| r.get(0),
    )?;
    Ok(exists)
}

/// (CORE-A CR-3) A session's `(created_at, updated_at)` timestamps, or `None` when the session row
/// is absent. Pure refs read (no body). The create receipt reads this back so it can report the
/// row's ORIGINAL `created_at` (an idempotent re-ensure keeps `created_at` and only bumps
/// `updated_at`) rather than guessing `now_ms`. `.optional()` maps ONLY the no-row case to `None`
/// and propagates any real storage error.
pub fn session_timestamps(
    conn: &Connection,
    agent_session_id: &str,
) -> Result<Option<(i64, i64)>> {
    let row = conn
        .query_row(
            "SELECT created_at, updated_at FROM agent_session WHERE agent_session_id = ?1",
            [agent_session_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?;
    Ok(row)
}

/// (CORE-A CR-3) PUBLIC fail-closed owner check: whether the session exists AND is owned by exactly
/// `user_id` (the `agent_session.user_id` axis bound to the authenticated caller). Thin wrapper over
/// the private [`owner_matches`] so the Hub session-append dispatch arm can OWNER-GATE without
/// duplicating the check: a blank `user_id`, an absent session, an owner-less (NULL `user_id`)
/// session, or a DIFFERENT owner all return `false`.
pub fn session_owner_matches(
    conn: &Connection,
    user_id: &str,
    agent_session_id: &str,
) -> Result<bool> {
    owner_matches(conn, user_id, agent_session_id)
}

/// Append one conversation message to a session, returning the assigned
/// `message_id`. The `seq` is assigned as `max(seq) + 1` for the session (0 for the
/// first message), computed and inserted in ONE transaction so concurrent appends
/// on a single connection never collide on an ordinal. The parent session must
/// already exist (call [`ensure_session`] first) — the FK rejects an orphan message.
pub fn append_session_message(
    conn: &Connection,
    agent_session_id: &str,
    message: &SessionMessage,
    now_ms: i64,
) -> Result<String> {
    if message.role.trim().is_empty() {
        return Err(StorageError::Unsupported(
            "session message role must be non-empty".into(),
        ));
    }
    let tx = conn.unchecked_transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_session WHERE agent_session_id = ?1)",
        [agent_session_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(StorageError::NotFound(format!(
            "agent_session '{agent_session_id}' (call ensure_session first)"
        )));
    }
    let next_seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq) + 1, 0) FROM agent_session_message
         WHERE agent_session_id = ?1",
        [agent_session_id],
        |r| r.get(0),
    )?;
    let message_id = format!("{agent_session_id}:m{next_seq}");
    tx.execute(
        "INSERT INTO agent_session_message
            (message_id, agent_session_id, seq, role, content, refs, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            message_id,
            agent_session_id,
            next_seq,
            message.role,
            message.content,
            message.refs,
            now_ms,
        ],
    )?;
    // Keep the session's updated_at current with its latest message.
    tx.execute(
        "UPDATE agent_session SET updated_at = ?2 WHERE agent_session_id = ?1",
        params![agent_session_id, now_ms],
    )?;
    tx.commit()?;
    Ok(message_id)
}

/// Load a session's conversation messages in `seq` order (oldest first). An unknown
/// or empty session returns an empty Vec (not an error) — a fresh session simply has
/// no prior history.
pub fn load_session_messages(
    conn: &Connection,
    agent_session_id: &str,
) -> Result<Vec<StoredSessionMessage>> {
    let mut stmt = conn.prepare(
        "SELECT message_id, agent_session_id, seq, role, content, refs, created_at
         FROM agent_session_message
         WHERE agent_session_id = ?1
         ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map([agent_session_id], |r| {
        Ok(StoredSessionMessage {
            message_id: r.get(0)?,
            agent_session_id: r.get(1)?,
            seq: r.get(2)?,
            role: r.get(3)?,
            content: r.get(4)?,
            refs: r.get(5)?,
            created_at: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Count of messages in a session (refs-only — no body). Convenience for refs-only
/// event/observability that must never carry message text.
pub fn session_message_count(conn: &Connection, agent_session_id: &str) -> Result<i64> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM agent_session_message WHERE agent_session_id = ?1",
        [agent_session_id],
        |r| r.get(0),
    )?;
    Ok(n)
}

// --- C2-4 owner-scoped routed-session list/open/read --------------------------
//
// An OWNER-SCOPED read view over the FRIDAY routed `agent_session` rows — the ones
// `friday_hub::HubRuntime::run_session_task_pinned` populates (and which carry REAL
// `token_ledger` rows attributed to the answering provider, e.g. an `anthropic` row per
// Claude turn). These read the routed sessions DELIBERATELY, NOT the
// `provider_session::list_projections` `provider_session_link` claude_control mirror — a
// `FridayLocalMirror` link is a CRUD projection, has no `user_id` to scope on, and carries
// no real billing, so surfacing it here would be a fake. This view never touches that
// table.
//
// The scope axis is the `agent_session.user_id` column (m0021), bound to the AUTHENTICATED
// caller's principal by `run_session_task_pinned` (NEVER a client-asserted id). Scoping is
// genuinely FAIL-CLOSED (INV-5/INV-7): a DIFFERENT principal's list is EMPTY and an open of
// another owner's session returns `None` — a guessed `agent_session_id` cannot bypass the
// owner check, so the WHOLE read API (list AND open/read) is owner-scoped, not best-effort.

/// One row of an owner's routed-session list ([`list_sessions_for_owner`]). Refs-only
/// metadata — id + timestamps, NEVER any message body (the bodies are read separately and
/// owner-gated via [`open_session_for_owner`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionListItem {
    pub agent_session_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// List the FRIDAY routed sessions OWNED by `user_id`, most-recently-active first.
///
/// Scopes on `agent_session.user_id = ?1` (the column `run_session_task_pinned` binds to the
/// authenticated caller). A blank/empty `user_id` matches NOTHING (fail-closed: an unbound /
/// owner-less session — whose `user_id` is NULL — is never listed under any owner, and a
/// blank query never collapses to "all sessions"). A principal that owns no session gets an
/// empty Vec (the load-bearing owner-scoping assertion: a DIFFERENT principal sees NOTHING).
///
/// ## C2-6: archive-aware (the active/owner list hides archived + pruned sessions)
/// The list excludes sessions whose `status` is `'archived'` or `'pruned'` (`status NOT IN ...`),
/// so an explicitly-archived session ([`archive_session_for_owner`]) — or one the time-based
/// `session_lifecycle` sweep advanced to `archived`/`pruned` — no longer appears in the owner's
/// active list. `'active'` and `'idle'` sessions stay visible (an idle session is still a live,
/// resumable conversation). The `status` column defaults to `'active'` (migration v28), so a
/// never-swept session is included exactly as before. Pure read: no write, no schema change.
///
/// Ordering is `updated_at DESC, agent_session_id` — most-recent-first (the same convention
/// as [`crate::provider_session::list_projections`]) with `agent_session_id` as a
/// deterministic tiebreaker so two sessions touched at the same `updated_at` have a stable
/// order.
pub fn list_sessions_for_owner(conn: &Connection, user_id: &str) -> Result<Vec<SessionListItem>> {
    // A blank owner must never match a NULL `user_id` row nor act as a wildcard — return
    // nothing without even querying (the `= ?1` bind already excludes NULL, but this makes
    // the fail-closed explicit and skips the round-trip).
    if user_id.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT agent_session_id, created_at, updated_at
         FROM agent_session
         WHERE user_id = ?1
           AND status NOT IN ('archived', 'pruned')
         ORDER BY updated_at DESC, agent_session_id",
    )?;
    let rows = stmt.query_map([user_id], |r| {
        Ok(SessionListItem {
            agent_session_id: r.get(0)?,
            created_at: r.get(1)?,
            updated_at: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// OWNER-SCOPED open of one routed session's conversation: returns the folded
/// user/assistant messages (via the existing [`load_session_messages`]) ONLY when the
/// session is owned by `user_id`; otherwise `None`.
///
/// This is the FAIL-CLOSED open half of the C2-4 read API: a caller cannot read another
/// principal's session by guessing its `agent_session_id` — the owner is checked FIRST (via
/// [`load_session_owner`], scoping on the SAME `user_id` axis as [`list_sessions_for_owner`])
/// and a mismatch (or an absent session, or an owner-less NULL `user_id`) returns `None` with
/// no message read at all. A blank `user_id` matches nothing. Pure read: no write.
///
/// `None` therefore covers three fail-closed cases uniformly — "no such session", "session
/// has no owner", and "session owned by someone else" — none of which a non-owner may
/// distinguish from the others (no existence oracle). `Some(vec)` (possibly empty for a
/// brand-new owned session with no turns yet) is returned ONLY to the matching owner.
pub fn open_session_for_owner(
    conn: &Connection,
    user_id: &str,
    agent_session_id: &str,
) -> Result<Option<Vec<StoredSessionMessage>>> {
    if !owner_matches(conn, user_id, agent_session_id)? {
        return Ok(None);
    }
    Ok(Some(load_session_messages(conn, agent_session_id)?))
}

/// OWNER-SCOPED message count for one routed session (refs-only — no body): `Some(n)` ONLY
/// when `user_id` owns the session, else `None`. The owner-gated counterpart of
/// [`session_message_count`], scoped identically to [`open_session_for_owner`] so a
/// non-owner gets no count (and thus no existence/size oracle). Pure read.
pub fn session_message_count_for_owner(
    conn: &Connection,
    user_id: &str,
    agent_session_id: &str,
) -> Result<Option<i64>> {
    if !owner_matches(conn, user_id, agent_session_id)? {
        return Ok(None);
    }
    Ok(Some(session_message_count(conn, agent_session_id)?))
}

/// Whether the session exists AND is owned by exactly `user_id`. The single fail-closed
/// owner check the owner-scoped open/read functions share: a blank `user_id`, an absent
/// session, an owner-less (NULL `user_id`) session, or a different owner all return `false`.
fn owner_matches(conn: &Connection, user_id: &str, agent_session_id: &str) -> Result<bool> {
    if user_id.is_empty() {
        return Ok(false);
    }
    // `load_session_owner` returns `None` for an absent session and `Some(owner)` with a
    // `None` `user_id` for an owner-less one — both fail the match closed.
    match load_session_owner(conn, agent_session_id)? {
        Some(owner) => Ok(owner.user_id.as_deref() == Some(user_id)),
        None => Ok(false),
    }
}

// --- C2-6 explicit owner-authed archive op (distinct from the time-based sweep) ---
//
// An EXPLICIT, owner-authed ARCHIVE of one FRIDAY routed `agent_session`: the owner says "archive
// this session NOW" (e.g. a "close conversation" action), as opposed to the time-based
// `session_lifecycle::sweep_lifecycle` reaper, which advances a session to `archived` only after
// the 7-day idle timeout. The two are DISTINCT and complementary: this op never runs the sweep and
// the sweep never runs this op — both simply write the SAME `agent_session` lifecycle columns
// (`status='archived'` + `archived_at` + `status_changed_at` + `updated_at`), so a session archived
// either way is read back identically (and continues down the sweep's archived→pruned path off its
// `archived_at`).
//
// Owner-gated EXACTLY like the C2-4 read API: it reuses [`owner_matches`] (the `agent_session.user_id`
// axis bound to the authenticated caller by `run_session_task_pinned`), so a DIFFERENT principal —
// or a blank owner, an owner-less (NULL `user_id`) session, or an absent id — is REFUSED fail-closed
// with NO state change and NO audit row. Only the bound owner can archive.
//
// The status transition + the hash-chained audit receipt are written in ONE `unchecked_transaction`
// (atomic: a crash can never leave an archived session with no receipt, nor a receipt with no
// transition). Metadata-only — NO model call, NO `token_ledger` row (archiving is not a turn).

/// The body-free outcome of an [`archive_session_for_owner`] attempt. `accepted=false` is the
/// fail-closed owner-mismatch refusal (no state change, no receipt). Never a body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveOutcome {
    /// Whether the archive was accepted (`true`) or refused fail-closed (`false`).
    pub accepted: bool,
    /// Coarse, body-free outcome label (closed-vocab): `"archived"` (the transition was written),
    /// `"already_archived"` (idempotent accepted no-op), or `"not_owner"` (fail-closed refusal —
    /// a non-owner, an owner-less session, a blank owner, or an absent id).
    pub status: String,
    /// Soft link to the hash-chained audit receipt, when one was written (only on a NEW archive
    /// transition — an idempotent re-archive of an already-archived session writes none).
    pub audit_ref: Option<String>,
}

impl ArchiveOutcome {
    fn refused() -> Self {
        ArchiveOutcome {
            accepted: false,
            status: "not_owner".to_string(),
            audit_ref: None,
        }
    }
}

/// Explicitly ARCHIVE a routed session as its BOUND owner: set `status='archived'` + `archived_at`
/// (plus `status_changed_at` + `updated_at`) and write a hash-chained audit receipt, in ONE
/// transaction.
///
/// Owner-gated fail-closed via [`owner_matches`] (the SAME `agent_session.user_id` axis as the C2-4
/// read API): a non-owner, an owner-less session, a blank `user_id`, or an absent `agent_session_id`
/// all return [`ArchiveOutcome::refused`] (`accepted=false`, `status="not_owner"`) with NO state
/// change and NO audit row — a guessed session id cannot archive another principal's session.
///
/// Idempotent: if the owner's session is ALREADY `'archived'`, this is an accepted no-op
/// (`status="already_archived"`, no new receipt, no timestamp bump). An already-`'pruned'` session
/// is treated the same (it is already past archive). Otherwise the transition fires and the receipt
/// is written.
///
/// Metadata-only: NO model call and NO `token_ledger` row (archiving is not a metered turn). DISTINCT
/// from [`crate::session_lifecycle::sweep_lifecycle`] — this never invokes the sweep and writes only
/// the lifecycle columns the sweep also uses, so the two compose without either touching the other.
pub fn archive_session_for_owner(
    conn: &Connection,
    user_id: &str,
    agent_session_id: &str,
    now_ms: i64,
) -> Result<ArchiveOutcome> {
    // (1) Owner gate FIRST (fail-closed): a non-owner / owner-less / absent / blank-owner attempt is
    //     refused with no state read leaked and no write.
    if !owner_matches(conn, user_id, agent_session_id)? {
        return Ok(ArchiveOutcome::refused());
    }

    // (2) The owner matched, so the row exists — read its current status to make re-archive an
    //     idempotent accepted no-op (and avoid stacking receipts on repeated archives).
    let current_status: String = conn.query_row(
        "SELECT status FROM agent_session WHERE agent_session_id = ?1",
        [agent_session_id],
        |r| r.get(0),
    )?;
    if current_status == "archived" || current_status == "pruned" {
        return Ok(ArchiveOutcome {
            accepted: true,
            status: "already_archived".to_string(),
            audit_ref: None,
        });
    }

    // (3) Write the transition + the receipt in ONE transaction (atomic). The columns are EXACTLY
    //     the ones the sweep's idle→archived step writes (status / archived_at / status_changed_at /
    //     updated_at) — so an explicitly-archived session is read back identically to a swept one.
    //     A CSPRNG tag keys the audit id so repeated archives of distinct sessions (or a re-archive
    //     after a future un-archive) never PK-collide on the audit_id primary key.
    let tag = friday_crypto::generate_approval_nonce();
    let receipt_id = format!("{agent_session_id}:archive:{tag}:receipt");
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE agent_session
            SET status = 'archived', archived_at = ?2, status_changed_at = ?2, updated_at = ?2
          WHERE agent_session_id = ?1",
        params![agent_session_id, now_ms],
    )?;
    // The actor is the owner principal that authorized the archive (WHO archived — more faithful
    // for an owner-authed op than a fixed component name); the payload_ref soft-links the session.
    audit::append_audit(
        &tx,
        &receipt_id,
        user_id,
        "session.archived",
        Some(agent_session_id),
        now_ms,
    )?;
    tx.commit()?;

    Ok(ArchiveOutcome {
        accepted: true,
        status: "archived".to_string(),
        audit_ref: Some(receipt_id),
    })
}

// --- C2-7 explicit owner-authed FORK op (a new branch of a metered session) -------
//
// An EXPLICIT, owner-authed FORK of one FRIDAY routed `agent_session`: the bound owner says
// "branch this conversation" — create a NEW owned session seeded with a COPY of the parent's
// messages, with `forked_from` pointing back at the parent, so a follow-up turn explores an
// alternate branch WITHOUT mutating the parent's history. This is the metadata half ONLY:
// the fork itself makes NO model call and writes NO `token_ledger` row (forking is not a
// turn). A later turn on the FORKED session routes + bills exactly like any other routed
// session (its OWN new `anthropic` row), so the fork is a real branch of a metered session —
// NOT a synthesized/mirror clone of a `provider_session_link` claude_control link (that local
// mirror has no owner axis and no real billing; this op never touches it).
//
// Owner-gated EXACTLY like the C2-4 read API and the C2-6 archive op: it reuses
// [`owner_matches`] on the PARENT (the `agent_session.user_id` axis bound to the authenticated
// caller by `run_session_task_pinned`), so a DIFFERENT principal — or a blank owner, an
// owner-less (NULL `user_id`) parent, or an absent parent id — is REFUSED fail-closed with NO
// child created, NO message copied, and NO audit row. Only the bound owner can fork, and the
// child is bound to the SAME owner (NEVER a client-asserted id).
//
// The child session row + the copied messages + the hash-chained audit receipt are written in
// ONE `unchecked_transaction` (atomic: a crash can never leave a half-copied child with no
// receipt, nor a child with a partial transcript). The copies are INSERTed directly into the
// child (the fork op holds the single tx, so it cannot call `append_session_message`, which
// would open a nested transaction) preserving each turn's `role`/`content`/`refs` VERBATIM —
// a fork is a faithful copy of the parent's history, so a copied message legitimately still
// `refs` the PARENT's run_id (only the NEW follow-up turn on the child gets its own run_id).

/// The body-free outcome of a [`fork_session_for_owner`] attempt. `accepted=false` is the
/// fail-closed owner-mismatch refusal (no child, no copy, no receipt). Never a body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForkOutcome {
    /// Whether the fork was accepted (`true`) or refused fail-closed (`false`).
    pub accepted: bool,
    /// Coarse, body-free outcome label (closed-vocab): `"forked"` (a child was created +
    /// seeded) or `"not_owner"` (fail-closed refusal — a non-owner, an owner-less parent, a
    /// blank owner, or an absent parent id).
    pub status: String,
    /// The minted child `agent_session_id`, present ONLY on an accepted fork. The caller uses
    /// it to run the next (branched) turn on the child.
    pub child_session_id: Option<String>,
    /// Soft link to the hash-chained audit receipt, written ONLY on an accepted fork.
    pub audit_ref: Option<String>,
}

impl ForkOutcome {
    fn refused() -> Self {
        ForkOutcome {
            accepted: false,
            status: "not_owner".to_string(),
            child_session_id: None,
            audit_ref: None,
        }
    }
}

/// Explicitly FORK a routed session as its BOUND owner: create a NEW owned `agent_session`
/// (fresh id, `forked_from` = the parent id, `user_id` = the authenticated caller, `status`
/// defaulting to `'active'`) seeded with a COPY of the parent's messages, and write a
/// hash-chained audit receipt — all in ONE transaction.
///
/// Owner-gated fail-closed via [`owner_matches`] on the PARENT (the SAME `agent_session.user_id`
/// axis as the C2-4 read API and the C2-6 archive op): a non-owner, an owner-less parent, a
/// blank `user_id`, or an absent `parent_session_id` all return [`ForkOutcome::refused`]
/// (`accepted=false`, `status="not_owner"`) with NO child, NO copied message, and NO audit row —
/// a guessed parent id cannot fork another principal's session.
///
/// The child is bound to the SAME owner the parent check established (`caller == parent.user_id`),
/// never a client-asserted id. The copied messages preserve each turn's `role`/`content`/`refs`
/// verbatim in `seq` order (a copied message legitimately still `refs` the parent's run_id — a
/// fork is a copy of history; only a NEW turn on the child gets its own run_id). The child's
/// `seq` restarts at `0` (a fresh session).
///
/// Metadata-only: NO model call and NO `token_ledger` row (forking is not a metered turn). A
/// LATER turn on the forked session routes + bills its OWN row exactly like any routed session,
/// so the fork is a real branch of a metered session — never a synthesized/mirror clone.
pub fn fork_session_for_owner(
    conn: &Connection,
    user_id: &str,
    parent_session_id: &str,
    now_ms: i64,
) -> Result<ForkOutcome> {
    // (1) Owner gate FIRST (fail-closed) on the PARENT: a non-owner / owner-less / absent /
    //     blank-owner attempt is refused with no read leaked, no mint, and no write.
    if !owner_matches(conn, user_id, parent_session_id)? {
        return Ok(ForkOutcome::refused());
    }

    // (2) The owner matched the parent. Read its messages to copy (refs-only metadata is not
    //     enough — a fork must carry the conversation, so the bodies are copied Hub-side, never
    //     over the wire). A CSPRNG tag keys both the child id and the audit id so repeated forks
    //     of the same parent never collide on the `agent_session` PK or the `audit_id` PK.
    let parent_messages = load_session_messages(conn, parent_session_id)?;
    let tag = friday_crypto::generate_approval_nonce();
    let child_session_id = format!("{parent_session_id}:fork:{tag}");
    let receipt_id = format!("{child_session_id}:fork:receipt");

    // (3) Create the child + copy the messages + write the receipt in ONE transaction (atomic:
    //     a crash can never leave a half-copied child or a child with no receipt). The child
    //     names `forked_from` (the parent pointer, m0032) and `user_id` (the SAME owner the gate
    //     established — never client-asserted); `status` takes its v28 DEFAULT 'active' so the
    //     child appears in the owner's active list. The copies are INSERTed DIRECTLY (the op
    //     holds the single tx; calling `append_session_message` would open a nested transaction).
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO agent_session (agent_session_id, created_at, updated_at, user_id, forked_from)
         VALUES (?1, ?2, ?2, ?3, ?4)",
        params![child_session_id, now_ms, user_id, parent_session_id],
    )?;
    for (seq, msg) in parent_messages.iter().enumerate() {
        let seq = seq as i64;
        let message_id = format!("{child_session_id}:m{seq}");
        tx.execute(
            "INSERT INTO agent_session_message
                (message_id, agent_session_id, seq, role, content, refs, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                message_id,
                child_session_id,
                seq,
                msg.role,
                msg.content,
                msg.refs,
                now_ms,
            ],
        )?;
    }
    // The actor is the owner principal that authorized the fork (WHO forked); the payload_ref
    // soft-links the NEW child session (the artifact this op produced).
    audit::append_audit(
        &tx,
        &receipt_id,
        user_id,
        "session.forked",
        Some(&child_session_id),
        now_ms,
    )?;
    tx.commit()?;

    Ok(ForkOutcome {
        accepted: true,
        status: "forked".to_string(),
        child_session_id: Some(child_session_id),
        audit_ref: Some(receipt_id),
    })
}

/// Read a session's `forked_from` parent pointer (C2-7). `Some(parent_id)` for a forked
/// session, `None` for a root session (or an absent one — both read back the same, no
/// existence oracle is intended here; the owner-gated read API governs visibility). Pure read.
pub fn session_forked_from(conn: &Connection, agent_session_id: &str) -> Result<Option<String>> {
    let parent = conn
        .query_row(
            "SELECT forked_from FROM agent_session WHERE agent_session_id = ?1",
            [agent_session_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok(parent)
}

// --- C2-8 offline/stale link-state (derived from last-activity vs now) --------
//
// A connectivity/staleness LABEL for a routed `agent_session`, derived purely from the
// session's last-activity timestamp (`agent_session.updated_at`) vs an injected `now_ms`.
// This is the SAME column `run_session_task_pinned`'s folded metered turn bumps (the
// `append_session_message` after a real provider-billed turn advances `updated_at`), so the
// staleness keys off the REAL routed session's activity — NOT a synthesized
// `provider_session_link` claude_control mirror heartbeat (that local mirror has no owner
// axis and no real billing, so reading it here would be a fake; this never touches it).
//
// DARK / pure compute: the state is DERIVED on read from `updated_at + now_ms`. Nothing is
// persisted — there is no `link_state` column, no migration, no write, and no model call.
// It is deterministically testable by injecting `now_ms` (never a wall clock).
//
// HONESTY SEAM (documented, not papered over): `updated_at` is the session's LAST-ACTIVITY
// timestamp. A metered turn bumps it (via the folded `append_session_message`), and the
// owner-less `ensure_session` at run-START also bumps it — so it is "last session activity",
// a SUPERSET of "last metered turn", not strictly the last billed turn. The faithful hub
// test drives the REAL `run_session_task_pinned` path so the metered turn IS what sets the
// timestamp the state keys off, and ASSERTS the anthropic ledger row to prove the session is
// genuinely metered (not a synthesized row).

/// Idle threshold (ms): a link with NO activity for AT LEAST this long is no longer
/// [`LinkState::Fresh`] — it becomes [`LinkState::Stale`]. 60s.
pub const LINK_STALE_AFTER_MS: i64 = 60_000;

/// Offline bound (ms): a link whose last activity is AT LEAST this old is
/// [`LinkState::Offline`] (the longer bound — the last metered turn is well past stale). 5m.
pub const LINK_OFFLINE_AFTER_MS: i64 = 300_000;

/// The connectivity/staleness state of a routed session link, derived from last-activity vs
/// now. A CLOSED vocabulary (like [`crate::run_readback_projection`]'s loop-status label) —
/// the only values are these three, so no session-embedded text can leak through it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkState {
    /// Active within the idle threshold (`elapsed < LINK_STALE_AFTER_MS`).
    Fresh,
    /// Idle for at least the stale threshold but less than the offline bound.
    Stale,
    /// Last activity is at least the offline bound old (`elapsed >= LINK_OFFLINE_AFTER_MS`).
    Offline,
}

impl LinkState {
    /// The stable, refs-only label — a fixed `&'static str` from the closed vocabulary
    /// (never any session text), suitable for an off-process projection.
    pub fn as_str(self) -> &'static str {
        match self {
            LinkState::Fresh => "fresh",
            LinkState::Stale => "stale",
            LinkState::Offline => "offline",
        }
    }
}

/// Derive the [`LinkState`] from a session's `last_activity_ms` and an injected `now_ms`.
///
/// Pure clock-driven transition on `elapsed = now_ms - last_activity_ms`:
/// `elapsed < LINK_STALE_AFTER_MS` ⇒ `Fresh`; `>= LINK_STALE_AFTER_MS` and
/// `< LINK_OFFLINE_AFTER_MS` ⇒ `Stale`; `>= LINK_OFFLINE_AFTER_MS` ⇒ `Offline`. A `now_ms`
/// BEFORE `last_activity_ms` (clock skew / a future timestamp) clamps elapsed to 0 ⇒ `Fresh`
/// (never an underflow). No wall clock — `now_ms` is injected so the transitions are
/// deterministically testable.
pub fn derive_link_state(last_activity_ms: i64, now_ms: i64) -> LinkState {
    let elapsed = now_ms.saturating_sub(last_activity_ms).max(0);
    if elapsed >= LINK_OFFLINE_AFTER_MS {
        LinkState::Offline
    } else if elapsed >= LINK_STALE_AFTER_MS {
        LinkState::Stale
    } else {
        LinkState::Fresh
    }
}

/// OWNER-SCOPED link-state of one routed session: `Some(state)` derived from the session's
/// `updated_at` (its last-activity timestamp) vs `now_ms`, ONLY when `user_id` owns the
/// session; otherwise `None`.
///
/// Fail-closed exactly like [`open_session_for_owner`] / [`session_message_count_for_owner`]:
/// a blank `user_id`, an absent session, an owner-less (NULL `user_id`) session, or a
/// DIFFERENT owner all return `None` — a non-owner cannot read another principal's link-state
/// by guessing its `agent_session_id` (no existence/state oracle). Pure read + compute: no
/// write, no schema change, no model call. The timestamp is the REAL routed session's
/// activity (`updated_at`), not a mirror heartbeat.
pub fn link_state_for_owner(
    conn: &Connection,
    user_id: &str,
    agent_session_id: &str,
    now_ms: i64,
) -> Result<Option<LinkState>> {
    if !owner_matches(conn, user_id, agent_session_id)? {
        return Ok(None);
    }
    // The owner check passed, so the row exists — read its last-activity timestamp.
    let last_activity_ms: i64 = conn.query_row(
        "SELECT updated_at FROM agent_session WHERE agent_session_id = ?1",
        [agent_session_id],
        |r| r.get(0),
    )?;
    Ok(Some(derive_link_state(last_activity_ms, now_ms)))
}

/// Load only the messages NOT yet consumed by a memory extraction
/// (`memory_extract_status = 'pending'`), in `seq` order (oldest first). This is the
/// dedup half of session-memory slice-2: the inline extraction reads PENDING messages
/// and marks the processed ones terminal, so a RE-RUN reads no pending and creates no
/// duplicate candidates. An unknown/empty session — or one whose every message is
/// already terminal — returns an empty Vec (not an error).
///
/// [`load_session_messages`] is kept UNCHANGED for the resume/history path, which must
/// always see the full conversation regardless of extraction status. Slice-2 changes
/// ONLY the extraction read; it does not alter how a session resumes.
pub fn load_pending_session_messages(
    conn: &Connection,
    agent_session_id: &str,
) -> Result<Vec<StoredSessionMessage>> {
    let mut stmt = conn.prepare(
        "SELECT message_id, agent_session_id, seq, role, content, refs, created_at
         FROM agent_session_message
         WHERE agent_session_id = ?1 AND memory_extract_status = 'pending'
         ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map([agent_session_id], |r| {
        Ok(StoredSessionMessage {
            message_id: r.get(0)?,
            agent_session_id: r.get(1)?,
            seq: r.get(2)?,
            role: r.get(3)?,
            content: r.get(4)?,
            refs: r.get(5)?,
            created_at: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Mark the given messages as consumed by a memory extraction
/// (`memory_extract_status = 'extracted'`), so a later extraction's
/// [`load_pending_session_messages`] no longer returns them (the dedup guarantee).
/// Returns the number of rows actually updated.
///
/// Slice-2 collapses the TS extracted/skipped distinction to a single terminal
/// `'extracted'` status: a processed message (whether a safe item referenced it, no
/// item referenced it, or its only item was sensitivity-DROPPED) is consumed and must
/// not be re-extracted — matching the TS, where a dropped/unreferenced message still
/// leaves the pending set. The richer 'skipped'/'failed'/queue transitions are deferred.
///
/// This takes a bare `&Connection` (not `&mut Db`) so the caller can run it INSIDE the
/// same `unchecked_transaction` that persists the candidates — then a mid-persist error
/// rolls back BOTH the candidates and these marks (all-or-nothing). An empty id slice is
/// a no-op (0 updated). The `memory_id`-shaped ids are bound as parameters (no string
/// interpolation), so this is injection-safe even with caller-minted ids.
pub fn mark_messages_extracted(conn: &Connection, message_ids: &[String]) -> Result<usize> {
    if message_ids.is_empty() {
        return Ok(0);
    }
    let placeholders = vec!["?"; message_ids.len()].join(", ");
    let sql = format!(
        "UPDATE agent_session_message SET memory_extract_status = 'extracted'
         WHERE message_id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params = rusqlite::params_from_iter(message_ids.iter());
    let updated = stmt.execute(params)?;
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "friday-agent-session-{}-{}-{}-{nanos}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed),
            ))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn ensure_session_is_idempotent_and_bumps_updated_at() {
        let db = Db::open_hub(&tmp("ensure")).unwrap();
        ensure_session(db.conn(), "s1", 1000).unwrap();
        assert!(session_exists(db.conn(), "s1").unwrap());
        let (created, updated): (i64, i64) = db
            .conn()
            .query_row(
                "SELECT created_at, updated_at FROM agent_session WHERE agent_session_id='s1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((created, updated), (1000, 1000));
        // Re-ensure bumps updated_at but keeps created_at and does not duplicate.
        ensure_session(db.conn(), "s1", 2000).unwrap();
        let (created2, updated2): (i64, i64) = db
            .conn()
            .query_row(
                "SELECT created_at, updated_at FROM agent_session WHERE agent_session_id='s1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(created2, 1000, "created_at is immutable");
        assert_eq!(updated2, 2000, "updated_at advances");
        assert_eq!(db.count("agent_session").unwrap(), 1, "no duplicate row");
    }

    #[test]
    fn append_assigns_monotonic_seq_and_loads_in_order() {
        let db = Db::open_hub(&tmp("append")).unwrap();
        ensure_session(db.conn(), "s1", 1).unwrap();
        let id0 = append_session_message(
            db.conn(),
            "s1",
            &SessionMessage::new("user", "remember 47", Some("r1".into())),
            10,
        )
        .unwrap();
        let id1 = append_session_message(
            db.conn(),
            "s1",
            &SessionMessage::new("assistant", "noted 47", Some("r1".into())),
            11,
        )
        .unwrap();
        assert_ne!(id0, id1);
        let msgs = load_session_messages(db.conn(), "s1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!((msgs[0].seq, msgs[1].seq), (0, 1));
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "remember 47");
        assert_eq!(msgs[0].refs.as_deref(), Some("r1"));
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(session_message_count(db.conn(), "s1").unwrap(), 2);
    }

    #[test]
    fn append_to_unknown_session_fails_closed() {
        let db = Db::open_hub(&tmp("orphan")).unwrap();
        let err = append_session_message(
            db.conn(),
            "ghost",
            &SessionMessage::new("user", "hi", None),
            1,
        )
        .unwrap_err();
        assert!(matches!(err, StorageError::NotFound(_)));
        assert_eq!(session_message_count(db.conn(), "ghost").unwrap(), 0);
    }

    #[test]
    fn load_unknown_session_is_empty_not_error() {
        let db = Db::open_hub(&tmp("empty")).unwrap();
        let msgs = load_session_messages(db.conn(), "nope").unwrap();
        assert!(msgs.is_empty());
        assert!(!session_exists(db.conn(), "nope").unwrap());
    }

    #[test]
    fn blank_role_and_blank_session_id_rejected() {
        let db = Db::open_hub(&tmp("blank")).unwrap();
        assert!(ensure_session(db.conn(), "  ", 1).is_err());
        ensure_session(db.conn(), "s1", 1).unwrap();
        assert!(
            append_session_message(db.conn(), "s1", &SessionMessage::new("  ", "x", None), 1)
                .is_err()
        );
    }

    // --- slice-2 (dedup) -----------------------------------------------------

    fn status_of(db: &Db, message_id: &str) -> String {
        db.conn()
            .query_row(
                "SELECT memory_extract_status FROM agent_session_message WHERE message_id = ?1",
                [message_id],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
    }

    #[test]
    fn fresh_db_defaults_messages_to_pending_and_reaches_latest() {
        let db = Db::open_hub(&tmp("pending-default")).unwrap();
        // The fresh-DB migration chain reaches at least the slice-2 version (the
        // `memory_extract_status` column exists). Derived from the migration set so a new
        // additive migration (e.g. slice-3 v21) does not break this assertion.
        let v: i64 = db
            .conn()
            .query_row("SELECT version FROM schema_version WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        let expected = crate::hub_migrations()
            .iter()
            .map(|m| m.version)
            .max()
            .unwrap();
        assert_eq!(v, expected, "fresh migration reaches the latest version");
        assert!(v >= 20, "the slice-2 memory_extract_status column exists");

        ensure_session(db.conn(), "s1", 1).unwrap();
        let id = append_session_message(
            db.conn(),
            "s1",
            &SessionMessage::new("user", "hello", None),
            10,
        )
        .unwrap();
        // A freshly-appended message defaults to 'pending' (extractable).
        assert_eq!(status_of(&db, &id), "pending");
    }

    #[test]
    fn load_pending_returns_only_pending_and_mark_makes_them_terminal() {
        let db = Db::open_hub(&tmp("pending")).unwrap();
        ensure_session(db.conn(), "s1", 1).unwrap();
        let m0 =
            append_session_message(db.conn(), "s1", &SessionMessage::new("user", "a", None), 10)
                .unwrap();
        let m1 = append_session_message(
            db.conn(),
            "s1",
            &SessionMessage::new("assistant", "b", None),
            11,
        )
        .unwrap();

        // Both start pending; load_pending sees both (in seq order); full load is unchanged.
        let pending = load_pending_session_messages(db.conn(), "s1").unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!((pending[0].seq, pending[1].seq), (0, 1));
        assert_eq!(load_session_messages(db.conn(), "s1").unwrap().len(), 2);

        // Mark m0 extracted → load_pending now returns only m1; full load still 2.
        let n = mark_messages_extracted(db.conn(), std::slice::from_ref(&m0)).unwrap();
        assert_eq!(n, 1);
        let pending = load_pending_session_messages(db.conn(), "s1").unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].message_id, m1);
        assert_eq!(status_of(&db, &m0), "extracted");
        assert_eq!(status_of(&db, &m1), "pending");
        assert_eq!(
            load_session_messages(db.conn(), "s1").unwrap().len(),
            2,
            "history/resume load is unaffected by extraction status"
        );

        // Mark the rest → no pending remains.
        assert_eq!(mark_messages_extracted(db.conn(), &[m1]).unwrap(), 1);
        assert!(load_pending_session_messages(db.conn(), "s1")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn mark_empty_slice_is_noop_and_unknown_ids_update_nothing() {
        let db = Db::open_hub(&tmp("noop")).unwrap();
        ensure_session(db.conn(), "s1", 1).unwrap();
        append_session_message(db.conn(), "s1", &SessionMessage::new("user", "a", None), 10)
            .unwrap();
        assert_eq!(mark_messages_extracted(db.conn(), &[]).unwrap(), 0);
        assert_eq!(
            mark_messages_extracted(db.conn(), &["does-not-exist".to_string()]).unwrap(),
            0
        );
        // The real message is untouched.
        assert_eq!(
            load_pending_session_messages(db.conn(), "s1")
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn load_pending_unknown_session_is_empty() {
        let db = Db::open_hub(&tmp("pending-unknown")).unwrap();
        assert!(load_pending_session_messages(db.conn(), "nope")
            .unwrap()
            .is_empty());
    }

    // --- slice-3 (ownership-binding) -----------------------------------------

    #[test]
    fn owner_less_ensure_session_reads_back_no_owner() {
        // A session created via the owner-less `ensure_session` has all owner axes NULL —
        // its memory namespace is UNRESOLVABLE (fail-closed) until an owner is set.
        let db = Db::open_hub(&tmp("noowner")).unwrap();
        ensure_session(db.conn(), "s1", 1).unwrap();
        let owner = load_session_owner(db.conn(), "s1").unwrap();
        assert_eq!(owner, Some(SessionOwner::default()));
        let o = owner.unwrap();
        assert_eq!(o.account_id, None);
        assert_eq!(o.channel, None);
        assert_eq!(o.user_id, None);
    }

    #[test]
    fn ensure_with_owner_stores_and_loads_owner_axes() {
        let db = Db::open_hub(&tmp("owner")).unwrap();
        let owner = SessionOwner {
            account_id: Some("acct-1".into()),
            channel: Some("discord".into()),
            user_id: Some("user-abc".into()),
            ..Default::default()
        };
        ensure_session_with_owner(db.conn(), "s1", &owner, 1).unwrap();
        assert_eq!(load_session_owner(db.conn(), "s1").unwrap(), Some(owner));
    }

    #[test]
    fn conversation_axes_store_and_load_round_trip() {
        // Owner-wiring: the DM/subagent fallback axes (`chat_kind`/`chat_id`/
        // `parent_session_id`) round-trip through ensure/load like the owner axes.
        let db = Db::open_hub(&tmp("convaxes")).unwrap();
        let owner = SessionOwner {
            account_id: Some("default".into()),
            channel: Some("telegram".into()),
            user_id: None,
            chat_kind: Some("dm".into()),
            chat_id: Some("chat-77".into()),
            parent_session_id: None,
            session_kind: Some("conversation".into()),
        };
        ensure_session_with_owner(db.conn(), "s1", &owner, 1).unwrap();
        assert_eq!(load_session_owner(db.conn(), "s1").unwrap(), Some(owner));

        // A subagent-shaped session links its parent (soft link, no FK — a not-yet-
        // existing parent id is accepted; the WALK fails closed, not the row) and carries
        // its STRUCTURAL kind explicitly (round-trips like the other axes).
        let sub = SessionOwner {
            parent_session_id: Some("s1".into()),
            session_kind: Some("subagent".into()),
            ..Default::default()
        };
        ensure_session_with_owner(db.conn(), "s2", &sub, 2).unwrap();
        let back = load_session_owner(db.conn(), "s2").unwrap().unwrap();
        assert_eq!(back.parent_session_id.as_deref(), Some("s1"));
        assert_eq!(back.session_kind.as_deref(), Some("subagent"));
        assert_eq!(back.chat_kind, None);
        assert_eq!(back.user_id, None);
    }

    #[test]
    fn chat_kind_outside_ts_vocabulary_is_rejected_by_check() {
        // The CHECK admits NULL or the exact TS vocabulary only — an unknown kind cannot
        // be stored to LOOK like (or later be confused with) a DM.
        let db = Db::open_hub(&tmp("chatkind-check")).unwrap();
        let bad = SessionOwner {
            chat_kind: Some("direct-message".into()),
            ..Default::default()
        };
        assert!(ensure_session_with_owner(db.conn(), "s1", &bad, 1).is_err());
        // The valid vocabulary is accepted.
        for (i, kind) in ["dm", "group", "channel", "thread"].iter().enumerate() {
            let ok = SessionOwner {
                chat_kind: Some((*kind).to_string()),
                ..Default::default()
            };
            ensure_session_with_owner(db.conn(), &format!("k{i}"), &ok, 1).unwrap();
        }
    }

    #[test]
    fn session_kind_outside_ts_vocabulary_is_rejected_by_check() {
        // The structural-kind CHECK admits NULL or the exact TS `parts.kind` vocabulary
        // only ("conversation" | "subagent") — an unknown value cannot be stored to LOOK
        // like (or later be confused with) a conversation/subagent and trigger a fallback.
        let db = Db::open_hub(&tmp("sessionkind-check")).unwrap();
        let bad = SessionOwner {
            session_kind: Some("agent".into()),
            ..Default::default()
        };
        assert!(ensure_session_with_owner(db.conn(), "s1", &bad, 1).is_err());
        // The valid vocabulary is accepted and round-trips.
        for (i, kind) in ["conversation", "subagent"].iter().enumerate() {
            let ok = SessionOwner {
                session_kind: Some((*kind).to_string()),
                ..Default::default()
            };
            ensure_session_with_owner(db.conn(), &format!("sk{i}"), &ok, 1).unwrap();
            let back = load_session_owner(db.conn(), &format!("sk{i}"))
                .unwrap()
                .unwrap();
            assert_eq!(back.session_kind.as_deref(), Some(*kind));
        }
    }

    #[test]
    fn blank_owner_fields_store_as_none() {
        // A blank-string owner field is indistinguishable from absent (the namespace
        // resolver treats None and Some("") identically).
        let db = Db::open_hub(&tmp("blankowner")).unwrap();
        let owner = SessionOwner {
            account_id: Some("".into()),
            channel: Some("   ".into()),
            user_id: Some("u".into()),
            ..Default::default()
        };
        ensure_session_with_owner(db.conn(), "s1", &owner, 1).unwrap();
        let back = load_session_owner(db.conn(), "s1").unwrap().unwrap();
        assert_eq!(back.account_id, None, "empty account stored as NULL");
        // A whitespace-only value is stored verbatim (non-empty), but blank trimming is
        // the resolver's job — here we only normalize the strictly-empty string.
        assert_eq!(back.channel.as_deref(), Some("   "));
        assert_eq!(back.user_id.as_deref(), Some("u"));
    }

    #[test]
    fn re_ensure_does_not_clobber_bound_owner_but_backfills_null() {
        // Once an owner is bound, a later no-owner ensure keeps it; a later ensure can
        // BACKFILL a field that was NULL.
        let db = Db::open_hub(&tmp("clobber")).unwrap();
        let owner = SessionOwner {
            account_id: Some("acct-1".into()),
            channel: None,
            user_id: Some("user-abc".into()),
            ..Default::default()
        };
        ensure_session_with_owner(db.conn(), "s1", &owner, 1).unwrap();
        // A no-owner re-ensure must NOT erase the bound account/user.
        ensure_session(db.conn(), "s1", 2).unwrap();
        let back = load_session_owner(db.conn(), "s1").unwrap().unwrap();
        assert_eq!(back.account_id.as_deref(), Some("acct-1"));
        assert_eq!(back.user_id.as_deref(), Some("user-abc"));
        assert_eq!(back.channel, None);
        // A later ensure backfills the previously-NULL channel.
        ensure_session_with_owner(
            db.conn(),
            "s1",
            &SessionOwner {
                account_id: Some("ignored-acct".into()),
                channel: Some("slack".into()),
                user_id: None,
                ..Default::default()
            },
            3,
        )
        .unwrap();
        let back = load_session_owner(db.conn(), "s1").unwrap().unwrap();
        assert_eq!(
            back.account_id.as_deref(),
            Some("acct-1"),
            "bound account is not clobbered by a new ensure"
        );
        assert_eq!(
            back.channel.as_deref(),
            Some("slack"),
            "the previously-NULL channel is backfilled"
        );
        assert_eq!(back.user_id.as_deref(), Some("user-abc"));
        // created_at immutable, updated_at advanced — owner binding preserves the existing
        // idempotency contract.
        let (created, updated): (i64, i64) = db
            .conn()
            .query_row(
                "SELECT created_at, updated_at FROM agent_session WHERE agent_session_id='s1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(created, 1, "created_at immutable across owner re-ensure");
        assert_eq!(updated, 3, "updated_at advances");
    }

    #[test]
    fn load_owner_of_absent_session_is_none() {
        let db = Db::open_hub(&tmp("absent")).unwrap();
        assert_eq!(load_session_owner(db.conn(), "ghost").unwrap(), None);
    }

    // --- C2-4 owner-scoped routed-session list/open/read ---------------------

    #[test]
    fn list_sessions_for_owner_scopes_to_owner_and_orders_by_updated_at_desc() {
        // SQL-level proof of the owner-scoping + ordering contract (the friday-hub
        // `run_session_task_pinned` e2e proof lives in runtime.rs's in-crate tests, where
        // the claude stub harness is reachable). Two sessions for `alice` at DISTINCT
        // updated_at, one for `bob`.
        let db = Db::open_hub(&tmp("c2-4-list")).unwrap();
        let alice = SessionOwner {
            user_id: Some("alice".into()),
            ..Default::default()
        };
        let bob = SessionOwner {
            user_id: Some("bob".into()),
            ..Default::default()
        };
        // alice/s1 created first (older updated_at), alice/s2 second (newer), bob/s3.
        ensure_session_with_owner(db.conn(), "s1", &alice, 3_000).unwrap();
        ensure_session_with_owner(db.conn(), "s2", &alice, 4_000).unwrap();
        ensure_session_with_owner(db.conn(), "s3", &bob, 5_000).unwrap();

        // alice sees exactly her two, most-recently-updated FIRST (s2 @4000 before s1 @3000).
        let alice_list = list_sessions_for_owner(db.conn(), "alice").unwrap();
        assert_eq!(
            alice_list
                .iter()
                .map(|s| &s.agent_session_id)
                .collect::<Vec<_>>(),
            vec!["s2", "s1"],
            "owner list is most-recently-updated first"
        );
        assert_eq!(alice_list[0].updated_at, 4_000);
        assert_eq!(alice_list[1].updated_at, 3_000);

        // bob sees only his — owner-scoped, never alice's (the load-bearing assertion).
        let bob_list = list_sessions_for_owner(db.conn(), "bob").unwrap();
        assert_eq!(bob_list.len(), 1);
        assert_eq!(bob_list[0].agent_session_id, "s3");

        // A principal that owns NOTHING gets an EMPTY list (fail-closed, not all-sessions).
        assert!(list_sessions_for_owner(db.conn(), "carol")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn list_excludes_owner_less_sessions_and_blank_query_matches_nothing() {
        // An owner-less session (NULL user_id, e.g. created via the no-owner `ensure_session`)
        // is never listed under any owner, and a blank/empty owner query never collapses to a
        // wildcard that would surface every session (fail-closed).
        let db = Db::open_hub(&tmp("c2-4-noowner")).unwrap();
        ensure_session(db.conn(), "owner-less", 1_000).unwrap();
        ensure_session_with_owner(
            db.conn(),
            "owned",
            &SessionOwner {
                user_id: Some("alice".into()),
                ..Default::default()
            },
            2_000,
        )
        .unwrap();
        // Blank query → nothing (must NOT match the NULL-user_id owner-less row nor wildcard).
        assert!(list_sessions_for_owner(db.conn(), "").unwrap().is_empty());
        // alice sees only her owned session, never the owner-less one.
        let alice = list_sessions_for_owner(db.conn(), "alice").unwrap();
        assert_eq!(alice.len(), 1);
        assert_eq!(alice[0].agent_session_id, "owned");
    }

    #[test]
    fn open_and_count_are_owner_scoped_fail_closed() {
        // Open/read of a session is gated by the SAME owner axis as the list: a guessed
        // agent_session_id cannot bypass scoping. A DIFFERENT principal — and an owner-less
        // session, and an absent id — all read back None (no existence/size oracle).
        let db = Db::open_hub(&tmp("c2-4-open")).unwrap();
        ensure_session_with_owner(
            db.conn(),
            "s1",
            &SessionOwner {
                user_id: Some("alice".into()),
                ..Default::default()
            },
            1_000,
        )
        .unwrap();
        append_session_message(
            db.conn(),
            "s1",
            &SessionMessage::new("user", "remember 47", Some("run-1".into())),
            1_010,
        )
        .unwrap();
        append_session_message(
            db.conn(),
            "s1",
            &SessionMessage::new("assistant", "noted 47", Some("run-1".into())),
            1_020,
        )
        .unwrap();

        // The OWNER opens + reads the folded transcript.
        let msgs = open_session_for_owner(db.conn(), "alice", "s1")
            .unwrap()
            .expect("the owner can open her own session");
        assert_eq!(msgs.len(), 2);
        assert_eq!(
            (msgs[0].role.as_str(), msgs[1].role.as_str()),
            ("user", "assistant")
        );
        assert_eq!(msgs[0].content, "remember 47");
        assert_eq!(
            session_message_count_for_owner(db.conn(), "alice", "s1").unwrap(),
            Some(2)
        );

        // A DIFFERENT principal guessing the same id reads NOTHING (fail-closed open).
        assert_eq!(
            open_session_for_owner(db.conn(), "bob", "s1").unwrap(),
            None
        );
        assert_eq!(
            session_message_count_for_owner(db.conn(), "bob", "s1").unwrap(),
            None
        );
        // A blank owner and an absent id are also fail-closed.
        assert_eq!(open_session_for_owner(db.conn(), "", "s1").unwrap(), None);
        assert_eq!(
            open_session_for_owner(db.conn(), "alice", "ghost").unwrap(),
            None
        );

        // An owner-less session is not openable by anyone (NULL user_id never matches).
        ensure_session(db.conn(), "orphan", 1_100).unwrap();
        assert_eq!(
            open_session_for_owner(db.conn(), "alice", "orphan").unwrap(),
            None
        );
    }

    // --- C2-6 explicit owner-authed archive op -------------------------------

    fn status_col(db: &Db, id: &str) -> String {
        db.conn()
            .query_row(
                "SELECT status FROM agent_session WHERE agent_session_id = ?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
    }

    fn archive_receipt_count(db: &Db) -> i64 {
        db.conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE action = 'session.archived'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn archive_session_for_owner_transitions_status_and_writes_receipt_and_hides_from_list() {
        // SQL-level proof of the archive op (the friday-hub faithful proof — REAL routed session +
        // metered anthropic row — lives in runtime.rs's in-crate tests). The BOUND owner archives
        // her session: status → 'archived' (+ archived_at), an audit receipt is written, the chain
        // verifies, and the session disappears from the C2-4 active list while a sibling active
        // session stays listed.
        let db = Db::open_hub(&tmp("c2-6-archive")).unwrap();
        let alice = SessionOwner {
            user_id: Some("alice".into()),
            ..Default::default()
        };
        ensure_session_with_owner(db.conn(), "s1", &alice, 1_000).unwrap();
        ensure_session_with_owner(db.conn(), "s2", &alice, 2_000).unwrap();
        // Both start active and listed (most-recent-first).
        assert_eq!(status_col(&db, "s1"), "active");
        assert_eq!(
            list_sessions_for_owner(db.conn(), "alice")
                .unwrap()
                .iter()
                .map(|s| s.agent_session_id.clone())
                .collect::<Vec<_>>(),
            vec!["s2", "s1"]
        );

        // The owner archives s1.
        let out = archive_session_for_owner(db.conn(), "alice", "s1", 3_000).unwrap();
        assert!(out.accepted);
        assert_eq!(out.status, "archived");
        assert!(out.audit_ref.is_some());

        // status → archived + archived_at = now; status_changed_at + updated_at bumped.
        let (status, archived_at, sca, upd): (String, Option<i64>, Option<i64>, i64) = db
            .conn()
            .query_row(
                "SELECT status, archived_at, status_changed_at, updated_at
                 FROM agent_session WHERE agent_session_id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(status, "archived");
        assert_eq!(archived_at, Some(3_000));
        assert_eq!(sca, Some(3_000));
        assert_eq!(upd, 3_000);

        // s1 is hidden from the active list; s2 (still active) remains.
        assert_eq!(
            list_sessions_for_owner(db.conn(), "alice")
                .unwrap()
                .iter()
                .map(|s| s.agent_session_id.clone())
                .collect::<Vec<_>>(),
            vec!["s2"],
            "the archived session is hidden; the active sibling remains listed"
        );

        // The receipt is written and the hash chain verifies.
        assert_eq!(archive_receipt_count(&db), 1);
        assert!(crate::audit::verify_audit_chain(db.conn()).is_ok());
    }

    #[test]
    fn archive_owner_mismatch_is_fail_closed_no_state_change_no_receipt() {
        // The load-bearing security assertion: a DIFFERENT principal (and a blank owner, an
        // owner-less session, an absent id) CANNOT archive — refused fail-closed with NO state
        // change and NO audit row. Only the bound owner can archive.
        let db = Db::open_hub(&tmp("c2-6-mismatch")).unwrap();
        ensure_session_with_owner(
            db.conn(),
            "s1",
            &SessionOwner {
                user_id: Some("alice".into()),
                ..Default::default()
            },
            1_000,
        )
        .unwrap();

        // A different principal's archive is refused, with no change and no receipt.
        let bob = archive_session_for_owner(db.conn(), "bob", "s1", 2_000).unwrap();
        assert_eq!(
            bob,
            ArchiveOutcome {
                accepted: false,
                status: "not_owner".into(),
                audit_ref: None,
            }
        );
        assert_eq!(
            status_col(&db, "s1"),
            "active",
            "no state change on mismatch"
        );
        assert_eq!(
            archive_receipt_count(&db),
            0,
            "no receipt on a refused archive"
        );
        // Still in alice's active list (untouched).
        assert_eq!(
            list_sessions_for_owner(db.conn(), "alice").unwrap().len(),
            1
        );

        // A blank owner, an absent id, and an owner-less session are all refused too.
        assert!(
            !archive_session_for_owner(db.conn(), "", "s1", 2_000)
                .unwrap()
                .accepted
        );
        assert!(
            !archive_session_for_owner(db.conn(), "alice", "ghost", 2_000)
                .unwrap()
                .accepted
        );
        ensure_session(db.conn(), "orphan", 1_500).unwrap();
        assert!(
            !archive_session_for_owner(db.conn(), "alice", "orphan", 2_000)
                .unwrap()
                .accepted
        );
        // None of those wrote a receipt or changed s1.
        assert_eq!(archive_receipt_count(&db), 0);
        assert_eq!(status_col(&db, "s1"), "active");
    }

    #[test]
    fn re_archive_is_an_idempotent_accepted_noop() {
        // Re-archiving an already-archived session is an accepted no-op: no new receipt, no
        // timestamp bump. (A 'pruned' session — already past archive — is treated the same.)
        let db = Db::open_hub(&tmp("c2-6-idem")).unwrap();
        ensure_session_with_owner(
            db.conn(),
            "s1",
            &SessionOwner {
                user_id: Some("alice".into()),
                ..Default::default()
            },
            1_000,
        )
        .unwrap();
        let first = archive_session_for_owner(db.conn(), "alice", "s1", 3_000).unwrap();
        assert_eq!(first.status, "archived");
        assert_eq!(archive_receipt_count(&db), 1);

        let again = archive_session_for_owner(db.conn(), "alice", "s1", 4_000).unwrap();
        assert!(again.accepted);
        assert_eq!(again.status, "already_archived");
        assert_eq!(again.audit_ref, None);
        assert_eq!(archive_receipt_count(&db), 1, "no second receipt");
        // updated_at NOT bumped by the no-op.
        let upd: i64 = db
            .conn()
            .query_row(
                "SELECT updated_at FROM agent_session WHERE agent_session_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            upd, 3_000,
            "the idempotent re-archive does not bump updated_at"
        );

        // A 'pruned' session is likewise an accepted no-op (already past archive).
        ensure_session_with_owner(
            db.conn(),
            "s2",
            &SessionOwner {
                user_id: Some("alice".into()),
                ..Default::default()
            },
            1_000,
        )
        .unwrap();
        db.conn()
            .execute(
                "UPDATE agent_session SET status = 'pruned' WHERE agent_session_id = 's2'",
                [],
            )
            .unwrap();
        let pruned = archive_session_for_owner(db.conn(), "alice", "s2", 5_000).unwrap();
        assert!(pruned.accepted);
        assert_eq!(pruned.status, "already_archived");
        assert_eq!(
            archive_receipt_count(&db),
            1,
            "pruned no-op writes no receipt"
        );
    }

    // --- C2-8 offline/stale link-state ---------------------------------------

    #[test]
    fn derive_link_state_transitions_fresh_stale_offline_on_the_injected_clock() {
        // Pure clock-driven transitions on elapsed = now - last_activity. The boundaries are
        // inclusive at the threshold (>=), so a now exactly AT a threshold is the harsher state.
        let t = 1_000_000;
        // Just after the turn → fresh.
        assert_eq!(derive_link_state(t, t + 1), LinkState::Fresh);
        assert_eq!(
            derive_link_state(t, t + LINK_STALE_AFTER_MS - 1),
            LinkState::Fresh,
            "one ms before the stale threshold is still fresh"
        );
        // At / past the stale threshold (but before offline) → stale.
        assert_eq!(
            derive_link_state(t, t + LINK_STALE_AFTER_MS),
            LinkState::Stale,
            "exactly at the stale threshold is stale (inclusive boundary)"
        );
        assert_eq!(
            derive_link_state(t, t + LINK_OFFLINE_AFTER_MS - 1),
            LinkState::Stale,
            "one ms before the offline bound is still stale"
        );
        // At / past the offline bound → offline.
        assert_eq!(
            derive_link_state(t, t + LINK_OFFLINE_AFTER_MS),
            LinkState::Offline,
            "exactly at the offline bound is offline (inclusive boundary)"
        );
        assert_eq!(
            derive_link_state(t, t + LINK_OFFLINE_AFTER_MS * 10),
            LinkState::Offline
        );
        // The label vocabulary is closed/stable.
        assert_eq!(LinkState::Fresh.as_str(), "fresh");
        assert_eq!(LinkState::Stale.as_str(), "stale");
        assert_eq!(LinkState::Offline.as_str(), "offline");
    }

    #[test]
    fn derive_link_state_clamps_clock_skew_to_fresh_not_underflow() {
        // A now BEFORE last_activity (clock skew / a future timestamp) clamps elapsed to 0 →
        // fresh, never an underflow/offline. Also robust at i64 extremes (saturating_sub).
        assert_eq!(derive_link_state(5_000, 1_000), LinkState::Fresh);
        assert_eq!(derive_link_state(i64::MAX, i64::MIN), LinkState::Fresh);
    }

    #[test]
    fn link_state_for_owner_keys_off_updated_at_and_advances_with_the_clock() {
        // SQL-level proof of the owner-gated read over the REAL agent_session.updated_at (the
        // claude-stub/anthropic-ledger faithful proof lives in friday-hub runtime.rs, where the
        // harness is reachable). Here updated_at stands in for the last-activity timestamp.
        let db = Db::open_hub(&tmp("c2-8-state")).unwrap();
        let last_turn = 2_000_000;
        ensure_session_with_owner(
            db.conn(),
            "s1",
            &SessionOwner {
                user_id: Some("alice".into()),
                ..Default::default()
            },
            last_turn,
        )
        .unwrap();

        // now just after the turn → fresh; past the stale threshold → stale; past offline → offline.
        assert_eq!(
            link_state_for_owner(db.conn(), "alice", "s1", last_turn + 1).unwrap(),
            Some(LinkState::Fresh)
        );
        assert_eq!(
            link_state_for_owner(db.conn(), "alice", "s1", last_turn + LINK_STALE_AFTER_MS)
                .unwrap(),
            Some(LinkState::Stale)
        );
        assert_eq!(
            link_state_for_owner(db.conn(), "alice", "s1", last_turn + LINK_OFFLINE_AFTER_MS)
                .unwrap(),
            Some(LinkState::Offline)
        );

        // A later metered turn bumps updated_at, so the link goes fresh again at the same `now`
        // (proving the state keys off the LIVE last-activity timestamp, not a fixed creation time).
        let stale_now = last_turn + LINK_STALE_AFTER_MS;
        assert_eq!(
            link_state_for_owner(db.conn(), "alice", "s1", stale_now).unwrap(),
            Some(LinkState::Stale)
        );
        append_session_message(
            db.conn(),
            "s1",
            &SessionMessage::new("assistant", "noted", Some("run-1".into())),
            stale_now,
        )
        .unwrap();
        assert_eq!(
            link_state_for_owner(db.conn(), "alice", "s1", stale_now + 1).unwrap(),
            Some(LinkState::Fresh),
            "a fresh metered turn (bumping updated_at) returns the link to fresh"
        );
    }

    #[test]
    fn link_state_for_owner_is_owner_scoped_fail_closed() {
        // The link-state read is gated by the SAME owner axis as open/count: a different
        // principal, an owner-less session, a blank owner, and an absent id all read back None
        // (no existence/state oracle — a non-owner cannot read another's link-state).
        let db = Db::open_hub(&tmp("c2-8-owner")).unwrap();
        ensure_session_with_owner(
            db.conn(),
            "s1",
            &SessionOwner {
                user_id: Some("alice".into()),
                ..Default::default()
            },
            10_000,
        )
        .unwrap();
        // The owner reads her own link-state.
        assert_eq!(
            link_state_for_owner(db.conn(), "alice", "s1", 10_000).unwrap(),
            Some(LinkState::Fresh)
        );
        // A DIFFERENT principal guessing the id reads NOTHING (fail-closed — the load-bearing one).
        assert_eq!(
            link_state_for_owner(db.conn(), "bob", "s1", 10_000).unwrap(),
            None
        );
        // A blank owner and an absent id are also fail-closed.
        assert_eq!(
            link_state_for_owner(db.conn(), "", "s1", 10_000).unwrap(),
            None
        );
        assert_eq!(
            link_state_for_owner(db.conn(), "alice", "ghost", 10_000).unwrap(),
            None
        );
        // An owner-less session (NULL user_id) is not readable by anyone.
        ensure_session(db.conn(), "orphan", 10_000).unwrap();
        assert_eq!(
            link_state_for_owner(db.conn(), "alice", "orphan", 10_000).unwrap(),
            None
        );
    }
}
