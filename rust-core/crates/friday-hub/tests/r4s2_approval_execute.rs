//! R4 slice-2 adversarial suite — the verified-approval → Allow → EXECUTE happy path
//! for system-intent (DARK), the system-intent analogue of the S6d resume suite.
//!
//! This lives in `tests/` (NOT `src/`) for the SAME reason `s6d_resume_ingestion.rs`
//! does: it must construct an operator SIGNING key to play the offline operator, and
//! `friday-hub/src/**` is forbidden from ever naming `OperatorSigningKey` (the
//! key-substitution defense, asserted by
//! `operator_vk::tests::hub_crate_never_references_a_signing_key`). The Hub never holds
//! a signing key; here the TEST holds it, exactly as the real operator does off-Hub.
//!
//! The security core proven here:
//!   * a verified operator-Ed25519 approval is the ONLY path that upgrades a mutating
//!     system intent to Allow → execute (the Hub holds only the PUBLIC verify key —
//!     it can never self-mint);
//!   * single-use: a replay of the same approval is refused (the `consumed_approval`
//!     nonce PK collision), so an approved intent does NOT re-authorize twice;
//!   * the DOWNGRADE defense: an HMAC-signed approval over the SAME canonical bytes
//!     (what a self-minting Hub holding the symmetric secret would produce) is rejected;
//!   * NEVER self-mintable: an Agent / Remote actor (the untrusted `OwnerKind`s this
//!     entrypoint can produce — both map to the gate's bound `Agent`) doing a reserved
//!     approve/deny is a hard-Deny EVEN with a perfectly-valid operator approval (the
//!     reserved-action rule is decided before the signature is examined). The `Channel`
//!     binding is a gate-LEVEL property (`OwnerKind` has no Channel variant, so it is not
//!     representable here) and is covered by `friday-core::gate`'s own suite;
//!   * the HONESTY posture: EVERY protected intent on a valid Allow — `resume_task`
//!     (its `activeTask` pointer + `system.task.updated`/`system.intent.completed`
//!     emissions are a deferred AC; `system.task.updated` is read back, so it is an
//!     OBSERVABLE divergence) just as much as `launch_app` / `recover_ui` — stays
//!     `unavailable` + `execution_deferred`. The approval AUTHORIZES the action and the
//!     m0026 lease IS acquired, but the domain effect is NEVER faked-`completed`. There
//!     is NO control-plane-completes path in this slice.

use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::gate::{
    canonical_approval_signature_bytes, ApprovalDecision, CanonicalApproval, CANONICAL_GATE_ISSUER,
};
use friday_crypto::{OperatorSigningKey, OperatorVerifyingKey};
use friday_hub::system_intent::{
    intent_action_digest, DispatchOutcome, IntentInput, SystemIntentEntrypoint,
    UnavailableExecutor, UNIMPLEMENTED_EXECUTION_MARKER,
};
use friday_storage::system_intent::{
    get_intent_result, get_lease, list_approval_records, DecisionLabel, IntentAction, IntentStatus,
    OwnerKind,
};
use friday_storage::Db;

/// The HMAC secret a self-minting Hub would hold (the symmetric mint==verify key). The
/// verify-only Ed25519 path must make this irrelevant for a protected action.
const HUB_HMAC_SECRET: &[u8] = b"hub-held-hmac-gate-secret-0123456789";
const NOW: i64 = 1_000;
const FUTURE: i64 = 2_000;

static C: AtomicU64 = AtomicU64::new(0);
fn tmp(tag: &str) -> String {
    std::env::temp_dir()
        .join(format!(
            "friday-r4s2-{}-{}-{}.sqlite",
            std::process::id(),
            tag,
            C.fetch_add(1, Ordering::Relaxed)
        ))
        .to_string_lossy()
        .into_owned()
}

fn operator() -> (OperatorSigningKey, OperatorVerifyingKey) {
    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();
    (sk, vk)
}

fn input(intent_id: &str, action: IntentAction, actor: &str, kind: OwnerKind) -> IntentInput {
    IntentInput {
        intent_id: intent_id.to_string(),
        action,
        actor_id: actor.to_string(),
        actor_kind: kind,
        target_ref: None,
        reason: None,
        lease_ttl_ms: None,
    }
}

