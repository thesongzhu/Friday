//! Phase-2 runtime truth — connection / offline / reconnect honesty (goal file 92 §Phase 2).
//!
//! Makes offline/stale truth a RUNTIME contract, not UI copy. Builds on the existing
//! `friday_core::ConnState` (transport state machine) and `friday_storage::offline` (the
//! confirmed-action queue whose `execute_once` already enforces ack≠completion and
//! fail-closed-on-invalid-approval). This module adds:
//! - a TIME-DRIVEN stale evaluator (the missing piece over `ConnState`);
//! - a single honest [`PresentationTruth`] label so a queued/acked/stale/offline state can
//!   never be rendered as completed or fresh-connected;
//! - an offline DRAIN that routes through the EXISTING gate/dispatch path only — it never
//!   creates a new dispatch path and never executes an unauthorized action.
//!
//! Reconnect/no-full-reload is the provider-timeline delta/snapshot contract
//! (`crate::provider_timeline`); zero-model-call on connect/status/refresh/reconnect is the
//! Phase-1 serve-loop (`crate::hub_server`). This module does not add any model call.

use friday_core::{ConnState, OfflineQueueState};
use friday_storage::offline::{execute_once, ExecOutcome};
use friday_storage::{Db, StorageError};

/// Time-driven stale evaluation. An ONLINE link (`Direct`/`Relay`) whose last observation
/// is older than `stale_after_ms` is reported `Stale` (the UI must show stale/offline
/// truth). Any non-online state is returned unchanged — `Stale` stays `Stale` and
/// `Disconnected` stays offline until a FRESH observation recovers it. This never
/// fabricates an online state from time alone (no "connected" without proof).
pub fn evaluate_stale(
    current: ConnState,
    last_seen_ms: i64,
    now_ms: i64,
    stale_after_ms: i64,
) -> ConnState {
    match current {
        ConnState::Direct | ConnState::Relay
            if now_ms.saturating_sub(last_seen_ms) > stale_after_ms =>
        {
            ConnState::Stale
        }
        other => other,
    }
}

/// The single client-facing truth label. Deriving it is the only sanctioned way to label
/// a connection/action — a queued/acked/stale/offline state can never become
/// `Connected`/`Executed` here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresentationTruth {
    Connected,
    Reconnecting,
    Stale,
    Offline,
    Queued,
    Executed,
    Failed,
}

impl PresentationTruth {
    /// Label for the CONNECTION row from the (already time-evaluated) transport state.
    pub fn for_connection(conn: ConnState) -> Self {
        match conn {
            ConnState::Direct | ConnState::Relay => PresentationTruth::Connected,
            ConnState::Connecting => PresentationTruth::Reconnecting,
            ConnState::Stale => PresentationTruth::Stale,
            ConnState::Disconnected => PresentationTruth::Offline,
        }
    }

    /// Label for an OFFLINE ACTION row. `Acked` is "the Hub saw it" — NOT completion — so
    /// both `Queued` and `Acked` render as `Queued`; only `Executed` is completion.
    pub fn for_offline_action(state: OfflineQueueState) -> Self {
        match state {
            OfflineQueueState::Queued | OfflineQueueState::Acked => PresentationTruth::Queued,
            OfflineQueueState::Executed => PresentationTruth::Executed,
            OfflineQueueState::Failed => PresentationTruth::Failed,
        }
    }

    /// Only `Executed` implies the action actually completed.
    pub fn implies_completion(self) -> bool {
        matches!(self, PresentationTruth::Executed)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PresentationTruth::Connected => "connected",
            PresentationTruth::Reconnecting => "reconnecting",
            PresentationTruth::Stale => "stale",
            PresentationTruth::Offline => "offline",
            PresentationTruth::Queued => "queued",
            PresentationTruth::Executed => "executed",
            PresentationTruth::Failed => "failed",
        }
    }
}

