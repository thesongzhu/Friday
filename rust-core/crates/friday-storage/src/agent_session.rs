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
}
