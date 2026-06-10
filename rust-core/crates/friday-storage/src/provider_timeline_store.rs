//! Durable Hub-side PROVIDER-SESSION TIMELINE store (SMOOTH-001, file 83). Hub-only.
//!
//! The Friday-canonical provider-session timeline (`friday_hub::ProviderTimeline`) is a
//! pure, in-memory state machine: it assigns a strictly-monotonic per-session `seq` to
//! every event, bumps a `revision` on EVERY mutation, tracks `PendingAction`s keyed by
//! `request_id`, and answers a reconnect with a delta/snapshot. Because it is memory-only,
//! that whole timeline is LOST across a Hub restart. This module adds the missing durable
//! substrate: a persist + load layer BESIDE the pure state machine (the pure logic is NOT
//! moved here) so the canonical timeline can be rehydrated.
//!
//! ## Three tables, one boundary (refs-only — UNCHANGED discipline)
//! * `provider_timeline` — the parent row holding the timeline-level SCALARS that are NOT
//!   recoverable from the events alone: `next_seq` (monotonic counter, never reset even
//!   after pruning), `retained_from_seq` (the prune watermark), and `revision` (bumped on
//!   EVERY mutation — including a pending submit or a status-only advance — so the live
//!   revision can be HIGHER than the last event's revision; it MUST be persisted, never
//!   derived).
//! * `provider_timeline_event` — the append-only, IMMUTABLE event log keyed by
//!   `(session_id, seq)`. An event's content never changes, so [`persist_event`] is
//!   idempotent-identical / fail-closed-on-conflict (mirrors [`crate::run_result`]).
//! * `provider_timeline_pending` — the MUTABLE Friday-originated action store keyed by
//!   `(session_id, request_id)`. The action ADVANCES through the `PendingState` machine
//!   across restarts (the whole point of surviving mid-flight), so [`upsert_pending`]
//!   UPSERTs (NOT immutable like the event log).
//!
//! MONOTONICITY (#596 follow-up): the timeline only ever ADVANCES, and the store enforces
//! that fail-closed — [`persist_timeline`] refuses a scalar rewind (stale snapshot) and
//! clamps `updated_at` so the persisted timestamp never regresses; [`persist_event`]
//! refuses a fresh append below the persisted high-water `seq` (gap backfill).
//!
//! REFS-ONLY: no raw transcript text / message body / PII is stored. `body_ref` /
//! `provider_event_id` / `dispatch_ref` are refs/ids; `event_kind` / `actor` / `action` /
//! `state` are coarse labels; `blocker` is a coarse reason (same shape as the existing
//! `work_item.blocking_reason`). The only transcript-bearing field is `body_ref`, which is
//! a REF by the source module's invariant.
//!
//! ## Boundary note (no friday-hub import)
//! friday-hub depends on friday-storage, so this crate cannot import the
//! `ProviderTimeline` / `TimelineEvent` / `PendingState` types back (a dependency cycle).
//! The row structs here are storage-local; mapping them to/from the in-memory state
//! machine (and the `u64 <-> i64` conversion) lives at the DEFERRED wire boundary in
//! friday-hub. All seq/revision columns are `i64` (SQLite-native).
//!
//! Truth label: durable provider-timeline persistence substrate + API + tests only. The
//! serve-loop EMIT (persisting from the live timeline), the ChannelInboundReceipt wire
//! form, and reconnect-detection are DEFERRED soft-design-gates owned by the operator.
//! PROOF-ONLY; NOT a v1 GO.

use crate::error::{Result, StorageError};
use rusqlite::{params, Connection, OptionalExtension};

/// The timeline-level scalar state (the parent `provider_timeline` row). These are the
/// fields that cannot be reconstructed from the event rows alone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelineState {
    /// The next seq to assign — monotonic, never reset (survives pruning). `>= 1`.
    pub next_seq: i64,
    /// The lowest seq still retained (the prune watermark). `>= 1`.
    pub retained_from_seq: i64,
    /// The timeline revision — bumped on EVERY mutation, so it can exceed the last
    /// event's revision. `>= 0`.
    pub revision: i64,
}

impl TimelineState {
    pub fn new(next_seq: i64, retained_from_seq: i64, revision: i64) -> Self {
        TimelineState {
            next_seq,
            retained_from_seq,
            revision,
        }
    }
}

/// One immutable timeline event as supplied to [`persist_event`]. `seq` + `revision`
/// are assigned by the in-memory state machine (the caller passes them through); they
/// are NOT re-derived here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelineEventRow {
    /// Per-session, strictly monotonic from 1. `>= 1`.
    pub seq: i64,
    /// The revision at which this event was appended. `>= 1`.
    pub revision: i64,
    /// A coarse event-kind LABEL (e.g. `assistant_message` / `system`). Not a body.
    pub event_kind: String,
    /// A coarse actor LABEL (e.g. `provider` / `hub`). Not a body.
    pub actor: String,
    /// A REF to the body — NEVER the raw transcript text.
    pub body_ref: Option<String>,
    /// The provider's event id (a ref/id, not a body).
    pub provider_event_id: Option<String>,
}

