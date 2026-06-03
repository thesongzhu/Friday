//! PR-3b: canonical mutating-action authorization — crypto-bound, single-use,
//! fail-closed. Real SQLite (the v4 `consumed_approval` replay store). Proves the
//! ONLY path to `Allow` for a mutating action is a digest-bound, signature-valid,
//! unexpired, unspent approval — and that double-spend / tamper / expiry all Deny.

mod common;

use common::temp_db_path;
use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, Actor, ActorKind, ApprovalDecision,
    CanonicalApproval, GateDecision, MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use friday_core::Risk;
use friday_storage::{authorize_mutating_action, Db};

const SECRET: &[u8] = b"gate-signing-secret";
const NOW: i64 = 1_000;
const FUTURE: i64 = 2_000;

/// Build a request through the SEALED constructor (task #29): the gate-decision trio
/// (`mutating`/`risk`/`resource`) comes from `gate::classify` — there is no struct
/// literal path. `resource` is derived from the `path` param, mirroring `build_request`.
fn req_with(
    action: &str,
    actor_kind: ActorKind,
    mutating: bool,
    base_risk: Risk,
    path: Option<&str>,
) -> MutatingActionRequest {
    let params: Vec<(String, String)> = path
        .map(|p| vec![("path".to_string(), p.to_string())])
        .unwrap_or_default();
    MutatingActionRequest::from_classification(
        friday_core::gate::classify(mutating, base_risk, action, &params),
        action.to_string(),
        Actor {
            kind: actor_kind,
            id: "owner-1".to_string(),
            principal_id: Some("p1".to_string()),
        },
        "system".to_string(),
        vec![],
        None,
        Some("idem-1".to_string()),
        None,
    )
}

fn mutating_req() -> MutatingActionRequest {
    req_with(
        "delete_file",
        ActorKind::Owner,
        true,
        Risk::Medium,
        Some("/data/secret.db"),
    )
}

/// A correctly-signed, digest-bound, future-dated approval for `request`.
fn signed_approval(request: &MutatingActionRequest, expires_at: Option<i64>) -> CanonicalApproval {
    let digest = friday_crypto::action_digest(&canonical_action_bytes(request));
    let mut a = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: "ap-1".to_string(),
        action_digest: digest,
        expires_at,
        issuer: Some(CANONICAL_GATE_ISSUER.to_string()),
        signature: None,
    };
    a.signature = Some(friday_crypto::sign_approval(
        &canonical_approval_signature_bytes(&a),
        SECRET,
    ));
    a
}

