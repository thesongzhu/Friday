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
use rusqlite::{params, Connection};

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

/// Ensure an `agent_session` row exists (idempotent). A new session is created at
/// `now_ms`; an existing session has its `updated_at` bumped. Safe to call at the
/// start of every run in the session.
pub fn ensure_session(conn: &Connection, agent_session_id: &str, now_ms: i64) -> Result<()> {
    if agent_session_id.trim().is_empty() {
        return Err(StorageError::Unsupported(
            "agent_session_id must be non-empty".into(),
        ));
    }
    // INSERT-or-bump in one statement: a fresh id INSERTs, an existing id keeps its
    // created_at and only advances updated_at (no row is ever clobbered).
    conn.execute(
        "INSERT INTO agent_session (agent_session_id, created_at, updated_at)
         VALUES (?1, ?2, ?2)
         ON CONFLICT(agent_session_id) DO UPDATE SET updated_at = ?2",
        params![agent_session_id, now_ms],
    )?;
    Ok(())
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
}
