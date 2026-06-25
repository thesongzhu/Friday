//! Channel→Hub event wiring (Channels track A-PR4 — goal file 92 §Phase 6).
//!
//! Closes the gap the channel auth/redaction layer ([`crate::channels`]) deliberately left
//! ("a channel-origin action does NOT reach the gate … no event wiring yet"): a verified +
//! PII-redacted channel inbound now becomes a Hub EVENT (one Activity row + one hash-chained
//! audit row), acting as the channel's BOUND, non-anonymous principal — never as an
//! independent memory/session owner.
//!
//! The terminus of a channel inbound is a Hub event. It NEVER executes a side effect and
//! NEVER self-approves. The disposition is the canonical gate's decision for a `Channel`
//! actor ([`friday_core::gate::evaluate`]):
//! - a reserved approve/deny action by a channel → REFUSED (gate hard-Deny, #514 binding: a
//!   channel can never self-execute a reserved approval action);
//! - a mutating / high-risk action → REQUIRES APPROVAL ELSEWHERE (mobile/desktop), never
//!   in-channel (Phase 6 forbids high-risk approval inside a channel);
//! - otherwise → RECORDED (a Hub event for the bound principal to act on).
//!
//! Idempotency: the event's `activity_id` is derived from `(channel_id, channel_msg_id)`; a
//! replay writes NOTHING — no second event and no second audit — via [`Db::record_event`].
//!
//! Safe projection: the returned [`ChannelInboundReceipt`] carries refs + PII KINDS only
//! (never values), a disposition label, and an optional blocker — never the raw transcript,
//! a private reasoning trace, or any provider/channel secret. (A protocol/wire form for the
//! receipt is a deferred-not-blocked follow-up — this struct is the headless contract, like
//! the Phase-3 FFI / Phase-5 timeline contracts that ship before a native shell emits them.)

use friday_core::gate::{
    classify, evaluate, is_reserved_approval_action_for_actor, Actor, ActorKind, GateDecision,
    MutatingActionRequest,
};
use friday_core::{ActivityState, ActivityType, Risk};
use friday_storage::{ActivityRow, AuditEvent, Db, RecordEventOutcome, StorageError};

use crate::channels::RedactedInbound;

/// The Hub's disposition of a channel-origin inbound — the gate decision, channel-framed.
/// The reserved-approval refusal is kept DISTINCT from a generic block so the audit trail
/// records WHY (the #514 binding) and not just "denied".
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChannelDisposition {
    /// Low-risk / non-mutating: recorded as a Hub event for the bound principal.
    Recorded,
    /// A reserved approve/deny action by a channel actor → refused (#514). A channel can
    /// NEVER self-approve.
    SelfApprovalRefused,
    /// A mutating / high-risk action: requires approval on mobile/desktop, NEVER in-channel.
    RequiresApprovalElsewhere { risk: String },
    /// Some other gate Deny (distinct from the reserved-approval refusal).
    Blocked { reason: String },
}

impl ChannelDisposition {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChannelDisposition::Recorded => "recorded",
            ChannelDisposition::SelfApprovalRefused => "self_approval_refused",
            ChannelDisposition::RequiresApprovalElsewhere { .. } => "requires_approval_elsewhere",
            ChannelDisposition::Blocked { .. } => "blocked",
        }
    }

    /// The activity state the event is recorded at.
    fn activity_state(&self) -> ActivityState {
        match self {
            // A recorded inbound is a completed event (the bound principal acts elsewhere).
            ChannelDisposition::Recorded => ActivityState::Done,
            // Awaiting approval on another surface (mobile/desktop) — not done, not failed.
            ChannelDisposition::RequiresApprovalElsewhere { .. } => ActivityState::Pending,
            // Refused / blocked are terminal failures of the channel-origin request.
            ChannelDisposition::SelfApprovalRefused | ChannelDisposition::Blocked { .. } => {
                ActivityState::Failed
            }
        }
    }

    fn blocker(&self) -> Option<String> {
        match self {
            ChannelDisposition::Recorded => None,
            ChannelDisposition::SelfApprovalRefused => {
                Some("channel cannot self-approve a reserved action".into())
            }
            ChannelDisposition::RequiresApprovalElsewhere { risk } => {
                Some(format!("requires approval on mobile/desktop ({risk} risk)"))
            }
            ChannelDisposition::Blocked { reason } => Some(reason.clone()),
        }
    }
}