/// `resume_task` — a protected mutating intent whose domain effect (the `activeTask`
/// pointer + the `system.task.updated`/`system.intent.completed` emissions) is a
/// deferred AC, so on a valid Allow it stays `unavailable` like every other protected
/// intent. It requires a `target_ref` (the task value), bound into the action digest.
fn resume_task_input(id: &str, value: &str) -> IntentInput {
    let mut inp = input(id, IntentAction::ResumeTask, "api-1", OwnerKind::Api);
    inp.target_ref = Some(value.to_string());
    inp
}

/// A correctly-signed, digest-bound, future-dated operator Ed25519 approval for `inp`.
/// The digest is the PUBLIC `intent_action_digest` binding — exactly what the dispatch
/// path verifies — so the test never touches a Hub internal.
fn ed25519_approval(
    inp: &IntentInput,
    sk: &OperatorSigningKey,
    approval_id: &str,
    expires_at: Option<i64>,
) -> CanonicalApproval {
    let mut a = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: approval_id.to_string(),
        action_digest: intent_action_digest(inp),
        expires_at,
        issuer: Some(CANONICAL_GATE_ISSUER.to_string()),
        signature: None,
    };
    a.signature = Some(sk.sign(&canonical_approval_signature_bytes(&a)).to_hex());
    a
}

/// A digest-bound approval signed with the HUB-held HMAC secret — exactly what a
/// self-minting Hub would produce over the SAME canonical bytes.
fn hmac_approval(inp: &IntentInput, approval_id: &str) -> CanonicalApproval {
    let mut a = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: approval_id.to_string(),
        action_digest: intent_action_digest(inp),
        expires_at: Some(FUTURE),
        issuer: Some(CANONICAL_GATE_ISSUER.to_string()),
        signature: None,
    };
    a.signature = Some(friday_crypto::sign_approval(
        &canonical_approval_signature_bytes(&a),
        HUB_HMAC_SECRET,
    ));
    a
}

fn consumed_count(db: &Db) -> i64 {
    db.conn()
        .query_row("SELECT count(*) FROM consumed_approval", [], |r| r.get(0))
        .unwrap()
}

fn enabled_ep() -> SystemIntentEntrypoint<UnavailableExecutor> {
    SystemIntentEntrypoint::with_execution_enabled(UnavailableExecutor)
}

/// THE HAPPY PATH (authorize, do not fake): `resume_task` + a valid operator Ed25519
/// approval → Allow, with the m0026 control-lease actually acquired, the approval-record
/// decision = Allow, and exactly one nonce consumed — BUT the result is `unavailable` +
/// `execution_deferred`, NOT `completed`. The approval AUTHORIZES `resume_task`, but its
/// domain effect (the `activeTask` pointer + the `system.task.updated` /
/// `system.intent.completed` emissions, the former read back via `findLatestEventByName`,
/// so an OBSERVABLE divergence) is a deferred AC — recording `completed` while performing
/// none of those would be a faked-complete.
#[test]
fn resume_task_with_valid_approval_is_authorized_but_deferred_not_completed() {
    let db = Db::open_hub(&tmp("cp-happy")).unwrap();
    let ep = enabled_ep();
    let (sk, vk) = operator();
    let inp = resume_task_input("i-rt", "follow_up_email");
    let approval = ed25519_approval(&inp, &sk, "ap-rt-1", Some(FUTURE));

    let outcome: DispatchOutcome = ep
        .dispatch_with_approval(db.conn(), &inp, &approval, &vk, NOW)
        .unwrap();
    assert_eq!(
        outcome.result.status,
        IntentStatus::Unavailable,
        "an approved resume_task is authorized but its domain effect is deferred — never faked-completed"
    );
    assert_ne!(outcome.result.status, IntentStatus::Completed);
    assert!(
        outcome.execution_deferred,
        "resume_task's domain effect is the deferred executor seam"
    );
    // The result message is the honest unimplemented marker — NOT a claim that activeTask
    // was set or the events emitted.
    assert_eq!(outcome.result.message, UNIMPLEMENTED_EXECUTION_MARKER);
    assert!(!outcome.result.message.contains("Active task set"));
    // The m0026 lease WAS actually acquired (the real, universal lease auto-acquire).
    let lease_id = outcome.result.control_lease_id.clone().unwrap();
    let lease = get_lease(db.conn(), &lease_id).unwrap().unwrap();
    assert_eq!(lease.owner_id, "api-1");
    assert!(lease.revoked_at.is_none(), "the lease is active");
    // The approval-record proves the verified Allow (the approval WAS honored).
    let trail = list_approval_records(db.conn(), "i-rt").unwrap();
    assert_eq!(trail.len(), 1);
    assert_eq!(trail[0].decision, DecisionLabel::Allow);
    assert_eq!(trail[0].reason, "canonical_approval_granted");
    // The nonce WAS consumed — the deferral is the executor's, not the gate's.
    assert_eq!(consumed_count(&db), 1);
    assert_eq!(
        get_intent_result(db.conn(), "i-rt")
            .unwrap()
            .unwrap()
            .status,
        IntentStatus::Unavailable
    );
}

