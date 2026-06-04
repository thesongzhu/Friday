//! SMOOTH-001 — provider session timeline + reconnect harness (file 83).
//!
//! One Friday-canonical timeline per provider session. It assigns a strictly-monotonic
//! per-session `seq` to every event and bumps a `revision` on EVERY mutation (including a
//! pending-action status-only change), tracks `PendingAction`s by `client_msg_id` (deduped
//! so a reconnect-and-resend never double-submits), and answers a reconnect with a DELTA
//! when the client's cursor is still retained, falling back to a SNAPSHOT only when it is
//! behind retention — so a reconnect is not a full-history reload by default.
//!
//! Honesty invariants (file 83):
//! - An `OfflineQueueAck` (the Hub saw the queued message → `SentToHub`/`AcceptedByHub`) is
//!   NEVER provider completion. The state machine makes `ProviderCompleted` reachable ONLY
//!   through `RoutedToProvider` → `WaitingProvider`, which require Hub acceptance first.
//! - Events carry only refs (`body_ref`/`provider_event_id`), never raw transcript text.
//! - Pure logic, no I/O; per-session isolation means one noisy stream cannot stall another.

use friday_protocol::{IdempotencyTracker, Seen};
use std::collections::BTreeMap;

/// A Friday-canonical timeline event (file 83 §ProviderTimelineEvent), metadata-only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelineEvent {
    /// Per-session, strictly monotonic from 1 (never reused, even after pruning).
    pub seq: u64,
    /// The timeline `revision` at which this event was appended.
    pub revision: u64,
    pub event_kind: String,
    pub actor: String,
    /// A ref to the body — never the raw transcript text.
    pub body_ref: Option<String>,
    pub provider_event_id: Option<String>,
}

/// The lifecycle of a Friday-originated action (file 83 §PendingAction). The happy path is
/// a chain; terminal states may be reached from several points. `OfflineQueueAck` maps to
/// `SentToHub`/`AcceptedByHub` and is NOT `ProviderCompleted`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingState {
    Draft,
    PendingLocal,
    SentToHub,
    AcceptedByHub,
    RoutedToProvider,
    WaitingProvider,
    ProviderCompleted,
    Blocked,
    FailedRetryable,
    FailedTerminal,
    Cancelled,
}

impl PendingState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            PendingState::ProviderCompleted
                | PendingState::Blocked
                | PendingState::FailedTerminal
                | PendingState::Cancelled
        )
    }

    /// The legal forward transitions. This is the load-bearing honesty guard:
    /// `ProviderCompleted` is reachable ONLY from `WaitingProvider` (which requires
    /// `RoutedToProvider` ← `AcceptedByHub` ← `SentToHub`), so an action can never be shown
    /// "done" without real Hub acceptance + provider routing.
    pub fn can_transition_to(self, to: PendingState) -> bool {
        use PendingState::*;
        matches!(
            (self, to),
            (Draft, PendingLocal)
                | (PendingLocal, SentToHub)
                | (PendingLocal, Cancelled)
                | (SentToHub, AcceptedByHub)
                | (SentToHub, Blocked)
                | (SentToHub, FailedRetryable)
                | (SentToHub, FailedTerminal)
                | (SentToHub, Cancelled)
                | (AcceptedByHub, RoutedToProvider)
                | (AcceptedByHub, Blocked)
                | (AcceptedByHub, FailedTerminal)
                | (AcceptedByHub, Cancelled)
                | (RoutedToProvider, WaitingProvider)
                | (RoutedToProvider, FailedRetryable)
                | (RoutedToProvider, FailedTerminal)
                | (WaitingProvider, ProviderCompleted)
                | (WaitingProvider, FailedRetryable)
                | (WaitingProvider, FailedTerminal)
                | (FailedRetryable, SentToHub) // retry
                | (FailedRetryable, FailedTerminal)
                | (FailedRetryable, Cancelled)
        )
    }
}

/// A Friday-originated pending action (file 83 §PendingAction).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingAction {
    pub request_id: String,
    pub client_msg_id: String,
    pub action: String,
    pub state: PendingState,
    pub dispatch_ref: Option<String>,
    pub blocker: Option<String>,
    /// The timeline revision the action was based on when submitted.
    pub base_revision: u64,
    /// The timeline revision of the last state change.
    pub updated_at_revision: u64,
}