/// The redacted proof receipt a channel surface may be shown. Refs + PII KINDS only — NO raw
/// transcript text, NO private reasoning, NO provider/channel secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelInboundReceipt {
    pub channel_id: String,
    pub sender_id: String,
    pub activity_id: String,
    pub disposition: String,
    /// The DISTINCT PII kind markers stripped from the body (e.g. `[EMAIL]`) — never values.
    pub pii_kinds_redacted: Vec<String>,
    pub blocker: Option<String>,
    /// True when this inbound was a replay (already recorded); nothing was written again.
    pub replayed: bool,
}

/// Decide the disposition of a channel-origin action via the canonical gate, as the bound
/// `Channel` principal. Pure (no I/O, no model call).
pub fn decide_disposition(
    bound_principal_id: &str,
    sender_id: &str,
    action: &str,
    mutating: bool,
    base_risk: Risk,
    params: &[(String, String)],
) -> ChannelDisposition {
    let actor = Actor {
        kind: ActorKind::Channel,
        id: sender_id.to_string(),
        // Bound, NON-anonymous principal (the channel's owner) — `evaluate`/anonymity reads
        // `principal_id`, so a real owner id is treated as non-anonymous.
        principal_id: Some(bound_principal_id.to_string()),
    };
    let classification = classify(mutating, base_risk, action, params);
    let request = MutatingActionRequest::from_classification(
        classification,
        action.to_string(),
        actor,
        "channel".to_string(),
        Vec::new(),
        None,
        None,
        None,
    );
    // A channel can NEVER self-execute a reserved approve/deny action (#514) — refusal kept
    // distinct from a generic block.
    if is_reserved_approval_action_for_actor(&request) {
        return ChannelDisposition::SelfApprovalRefused;
    }
    let record = evaluate(&request);
    match record.decision {
        GateDecision::Allow => ChannelDisposition::Recorded,
        GateDecision::RequiresApproval => ChannelDisposition::RequiresApprovalElsewhere {
            risk: record.risk.as_str().to_string(),
        },
        GateDecision::Deny => ChannelDisposition::Blocked {
            reason: record.reason,
        },
    }
}

/// Deterministic, idempotent event id for a channel inbound.
pub fn channel_event_id(channel_id: &str, channel_msg_id: &str) -> String {
    format!("chan:{channel_id}:{channel_msg_id}")
}

/// A stable, value-free label for a redacted PII KIND (never the value). Exhaustive: a new
/// `PiiKind` forces this to be updated rather than drifting to a silent default.
fn pii_kind_label(k: &crate::cognition::PiiKind) -> &'static str {
    use crate::cognition::PiiKind;
    match k {
        PiiKind::Email => "email",
        PiiKind::Phone => "phone",
        PiiKind::Ssn => "ssn",
        PiiKind::CreditCard => "credit_card",
    }
}