/// A stored timeline event read back by [`load_timeline_by_session`], including its
/// `created_at`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredTimelineEvent {
    pub session_id: String,
    pub seq: i64,
    pub revision: i64,
    pub event_kind: String,
    pub actor: String,
    pub body_ref: Option<String>,
    pub provider_event_id: Option<String>,
    pub created_at: i64,
}

/// One MUTABLE Friday-originated pending action as supplied to [`upsert_pending`]. It
/// advances through the `PendingState` machine across restarts, so a re-persist UPDATEs
/// the row (it is not immutable like an event).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingActionRow {
    pub request_id: String,
    pub client_msg_id: String,
    /// A coarse action LABEL (e.g. `send_turn`). Not a body.
    pub action: String,
    /// The snake_case `PendingState` label (e.g. `accepted_by_hub`). The schema CHECK
    /// rejects any value outside the 11 known states.
    pub state: String,
    /// A REF to the dispatch (e.g. `friday://d/1`), not a body.
    pub dispatch_ref: Option<String>,
    /// A coarse blocker reason (same shape as `work_item.blocking_reason`), not a body.
    pub blocker: Option<String>,
    pub base_revision: i64,
    pub updated_at_revision: i64,
}

/// A stored pending action read back by [`load_timeline_by_session`], including its
/// `created_at`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredPendingAction {
    pub session_id: String,
    pub request_id: String,
    pub client_msg_id: String,
    pub action: String,
    pub state: String,
    pub dispatch_ref: Option<String>,
    pub blocker: Option<String>,
    pub base_revision: i64,
    pub updated_at_revision: i64,
    pub created_at: i64,
}

/// A full rehydration projection of one session's persisted timeline: the parent scalar
/// state + the event log (in `seq` order) + the pending actions (in `request_id` order).
/// Returned by [`load_timeline_by_session`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredTimeline {
    pub session_id: String,
    pub state: TimelineState,
    pub created_at: i64,
    pub updated_at: i64,
    pub events: Vec<StoredTimelineEvent>,
    pub pending: Vec<StoredPendingAction>,
}

/// Outcome of [`persist_event`]: a fresh event was appended, or an identical event
/// (same `(session_id, seq)`, same content) was already present and the re-persist was a
/// benign idempotent no-op.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PersistEventOutcome {
    Persisted,
    DuplicateIdentical,
}

fn require_non_empty(field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(StorageError::Unsupported(format!(
            "{field} must be non-empty"
        )));
    }
    Ok(())
}

/// Persist (UPSERT) a session's timeline-level scalar state. Idempotent on `session_id`:
/// a fresh id INSERTs (keeping `created_at`); an existing id UPDATEs the scalars and
/// `updated_at`. The scalars ADVANCE over the life of a session (seq grows, revision
/// grows, the prune watermark rises), so unlike an immutable run-result this is an UPSERT.
///
/// `next_seq`/`retained_from_seq`/`revision` are persisted EXPLICITLY (never re-derived
/// from the event rows) — `revision` in particular bumps on pending submits / status-only
/// advances, so it can exceed the last event's revision.
///
/// ## Monotonicity guard (#596 follow-up, fail-closed)
/// The in-memory state machine only ever ADVANCES these scalars, so a re-persist that
/// would REWIND any of them can only come from a stale snapshot (e.g. an old in-memory
/// copy persisted after a restart-rehydrate-advance) or a buggy writer. The bare UPSERT
/// would silently rewind `next_seq` and set up future seq collisions, so:
/// * a `next_seq` / `retained_from_seq` / `revision` LOWER than the persisted value is
///   REJECTED (fail-closed `Err`; equal is allowed — an identical re-persist is a benign
///   idempotent replay);
/// * `updated_at` is CLAMPED to never regress (`MAX(stored, now_ms)`): an older `now_ms`
///   is wall-clock skew, not writer staleness (the scalars are the logical clock), so the
///   write itself is NOT refused — but the persisted timestamp surface stays monotone.
///
/// The guard + upsert run in ONE transaction, so the monotonicity decision is race-free.
pub fn persist_timeline(
    conn: &Connection,
    session_id: &str,
    state: &TimelineState,
    now_ms: i64,
) -> Result<()> {
    require_non_empty("session_id", session_id)?;
    if state.next_seq < 1 || state.retained_from_seq < 1 || state.revision < 0 {
        return Err(StorageError::Unsupported(
            "timeline scalars out of range (next_seq>=1, retained_from_seq>=1, revision>=0)".into(),
        ));
    }
    let tx = conn.unchecked_transaction()?;
    let existing: Option<TimelineState> = tx
        .query_row(
            "SELECT next_seq, retained_from_seq, revision
             FROM provider_timeline WHERE session_id = ?1",
            [session_id],
            |r| {
                Ok(TimelineState {
                    next_seq: r.get(0)?,
                    retained_from_seq: r.get(1)?,
                    revision: r.get(2)?,
                })
            },
        )
        .optional()?;
    if let Some(prev) = existing {
        if state.next_seq < prev.next_seq
            || state.retained_from_seq < prev.retained_from_seq
            || state.revision < prev.revision
        {
            return Err(StorageError::Unsupported(format!(
                "provider_timeline ({session_id}) scalar regression refused: persisted \
                 (next_seq {}, retained_from_seq {}, revision {}) vs incoming \
                 (next_seq {}, retained_from_seq {}, revision {}); the timeline scalars \
                 only ever advance — a lower value is a stale snapshot (fail-closed)",
                prev.next_seq,
                prev.retained_from_seq,
                prev.revision,
                state.next_seq,
                state.retained_from_seq,
                state.revision,
            )));
        }
    }
    tx.execute(
        "INSERT INTO provider_timeline
            (session_id, next_seq, retained_from_seq, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(session_id) DO UPDATE SET
            next_seq          = excluded.next_seq,
            retained_from_seq = excluded.retained_from_seq,
            revision          = excluded.revision,
            updated_at        = MAX(provider_timeline.updated_at, excluded.updated_at)",
        params![
            session_id,
            state.next_seq,
            state.retained_from_seq,
            state.revision,
            now_ms,
        ],
    )?;
    tx.commit()?;
    Ok(())
}

/// Whether a parent `provider_timeline` row exists.
pub fn timeline_exists(conn: &Connection, session_id: &str) -> Result<bool> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM provider_timeline WHERE session_id = ?1)",
        [session_id],
        |r| r.get(0),
    )?;
    Ok(exists)
}