/// The reconnect answer: a bounded DELTA when the cursor is retained, else a SNAPSHOT.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reconnect {
    Delta {
        from_seq: u64,
        to_seq: u64,
        from_revision: u64,
        to_revision: u64,
        events: Vec<TimelineEvent>,
        pending: Vec<PendingAction>,
    },
    Snapshot {
        to_seq: u64,
        revision: u64,
        events: Vec<TimelineEvent>,
        pending: Vec<PendingAction>,
        reason: &'static str,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum TimelineError {
    /// A pending action transition that the state machine forbids.
    IllegalTransition {
        from: PendingState,
        to: PendingState,
    },
    /// No pending action with that request id.
    UnknownPending,
}

/// One Friday-canonical provider-session timeline.
pub struct ProviderTimeline {
    friday_session_id: String,
    events: Vec<TimelineEvent>,
    /// Next seq to assign — monotonic, never reset (survives pruning).
    next_seq: u64,
    /// Lowest seq still retained in `events` (events below this were pruned).
    retained_from_seq: u64,
    revision: u64,
    pending: BTreeMap<String, PendingAction>, // keyed by request_id (insertion-ordered output)
    by_client_msg: IdempotencyTracker,
    client_to_request: BTreeMap<String, String>, // client_msg_id -> request_id (dedup)
}

impl ProviderTimeline {
    pub fn new(friday_session_id: impl Into<String>) -> Self {
        Self {
            friday_session_id: friday_session_id.into(),
            events: Vec::new(),
            next_seq: 1,
            retained_from_seq: 1,
            revision: 0,
            pending: BTreeMap::new(),
            by_client_msg: IdempotencyTracker::new(),
            client_to_request: BTreeMap::new(),
        }
    }

    pub fn friday_session_id(&self) -> &str {
        &self.friday_session_id
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn last_seq(&self) -> u64 {
        self.next_seq - 1
    }

    /// Append an event; assigns the next seq and bumps revision. Returns the seq.
    pub fn append_event(
        &mut self,
        event_kind: impl Into<String>,
        actor: impl Into<String>,
        body_ref: Option<String>,
        provider_event_id: Option<String>,
    ) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.revision += 1;
        self.events.push(TimelineEvent {
            seq,
            revision: self.revision,
            event_kind: event_kind.into(),
            actor: actor.into(),
            body_ref,
            provider_event_id,
        });
        seq
    }

    /// Submit a Friday-originated pending action. Deduped by `client_msg_id`: a resend
    /// (e.g. after reconnect) returns the EXISTING action and does not create a second one.
    /// A freshly-submitted action starts at `PendingLocal` and bumps revision.
    pub fn submit_pending(
        &mut self,
        client_msg_id: impl Into<String>,
        request_id: impl Into<String>,
        action: impl Into<String>,
    ) -> &PendingAction {
        let client_msg_id = client_msg_id.into();
        if let Seen::Replay = self.by_client_msg.observe(&client_msg_id) {
            let rid = self
                .client_to_request
                .get(&client_msg_id)
                .expect("seen client_msg_id maps to a request");
            return self.pending.get(rid).expect("mapped request exists");
        }
        let request_id = request_id.into();
        self.revision += 1;
        self.client_to_request
            .insert(client_msg_id.clone(), request_id.clone());
        let action = PendingAction {
            request_id: request_id.clone(),
            client_msg_id,
            action: action.into(),
            state: PendingState::PendingLocal,
            dispatch_ref: None,
            blocker: None,
            base_revision: self.revision,
            updated_at_revision: self.revision,
        };
        self.pending.entry(request_id.clone()).or_insert(action);
        self.pending.get(&request_id).unwrap()
    }