/// Ingest a verified + redacted channel inbound: decide its disposition, record it as ONE
/// Hub event (Activity + hash-chained audit) acting as the BOUND principal, and return a
/// redacted receipt. Idempotent on `(channel_id, channel_msg_id)`: a replay records nothing
/// and the receipt is marked `replayed`. Records EVERY verified inbound (incl. a refusal) so
/// the attempt is honestly auditable.
#[allow(clippy::too_many_arguments)]
pub fn ingest_channel_inbound(
    db: &mut Db,
    redacted: &RedactedInbound,
    channel_msg_id: &str,
    action: &str,
    mutating: bool,
    base_risk: Risk,
    params: &[(String, String)],
    now_ms: i64,
) -> Result<ChannelInboundReceipt, StorageError> {
    let disposition = decide_disposition(
        &redacted.bound_principal_id,
        &redacted.sender_id,
        action,
        mutating,
        base_risk,
        params,
    );
    let activity_id = channel_event_id(&redacted.channel_id, channel_msg_id);
    let pii_kinds_redacted: Vec<String> = redacted
        .pii_redacted
        .iter()
        .map(|k| pii_kind_label(k).to_string())
        .collect();

    // Metadata-only summary — counts + disposition, NEVER the raw inbound body.
    let summary = format!(
        "channel {} inbound by {} -> {} ({} action; {} pii kinds redacted)",
        redacted.channel_id,
        redacted.sender_id,
        disposition.as_str(),
        action,
        pii_kinds_redacted.len(),
    );
    // The audit names the BOUND PRINCIPAL who acted (via the channel) — honest "who", not
    // just "a channel".
    let actor = format!(
        "channel:{}#{}",
        redacted.channel_id, redacted.bound_principal_id
    );

    let activity = ActivityRow {
        activity_id: activity_id.clone(),
        session_id: None,
        kind: ActivityType::ChannelInbound,
        state: disposition.activity_state(),
        summary,
        created_at: now_ms,
        updated_at: now_ms,
        deep_link: None,
        // M6: stamp the channel's BOUND OWNER principal (NOT the sender_id) so mark-done
        // scopes the clear to the owner who owns the binding. Shares the WS principal_id()
        // identifier space.
        owner: Some(redacted.bound_principal_id.clone()),
    };
    let audit = AuditEvent {
        audit_id: activity_id.clone(),
        actor,
        action: format!("channel_inbound:{}", disposition.as_str()),
        payload_ref: Some(format!("friday://activity/{activity_id}")),
        created_at: now_ms,
    };

    let outcome = db.record_event(&activity, &audit)?;
    Ok(ChannelInboundReceipt {
        channel_id: redacted.channel_id.clone(),
        sender_id: redacted.sender_id.clone(),
        activity_id,
        disposition: disposition.as_str().to_string(),
        pii_kinds_redacted,
        blocker: disposition.blocker(),
        replayed: outcome == RecordEventOutcome::Duplicate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::{redact_inbound, resolve_and_verify, InboundRejection, VerifiedInbound};
    use friday_crypto::InMemorySecureStore;
    use friday_storage::audit::verify_audit_chain;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp() -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-chanevent-{}-{}.sqlite",
                std::process::id(),
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    /// A redacted inbound for an OWNER-bound channel (non-anonymous principal).
    fn redacted(raw_text: &str) -> RedactedInbound {
        redact_inbound(
            VerifiedInbound {
                channel_id: "tg:room-1".into(),
                sender_id: "u-1".into(),
                bound_principal_id: "owner-1".into(),
            },
            raw_text.to_string(),
        )
    }

    #[test]
    fn recorded_inbound_terminus_is_one_event_and_executes_nothing() {
        let mut db = Db::open_hub(&tmp()).unwrap();
        let r = redacted("hello friday");
        let receipt =
            ingest_channel_inbound(&mut db, &r, "m-1", "message", false, Risk::Low, &[], 1)
                .unwrap();

        assert_eq!(receipt.disposition, "recorded");
        assert!(receipt.blocker.is_none());
        assert!(!receipt.replayed);

        // THE safety property: the terminus is ONE Hub event (Activity + audit) — and NOTHING
        // is executed/dispatched. No model call (token_ledger empty), audit chain intact.
        assert_eq!(db.count("activity_item").unwrap(), 1);
        assert_eq!(db.count("audit_ledger").unwrap(), 1);
        assert_eq!(
            db.count("token_ledger").unwrap(),
            0,
            "no model call/dispatch"
        );
        assert_eq!(verify_audit_chain(db.conn()).unwrap(), 1);
    }

    #[test]
    fn replay_writes_no_second_event_or_audit() {
        let mut db = Db::open_hub(&tmp()).unwrap();
        let r = redacted("hello");
        let first = ingest_channel_inbound(&mut db, &r, "m-1", "message", false, Risk::Low, &[], 1)
            .unwrap();
        assert!(!first.replayed);
        let act_before = db.count("activity_item").unwrap();
        let aud_before = db.count("audit_ledger").unwrap();
        assert_eq!((act_before, aud_before), (1, 1));

        // Replay: SAME (channel_id, channel_msg_id).
        let second =
            ingest_channel_inbound(&mut db, &r, "m-1", "message", false, Risk::Low, &[], 2)
                .unwrap();
        assert!(second.replayed, "a resend must be detected as a replay");
        // Row counts UNCHANGED — no second event AND no second audit row.
        assert_eq!(db.count("activity_item").unwrap(), act_before);
        assert_eq!(db.count("audit_ledger").unwrap(), aud_before);
        assert_eq!(verify_audit_chain(db.conn()).unwrap(), 1);
    }

    #[test]
    fn pii_is_redacted_to_kinds_only_never_values_in_event_or_receipt() {
        let mut db = Db::open_hub(&tmp()).unwrap();
        // Raw body carries an email + an SSN.
        let r = redacted("reach me at me@example.com or ssn 123-45-6789");
        // The redactor already stripped the values (no raw value survives onto the boundary).
        assert!(!r.text.contains("me@example.com"));
        assert!(!r.text.contains("123-45-6789"));

        let receipt =
            ingest_channel_inbound(&mut db, &r, "m-1", "message", false, Risk::Low, &[], 1)
                .unwrap();
        // The receipt names the KINDS, never the values.
        assert!(receipt.pii_kinds_redacted.contains(&"email".to_string()));
        assert!(receipt.pii_kinds_redacted.contains(&"ssn".to_string()));
        for leaked in ["me@example.com", "123-45-6789"] {
            assert!(
                !format!("{receipt:?}").contains(leaked),
                "value leaked in receipt"
            );
        }

        // ADVERSE: the persisted Activity summary carries no raw value either.
        let items = db.list_activity().unwrap();
        assert_eq!(items.len(), 1);
        for leaked in ["me@example.com", "123-45-6789"] {
            assert!(
                !items[0].summary.contains(leaked),
                "value leaked into the persisted event"
            );
        }
    }

    #[test]
    fn channel_cannot_self_approve_a_reserved_action() {
        // Build the exact request the disposition uses and assert the #514 binding fires for
        // the SPECIFIC reserved-action reason (not just some Deny).
        let actor = Actor {
            kind: ActorKind::Channel,
            id: "u-1".into(),
            principal_id: Some("owner-1".into()),
        };
        let request = MutatingActionRequest::from_classification(
            classify(true, Risk::High, "approve", &[]),
            "approve".into(),
            actor,
            "channel".into(),
            Vec::new(),
            None,
            None,
            None,
        );
        assert!(
            is_reserved_approval_action_for_actor(&request),
            "approve by a channel must be a reserved-approval action"
        );
        let record = evaluate(&request);
        assert_eq!(record.decision, GateDecision::Deny);
        assert_eq!(
            record.reason, "channel_cannot_execute_reserved_approval_action",
            "the deny must be the #514 channel-binding, not an incidental block"
        );

        // And the ingested event reflects the refusal: Failed state, distinct disposition,
        // an honest audit row of the attempt.
        let mut db = Db::open_hub(&tmp()).unwrap();
        let r = redacted("/approve");
        let receipt =
            ingest_channel_inbound(&mut db, &r, "m-1", "approve", true, Risk::High, &[], 1)
                .unwrap();
        assert_eq!(receipt.disposition, "self_approval_refused");
        assert!(receipt.blocker.unwrap().contains("self-approve"));
        // The refusal is still audited (the attempt is honestly recorded), but nothing ran.
        assert_eq!(db.count("activity_item").unwrap(), 1);
        assert_eq!(db.count("audit_ledger").unwrap(), 1);
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.list_activity().unwrap()[0].state, "failed");
    }

    #[test]
    fn high_risk_mutating_action_requires_approval_elsewhere_never_in_channel() {
        let mut db = Db::open_hub(&tmp()).unwrap();
        let r = redacted("run the migration");
        let receipt =
            ingest_channel_inbound(&mut db, &r, "m-1", "run_command", true, Risk::High, &[], 1)
                .unwrap();
        // Mutating/high-risk → requires approval on mobile/desktop, NEVER approved in-channel.
        assert_eq!(receipt.disposition, "requires_approval_elsewhere");
        assert!(receipt.blocker.unwrap().contains("mobile/desktop"));
        // Recorded as a Pending event awaiting approval elsewhere; nothing executed.
        assert_eq!(db.list_activity().unwrap()[0].state, "pending");
        assert_eq!(
            db.count("token_ledger").unwrap(),
            0,
            "not executed in-channel"
        );
    }

    /// M6 (real-derivation, NOT a hand-set owner): a Pending ChannelInbound row produced by
    /// the REAL ingest carries `owner = bound_principal_id` ("owner-1"), NOT the `sender_id`
    /// ("u-1"). Marking it done with the bound OWNER ALLOWS; marking it done with the SENDER
    /// or any other principal is BLOCKED and leaves the row Pending — so the channel binding
    /// (not a coincidence) is the proven discriminator.
    #[test]
    fn m6_channel_inbound_owner_is_bound_principal_allows_owner_denies_sender_and_other() {
        let mut db = Db::open_hub(&tmp()).unwrap();
        let r = redacted("run the migration");
        // RequiresApprovalElsewhere ⇒ a Pending (markable) row.
        let receipt =
            ingest_channel_inbound(&mut db, &r, "m-1", "run_command", true, Risk::High, &[], 1)
                .unwrap();
        assert_eq!(receipt.disposition, "requires_approval_elsewhere");
        let activity_id = channel_event_id("tg:room-1", "m-1");

        // The stamped owner is the BOUND principal "owner-1", NOT the sender "u-1".
        let stored_owner: Option<String> = db
            .conn()
            .query_row(
                "SELECT owner FROM activity_item WHERE activity_id = ?1",
                [activity_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_owner.as_deref(), Some("owner-1"));
        assert_ne!(
            stored_owner.as_deref(),
            Some("u-1"),
            "owner must be the bound principal, never the sender_id"
        );

        let state = |db: &Db| -> String {
            db.conn()
                .query_row(
                    "SELECT state FROM activity_item WHERE activity_id = ?1",
                    [activity_id.as_str()],
                    |row| row.get(0),
                )
                .unwrap()
        };

        // The SENDER ("u-1") is NOT the owner ⇒ BLOCKED, row stays Pending.
        assert!(!db
            .mark_activity_done(&activity_id, Some("u-1"), 200)
            .unwrap());
        assert_eq!(state(&db), "pending");
        // A different principal ("bob") ⇒ BLOCKED, row stays Pending.
        assert!(!db
            .mark_activity_done(&activity_id, Some("bob"), 201)
            .unwrap());
        assert_eq!(state(&db), "pending");

        // The BOUND OWNER ("owner-1") ⇒ ALLOWED.
        assert!(db
            .mark_activity_done(&activity_id, Some("owner-1"), 300)
            .unwrap());
        assert_eq!(state(&db), "done");
    }

    #[test]
    fn unauthenticated_or_non_allowlisted_inbound_never_reaches_an_event() {
        // Provision a channel; a bad bearer / non-allowlisted sender is rejected at the auth
        // boundary (resolve_and_verify) BEFORE any Hub event could be recorded.
        let mut db = Db::open_hub(&tmp()).unwrap();
        let mut store = InMemorySecureStore::new();
        let secret: &[u8] = b"channel-inbound-hmac-material-0123456789"; // pragma: allowlist secret
        let bearer = crate::channels::provision_channel_auth(
            &mut store,
            db.conn(),
            "tg:room-1",
            friday_storage::channel::ChannelKind::Telegram,
            "owner-1",
            &["u-1".to_string()],
            secret,
            1,
        )
        .unwrap();
        let binding = friday_storage::channel::get_channel(db.conn(), "tg:room-1")
            .unwrap()
            .unwrap();

        // Bad bearer → rejected, no event.
        assert_eq!(
            resolve_and_verify(&store, &binding, "deadbeef", "u-1"),
            Err(InboundRejection::BadBearer)
        );
        // Valid bearer but sender NOT in the allowlist → rejected, no event.
        assert_eq!(
            resolve_and_verify(&store, &binding, &bearer, "intruder"),
            Err(InboundRejection::SenderNotAllowed)
        );
        // Neither produced a VerifiedInbound, so ingest was never reachable: 0 events.
        assert_eq!(db.count("activity_item").unwrap(), 0);
        assert_eq!(db.count("audit_ledger").unwrap(), 0);

        // The allowlisted sender with the right bearer DOES verify (the happy path still works).
        let verified = resolve_and_verify(&store, &binding, &bearer, "u-1").unwrap();
        let receipt = ingest_channel_inbound(
            &mut db,
            &redact_inbound(verified, "hi".into()),
            "m-1",
            "message",
            false,
            Risk::Low,
            &[],
            2,
        )
        .unwrap();
        assert_eq!(receipt.disposition, "recorded");
        assert_eq!(db.count("activity_item").unwrap(), 1);
    }
}
