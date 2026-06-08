//! S6b adversarial suite for the Ed25519 **verify-only** mutating-action gate.
//!
//! The point of S6b: a protected/mutating action can be Allowed by an
//! operator-Ed25519-signed approval (verify-only, the Hub holds only the public key),
//! and CANNOT be Allowed by anything the Hub could mint itself. Real SQLite (the v4
//! `consumed_approval` replay store + the v14 `pending_approval_request` table).
//!
//! The headline test is the DOWNGRADE defense: an HMAC-signed approval over the SAME
//! canonical bytes as a valid Ed25519 one is REJECTED for a protected action — the Hub,
//! holding the HMAC secret, cannot get a protected action Allowed via this policy.

mod common;

use common::temp_db_path;
use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, Actor, ActorKind, ApprovalDecision,
    CanonicalApproval, GateDecision, MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use friday_core::Risk;
use friday_crypto::{OperatorSigningKey, OperatorVerifyingKey};
use friday_storage::{
    authorize_mutating_action_ed25519, get_pending_request, persist_pending_request, Db,
    Ed25519VerifyOnlyPolicy, PendingApprovalRequest,
};

/// The HMAC secret the HUB holds (the symmetric mint==verify key). A correct verify-only
/// Ed25519 policy must make this irrelevant for protected actions.
const HUB_HMAC_SECRET: &[u8] = b"hub-held-hmac-gate-secret-0123456789";
const NOW: i64 = 1_000;
const FUTURE: i64 = 2_000;

/// Build a request through the SEALED constructor (the gate-decision trio comes from
/// `gate::classify`; `resource` is derived from the `path` param). `principal` is bound
/// into the actor → into the action digest.
fn req_with(
    action: &str,
    actor_kind: ActorKind,
    mutating: bool,
    base_risk: Risk,
    path: Option<&str>,
    principal: &str,
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
            principal_id: Some(principal.to_string()),
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
        "p1",
    )
}

/// A correctly-signed, digest-bound, future-dated **Ed25519** approval (the operator's
/// offline signature; carried as 128-hex in `CanonicalApproval.signature`).
fn ed25519_approval(
    request: &MutatingActionRequest,
    sk: &OperatorSigningKey,
    approval_id: &str,
    expires_at: Option<i64>,
) -> CanonicalApproval {
    let digest = friday_crypto::action_digest(&canonical_action_bytes(request));
    let mut a = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: approval_id.to_string(),
        action_digest: digest,
        expires_at,
        issuer: Some(CANONICAL_GATE_ISSUER.to_string()),
        signature: None,
    };
    let bytes = canonical_approval_signature_bytes(&a);
    a.signature = Some(sk.sign(&bytes).to_hex());
    a
}