    /// Advance a pending action to `to`, enforcing the legal state machine. A status-only
    /// change still bumps revision (so a reconnecting client sees it).
    pub fn advance_pending(
        &mut self,
        request_id: &str,
        to: PendingState,
        dispatch_ref: Option<String>,
        blocker: Option<String>,
    ) -> Result<(), TimelineError> {
        let action = self
            .pending
            .get_mut(request_id)
            .ok_or(TimelineError::UnknownPending)?;
        if !action.state.can_transition_to(to) {
            return Err(TimelineError::IllegalTransition {
                from: action.state,
                to,
            });
        }
        action.state = to;
        if dispatch_ref.is_some() {
            action.dispatch_ref = dispatch_ref;
        }
        if blocker.is_some() {
            action.blocker = blocker;
        }
        self.revision += 1;
        action.updated_at_revision = self.revision;
        Ok(())
    }

    pub fn pending(&self, request_id: &str) -> Option<&PendingAction> {
        self.pending.get(request_id)
    }

    fn pending_snapshot(&self) -> Vec<PendingAction> {
        self.pending.values().cloned().collect()
    }

    /// Prune events with seq below `keep_from_seq` (bounded hydration). seq assignment is
    /// unaffected; a client whose cursor is below the new retention gets a snapshot.
    pub fn prune_before(&mut self, keep_from_seq: u64) {
        self.events.retain(|e| e.seq >= keep_from_seq);
        self.retained_from_seq = self.retained_from_seq.max(keep_from_seq);
    }