/// THE HONESTY CONTRAST: an OS-affecting intent (`launch_app`) + a *valid* operator
/// approval → Allow, but the result is STILL `unavailable`, NOT `completed`. A legitimate
/// Allow does NOT fake an OS effect.
#[test]
fn os_affecting_with_valid_approval_is_allowed_but_still_unavailable_not_completed() {
    let db = Db::open_hub(&tmp("os-unavail")).unwrap();
    let ep = enabled_ep();
    let (sk, vk) = operator();
    let mut inp = input("i-launch", IntentAction::LaunchApp, "api-1", OwnerKind::Api);
    inp.target_ref = Some("com.apple.Safari".to_string());
    let approval = ed25519_approval(&inp, &sk, "ap-launch-1", Some(FUTURE));

    let outcome = ep
        .dispatch_with_approval(db.conn(), &inp, &approval, &vk, NOW)
        .unwrap();
    assert_eq!(
        outcome.result.status,
        IntentStatus::Unavailable,
        "a valid Allow does NOT fake the OS effect"
    );
    assert_ne!(outcome.result.status, IntentStatus::Completed);
    assert_eq!(outcome.result.message, UNIMPLEMENTED_EXECUTION_MARKER);
    assert!(outcome.execution_deferred);
    // The approval WAS verified-Allow (the action was authorized) and the nonce WAS
    // consumed — the deferral is the executor's, not the gate's.
    let trail = list_approval_records(db.conn(), "i-launch").unwrap();
    assert_eq!(trail[0].decision, DecisionLabel::Allow);
    assert_eq!(consumed_count(&db), 1);
}

/// `recover_ui` is OS-affecting (its TS handler hides the companion overlay + reads
/// companion status, beyond the lease-revoke) → even with a valid approval it stays
/// `unavailable`, never faked-`completed` from only the lease leg.
#[test]
fn recover_ui_with_valid_approval_stays_unavailable_not_completed() {
    let db = Db::open_hub(&tmp("recover-unavail")).unwrap();
    let ep = enabled_ep();
    let (sk, vk) = operator();
    let inp = input(
        "i-recover",
        IntentAction::RecoverUi,
        "api-1",
        OwnerKind::Api,
    );
    let approval = ed25519_approval(&inp, &sk, "ap-recover-1", Some(FUTURE));

    let outcome = ep
        .dispatch_with_approval(db.conn(), &inp, &approval, &vk, NOW)
        .unwrap();
    assert_eq!(outcome.result.status, IntentStatus::Unavailable);
    assert_ne!(outcome.result.status, IntentStatus::Completed);
    assert!(outcome.execution_deferred);
}