/// Append ONE immutable event to a session's timeline. The parent `provider_timeline`
/// row must already exist (call [`persist_timeline`] first) — the FK rejects an orphan.
///
/// An event's content is IMMUTABLE (its `seq` never changes meaning), so this is
/// idempotent / fail-closed on `(session_id, seq)`, mirroring [`crate::run_result`]:
/// * no existing row at that seq → INSERT, returns [`PersistEventOutcome::Persisted`];
/// * an existing row with IDENTICAL content → no write, returns
///   [`PersistEventOutcome::DuplicateIdentical`] (benign replay);
/// * an existing row with DIFFERENT content → fail-closed `Err` (an event's content is
///   never silently overwritten).
///
/// ## Monotonicity guard (#596 follow-up, fail-closed)
/// A FRESH append must not land BELOW the session's persisted high-water `seq`: the
/// in-memory machine assigns strictly-monotonic seqs, so a new row under the high-water
/// mark is a late "backfill" into a gap — indistinguishable post-hoc from a stale or
/// forged writer (the genuine event's content at that seq is unknowable once it was
/// missed), so it is REFUSED. Replaying an ALREADY-persisted seq stays a benign
/// idempotent no-op (handled above, content-checked); appending ABOVE the high-water
/// mark is unrestricted (contiguity is the in-memory machine's invariant — after a
/// prune the first persisted seq legitimately starts above 1).
///
/// The check-then-insert runs in ONE transaction, so the idempotency decision is race-free.
pub fn persist_event(
    conn: &Connection,
    session_id: &str,
    event: &TimelineEventRow,
    now_ms: i64,
) -> Result<PersistEventOutcome> {
    require_non_empty("session_id", session_id)?;
    require_non_empty("event_kind", &event.event_kind)?;
    require_non_empty("actor", &event.actor)?;
    if event.seq < 1 || event.revision < 1 {
        return Err(StorageError::Unsupported(
            "event seq must be >= 1 and revision >= 1".into(),
        ));
    }

    let tx = conn.unchecked_transaction()?;
    // Read any existing row at this seq back into a `TimelineEventRow` so the
    // immutability check is a single struct equality (no complex tuple type).
    let existing: Option<TimelineEventRow> = tx
        .query_row(
            "SELECT seq, revision, event_kind, actor, body_ref, provider_event_id
             FROM provider_timeline_event WHERE session_id = ?1 AND seq = ?2",
            params![session_id, event.seq],
            |r| {
                Ok(TimelineEventRow {
                    seq: r.get(0)?,
                    revision: r.get(1)?,
                    event_kind: r.get(2)?,
                    actor: r.get(3)?,
                    body_ref: r.get(4)?,
                    provider_event_id: r.get(5)?,
                })
            },
        )
        .optional()?;
    let outcome = match existing {
        Some(prev) => {
            if &prev == event {
                PersistEventOutcome::DuplicateIdentical
            } else {
                return Err(StorageError::Unsupported(format!(
                    "provider_timeline_event ({session_id}, seq {}) already persisted with \
                     different content; refusing to overwrite (an event is immutable)",
                    event.seq
                )));
            }
        }
        None => {
            // Monotonicity guard: a FRESH append below the persisted high-water seq is a
            // gap backfill / stale writer — refused (see the fn doc). `MAX(seq)` on an
            // empty log is NULL → no constraint on the first persisted seq.
            let high_water: Option<i64> = tx.query_row(
                "SELECT MAX(seq) FROM provider_timeline_event WHERE session_id = ?1",
                [session_id],
                |r| r.get(0),
            )?;
            if let Some(hw) = high_water {
                if event.seq < hw {
                    return Err(StorageError::Unsupported(format!(
                        "provider_timeline_event ({session_id}) seq regression refused: \
                         fresh append at seq {} is below the persisted high-water seq {hw}; \
                         the timeline seq only ever advances — a below-watermark insert is \
                         a gap backfill from a stale writer (fail-closed)",
                        event.seq
                    )));
                }
            }
            tx.execute(
                "INSERT INTO provider_timeline_event
                    (session_id, seq, revision, event_kind, actor, body_ref,
                     provider_event_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    session_id,
                    event.seq,
                    event.revision,
                    event.event_kind,
                    event.actor,
                    event.body_ref,
                    event.provider_event_id,
                    now_ms,
                ],
            )?;
            PersistEventOutcome::Persisted
        }
    };
    tx.commit()?;
    Ok(outcome)
}

