//! S6a field-level adversarial proof: the Ed25519 signature over an approval's
//! REAL canonical bytes (`friday-core::gate::canonical_approval_signature_bytes`)
//! covers EVERY bound field — at both levels:
//!
//!  - approval-level (directly serialized): decision, approval_id (the single-use
//!    nonce), action_digest (the action-hash), expires_at (expiry), issuer; and
//!  - request-level (bound TRANSITIVELY through `action_digest =
//!    SHA256(canonical_action_bytes)`): principal_id, action, surface, resource
//!    (scope).
//!
//! For each field we sign a baseline approval, mutate exactly that field, rebuild
//! the canonical bytes, and assert the ORIGINAL signature no longer verifies. This
//! is the same coverage the symmetric HMAC path has — proven against the same
//! gate-built bytes — but with operator-private-key / hub-public-key separation.
//!
//! `friday-core` is a DEV-only dependency here (tests build real domain bytes);
//! `friday-crypto` stays domain-free in its shipped dependency graph.

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, classify, Actor, ActorKind,
    ApprovalDecision, CanonicalApproval, MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use friday_core::Risk;
use friday_crypto::ed25519_approval::OperatorSigningKey;

const FUTURE: i64 = 2_000;

/// Build a request through the SEALED constructor (the gate-decision trio comes
/// from `classify`; `resource` is derived from the `path` param — mirrors the
/// Hub's `build_request` and `friday-storage`'s authorize tests).
fn req(action: &str, principal: &str, surface: &str, path: &str) -> MutatingActionRequest {
    let params = vec![("path".to_string(), path.to_string())];
    MutatingActionRequest::from_classification(
        classify(true, Risk::Medium, action, &params),
        action.to_string(),
        Actor {
            kind: ActorKind::Owner,
            id: "owner-1".to_string(),
            principal_id: Some(principal.to_string()),
        },
        surface.to_string(),
        vec![],
        None,
        Some("idem-1".to_string()),
        None,
    )
}

fn baseline_req() -> MutatingActionRequest {
    req("delete_file", "principal-A", "system", "/data/secret.db")
}

/// A canonical approval bound to `request`, with the given mutable fields.
fn approval_for(
    request: &MutatingActionRequest,
    decision: ApprovalDecision,
    approval_id: &str,
    expires_at: Option<i64>,
    issuer: Option<&str>,
) -> CanonicalApproval {
    CanonicalApproval {
        decision,
        approval_id: approval_id.to_string(),
        action_digest: friday_crypto::action_digest(&canonical_action_bytes(request)),
        expires_at,
        issuer: issuer.map(|s| s.to_string()),
        signature: None,
    }
}

fn baseline_approval(request: &MutatingActionRequest) -> CanonicalApproval {
    approval_for(
        request,
        ApprovalDecision::Approved,
        "ap-1",
        Some(FUTURE),
        Some(CANONICAL_GATE_ISSUER),
    )
}

#[test]
fn baseline_operator_signed_approval_verifies() {
    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();
    let req = baseline_req();
    let appr = baseline_approval(&req);
    let bytes = canonical_approval_signature_bytes(&appr);
    let sig = sk.sign(&bytes);
    assert!(
        vk.verify(&bytes, &sig),
        "operator-signed approval must verify"
    );
    // And the raw-bytes hub path agrees.
    assert!(friday_crypto::verify_ed25519_approval(
        &bytes,
        &vk.to_bytes(),
        &sig.to_bytes()
    ));
}