/// A digest-bound, future-dated approval signed with the HUB-held HMAC secret — exactly
/// what a self-minting Hub would produce over the SAME canonical bytes.
fn hmac_approval(
    request: &MutatingActionRequest,
    approval_id: &str,
    expires_at: Option<i64>,
) -> CanonicalApproval {
    let digest = friday_crypto::action_digest(&canonical_action_bytes(request));
    let mut a = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: approval_id.to_string(),
        action_digest: digest,
        expires_at,
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

/// A fresh operator keypair; the Hub gets ONLY the verify key.
fn operator() -> (OperatorSigningKey, OperatorVerifyingKey) {
    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();
    (sk, vk)
}

#[test]
fn valid_ed25519_approval_grants_then_replay_is_refused() {
    let db = Db::open_hub(&temp_db_path("ed-grant")).unwrap();
    let (sk, vk) = operator();
    let req = mutating_req();
    let approval = ed25519_approval(&req, &sk, "ap-ed-1", Some(FUTURE));

    // First use: granted by the operator-signed approval (Hub holds only the public key).
    let r = authorize_mutating_action_ed25519(db.conn(), &req, Some(&approval), &vk, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Allow);
    assert_eq!(r.reason, "canonical_approval_granted");
    assert_eq!(consumed_count(&db), 1);

    // Second use of the SAME approval: refused (single-use, via nonce PK collision).
    let r2 = authorize_mutating_action_ed25519(db.conn(), &req, Some(&approval), &vk, NOW).unwrap();
    assert_eq!(r2.decision, GateDecision::Deny);
    assert_eq!(r2.reason, "canonical_approval_replay_refused");
    assert_eq!(
        consumed_count(&db),
        1,
        "replay must not insert a second row"
    );
}

/// THE #1 TEST — the downgrade defense. An HMAC-signed approval over the SAME canonical
/// bytes as a valid Ed25519 one is REJECTED for a protected action; so is a correctly
/// sized but bogus 64-byte value and malformed hex. The Hub, holding the HMAC secret,
/// cannot get the protected action Allowed via the verify-only Ed25519 policy. The valid
/// Ed25519 approval then DOES grant (non-vacuous).
#[test]
fn downgrade_hmac_signed_approval_is_rejected_for_protected_action() {
    let db = Db::open_hub(&temp_db_path("ed-downgrade")).unwrap();
    let (sk, vk) = operator();
    let req = mutating_req();

    // (a) The Hub mints a perfectly valid HMAC approval over the same canonical bytes.
    //     Verify-only Ed25519 policy rejects it — no HMAC code path, no secret consulted.
    let hmac = hmac_approval(&req, "ap-ed-1", Some(FUTURE));
    let r = authorize_mutating_action_ed25519(db.conn(), &req, Some(&hmac), &vk, NOW).unwrap();
    assert_eq!(
        r.decision,
        GateDecision::Deny,
        "an HMAC-signed approval must NOT Allow a protected action"
    );
    assert_eq!(r.reason, "canonical_approval_signature_invalid");

    // (c) A right-LENGTH (64-byte / 128-hex) but bogus value — proves it is not merely a
    //     length check: a valid-shaped non-signature still fails Ed25519 verify_strict.
    let mut bogus = ed25519_approval(&req, &sk, "ap-ed-1", Some(FUTURE));
    bogus.signature = Some("ab".repeat(64)); // 128 hex chars => 64 bytes, not a real sig
    let rb = authorize_mutating_action_ed25519(db.conn(), &req, Some(&bogus), &vk, NOW).unwrap();
    assert_eq!(rb.decision, GateDecision::Deny);
    assert_eq!(rb.reason, "canonical_approval_signature_invalid");

    // (d) Malformed hex (odd length / non-hex) — fail closed, never panic.
    let mut malformed = ed25519_approval(&req, &sk, "ap-ed-1", Some(FUTURE));
    malformed.signature = Some("zzz".to_string());
    let rm =
        authorize_mutating_action_ed25519(db.conn(), &req, Some(&malformed), &vk, NOW).unwrap();
    assert_eq!(rm.decision, GateDecision::Deny);
    assert_eq!(rm.reason, "canonical_approval_signature_invalid");

    // None of the rejected approvals burned the nonce.
    assert_eq!(
        consumed_count(&db),
        0,
        "a rejected approval consumes no nonce"
    );

    // (b) NON-VACUOUS: the SAME action, properly Ed25519-signed, DOES grant.
    let good = ed25519_approval(&req, &sk, "ap-ed-1", Some(FUTURE));
    let rg = authorize_mutating_action_ed25519(db.conn(), &req, Some(&good), &vk, NOW).unwrap();
    assert_eq!(rg.decision, GateDecision::Allow);
    assert_eq!(rg.reason, "canonical_approval_granted");
    assert_eq!(consumed_count(&db), 1);
}

/// Single-use is keyed on the NONCE, not the signature: the same `approval_id` re-signed
/// with a DIFFERENT expiry (different signed bytes ⇒ different signature) is still refused
/// on its second use. (Keying on the signature would have let the nonce be spent twice.)
#[test]
fn same_nonce_resigned_with_different_expiry_is_still_replay_refused() {
    let db = Db::open_hub(&temp_db_path("ed-nonce")).unwrap();
    let (sk, vk) = operator();
    let req = mutating_req();

    let first = ed25519_approval(&req, &sk, "ap-nonce", Some(FUTURE));
    let r1 = authorize_mutating_action_ed25519(db.conn(), &req, Some(&first), &vk, NOW).unwrap();
    assert_eq!(r1.decision, GateDecision::Allow);

    // SAME nonce, different (still-future) expiry → re-signed → a valid, distinct signature.
    let resigned = ed25519_approval(&req, &sk, "ap-nonce", Some(FUTURE + 5_000));
    assert_ne!(
        first.signature, resigned.signature,
        "different expiry must produce a different signature (precondition)"
    );
    let r2 = authorize_mutating_action_ed25519(db.conn(), &req, Some(&resigned), &vk, NOW).unwrap();
    assert_eq!(r2.decision, GateDecision::Deny);
    assert_eq!(r2.reason, "canonical_approval_replay_refused");
    assert_eq!(consumed_count(&db), 1);
}

#[test]
fn no_approval_stays_requires_approval_and_does_not_touch_replay_store() {
    let db = Db::open_hub(&temp_db_path("ed-none")).unwrap();
    let (_sk, vk) = operator();
    let req = mutating_req();
    let r = authorize_mutating_action_ed25519(db.conn(), &req, None, &vk, NOW).unwrap();
    assert_eq!(
        r.decision,
        GateDecision::RequiresApproval,
        "no approval ⇒ Pause"
    );
    assert_eq!(consumed_count(&db), 0);
}

#[test]
fn wrong_binding_digest_and_principal_mismatch_are_denied() {
    let db = Db::open_hub(&temp_db_path("ed-bind")).unwrap();
    let (sk, vk) = operator();
    let req = mutating_req();

    // Different RESOURCE → different digest. Sign for the other action, present against req.
    let other = req_with(
        "delete_file",
        ActorKind::Owner,
        true,
        Risk::Medium,
        Some("/data/OTHER.db"),
        "p1",
    );
    let cross = ed25519_approval(&other, &sk, "ap-x", Some(FUTURE));
    let r = authorize_mutating_action_ed25519(db.conn(), &req, Some(&cross), &vk, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_digest_mismatch");

    // Different PRINCIPAL → different digest (principal is bound into canonical bytes).
    let other_principal = req_with(
        "delete_file",
        ActorKind::Owner,
        true,
        Risk::Medium,
        Some("/data/secret.db"),
        "p2",
    );
    let cross_p = ed25519_approval(&other_principal, &sk, "ap-y", Some(FUTURE));
    let r2 = authorize_mutating_action_ed25519(db.conn(), &req, Some(&cross_p), &vk, NOW).unwrap();
    assert_eq!(r2.decision, GateDecision::Deny);
    assert_eq!(r2.reason, "canonical_approval_digest_mismatch");

    assert_eq!(consumed_count(&db), 0);
}

#[test]
fn expired_and_missing_expiry_are_denied_fail_closed() {
    let db = Db::open_hub(&temp_db_path("ed-exp")).unwrap();
    let (sk, vk) = operator();
    let req = mutating_req();

    // expires_at in the past.
    let past = ed25519_approval(&req, &sk, "ap-past", Some(500));
    let r = authorize_mutating_action_ed25519(db.conn(), &req, Some(&past), &vk, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_expired");

    // no expiry at all → fail-closed (an approval MUST carry one).
    let none = ed25519_approval(&req, &sk, "ap-noexp", None);
    let r2 = authorize_mutating_action_ed25519(db.conn(), &req, Some(&none), &vk, NOW).unwrap();
    assert_eq!(r2.decision, GateDecision::Deny);
    assert_eq!(r2.reason, "canonical_approval_expiration_required");

    assert_eq!(consumed_count(&db), 0);
}

#[test]
fn explicit_owner_denial_bad_issuer_and_missing_signature_are_denied() {
    let db = Db::open_hub(&temp_db_path("ed-deny")).unwrap();
    let (sk, vk) = operator();
    let req = mutating_req();

    // Explicit owner Denied (re-signed so the signature is valid but decision is Denied).
    let mut denied = ed25519_approval(&req, &sk, "ap-d", Some(FUTURE));
    denied.decision = ApprovalDecision::Denied;
    denied.signature = Some(
        sk.sign(&canonical_approval_signature_bytes(&denied))
            .to_hex(),
    );
    let r = authorize_mutating_action_ed25519(db.conn(), &req, Some(&denied), &vk, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_denied");

    // Wrong issuer.
    let mut bad_issuer = ed25519_approval(&req, &sk, "ap-i", Some(FUTURE));
    bad_issuer.issuer = Some("not_the_gate".to_string());
    bad_issuer.signature = Some(
        sk.sign(&canonical_approval_signature_bytes(&bad_issuer))
            .to_hex(),
    );
    let ri =
        authorize_mutating_action_ed25519(db.conn(), &req, Some(&bad_issuer), &vk, NOW).unwrap();
    assert_eq!(ri.decision, GateDecision::Deny);
    assert_eq!(ri.reason, "canonical_approval_bad_issuer");

    // Missing signature.
    let mut nosig = ed25519_approval(&req, &sk, "ap-n", Some(FUTURE));
    nosig.signature = None;
    let rn = authorize_mutating_action_ed25519(db.conn(), &req, Some(&nosig), &vk, NOW).unwrap();
    assert_eq!(rn.decision, GateDecision::Deny);
    assert_eq!(rn.reason, "canonical_approval_signature_missing");

    assert_eq!(consumed_count(&db), 0);
}

/// Mint-impossibility: holding ONLY the operator's PUBLIC verify key, nothing the Hub can
/// construct Allows a protected action. A signature from an UNRELATED key, the public-key
/// bytes used as a candidate signature, and an HMAC over the same bytes all fail.
#[test]
fn holding_only_the_public_key_cannot_mint_an_allow() {
    let db = Db::open_hub(&temp_db_path("ed-mint")).unwrap();
    let (_operator_sk, vk) = operator();
    let req = mutating_req();

    // An unrelated signing key (an attacker's own keypair) cannot satisfy the operator vk.
    let attacker = OperatorSigningKey::generate();
    let forged = ed25519_approval(&req, &attacker, "ap-f", Some(FUTURE));
    let rf = authorize_mutating_action_ed25519(db.conn(), &req, Some(&forged), &vk, NOW).unwrap();
    assert_eq!(rf.decision, GateDecision::Deny);
    assert_eq!(rf.reason, "canonical_approval_signature_invalid");

    // The public-key bytes themselves, padded to 64 bytes, are not a signature.
    let mut from_pub = ed25519_approval(&req, &_operator_sk, "ap-p", Some(FUTURE));
    let mut padded = [0u8; 64];
    padded[..32].copy_from_slice(&vk.to_bytes());
    from_pub.signature = Some(friday_crypto::ApprovalSig::from_bytes(&padded).to_hex());
    let rp = authorize_mutating_action_ed25519(db.conn(), &req, Some(&from_pub), &vk, NOW).unwrap();
    assert_eq!(rp.decision, GateDecision::Deny);
    assert_eq!(rp.reason, "canonical_approval_signature_invalid");

    // An HMAC over the same bytes (the Hub's symmetric mint capability) — rejected.
    let hmac = hmac_approval(&req, "ap-h", Some(FUTURE));
    let rh = authorize_mutating_action_ed25519(db.conn(), &req, Some(&hmac), &vk, NOW).unwrap();
    assert_eq!(rh.decision, GateDecision::Deny);

    assert_eq!(consumed_count(&db), 0, "no Allow ⇒ no nonce consumed");
}

/// The bound-principal rule is intact and is decided BEFORE any signature is examined: an
/// Agent/Channel attempting a reserved approval action is a hard Deny even with a valid
/// operator-signed approval; a mutating action with no approval still Pauses.
#[test]
fn bound_principal_rule_intact_agent_and_channel_cannot_self_approve() {
    let db = Db::open_hub(&temp_db_path("ed-bound")).unwrap();
    let (sk, vk) = operator();

    for (kind, reason) in [
        (
            ActorKind::Agent,
            "agent_cannot_execute_reserved_approval_action",
        ),
        (
            ActorKind::Channel,
            "channel_cannot_execute_reserved_approval_action",
        ),
    ] {
        let mut req = mutating_req();
        req.action = "approve".to_string();
        req.actor.kind = kind;
        // Even WITH a digest-bound, valid operator signature, the reserved-action Deny wins.
        let approval = ed25519_approval(&req, &sk, "ap-r", Some(FUTURE));
        let r =
            authorize_mutating_action_ed25519(db.conn(), &req, Some(&approval), &vk, NOW).unwrap();
        assert_eq!(r.decision, GateDecision::Deny, "kind={kind:?}");
        assert_eq!(r.reason, reason);
    }

    // A normal mutating action with NO approval still Pauses (the agent can never produce
    // the operator's offline signature).
    let mut agent_write = mutating_req();
    agent_write.actor.kind = ActorKind::Agent;
    let p = authorize_mutating_action_ed25519(db.conn(), &agent_write, None, &vk, NOW).unwrap();
    assert_eq!(p.decision, GateDecision::RequiresApproval);

    assert_eq!(consumed_count(&db), 0);
}

#[test]
fn base_allow_and_base_deny_bypass_approval_and_replay_store() {
    let db = Db::open_hub(&temp_db_path("ed-base")).unwrap();
    let (sk, vk) = operator();

    // Base Allow: a non-mutating, low-risk read — approval irrelevant, table untouched.
    let ro = req_with(
        "read_file",
        ActorKind::Owner,
        false,
        Risk::ReadOnly,
        Some("/data/secret.db"),
        "p1",
    );
    let r = authorize_mutating_action_ed25519(db.conn(), &ro, None, &vk, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Allow);

    // Base Deny (agent reserved): hard Deny regardless of a valid approval.
    let mut agent = mutating_req();
    agent.action = "approve".to_string();
    agent.actor.kind = ActorKind::Agent;
    let approval = ed25519_approval(&agent, &sk, "ap-b", Some(FUTURE));
    let r2 =
        authorize_mutating_action_ed25519(db.conn(), &agent, Some(&approval), &vk, NOW).unwrap();
    assert_eq!(r2.decision, GateDecision::Deny);
    assert_eq!(r2.reason, "agent_cannot_execute_reserved_approval_action");

    assert_eq!(consumed_count(&db), 0);
}

/// The verify-only policy wrapper holds ONLY the public key and authorizes identically.
#[test]
fn verify_only_policy_wrapper_grants_and_rejects_hmac() {
    let db = Db::open_hub(&temp_db_path("ed-policy")).unwrap();
    let (sk, vk) = operator();
    let policy = Ed25519VerifyOnlyPolicy::new(vk);
    let req = mutating_req();

    // HMAC over the same bytes → rejected through the policy.
    let hmac = hmac_approval(&req, "ap-pol", Some(FUTURE));
    let rh = policy.authorize(db.conn(), &req, Some(&hmac), NOW).unwrap();
    assert_eq!(rh.decision, GateDecision::Deny);

    // Operator Ed25519 → Allow through the policy.
    let good = ed25519_approval(&req, &sk, "ap-pol", Some(FUTURE));
    let rg = policy.authorize(db.conn(), &req, Some(&good), NOW).unwrap();
    assert_eq!(rg.decision, GateDecision::Allow);
}

// ── pending-request persistence (the offline operator's to-sign work item) ──────────

#[test]
fn pending_request_persists_with_correct_binding_and_rejects_duplicate_nonce() {
    let db = Db::open_hub(&temp_db_path("ed-pending")).unwrap();
    let req = mutating_req();
    let expected_digest = friday_crypto::action_digest(&canonical_action_bytes(&req));

    let pending = PendingApprovalRequest::for_request(&req, "ap-pending", "run-7", FUTURE, NOW);
    persist_pending_request(db.conn(), &pending).unwrap();

    let got = get_pending_request(db.conn(), "ap-pending")
        .unwrap()
        .expect("pending row present");
    // The persisted digest binds the EXACT action an approval must match.
    assert_eq!(got.action_digest, expected_digest);
    assert_eq!(got.approval_id, "ap-pending");
    assert_eq!(got.run_id, "run-7");
    assert_eq!(got.action, "delete_file");
    assert_eq!(got.principal_id.as_deref(), Some("p1"));
    assert_eq!(got.surface, "system");
    assert_eq!(got.resource_type.as_deref(), Some("file"));
    assert_eq!(got.resource_id.as_deref(), Some("/data/secret.db"));
    assert_eq!(got.expires_at, FUTURE);
    assert_eq!(got.issuer, CANONICAL_GATE_ISSUER);
    assert_eq!(got.status, "pending");

    // The persisted pending request is exactly the binding an operator can sign and have
    // accepted: sign over its (approval_id, action_digest, expiry, issuer) → Allow.
    let (sk, vk) = operator();
    let approval = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: got.approval_id.clone(),
        action_digest: got.action_digest.clone(),
        expires_at: Some(got.expires_at),
        issuer: Some(got.issuer.clone()),
        signature: None,
    };
    let mut approval = approval;
    approval.signature = Some(
        sk.sign(&canonical_approval_signature_bytes(&approval))
            .to_hex(),
    );
    let r = authorize_mutating_action_ed25519(db.conn(), &req, Some(&approval), &vk, NOW).unwrap();
    assert_eq!(
        r.decision,
        GateDecision::Allow,
        "an approval built from the persisted pending binding must be accepted"
    );

    // A duplicate nonce is a fail-closed insert error (a nonce is never silently reused).
    let dup = PendingApprovalRequest::for_request(&req, "ap-pending", "run-9", FUTURE, NOW);
    assert!(
        persist_pending_request(db.conn(), &dup).is_err(),
        "duplicate approval_id (nonce) must be refused"
    );
}