fn consumed_count(db: &Db) -> i64 {
    db.conn()
        .query_row("SELECT count(*) FROM consumed_approval", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn valid_approval_grants_then_replay_is_refused() {
    let db = Db::open_hub(&temp_db_path("authz-grant")).unwrap();
    let req = mutating_req();
    let approval = signed_approval(&req, Some(FUTURE));

    // First use: granted.
    let r = authorize_mutating_action(db.conn(), &req, Some(&approval), SECRET, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Allow);
    assert_eq!(r.reason, "canonical_approval_granted");
    assert_eq!(consumed_count(&db), 1);

    // Second use of the SAME approval: refused (single-use, via PK collision).
    let r2 = authorize_mutating_action(db.conn(), &req, Some(&approval), SECRET, NOW).unwrap();
    assert_eq!(r2.decision, GateDecision::Deny);
    assert_eq!(r2.reason, "canonical_approval_replay_refused");
    assert_eq!(
        consumed_count(&db),
        1,
        "replay must not insert a second row"
    );
}

#[test]
fn no_approval_stays_requires_approval_and_does_not_touch_replay_store() {
    let db = Db::open_hub(&temp_db_path("authz-none")).unwrap();
    let req = mutating_req();
    let r = authorize_mutating_action(db.conn(), &req, None, SECRET, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::RequiresApproval);
    assert_eq!(consumed_count(&db), 0);
}

#[test]
fn digest_mismatch_is_denied() {
    let db = Db::open_hub(&temp_db_path("authz-digest")).unwrap();
    let req = mutating_req();
    let mut approval = signed_approval(&req, Some(FUTURE));
    // Re-point the approval at a DIFFERENT action (different resource) and re-sign it
    // so the signature is valid but the digest no longer matches `req`.
    let other = req_with(
        "delete_file",
        ActorKind::Owner,
        true,
        Risk::Medium,
        Some("/data/OTHER.db"),
    );
    approval.action_digest = friday_crypto::action_digest(&canonical_action_bytes(&other));
    approval.signature = Some(friday_crypto::sign_approval(
        &canonical_approval_signature_bytes(&approval),
        SECRET,
    ));
    let r = authorize_mutating_action(db.conn(), &req, Some(&approval), SECRET, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_digest_mismatch");
    assert_eq!(consumed_count(&db), 0);
}

#[test]
fn bad_signature_is_denied_and_does_not_burn_the_key() {
    let db = Db::open_hub(&temp_db_path("authz-sig")).unwrap();
    let req = mutating_req();
    let mut approval = signed_approval(&req, Some(FUTURE));
    let good_sig = approval.signature.clone().unwrap();
    // Tamper the signature (flip a hex char) -> verify fails -> Deny, NO insert.
    approval.signature = Some(format!("0{}", &good_sig[1..]));
    let r = authorize_mutating_action(db.conn(), &req, Some(&approval), SECRET, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_signature_invalid");
    assert_eq!(
        consumed_count(&db),
        0,
        "a rejected approval must not consume a key"
    );

    // The same approval, now with its VALID signature, still grants (key not burned).
    approval.signature = Some(good_sig);
    let r2 = authorize_mutating_action(db.conn(), &req, Some(&approval), SECRET, NOW).unwrap();
    assert_eq!(r2.decision, GateDecision::Allow);
}

#[test]
fn wrong_secret_is_denied() {
    let db = Db::open_hub(&temp_db_path("authz-secret")).unwrap();
    let req = mutating_req();
    let approval = signed_approval(&req, Some(FUTURE)); // signed with SECRET
    let r =
        authorize_mutating_action(db.conn(), &req, Some(&approval), b"WRONG-secret", NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_signature_invalid");
}

#[test]
fn expired_and_missing_expiry_are_denied() {
    let db = Db::open_hub(&temp_db_path("authz-exp")).unwrap();
    let req = mutating_req();
    // expires_at in the past.
    let past = signed_approval(&req, Some(500));
    let r = authorize_mutating_action(db.conn(), &req, Some(&past), SECRET, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_expired");
    // no expiry at all -> fail-closed.
    let none = signed_approval(&req, None);
    let r2 = authorize_mutating_action(db.conn(), &req, Some(&none), SECRET, NOW).unwrap();
    assert_eq!(r2.decision, GateDecision::Deny);
    assert_eq!(r2.reason, "canonical_approval_expiration_required");
    assert_eq!(consumed_count(&db), 0);
}

#[test]
fn explicit_owner_denial_is_denied() {
    let db = Db::open_hub(&temp_db_path("authz-deny")).unwrap();
    let req = mutating_req();
    let mut approval = signed_approval(&req, Some(FUTURE));
    approval.decision = ApprovalDecision::Denied;
    approval.signature = Some(friday_crypto::sign_approval(
        &canonical_approval_signature_bytes(&approval),
        SECRET,
    ));
    let r = authorize_mutating_action(db.conn(), &req, Some(&approval), SECRET, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_denied");
}

#[test]
fn base_allow_and_base_deny_bypass_approval_and_replay_store() {
    let db = Db::open_hub(&temp_db_path("authz-base")).unwrap();
    // Base Allow: a non-mutating, low-risk action — approval irrelevant, table untouched.
    let ro = req_with(
        "read_file",
        ActorKind::Owner,
        false,
        Risk::ReadOnly,
        Some("/data/secret.db"),
    );
    let r = authorize_mutating_action(db.conn(), &ro, None, SECRET, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Allow);

    // Base Deny: an agent attempting a reserved approval action — hard Deny regardless
    // of any presented approval; never consults the replay store.
    let mut agent = mutating_req();
    agent.action = "approve".to_string();
    agent.actor.kind = ActorKind::Agent;
    let approval = signed_approval(&agent, Some(FUTURE));
    let r2 = authorize_mutating_action(db.conn(), &agent, Some(&approval), SECRET, NOW).unwrap();
    assert_eq!(r2.decision, GateDecision::Deny);
    assert_eq!(r2.reason, "agent_cannot_execute_reserved_approval_action");

    assert_eq!(consumed_count(&db), 0);
}