/// Persist (UPSERT) a Friday-originated pending action. The action ADVANCES through the
/// `PendingState` machine across restarts, so this is an UPSERT keyed by
/// `(session_id, request_id)` (NOT immutable): a fresh action INSERTs (keeping
/// `created_at`); an existing action UPDATEs its mutable fields (state / dispatch_ref /
/// blocker / revisions). The parent `provider_timeline` row must already exist (the FK
/// rejects an orphan).
pub fn upsert_pending(
    conn: &Connection,
    session_id: &str,
    pending: &PendingActionRow,
    now_ms: i64,
) -> Result<()> {
    require_non_empty("session_id", session_id)?;
    require_non_empty("request_id", &pending.request_id)?;
    require_non_empty("client_msg_id", &pending.client_msg_id)?;
    require_non_empty("action", &pending.action)?;
    require_non_empty("state", &pending.state)?;
    if pending.base_revision < 0 || pending.updated_at_revision < 0 {
        return Err(StorageError::Unsupported(
            "pending base_revision / updated_at_revision must be >= 0".into(),
        ));
    }
    conn.execute(
        "INSERT INTO provider_timeline_pending
            (session_id, request_id, client_msg_id, action, state, dispatch_ref, blocker,
             base_revision, updated_at_revision, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(session_id, request_id) DO UPDATE SET
            client_msg_id       = excluded.client_msg_id,
            action              = excluded.action,
            state               = excluded.state,
            dispatch_ref        = excluded.dispatch_ref,
            blocker             = excluded.blocker,
            base_revision       = excluded.base_revision,
            updated_at_revision = excluded.updated_at_revision",
        params![
            session_id,
            pending.request_id,
            pending.client_msg_id,
            pending.action,
            pending.state,
            pending.dispatch_ref,
            pending.blocker,
            pending.base_revision,
            pending.updated_at_revision,
            now_ms,
        ],
    )?;
    Ok(())
}

/// Load the parent timeline scalar state. `None` if no row exists for `session_id`.
pub fn load_timeline_state(conn: &Connection, session_id: &str) -> Result<Option<TimelineState>> {
    let row = conn
        .query_row(
            "SELECT next_seq, retained_from_seq, revision
             FROM provider_timeline WHERE session_id = ?1",
            [session_id],
            |r| {
                Ok(TimelineState {
                    next_seq: r.get(0)?,
                    retained_from_seq: r.get(1)?,
                    revision: r.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// Load a session's event log in `seq` order (oldest first). An unknown session returns
/// an empty Vec (not an error).
pub fn load_events(conn: &Connection, session_id: &str) -> Result<Vec<StoredTimelineEvent>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, seq, revision, event_kind, actor, body_ref, provider_event_id,
                created_at
         FROM provider_timeline_event
         WHERE session_id = ?1
         ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map([session_id], |r| {
        Ok(StoredTimelineEvent {
            session_id: r.get(0)?,
            seq: r.get(1)?,
            revision: r.get(2)?,
            event_kind: r.get(3)?,
            actor: r.get(4)?,
            body_ref: r.get(5)?,
            provider_event_id: r.get(6)?,
            created_at: r.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Load a session's pending actions in `request_id` order. An unknown session returns an
/// empty Vec (not an error).
pub fn load_pending(conn: &Connection, session_id: &str) -> Result<Vec<StoredPendingAction>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, request_id, client_msg_id, action, state, dispatch_ref, blocker,
                base_revision, updated_at_revision, created_at
         FROM provider_timeline_pending
         WHERE session_id = ?1
         ORDER BY request_id ASC",
    )?;
    let rows = stmt.query_map([session_id], |r| {
        Ok(StoredPendingAction {
            session_id: r.get(0)?,
            request_id: r.get(1)?,
            client_msg_id: r.get(2)?,
            action: r.get(3)?,
            state: r.get(4)?,
            dispatch_ref: r.get(5)?,
            blocker: r.get(6)?,
            base_revision: r.get(7)?,
            updated_at_revision: r.get(8)?,
            created_at: r.get(9)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Load a session's FULL persisted timeline (parent scalars + ordered events + pending
/// actions) — the rehydration projection. `None` if no parent `provider_timeline` row
/// exists for `session_id`.
pub fn load_timeline_by_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<StoredTimeline>> {
    let parent = conn
        .query_row(
            "SELECT next_seq, retained_from_seq, revision, created_at, updated_at
             FROM provider_timeline WHERE session_id = ?1",
            [session_id],
            |r| {
                Ok((
                    TimelineState {
                        next_seq: r.get(0)?,
                        retained_from_seq: r.get(1)?,
                        revision: r.get(2)?,
                    },
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    let (state, created_at, updated_at) = match parent {
        Some(p) => p,
        None => return Ok(None),
    };
    let events = load_events(conn, session_id)?;
    let pending = load_pending(conn, session_id)?;
    Ok(Some(StoredTimeline {
        session_id: session_id.to_string(),
        state,
        created_at,
        updated_at,
        events,
        pending,
    }))
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
                "friday-provider-timeline-{}-{}-{}-{nanos}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed),
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn ev(seq: i64, revision: i64, body_ref: Option<&str>) -> TimelineEventRow {
        TimelineEventRow {
            seq,
            revision,
            event_kind: "assistant_message".into(),
            actor: "provider".into(),
            body_ref: body_ref.map(|s| s.to_string()),
            provider_event_id: None,
        }
    }

    fn pend(request_id: &str, state: &str, base_rev: i64, upd_rev: i64) -> PendingActionRow {
        PendingActionRow {
            request_id: request_id.into(),
            client_msg_id: format!("c-{request_id}"),
            action: "send_turn".into(),
            state: state.into(),
            dispatch_ref: None,
            blocker: None,
            base_revision: base_rev,
            updated_at_revision: upd_rev,
        }
    }

    #[test]
    fn persist_then_load_round_trips_events_in_seq_order() {
        let db = Db::open_hub(&tmp("roundtrip")).unwrap();
        // 5 events appended (seq 1..=5), revision == seq at this point.
        persist_timeline(db.conn(), "s1", &TimelineState::new(6, 1, 5), 1000).unwrap();
        for i in 1..=5 {
            assert_eq!(
                persist_event(
                    db.conn(),
                    "s1",
                    &ev(i, i, Some(&format!("body://{i}"))),
                    1000 + i
                )
                .unwrap(),
                PersistEventOutcome::Persisted
            );
        }
        let loaded = load_timeline_by_session(db.conn(), "s1").unwrap().unwrap();
        assert_eq!(loaded.session_id, "s1");
        assert_eq!(loaded.state.next_seq, 6);
        assert_eq!(loaded.state.retained_from_seq, 1);
        assert_eq!(loaded.events.len(), 5);
        // Loaded strictly in seq order, with refs preserved.
        let seqs: Vec<i64> = loaded.events.iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
        assert_eq!(loaded.events[0].body_ref.as_deref(), Some("body://1"));
        assert_eq!(loaded.events[0].event_kind, "assistant_message");
        assert_eq!(loaded.events[0].actor, "provider");
    }

    #[test]
    fn revision_survives_when_higher_than_the_last_events_revision() {
        // The load-bearing test: a pending submit / status-only advance bumps `revision`
        // PAST the last event's revision. A "derive revision from max(event.revision)"
        // implementation would lose this. We persist the scalar explicitly and assert it
        // survives a load.
        let db = Db::open_hub(&tmp("revision")).unwrap();
        // 3 events were appended (seq 1..=3, revision 1..=3). THEN a pending was submitted
        // (revision -> 4) and advanced twice (revision -> 5, -> 6). So the live revision is
        // 6, higher than the last event's revision (3). next_seq is still 4 (no new event).
        persist_timeline(db.conn(), "s1", &TimelineState::new(4, 1, 6), 100).unwrap();
        for i in 1..=3 {
            persist_event(db.conn(), "s1", &ev(i, i, None), 100 + i).unwrap();
        }
        // The pending action sits at revision 6 (updated_at_revision), base 4.
        upsert_pending(db.conn(), "s1", &pend("r1", "accepted_by_hub", 4, 6), 200).unwrap();

        let loaded = load_timeline_by_session(db.conn(), "s1").unwrap().unwrap();
        // The persisted revision (6) is HIGHER than the max event revision (3) — and it
        // survived the load. This is what would silently break under a derived revision.
        let max_event_rev = loaded.events.iter().map(|e| e.revision).max().unwrap();
        assert_eq!(max_event_rev, 3);
        assert_eq!(
            loaded.state.revision, 6,
            "the persisted revision must survive, even though it exceeds the last event's"
        );
        assert_eq!(loaded.state.next_seq, 4);
        assert_eq!(loaded.pending.len(), 1);
        assert_eq!(loaded.pending[0].state, "accepted_by_hub");
        assert_eq!(loaded.pending[0].updated_at_revision, 6);
        assert_eq!(loaded.pending[0].base_revision, 4);
    }

    #[test]
    fn retained_from_seq_watermark_survives_a_prune() {
        // `retained_from_seq` is a prune watermark NOT recoverable from the retained rows
        // (the lowest retained seq could be >= the watermark for other reasons). Persist it
        // explicitly and assert it round-trips above 1.
        let db = Db::open_hub(&tmp("prune")).unwrap();
        // After prune_before(3): retained_from_seq = 3, next_seq still 6, revision 5.
        persist_timeline(db.conn(), "s1", &TimelineState::new(6, 3, 5), 10).unwrap();
        for i in 3..=5 {
            persist_event(db.conn(), "s1", &ev(i, i, None), 10 + i).unwrap();
        }
        let st = load_timeline_state(db.conn(), "s1").unwrap().unwrap();
        assert_eq!(st.retained_from_seq, 3);
        assert_eq!(st.next_seq, 6);
        assert_eq!(st.revision, 5);
    }

    #[test]
    fn re_persist_timeline_is_an_idempotent_upsert_advancing_scalars() {
        let db = Db::open_hub(&tmp("upsert-parent")).unwrap();
        persist_timeline(db.conn(), "s1", &TimelineState::new(2, 1, 1), 100).unwrap();
        // Re-persist with ADVANCED scalars (the session grew) — UPSERT, not a dup row.
        persist_timeline(db.conn(), "s1", &TimelineState::new(5, 1, 7), 200).unwrap();
        assert_eq!(
            db.count("provider_timeline").unwrap(),
            1,
            "no duplicate parent"
        );
        let st = load_timeline_state(db.conn(), "s1").unwrap().unwrap();
        assert_eq!(st.next_seq, 5);
        assert_eq!(st.revision, 7);
        // created_at is preserved; updated_at advanced.
        let (created, updated): (i64, i64) = db
            .conn()
            .query_row(
                "SELECT created_at, updated_at FROM provider_timeline WHERE session_id='s1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(created, 100, "created_at is immutable across upsert");
        assert_eq!(updated, 200, "updated_at advances");
    }

    #[test]
    fn re_persist_identical_event_is_idempotent_noop() {
        let db = Db::open_hub(&tmp("event-idem")).unwrap();
        persist_timeline(db.conn(), "s1", &TimelineState::new(2, 1, 1), 10).unwrap();
        assert_eq!(
            persist_event(db.conn(), "s1", &ev(1, 1, Some("body://1")), 10).unwrap(),
            PersistEventOutcome::Persisted
        );
        // A second persist of the IDENTICAL event (same seq + content) is a benign no-op.
        assert_eq!(
            persist_event(db.conn(), "s1", &ev(1, 1, Some("body://1")), 99).unwrap(),
            PersistEventOutcome::DuplicateIdentical
        );
        assert_eq!(
            db.count("provider_timeline_event").unwrap(),
            1,
            "no dup event"
        );
    }

    #[test]
    fn re_persist_event_with_different_content_fails_closed() {
        let db = Db::open_hub(&tmp("event-conflict")).unwrap();
        persist_timeline(db.conn(), "s1", &TimelineState::new(2, 1, 1), 10).unwrap();
        persist_event(db.conn(), "s1", &ev(1, 1, Some("body://original")), 10).unwrap();
        // A different body_ref at the SAME seq is refused (events are immutable).
        let conflict = ev(1, 1, Some("body://TAMPERED"));
        assert!(
            persist_event(db.conn(), "s1", &conflict, 20).is_err(),
            "a conflicting event re-persist must fail closed"
        );
        // The original is untouched.
        let events = load_events(db.conn(), "s1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].body_ref.as_deref(), Some("body://original"));
    }

    #[test]
    fn pending_is_mutable_upsert_advancing_state_across_restart() {
        // Unlike an event, a pending action ADVANCES across restarts. Re-persisting the
        // SAME request_id with an advanced state UPDATEs the row in place (no dup).
        let db = Db::open_hub(&tmp("pending-upsert")).unwrap();
        persist_timeline(db.conn(), "s1", &TimelineState::new(1, 1, 3), 10).unwrap();
        upsert_pending(db.conn(), "s1", &pend("r1", "pending_local", 1, 1), 10).unwrap();
        upsert_pending(db.conn(), "s1", &pend("r1", "sent_to_hub", 1, 2), 20).unwrap();
        upsert_pending(db.conn(), "s1", &pend("r1", "accepted_by_hub", 1, 3), 30).unwrap();
        assert_eq!(
            db.count("provider_timeline_pending").unwrap(),
            1,
            "an advancing action UPSERTs, never duplicates"
        );
        let pending = load_pending(db.conn(), "s1").unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].state, "accepted_by_hub");
        assert_eq!(pending[0].updated_at_revision, 3);
    }

    #[test]
    fn pending_with_bogus_state_is_rejected_by_the_schema_check() {
        let db = Db::open_hub(&tmp("bad-state")).unwrap();
        persist_timeline(db.conn(), "s1", &TimelineState::new(1, 1, 1), 10).unwrap();
        let bad = pend("r1", "definitely_done", 1, 1); // not a real PendingState
        assert!(
            upsert_pending(db.conn(), "s1", &bad, 10).is_err(),
            "a state outside the 11 known PendingState labels must be rejected"
        );
    }

    #[test]
    fn orphan_event_or_pending_without_parent_fails_closed() {
        // The FK rejects an event/pending whose parent timeline row does not exist.
        let db = Db::open_hub(&tmp("orphan")).unwrap();
        assert!(
            persist_event(db.conn(), "ghost", &ev(1, 1, None), 10).is_err(),
            "an event for a non-existent timeline must be rejected by the FK"
        );
        assert!(
            upsert_pending(db.conn(), "ghost", &pend("r1", "pending_local", 1, 1), 10).is_err(),
            "a pending for a non-existent timeline must be rejected by the FK"
        );
    }

    #[test]
    fn load_unknown_session_is_none_or_empty_not_error() {
        let db = Db::open_hub(&tmp("missing")).unwrap();
        assert!(load_timeline_by_session(db.conn(), "nope")
            .unwrap()
            .is_none());
        assert!(load_timeline_state(db.conn(), "nope").unwrap().is_none());
        assert!(load_events(db.conn(), "nope").unwrap().is_empty());
        assert!(load_pending(db.conn(), "nope").unwrap().is_empty());
        assert!(!timeline_exists(db.conn(), "nope").unwrap());
    }

    #[test]
    fn persist_timeline_rejects_scalar_regression_fail_closed() {
        // The scalars only ever ADVANCE in the in-memory machine; a lower value can only
        // be a stale snapshot (e.g. an old in-memory copy persisted after a
        // restart-rehydrate-advance). The bare UPSERT would silently rewind next_seq and
        // set up future seq collisions — the guard refuses it, per axis.
        let db = Db::open_hub(&tmp("monotonic-scalars")).unwrap();
        persist_timeline(db.conn(), "s1", &TimelineState::new(5, 3, 7), 100).unwrap();

        for (label, regressed) in [
            ("next_seq", TimelineState::new(4, 3, 7)),
            ("retained_from_seq", TimelineState::new(5, 2, 7)),
            ("revision", TimelineState::new(5, 3, 6)),
        ] {
            assert!(
                persist_timeline(db.conn(), "s1", &regressed, 200).is_err(),
                "a {label} regression must fail closed"
            );
        }
        // The persisted row is untouched by the refused writes (incl. updated_at).
        let st = load_timeline_state(db.conn(), "s1").unwrap().unwrap();
        assert_eq!(st, TimelineState::new(5, 3, 7));
        let updated: i64 = db
            .conn()
            .query_row(
                "SELECT updated_at FROM provider_timeline WHERE session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(updated, 100, "a refused write must not touch updated_at");

        // Equal scalars are a benign idempotent replay — allowed.
        persist_timeline(db.conn(), "s1", &TimelineState::new(5, 3, 7), 300).unwrap();
        // And a genuine advance is allowed.
        persist_timeline(db.conn(), "s1", &TimelineState::new(6, 3, 9), 400).unwrap();
        let st = load_timeline_state(db.conn(), "s1").unwrap().unwrap();
        assert_eq!(st, TimelineState::new(6, 3, 9));
    }

    #[test]
    fn persist_timeline_updated_at_never_regresses_on_upsert() {
        // Wall-clock skew is NOT writer staleness (the scalars are the logical clock), so
        // an advancing write with an OLDER now_ms is accepted — but the persisted
        // updated_at is clamped: the timestamp surface never moves backwards.
        let db = Db::open_hub(&tmp("monotonic-ts")).unwrap();
        persist_timeline(db.conn(), "s1", &TimelineState::new(5, 1, 5), 200).unwrap();
        // Logical progress at a skewed (older) clock: accepted, timestamp clamped.
        persist_timeline(db.conn(), "s1", &TimelineState::new(6, 1, 6), 100).unwrap();
        let (st, updated): (TimelineState, i64) = (
            load_timeline_state(db.conn(), "s1").unwrap().unwrap(),
            db.conn()
                .query_row(
                    "SELECT updated_at FROM provider_timeline WHERE session_id='s1'",
                    [],
                    |r| r.get(0),
                )
                .unwrap(),
        );
        assert_eq!(st, TimelineState::new(6, 1, 6), "the advance is accepted");
        assert_eq!(updated, 200, "updated_at must not regress (clamped to MAX)");
        // A later clock advances it again.
        persist_timeline(db.conn(), "s1", &TimelineState::new(6, 1, 6), 300).unwrap();
        let updated: i64 = db
            .conn()
            .query_row(
                "SELECT updated_at FROM provider_timeline WHERE session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(updated, 300);
    }

    #[test]
    fn persist_event_rejects_fresh_append_below_the_high_water_seq() {
        // A FRESH insert below the persisted high-water seq is a gap backfill — the
        // genuine event's content at that seq is unknowable post-hoc, so it is refused.
        // Idempotent replay of an EXISTING seq stays a benign no-op.
        let db = Db::open_hub(&tmp("monotonic-seq")).unwrap();
        persist_timeline(db.conn(), "s1", &TimelineState::new(6, 1, 5), 10).unwrap();
        persist_event(db.conn(), "s1", &ev(1, 1, None), 11).unwrap();
        persist_event(db.conn(), "s1", &ev(2, 2, None), 12).unwrap();
        // Appending ABOVE the high-water mark is unrestricted (post-prune logs
        // legitimately start above 1; contiguity is the in-memory machine's invariant).
        persist_event(db.conn(), "s1", &ev(5, 5, None), 15).unwrap();

        // Backfilling the 3/4 gap under the high-water mark (5) is refused.
        assert!(
            persist_event(db.conn(), "s1", &ev(3, 3, None), 20).is_err(),
            "a fresh append below the high-water seq must fail closed"
        );
        assert!(
            persist_event(db.conn(), "s1", &ev(4, 4, None), 20).is_err(),
            "a fresh append below the high-water seq must fail closed"
        );
        // The refused writes left no rows behind.
        let seqs: Vec<i64> = load_events(db.conn(), "s1")
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect();
        assert_eq!(seqs, vec![1, 2, 5]);

        // Replay of an existing seq is still the idempotent no-op (NOT a regression).
        assert_eq!(
            persist_event(db.conn(), "s1", &ev(2, 2, None), 99).unwrap(),
            PersistEventOutcome::DuplicateIdentical
        );
        // And the next genuine append (above the mark) still lands.
        assert_eq!(
            persist_event(db.conn(), "s1", &ev(6, 6, None), 30).unwrap(),
            PersistEventOutcome::Persisted
        );
    }

    #[test]
    fn persisted_timeline_surface_is_an_exact_refs_only_column_allowlist() {
        // ALLOWLIST (#596 follow-up): the refs-only review covered EXACTLY these columns.
        // The original denylist check (`no column named body/content/transcript`) cannot
        // catch a future migration adding a transcript-bearing column under any OTHER
        // name — this exact-match allowlist fails the build for ANY new column on the
        // persisted timeline surface, forcing it through an explicit refs-only review.
        let db = Db::open_hub(&tmp("allowlist")).unwrap();
        let cols = |table: &str| -> Vec<String> {
            let mut stmt = db
                .conn()
                .prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")
                .unwrap();
            let rows = stmt.query_map([table], |r| r.get::<_, String>(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(
            cols("provider_timeline"),
            vec![
                "session_id",
                "next_seq",
                "retained_from_seq",
                "revision",
                "created_at",
                "updated_at",
            ],
            "provider_timeline columns drifted from the reviewed refs-only allowlist"
        );
        assert_eq!(
            cols("provider_timeline_event"),
            vec![
                "session_id",
                "seq",
                "revision",
                "event_kind",
                "actor",
                "body_ref",
                "provider_event_id",
                "created_at",
            ],
            "provider_timeline_event columns drifted from the reviewed refs-only allowlist"
        );
        assert_eq!(
            cols("provider_timeline_pending"),
            vec![
                "session_id",
                "request_id",
                "client_msg_id",
                "action",
                "state",
                "dispatch_ref",
                "blocker",
                "base_revision",
                "updated_at_revision",
                "created_at",
            ],
            "provider_timeline_pending columns drifted from the reviewed refs-only allowlist"
        );
    }

    #[test]
    fn rows_are_refs_only_no_raw_body_column() {
        // The only body-bearing field is `body_ref`, which is a REF (never raw transcript).
        // There is no schema column that could hold raw transcript text / message body /
        // PII. A canary "raw body" value never appears anywhere in the loaded projection's
        // Debug rendering except as the explicit ref we stored.
        let db = Db::open_hub(&tmp("refs-only")).unwrap();
        persist_timeline(db.conn(), "s1", &TimelineState::new(2, 1, 1), 10).unwrap();
        persist_event(
            db.conn(),
            "s1",
            &TimelineEventRow {
                seq: 1,
                revision: 1,
                event_kind: "assistant_message".into(),
                actor: "provider".into(),
                body_ref: Some("body://ref/1".into()),
                provider_event_id: Some("pe-1".into()),
            },
            10,
        )
        .unwrap();
        let loaded = load_timeline_by_session(db.conn(), "s1").unwrap().unwrap();
        let rendered = format!("{loaded:?}");
        // The stored ref is present...
        assert!(rendered.contains("body://ref/1"));
        // ...and there is NO raw transcript anywhere (sentinel we never put into a ref).
        assert!(
            !rendered.contains("RAW-TRANSCRIPT-BODY"),
            "no row may carry raw transcript text: {rendered}"
        );
        // The event columns are exactly the refs-only set (no body/content column exists).
        let cols: Vec<String> = {
            let mut stmt = db
                .conn()
                .prepare("SELECT name FROM pragma_table_info('provider_timeline_event')")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert!(
            !cols
                .iter()
                .any(|c| c == "body" || c == "content" || c == "transcript"),
            "the event table must have no raw-body column: {cols:?}"
        );
    }
}