/// Single-use: a second dispatch with the SAME approval is replay-refused (the nonce PK
/// collision in consumed_approval), so the approval does NOT re-authorize a second time.
#[test]
fn replay_of_same_approval_is_refused_and_does_not_complete_twice() {
    let db = Db::open_hub(&tmp("replay")).unwrap();
    let ep = enabled_ep();
    let (sk, vk) = operator();
    let inp1 = resume_task_input("i-r1", "task_a");
    let approval = ed25519_approval(&inp1, &sk, "ap-replay", Some(FUTURE));

    // First use: authorized (Allow) and the nonce is consumed; the domain effect is
    // deferred, so the result is `unavailable` (NOT `completed`).
    let o1 = ep
        .dispatch_with_approval(db.conn(), &inp1, &approval, &vk, NOW)
        .unwrap();
    assert_eq!(o1.result.status, IntentStatus::Unavailable);
    assert!(o1.execution_deferred);
    assert_eq!(consumed_count(&db), 1);

    // Second use of the SAME approval nonce on a FRESH intent_id (same task value, so the
    // digest still matches): replay-refused → blocked, NOT a second completion.
    let inp2 = resume_task_input("i-r2", "task_a");
    let o2 = ep
        .dispatch_with_approval(db.conn(), &inp2, &approval, &vk, NOW)
        .unwrap();
    assert_eq!(
        o2.result.status,
        IntentStatus::Blocked,
        "a replayed approval must not complete a second time"
    );
    assert_eq!(
        o2.result.gate_reason.as_deref(),
        Some("canonical_approval_replay_refused")
    );
    assert_eq!(consumed_count(&db), 1, "replay consumes no second nonce");
}

/// THE DOWNGRADE DEFENSE: an HMAC-signed approval over the SAME canonical bytes is
/// REJECTED for the protected `resume_task` action — it does NOT authorize. Non-vacuous:
/// the same intent with a real operator Ed25519 signature DOES complete.
#[test]
fn hmac_signed_approval_is_rejected_downgrade_defense() {
    let db = Db::open_hub(&tmp("downgrade")).unwrap();
    let ep = enabled_ep();
    let (sk, vk) = operator();
    let inp = resume_task_input("i-hmac", "task_b");

    // HMAC approval → rejected (no HMAC code path; verified as Ed25519 under vk).
    let hmac = hmac_approval(&inp, "ap-hmac");
    let blocked = ep
        .dispatch_with_approval(db.conn(), &inp, &hmac, &vk, NOW)
        .unwrap();
    assert_eq!(
        blocked.result.status,
        IntentStatus::Blocked,
        "an HMAC-signed approval must NOT Allow a protected action"
    );
    assert_eq!(
        blocked.result.gate_reason.as_deref(),
        Some("canonical_approval_signature_invalid")
    );
    assert_eq!(consumed_count(&db), 0, "a rejected approval burns no nonce");

    // Non-vacuous: the SAME intent, properly Ed25519-signed by the operator, IS
    // authorized (Allow) and consumes the nonce — its domain effect is deferred, so the
    // result is `unavailable` (the Allow is real, distinguishing it from the HMAC block).
    let inp2 = resume_task_input("i-hmac2", "task_b");
    let good = ed25519_approval(&inp2, &sk, "ap-good", Some(FUTURE));
    let ok = ep
        .dispatch_with_approval(db.conn(), &inp2, &good, &vk, NOW)
        .unwrap();
    assert_eq!(ok.result.status, IntentStatus::Unavailable);
    assert!(ok.execution_deferred);
    let trail = list_approval_records(db.conn(), "i-hmac2").unwrap();
    assert_eq!(trail[0].decision, DecisionLabel::Allow);
    assert_eq!(consumed_count(&db), 1);
}

/// NEVER self-mintable: an Agent/remote actor doing a reserved action (`approve`/`deny`)
/// is a hard-`Deny` EVEN with a perfectly-valid, digest-bound operator approval — the
/// gate's reserved-action rule is decided before the signature is examined. NOTHING
/// completes; no nonce is consumed.
#[test]
fn untrusted_actor_cannot_self_approve_reserved_action_even_with_valid_approval() {
    let db = Db::open_hub(&tmp("self-approve")).unwrap();
    let ep = enabled_ep();
    let (sk, vk) = operator();

    for (kind, tag) in [(OwnerKind::Agent, "ag"), (OwnerKind::Remote, "rm")] {
        for action in [IntentAction::Approve, IntentAction::Deny] {
            let id = format!("i-{tag}-{}", action.as_str());
            let mut inp = input(&id, action, "untrusted-1", kind);
            inp.target_ref = Some("close_app".to_string());
            // A valid operator approval bound to THIS exact request.
            let approval = ed25519_approval(&inp, &sk, &format!("ap-{id}"), Some(FUTURE));
            let outcome = ep
                .dispatch_with_approval(db.conn(), &inp, &approval, &vk, NOW)
                .unwrap();
            assert_eq!(
                outcome.result.status,
                IntentStatus::Blocked,
                "{kind:?}/{action:?} must hard-Deny even with a valid operator approval"
            );
            assert_eq!(
                outcome.result.gate_reason.as_deref(),
                Some("agent_cannot_execute_reserved_approval_action")
            );
            let trail = list_approval_records(db.conn(), &id).unwrap();
            assert_eq!(trail[0].decision, DecisionLabel::Deny);
        }
    }
    // The reserved-action hard-Deny is a base decision — it consumes NO nonce.
    assert_eq!(consumed_count(&db), 0);
}