/// Drain ONE already-confirmed offline action through the EXISTING gate/dispatch path.
///
/// This adds NO new dispatch path: it computes whether the stored authorization still
/// holds (`gate_check`, e.g. the existing approval verify) and delegates to
/// [`friday_storage::offline::execute_once`], which (a) refuses anything not `Acked` (an
/// ack is not completion), (b) fails closed to `Failed` if the authorization is invalid
/// (no run), and (c) is idempotent. An unauthorized or un-acked action is never executed;
/// it stays `Queued`/`Failed` with an exact reason.
pub fn drain_one<G, E>(
    db: &mut Db,
    queue_id: &str,
    now_ms: i64,
    gate_check: G,
    exec: E,
) -> Result<ExecOutcome, StorageError>
where
    G: FnOnce() -> bool,
    E: FnOnce() -> Result<String, String>,
{
    let approval_valid = gate_check();
    execute_once(db.conn_mut(), queue_id, approval_valid, now_ms, exec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_storage::offline::{ack, enqueue, get_state};
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp() -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-conntruth-{}-{}.sqlite",
                std::process::id(),
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn online_link_goes_stale_after_threshold_and_stays_until_fresh_observation() {
        // Fresh online → stays online.
        assert_eq!(
            evaluate_stale(ConnState::Direct, 1000, 1500, 1000),
            ConnState::Direct
        );
        // Stale by time → Stale.
        assert_eq!(
            evaluate_stale(ConnState::Direct, 1000, 2500, 1000),
            ConnState::Stale
        );
        assert_eq!(
            evaluate_stale(ConnState::Relay, 0, 5000, 1000),
            ConnState::Stale
        );
        // Already stale / disconnected: time never fabricates "online".
        assert_eq!(
            evaluate_stale(ConnState::Stale, 0, 0, 1000),
            ConnState::Stale
        );
        assert_eq!(
            evaluate_stale(ConnState::Disconnected, 0, 0, 1000),
            ConnState::Disconnected
        );
    }

    #[test]
    fn presentation_never_labels_stale_as_connected_or_queued_as_completed() {
        assert_eq!(
            PresentationTruth::for_connection(ConnState::Direct),
            PresentationTruth::Connected
        );
        assert_eq!(
            PresentationTruth::for_connection(ConnState::Stale),
            PresentationTruth::Stale
        );
        assert_eq!(
            PresentationTruth::for_connection(ConnState::Disconnected),
            PresentationTruth::Offline
        );
        assert_eq!(
            PresentationTruth::for_connection(ConnState::Connecting),
            PresentationTruth::Reconnecting
        );
        // ack is NOT completion.
        assert_eq!(
            PresentationTruth::for_offline_action(OfflineQueueState::Acked),
            PresentationTruth::Queued
        );
        assert_eq!(
            PresentationTruth::for_offline_action(OfflineQueueState::Queued),
            PresentationTruth::Queued
        );
        assert_eq!(
            PresentationTruth::for_offline_action(OfflineQueueState::Executed),
            PresentationTruth::Executed
        );
        // Only Executed implies completion.
        for s in [
            OfflineQueueState::Queued,
            OfflineQueueState::Acked,
            OfflineQueueState::Failed,
        ] {
            assert!(!PresentationTruth::for_offline_action(s).implies_completion());
        }
        assert!(
            PresentationTruth::for_offline_action(OfflineQueueState::Executed).implies_completion()
        );
        assert!(!PresentationTruth::Stale.implies_completion());
    }

    #[test]
    fn queued_is_not_executed_and_ack_is_not_completion() {
        let db = Db::open_phone(&tmp()).unwrap();
        enqueue(
            db.conn(),
            "q1",
            "send_message",
            "m1",
            None,
            Some("approval-1"),
            1,
        )
        .unwrap();
        assert_eq!(
            get_state(db.conn(), "q1").unwrap(),
            Some(OfflineQueueState::Queued)
        );
        // A Queued (un-acked) action cannot be drained — ack is not completion.
        let mut db = db;
        let err = drain_one(&mut db, "q1", 2, || true, || Ok("ran".into()));
        assert!(
            err.is_err(),
            "draining an un-acked action must fail (ack is not completion)"
        );
        assert_eq!(
            get_state(db.conn(), "q1").unwrap(),
            Some(OfflineQueueState::Queued)
        );
    }

    #[test]
    fn drain_without_valid_authorization_fails_closed_and_does_not_run() {
        let mut db = Db::open_phone(&tmp()).unwrap();
        enqueue(
            db.conn(),
            "q1",
            "send_message",
            "m1",
            None,
            Some("approval-1"),
            1,
        )
        .unwrap();
        ack(db.conn(), "q1").unwrap();
        // gate_check = false → execute_once fails closed to Failed, exec never runs.
        let mut ran = false;
        let outcome = drain_one(
            &mut db,
            "q1",
            2,
            || false,
            || {
                ran = true;
                Ok("should-not-run".into())
            },
        )
        .unwrap();
        assert_eq!(outcome, ExecOutcome::ApprovalInvalid);
        assert!(!ran, "unauthorized drain must NOT run the side effect");
        assert_eq!(
            get_state(db.conn(), "q1").unwrap(),
            Some(OfflineQueueState::Failed)
        );
    }

    #[test]
    fn authorized_drain_executes_once_through_the_existing_path_and_is_idempotent() {
        let mut db = Db::open_phone(&tmp()).unwrap();
        enqueue(
            db.conn(),
            "q1",
            "send_message",
            "m1",
            None,
            Some("approval-1"),
            1,
        )
        .unwrap();
        ack(db.conn(), "q1").unwrap();
        let outcome =
            drain_one(&mut db, "q1", 2, || true, || Ok("execution-proof".into())).unwrap();
        assert_eq!(outcome, ExecOutcome::Executed);
        assert_eq!(
            get_state(db.conn(), "q1").unwrap(),
            Some(OfflineQueueState::Executed)
        );
        // Idempotent: a second drain is a no-op (already executed).
        let again = drain_one(&mut db, "q1", 3, || true, || Ok("again".into())).unwrap();
        assert_eq!(again, ExecOutcome::AlreadyExecuted);
    }
}