/// The core proof: sign the baseline, then for each mutated approval assert the
/// ORIGINAL signature fails — i.e. that field is bound by the signature.
#[test]
fn every_bound_field_is_covered_by_the_signature() {
    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();

    let base_req = baseline_req();
    let base_appr = baseline_approval(&base_req);
    let base_bytes = canonical_approval_signature_bytes(&base_appr);
    let sig = sk.sign(&base_bytes);
    assert!(vk.verify(&base_bytes, &sig));

    // Helper: assert the ORIGINAL signature does NOT verify over the bytes of a
    // mutated approval (proves the mutated field is signature-bound).
    let assert_rejected = |label: &str, mutated: &CanonicalApproval| {
        let mutated_bytes = canonical_approval_signature_bytes(mutated);
        assert_ne!(
            mutated_bytes, base_bytes,
            "{label}: mutation must change the canonical bytes"
        );
        assert!(
            !vk.verify(&mutated_bytes, &sig),
            "{label}: original signature must NOT verify over mutated bytes"
        );
    };

    // ── approval-level fields (directly serialized) ──────────────────────────

    // decision: Approved -> Denied
    assert_rejected(
        "decision",
        &approval_for(
            &base_req,
            ApprovalDecision::Denied,
            "ap-1",
            Some(FUTURE),
            Some(CANONICAL_GATE_ISSUER),
        ),
    );
    // approval_id (the single-use NONCE)
    assert_rejected(
        "approval_id/nonce",
        &approval_for(
            &base_req,
            ApprovalDecision::Approved,
            "ap-DIFFERENT",
            Some(FUTURE),
            Some(CANONICAL_GATE_ISSUER),
        ),
    );
    // expires_at (EXPIRY): different value
    assert_rejected(
        "expiry value",
        &approval_for(
            &base_req,
            ApprovalDecision::Approved,
            "ap-1",
            Some(FUTURE + 1),
            Some(CANONICAL_GATE_ISSUER),
        ),
    );
    // expires_at: None (presence tag flips) — an attacker cannot strip the expiry.
    assert_rejected(
        "expiry presence",
        &approval_for(
            &base_req,
            ApprovalDecision::Approved,
            "ap-1",
            None,
            Some(CANONICAL_GATE_ISSUER),
        ),
    );
    // issuer: different value
    assert_rejected(
        "issuer value",
        &approval_for(
            &base_req,
            ApprovalDecision::Approved,
            "ap-1",
            Some(FUTURE),
            Some("not_the_canonical_gate"),
        ),
    );
    // issuer: None (presence tag flips)
    assert_rejected(
        "issuer presence",
        &approval_for(
            &base_req,
            ApprovalDecision::Approved,
            "ap-1",
            Some(FUTURE),
            None,
        ),
    );
    // action_digest (ACTION-HASH) directly repointed to a different action's digest.
    {
        let other = req("delete_file", "principal-A", "system", "/data/OTHER.db");
        let mut a = base_appr.clone();
        a.action_digest = friday_crypto::action_digest(&canonical_action_bytes(&other));
        assert_rejected("action_digest", &a);
    }

    // ── request-level fields (bound TRANSITIVELY via action_digest) ──────────
    // Each mutates the REQUEST, recomputes action_digest, and rebuilds the approval.

    // principal_id — the bound-principal field
    assert_rejected(
        "principal_id",
        &baseline_approval(&req(
            "delete_file",
            "principal-B",
            "system",
            "/data/secret.db",
        )),
    );
    // action (verb)
    assert_rejected(
        "action",
        &baseline_approval(&req(
            "write_file",
            "principal-A",
            "system",
            "/data/secret.db",
        )),
    );
    // surface
    assert_rejected(
        "surface",
        &baseline_approval(&req(
            "delete_file",
            "principal-A",
            "telegram",
            "/data/secret.db",
        )),
    );
    // resource / scope (the path → resource id in the digest)
    assert_rejected(
        "resource/scope",
        &baseline_approval(&req(
            "delete_file",
            "principal-A",
            "system",
            "/data/OTHER.db",
        )),
    );
}

/// Cross-actor: an approval bound to one principal does not verify when re-pointed
/// at a request from a DIFFERENT principal — even though the signature itself is
/// internally valid for its own (other-principal) bytes. Proves principal binding
/// is not bypassable by swapping the live request.
#[test]
fn approval_does_not_transfer_across_principals() {
    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();

    let req_a = req("delete_file", "principal-A", "system", "/data/secret.db");
    let appr_a = baseline_approval(&req_a);
    let bytes_a = canonical_approval_signature_bytes(&appr_a);
    let sig_a = sk.sign(&bytes_a);
    assert!(vk.verify(&bytes_a, &sig_a)); // valid for principal-A's action

    // The same approval id/expiry/issuer but bound to principal-B's action digest.
    let req_b = req("delete_file", "principal-B", "system", "/data/secret.db");
    let appr_b = baseline_approval(&req_b);
    let bytes_b = canonical_approval_signature_bytes(&appr_b);
    // principal-A's signature must NOT cover principal-B's action bytes.
    assert!(!vk.verify(&bytes_b, &sig_a));
}