    /// Answer a reconnect. If every event after `last_seen_seq` is still retained, return a
    /// DELTA (only the missed events, in seq order); otherwise the cursor is behind
    /// retention and we return a SNAPSHOT of what is retained.
    pub fn reconnect(&self, last_seen_seq: u64, last_seen_revision: u64) -> Reconnect {
        let cursor_retained = last_seen_seq + 1 >= self.retained_from_seq;
        if cursor_retained {
            let events: Vec<TimelineEvent> = self
                .events
                .iter()
                .filter(|e| e.seq > last_seen_seq)
                .cloned()
                .collect();
            Reconnect::Delta {
                from_seq: last_seen_seq,
                to_seq: self.last_seq(),
                from_revision: last_seen_revision,
                to_revision: self.revision,
                events,
                pending: self.pending_snapshot(),
            }
        } else {
            Reconnect::Snapshot {
                to_seq: self.last_seq(),
                revision: self.revision,
                events: self.events.clone(),
                pending: self.pending_snapshot(),
                reason: "cursor_behind_retention",
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> ProviderTimeline {
        let mut t = ProviderTimeline::new("friday-session-1");
        for i in 1..=5 {
            t.append_event(
                "assistant_message",
                "provider",
                Some(format!("body://{i}")),
                None,
            );
        }
        t
    }

    #[test]
    fn seq_is_strictly_monotonic_and_revision_bumps_on_every_mutation() {
        let mut t = ProviderTimeline::new("s");
        assert_eq!(t.revision(), 0);
        assert_eq!(t.append_event("system", "hub", None, None), 1);
        assert_eq!(
            t.append_event("assistant_message", "provider", None, None),
            2
        );
        assert_eq!(t.last_seq(), 2);
        assert_eq!(t.revision(), 2);
        // A pending submit is a mutation (revision++), and a status-only advance is too.
        t.submit_pending("c1", "r1", "send_turn");
        assert_eq!(t.revision(), 3);
        t.advance_pending("r1", PendingState::SentToHub, None, None)
            .unwrap();
        assert_eq!(t.revision(), 4);
    }

    #[test]
    fn hub_ack_is_not_provider_completion_and_done_requires_provider_routing() {
        let mut t = ProviderTimeline::new("s");
        t.submit_pending("c1", "r1", "send_turn");
        // Cannot jump straight to provider-completed from pending_local.
        assert_eq!(
            t.advance_pending("r1", PendingState::ProviderCompleted, None, None),
            Err(TimelineError::IllegalTransition {
                from: PendingState::PendingLocal,
                to: PendingState::ProviderCompleted,
            })
        );
        // Hub acceptance is not completion.
        t.advance_pending("r1", PendingState::SentToHub, None, None)
            .unwrap();
        t.advance_pending("r1", PendingState::AcceptedByHub, None, None)
            .unwrap();
        assert!(!t.pending("r1").unwrap().state.is_terminal());
        assert_ne!(
            t.pending("r1").unwrap().state,
            PendingState::ProviderCompleted
        );
        // Still cannot complete without routing + waiting.
        assert!(t
            .advance_pending("r1", PendingState::ProviderCompleted, None, None)
            .is_err());
        // The full legal path reaches completion.
        t.advance_pending(
            "r1",
            PendingState::RoutedToProvider,
            Some("friday://d/1".into()),
            None,
        )
        .unwrap();
        t.advance_pending("r1", PendingState::WaitingProvider, None, None)
            .unwrap();
        t.advance_pending("r1", PendingState::ProviderCompleted, None, None)
            .unwrap();
        assert_eq!(
            t.pending("r1").unwrap().state,
            PendingState::ProviderCompleted
        );
    }

    #[test]
    fn duplicate_client_msg_id_does_not_create_a_second_pending() {
        let mut t = ProviderTimeline::new("s");
        let first_rid = t.submit_pending("c1", "r1", "send_turn").request_id.clone();
        let rev_after_first = t.revision();
        // A resend with the SAME client_msg_id returns the existing action; no new pending,
        // no extra revision bump (no double dispatch).
        let again = t.submit_pending("c1", "r2-should-be-ignored", "send_turn");
        assert_eq!(again.request_id, first_rid);
        assert_eq!(t.revision(), rev_after_first);
    }

    #[test]
    fn reconnect_delta_replays_only_missed_events_in_order() {
        let t = seeded();
        match t.reconnect(2, 2) {
            Reconnect::Delta {
                events,
                from_seq,
                to_seq,
                to_revision,
                ..
            } => {
                assert_eq!(from_seq, 2);
                assert_eq!(to_seq, 5);
                assert_eq!(to_revision, 5);
                let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
                assert_eq!(seqs, vec![3, 4, 5]); // only missed, in order
            }
            other => panic!("expected delta, got {other:?}"),
        }
    }

    #[test]
    fn fresh_client_gets_a_delta_of_everything_not_a_snapshot() {
        let t = seeded();
        match t.reconnect(0, 0) {
            Reconnect::Delta { events, .. } => assert_eq!(events.len(), 5),
            other => panic!("expected delta, got {other:?}"),
        }
    }

    #[test]
    fn old_cursor_behind_retention_triggers_snapshot_fallback() {
        let mut t = seeded();
        t.prune_before(3); // retain seq >= 3
                           // A client last at seq 1 is behind retention → snapshot, not a broken delta.
        match t.reconnect(1, 1) {
            Reconnect::Snapshot {
                events,
                reason,
                to_seq,
                ..
            } => {
                assert_eq!(reason, "cursor_behind_retention");
                assert_eq!(to_seq, 5);
                let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
                assert_eq!(seqs, vec![3, 4, 5]); // retained window
            }
            other => panic!("expected snapshot, got {other:?}"),
        }
        // A client still within retention (seq 3) gets a delta.
        assert!(matches!(t.reconnect(3, 3), Reconnect::Delta { .. }));
    }

    #[test]
    fn two_session_timelines_are_independent() {
        // Backpressure / isolation: appending to one session's timeline never changes
        // another's seq or revision.
        let mut a = ProviderTimeline::new("session-a");
        let mut b = ProviderTimeline::new("session-b");
        a.append_event("assistant_message", "provider", None, None);
        a.append_event("assistant_message", "provider", None, None);
        assert_eq!(a.last_seq(), 2);
        assert_eq!(b.last_seq(), 0);
        assert_eq!(b.revision(), 0);
        b.append_event("system", "hub", None, None);
        assert_eq!(b.last_seq(), 1);
        assert_eq!(a.last_seq(), 2);
    }

    #[test]
    fn events_carry_only_refs_never_raw_body() {
        let mut t = ProviderTimeline::new("s");
        t.append_event(
            "assistant_message",
            "provider",
            Some("body://ref/1".into()),
            Some("pe-1".into()),
        );
        let ev = &t.reconnect(0, 0);
        let debug = format!("{ev:?}");
        assert!(debug.contains("body://ref/1"));
        // body_ref is a ref; there is no field that could carry raw transcript text.
    }
}