/// A digest MISMATCH (an approval for a different task value) is denied — the approval
/// does not authorize THIS action. No completion, no nonce consumed.
#[test]
fn digest_mismatch_approval_is_denied() {
    let db = Db::open_hub(&tmp("digest-mismatch")).unwrap();
    let ep = enabled_ep();
    let (sk, vk) = operator();

    // Sign an approval for a DIFFERENT task value, present it against this intent.
    let other = resume_task_input("i-other", "DIFFERENT_TASK");
    let cross = ed25519_approval(&other, &sk, "ap-cross", Some(FUTURE));
    let inp = resume_task_input("i-dm", "task_c");
    let outcome = ep
        .dispatch_with_approval(db.conn(), &inp, &cross, &vk, NOW)
        .unwrap();
    assert_eq!(outcome.result.status, IntentStatus::Blocked);
    assert_eq!(
        outcome.result.gate_reason.as_deref(),
        Some("canonical_approval_digest_mismatch")
    );
    assert_eq!(consumed_count(&db), 0);
}

/// An EXPIRED approval is denied fail-closed — `resume_task` is not authorized at all.
#[test]
fn expired_approval_is_denied_fail_closed() {
    let db = Db::open_hub(&tmp("expired")).unwrap();
    let ep = enabled_ep();
    let (sk, vk) = operator();
    let inp = resume_task_input("i-exp", "task_d");
    // expires_at in the past relative to NOW.
    let past = ed25519_approval(&inp, &sk, "ap-past", Some(500));
    let outcome = ep
        .dispatch_with_approval(db.conn(), &inp, &past, &vk, NOW)
        .unwrap();
    assert_eq!(outcome.result.status, IntentStatus::Blocked);
    assert_eq!(
        outcome.result.gate_reason.as_deref(),
        Some("canonical_approval_expired")
    );
    assert_eq!(consumed_count(&db), 0);
}

/// MINT-IMPOSSIBILITY: holding ONLY the operator's PUBLIC verify key, a signature from
/// an UNRELATED (attacker) key cannot satisfy it. Nothing the Hub/attacker constructs
/// Allows a protected action.
#[test]
fn forged_signature_from_unrelated_key_is_denied() {
    let db = Db::open_hub(&tmp("forged")).unwrap();
    let ep = enabled_ep();
    let (_operator_sk, vk) = operator();
    let attacker = OperatorSigningKey::generate();
    let inp = resume_task_input("i-forge", "task_e");
    let forged = ed25519_approval(&inp, &attacker, "ap-forge", Some(FUTURE));
    let outcome = ep
        .dispatch_with_approval(db.conn(), &inp, &forged, &vk, NOW)
        .unwrap();
    assert_eq!(outcome.result.status, IntentStatus::Blocked);
    assert_eq!(
        outcome.result.gate_reason.as_deref(),
        Some("canonical_approval_signature_invalid")
    );
    assert_eq!(consumed_count(&db), 0);
}

/// The flag is fail-closed for the approval path too: a fail-closed entrypoint refuses
/// `dispatch_with_approval` BEFORE any side effect, even with a valid operator approval.
#[test]
fn approval_path_is_fail_closed_when_flag_disabled() {
    let db = Db::open_hub(&tmp("fc-approval")).unwrap();
    let ep = SystemIntentEntrypoint::fail_closed();
    let (sk, vk) = operator();
    let inp = resume_task_input("i-fc", "task_f");
    let approval = ed25519_approval(&inp, &sk, "ap-fc", Some(FUTURE));
    let err = ep.dispatch_with_approval(db.conn(), &inp, &approval, &vk, NOW);
    assert!(err.is_err(), "a disabled flag must fail-closed");
    // No request/result/lease/approval-record/nonce side effect.
    assert_eq!(db.count("system_intent_request").unwrap(), 0);
    assert_eq!(db.count("system_intent_result").unwrap(), 0);
    assert_eq!(db.count("system_control_lease").unwrap(), 0);
    assert_eq!(db.count("system_intent_approval_record").unwrap(), 0);
    assert_eq!(consumed_count(&db), 0);
}

/// A mutating intent dispatched WITHOUT any approval still Pauses (RequiresApproval →
/// blocked) — the agent can never produce the operator's offline signature. (Covers the
/// no-approval base of `dispatch_with_approval` vs the slice-1 `dispatch` block path.)
#[test]
fn explicit_owner_denial_and_missing_signature_are_denied() {
    let db = Db::open_hub(&tmp("deny-paths")).unwrap();
    let ep = enabled_ep();
    let (sk, vk) = operator();
    let inp = resume_task_input("i-deny", "task_g");

    // Explicit owner Denied (re-signed so the signature is valid but decision is Denied).
    let mut denied = ed25519_approval(&inp, &sk, "ap-d", Some(FUTURE));
    denied.decision = ApprovalDecision::Denied;
    denied.signature = Some(
        sk.sign(&canonical_approval_signature_bytes(&denied))
            .to_hex(),
    );
    let r = ep
        .dispatch_with_approval(db.conn(), &inp, &denied, &vk, NOW)
        .unwrap();
    assert_eq!(r.result.status, IntentStatus::Blocked);
    assert_eq!(
        r.result.gate_reason.as_deref(),
        Some("canonical_approval_denied")
    );

    // Missing signature → fail-closed Deny.
    let inp2 = resume_task_input("i-nosig", "task_g");
    let mut nosig = ed25519_approval(&inp2, &sk, "ap-n", Some(FUTURE));
    nosig.signature = None;
    let rn = ep
        .dispatch_with_approval(db.conn(), &inp2, &nosig, &vk, NOW)
        .unwrap();
    assert_eq!(rn.result.status, IntentStatus::Blocked);
    assert_eq!(
        rn.result.gate_reason.as_deref(),
        Some("canonical_approval_signature_missing")
    );

    assert_eq!(consumed_count(&db), 0);
}

/// CONTRACT GUARD: the approval-ingestion path is for PROTECTED (mutating/high-risk)
/// intents only. A non-protected action (a read-only `snapshot`, a lease-lifecycle
/// `request_control`) is refused fail-closed `Invalid` BEFORE any side effect — it does
/// NOT silently auto-acquire a lease here (those go through `dispatch`). Even a valid
/// operator approval cannot route a non-protected action through this path.
#[test]
fn non_protected_action_is_refused_on_the_approval_path() {
    let db = Db::open_hub(&tmp("non-protected")).unwrap();
    let ep = enabled_ep();
    let (sk, vk) = operator();

    for (action, target) in [
        (IntentAction::Snapshot, None),
        (IntentAction::RequestControl, None),
        (IntentAction::SearchFile, Some("query")),
    ] {
        let mut inp = input("i-np", action, "api-1", OwnerKind::Api);
        inp.target_ref = target.map(str::to_string);
        let approval = ed25519_approval(&inp, &sk, "ap-np", Some(FUTURE));
        let err = ep.dispatch_with_approval(db.conn(), &inp, &approval, &vk, NOW);
        assert!(
            err.is_err(),
            "{action:?} must be refused on the approval path"
        );
    }
    // Nothing was persisted and no nonce consumed (the guard is BEFORE the request insert).
    assert_eq!(db.count("system_intent_request").unwrap(), 0);
    assert_eq!(db.count("system_control_lease").unwrap(), 0);
    assert_eq!(consumed_count(&db), 0);
}
