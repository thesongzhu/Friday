//! S6d adversarial suite — the protected-path switch (HMAC → Ed25519 verify-only), the
//! operator-controlled verify-key provisioning, the resume/ingestion entrypoint, and the
//! CSPRNG Pause nonce.
//!
//! This lives in `tests/` (NOT `src/`) BECAUSE it must construct an operator SIGNING key to
//! play the offline operator — and `friday-hub/src/**` is forbidden from ever referencing
//! `OperatorSigningKey` (the key-substitution defense, asserted by
//! `operator_vk::tests::hub_crate_never_references_a_signing_key`). The Hub never holds a
//! signing key; here the TEST holds it, exactly as the real operator does off-Hub.
//!
//! Coverage:
//!   - protected action + NO approval → Pauses, executes nothing, persists a pending
//!     request with a CSPRNG nonce (DenyAll-equivalent);
//!   - protected action + VALID operator-Ed25519 approval → completes EXACTLY ONE mutation;
//!     a SECOND ingest of the same approval → replay-refused (single-use), no 2nd mutation;
//!   - HMAC downgrade: a protected action canNOT be Allowed by an HMAC approval, at the loop
//!     AND at the resume entrypoint, even with an operator key provisioned;
//!   - key-substitution: a DIFFERENT (attacker) operator key cannot resume; the operator's
//!     signature only verifies under the operator's provisioned key;
//!   - wrong-digest / expired / unknown-nonce → refused, no mutation.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, ApprovalDecision,
    CanonicalApproval, GateDecision, MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use friday_crypto::{OperatorSigningKey, OperatorVerifyingKey};
use friday_hub::resume::{resume_with_approval, ResumeError};
use friday_hub::{
    build_request_with_policy, run_loop_with_policy, AgentError, AgentLlmClient, AgentStep,
    FsToolExecutor, LoopStatus, RawToolCall, RunPolicy, TurnTrace,
};
use friday_storage::{
    agent_run, get_run_answer_for_principal, get_run_result, list_pending_requests_for_run,
    AnswerDenyReason, Db, RunAnswerAccess,
};

static C: AtomicU64 = AtomicU64::new(0);

fn unique(tag: &str) -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        tag,
        C.fetch_add(1, Ordering::Relaxed)
    )
}

fn temp_db(tag: &str) -> String {
    std::env::temp_dir()
        .join(format!("friday-s6d-{}.sqlite", unique(tag)))
        .to_string_lossy()
        .into_owned()
}

struct Workspace(std::path::PathBuf);
impl Workspace {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("friday-s6d-ws-{}", unique(tag)));
        std::fs::create_dir_all(&p).unwrap();
        Workspace(p)
    }
    fn join(&self, n: &str) -> std::path::PathBuf {
        self.0.join(n)
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A scripted model client: returns the next pre-canned `AgentStep` each turn, finishing
/// when the script runs out. (Bills nothing — the default `next_step_metered`.)
struct Script {
    steps: RefCell<std::vec::IntoIter<AgentStep>>,
}
impl Script {
    fn new(steps: Vec<AgentStep>) -> Self {
        Script {
            steps: RefCell::new(steps.into_iter()),
        }
    }
}
impl AgentLlmClient for Script {
    fn propose_tool_call(&self, _task: &str) -> Result<RawToolCall, AgentError> {
        // Unused: we override next_step. Fail closed if ever called.
        Err(AgentError::Model("propose_tool_call unused".into()))
    }
    fn next_step(&self, _task: &str, _history: &[TurnTrace]) -> Result<AgentStep, AgentError> {
        Ok(self.steps.borrow_mut().next().unwrap_or(AgentStep::Finish {
            message: "done".into(),
        }))
    }
}

fn raw(action: &str, params: &[(&str, &str)]) -> RawToolCall {
    RawToolCall {
        action: action.to_string(),
        params: params
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    }
}

/// A fresh operator keypair; the Hub gets ONLY the verify key (the test plays the operator
/// holding the signing key off-Hub).
fn operator() -> (OperatorSigningKey, OperatorVerifyingKey) {
    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();
    (sk, vk)
}

/// Build a correctly-signed operator Ed25519 approval bound to `req`'s exact digest.
fn ed_approval(
    req: &MutatingActionRequest,
    sk: &OperatorSigningKey,
    approval_id: &str,
    expires_at: Option<i64>,
) -> CanonicalApproval {
    let digest = friday_crypto::action_digest(&canonical_action_bytes(req));
    let mut a = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: approval_id.to_string(),
        action_digest: digest,
        expires_at,
        issuer: Some(CANONICAL_GATE_ISSUER.to_string()),
        signature: None,
    };
    a.signature = Some(sk.sign(&canonical_approval_signature_bytes(&a)).to_hex());
    a
}

/// An HMAC-signed approval over the SAME canonical bytes — what a self-minting Hub would
/// produce. The verify-only Ed25519 path must reject it.
fn hmac_approval(
    req: &MutatingActionRequest,
    hub_secret: &[u8],
    approval_id: &str,
    expires_at: Option<i64>,
) -> CanonicalApproval {
    let digest = friday_crypto::action_digest(&canonical_action_bytes(req));
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
        hub_secret,
    ));
    a
}

fn no_approval() -> impl Fn(&MutatingActionRequest) -> Option<CanonicalApproval> {
    |_req| None
}

const NOW: i64 = 1_000;
const FUTURE: i64 = 5_000_000_000_000;

// ─────────────────────────── loop-level: the protected-path switch ───────────────────────────

/// Protected action + NO approval → the loop Pauses, executes nothing, and persists a
/// pending request with a CSPRNG nonce (DenyAll-equivalent), EVEN WITH an operator key
/// provisioned. (No approval is presented in-loop; the operator approves OFFLINE.)
#[test]
fn loop_protected_no_approval_pauses_and_persists_csprng_pending() {
    let db = Db::open_hub(&temp_db("pause")).unwrap();
    let ws = Workspace::new("pause");
    agent_run::create_run(db.conn(), "run-pause", "write a file", 1).unwrap();
    let (_sk, vk) = operator();
    let client = Script::new(vec![AgentStep::Tool(raw(
        "write_file",
        &[("path", "out.txt"), ("content", "X")],
    ))]);
    let exec = FsToolExecutor::new(&ws.0);

    let out = run_loop_with_policy(
        &client,
        &exec,
        db.conn(),
        "run-pause",
        "write a file",
        "",
        Some(&vk), // operator key provisioned, but NO in-loop approval is presented
        &no_approval(),
        &RunPolicy::default(),
        5,
        None, // cancel: not exercised by this test
        None, // steer: not exercised by this test
        NOW,
    )
    .unwrap();

    assert_eq!(out.status, LoopStatus::Paused);
    assert_eq!(
        out.executed_tools, 0,
        "nothing executes without an approval"
    );
    assert!(!ws.join("out.txt").exists(), "no file written on Pause");

    let pending = list_pending_requests_for_run(db.conn(), "run-pause").unwrap();
    assert_eq!(pending.len(), 1, "one pending request persisted on Pause");
    let p = &pending[0];
    assert_eq!(
        p.approval_id.len(),
        64,
        "CSPRNG nonce is 32 bytes => 64 hex"
    );
    assert!(
        p.approval_id.bytes().all(|c| c.is_ascii_hexdigit()),
        "nonce is hex"
    );
    assert_eq!(p.action, "write_file");
    assert_eq!(p.status, "pending");
    assert!(
        p.tool_params.is_some(),
        "the executable tool call is persisted"
    );
}

/// Protected action + a VALID in-loop operator-Ed25519 approval → the mutation executes
/// EXACTLY once (the file is written). The positive control for the switch.
#[test]
fn loop_valid_ed25519_approval_executes_the_mutation() {
    let db = Db::open_hub(&temp_db("loop-ok")).unwrap();
    let ws = Workspace::new("loop-ok");
    agent_run::create_run(db.conn(), "run-ok", "write a file", 1).unwrap();
    let (sk, vk) = operator();
    let exec = FsToolExecutor::new(&ws.0);
    let client = Script::new(vec![
        AgentStep::Tool(raw("write_file", &[("path", "out.txt"), ("content", "OK")])),
        AgentStep::Finish {
            message: "done".into(),
        },
    ]);
    // In-loop "operator" approval seam: sign an Ed25519 approval bound to THIS request.
    let approve =
        |req: &MutatingActionRequest| Some(ed_approval(req, &sk, "ap-loop", Some(FUTURE)));

    let out = run_loop_with_policy(
        &client,
        &exec,
        db.conn(),
        "run-ok",
        "write a file",
        "",
        Some(&vk),
        &approve,
        &RunPolicy::default(),
        5,
        None, // cancel: not exercised by this test
        None, // steer: not exercised by this test
        NOW,
    )
    .unwrap();
    assert_eq!(out.status, LoopStatus::Finished);
    assert_eq!(out.executed_tools, 1, "the approved mutation executed once");
    assert_eq!(std::fs::read_to_string(ws.join("out.txt")).unwrap(), "OK");
}

/// HMAC downgrade closed AT THE LOOP, even WITH an operator key provisioned: an in-loop
/// HMAC-signed approval over the same bytes can NOT Allow the protected write — it is a
/// gate Deny → the loop Blocks, executes nothing, writes no file.
#[test]
fn loop_hmac_approval_cannot_execute_even_with_operator_key() {
    let db = Db::open_hub(&temp_db("loop-hmac")).unwrap();
    let ws = Workspace::new("loop-hmac");
    agent_run::create_run(db.conn(), "run-h", "write a file", 1).unwrap();
    let (_sk, vk) = operator();
    let hub_secret = b"hub-held-hmac-secret-0123456789ab";
    let exec = FsToolExecutor::new(&ws.0);
    let client = Script::new(vec![AgentStep::Tool(raw(
        "write_file",
        &[("path", "out.txt"), ("content", "X")],
    ))]);
    let approve =
        |req: &MutatingActionRequest| Some(hmac_approval(req, hub_secret, "ap-h", Some(FUTURE)));

    let out = run_loop_with_policy(
        &client,
        &exec,
        db.conn(),
        "run-h",
        "write a file",
        "",
        Some(&vk),
        &approve,
        &RunPolicy::default(),
        5,
        None, // cancel: not exercised by this test
        None, // steer: not exercised by this test
        NOW,
    )
    .unwrap();
    assert_eq!(
        out.status,
        LoopStatus::Blocked,
        "an HMAC approval is a gate Deny ⇒ the loop Blocks"
    );
    assert_eq!(out.executed_tools, 0);
    assert!(
        !ws.join("out.txt").exists(),
        "the HMAC approval did not complete the mutation (downgrade closed)"
    );
}

// ─────────────────────────── resume/ingestion entrypoint ───────────────────────────

/// Drive a run to a Pause under the supplied `policy`, return (db, ws, pending nonce, the
/// reconstructed request) so a resume test can sign + ingest an approval for the EXACT
/// paused action. The pending row carries the policy's `principal_id` (the digest binds
/// it), so the reconstructed request used to sign MUST be built with the SAME policy.
fn pause_a_run_with_policy(
    tag: &str,
    vk: &OperatorVerifyingKey,
    policy: &RunPolicy,
) -> (Db, Workspace, String, MutatingActionRequest) {
    let db = Db::open_hub(&temp_db(tag)).unwrap();
    let ws = Workspace::new(tag);
    let run_id = "run-resume";
    agent_run::create_run(db.conn(), run_id, "write a file", 1).unwrap();
    let call = raw("write_file", &[("path", "out.txt"), ("content", "RESUMED")]);
    let client = Script::new(vec![AgentStep::Tool(call.clone())]);
    let exec = FsToolExecutor::new(&ws.0);
    let out = run_loop_with_policy(
        &client,
        &exec,
        db.conn(),
        run_id,
        "write a file",
        "",
        Some(vk),
        &no_approval(),
        policy,
        5,
        None, // cancel: not exercised by this test
        None, // steer: not exercised by this test
        NOW,
    )
    .unwrap();
    assert_eq!(out.status, LoopStatus::Paused);
    let pending = list_pending_requests_for_run(db.conn(), run_id).unwrap();
    let nonce = pending[0].approval_id.clone();
    let request = build_request_with_policy(&call, policy).unwrap();
    (db, ws, nonce, request)
}

/// The default (no-principal) Pause helper used by the existing refusal/replay tests.
fn pause_a_run(
    tag: &str,
    vk: &OperatorVerifyingKey,
) -> (Db, Workspace, String, MutatingActionRequest) {
    pause_a_run_with_policy(tag, vk, &RunPolicy::default())
}

/// THE core S6d flow: resume with a valid operator approval executes EXACTLY ONE mutation;
/// a SECOND ingest of the same approval is replay-refused (single-use), with NO 2nd mutation.
#[test]
fn resume_executes_one_mutation_then_replay_is_refused() {
    let (sk, vk) = operator();
    let (db, ws, nonce, request) = pause_a_run("resume-ok", &vk);
    let exec = FsToolExecutor::new(&ws.0);

    // The offline operator signs the pending nonce's exact digest.
    let approval = ed_approval(&request, &sk, &nonce, Some(FUTURE));

    // First ingest → Allow → executes the one mutation.
    let r1 = resume_with_approval(db.conn(), &exec, &vk, &approval, NOW).unwrap();
    assert_eq!(r1.decision, GateDecision::Allow);
    assert!(r1.executed, "the approved mutation executed");
    assert_eq!(r1.result_status, "mutation_completed");
    assert_eq!(
        std::fs::read_to_string(ws.join("out.txt")).unwrap(),
        "RESUMED",
        "the file the operator approved was written"
    );
    // Truth-labeled, proof-linked result persisted, linking the audit receipt.
    let stored = get_run_result(db.conn(), &r1.run_id).unwrap().unwrap();
    assert_eq!(stored.status, "mutation_completed");
    assert!(stored.audit_ref.is_some(), "result links the audit receipt");

    // Tamper the file so a (refused) second execution would be detectable.
    std::fs::write(ws.join("out.txt"), b"TAMPERED").unwrap();

    // Second ingest of the SAME approval → replay-refused (consumed nonce), no 2nd mutation.
    let r2 = resume_with_approval(db.conn(), &exec, &vk, &approval, NOW).unwrap();
    assert_eq!(r2.decision, GateDecision::Deny);
    assert_eq!(r2.reason, "canonical_approval_replay_refused");
    assert!(!r2.executed, "replay must not execute a second mutation");
    assert_eq!(
        std::fs::read_to_string(ws.join("out.txt")).unwrap(),
        "TAMPERED",
        "the file was NOT re-written by the replay"
    );
}

/// Owner-wiring completeness (review MED-2): a BOUND paused run, resumed with a valid
/// operator approval, persists its `mutation_completed` run_result WITH the run's owner
/// principal — so the authenticated body projection RELEASES the resumed mutation's body
/// to the legitimate owner and DENIES every other caller. Before the fix the resume leg
/// dropped the owner ⇒ the result was ownerless ⇒ even the owner was Denied
/// (`NoOwnerPrincipal`). This also covers the identical gap on the `run_task` resume path
/// (resume.rs IS that path; runtime.rs only persists the already-owned Finished leg).
#[test]
fn resume_completion_persists_owner_principal_readable_only_to_owner() {
    let (sk, vk) = operator();
    // The paused run is BOUND to principal "alice" (the digest binds it, so the signed
    // approval and the reconstructed request must use the SAME policy — they do via the
    // helper).
    let policy = RunPolicy::new(Some("alice".to_string()), Vec::<String>::new(), false);
    let (db, ws, nonce, request) = pause_a_run_with_policy("resume-owner", &vk, &policy);
    let exec = FsToolExecutor::new(&ws.0);

    let approval = ed_approval(&request, &sk, &nonce, Some(FUTURE));
    let r = resume_with_approval(db.conn(), &exec, &vk, &approval, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Allow);
    assert!(r.executed, "the approved mutation executed");
    assert_eq!(r.result_status, "mutation_completed");
    assert_eq!(
        std::fs::read_to_string(ws.join("out.txt")).unwrap(),
        "RESUMED"
    );

    // The OWNER reads the resumed mutation's body back (Granted), with the recorded owner.
    match get_run_answer_for_principal(db.conn(), &r.run_id, "alice").unwrap() {
        RunAnswerAccess::Granted(stored) => {
            assert_eq!(stored.status, "mutation_completed");
            assert_eq!(
                stored.owner_principal.as_deref(),
                Some("alice"),
                "the resume leg recorded the run's bound owner principal"
            );
            assert!(
                stored.audit_ref.is_some(),
                "result still links the audit receipt"
            );
        }
        other => panic!("owner must be Granted the resumed body, got {other:?}"),
    }
    // A DIFFERENT principal is denied (body withheld) — not over-denied to the owner, but
    // closed to everyone else.
    assert_eq!(
        get_run_answer_for_principal(db.conn(), &r.run_id, "mallory").unwrap(),
        RunAnswerAccess::Denied(AnswerDenyReason::PrincipalMismatch)
    );
    // An anonymous / public caller never reads a body.
    for anon in ["", "public", "public:default"] {
        assert_eq!(
            get_run_answer_for_principal(db.conn(), &r.run_id, anon).unwrap(),
            RunAnswerAccess::Denied(AnswerDenyReason::AnonymousCaller),
            "anonymous caller {anon:?} must be denied"
        );
    }
}

/// The fail-closed direction is preserved: an UNBOUND (no-principal) paused run resumed to
/// completion records NO owner ⇒ the resumed body is unreadable by EVERYONE
/// (`NoOwnerPrincipal`) — never widened to a default/anonymous owner.
#[test]
fn resume_completion_without_principal_is_ownerless_fail_closed() {
    let (sk, vk) = operator();
    let (db, ws, nonce, request) = pause_a_run("resume-noowner", &vk); // RunPolicy::default()
    let exec = FsToolExecutor::new(&ws.0);

    let approval = ed_approval(&request, &sk, &nonce, Some(FUTURE));
    let r = resume_with_approval(db.conn(), &exec, &vk, &approval, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Allow);
    assert!(r.executed);
    // No bound principal ⇒ ownerless ⇒ every caller (incl. any principal) is Denied.
    let stored = get_run_result(db.conn(), &r.run_id).unwrap().unwrap();
    assert_eq!(
        stored.owner_principal, None,
        "no bound principal ⇒ no owner recorded (fail-closed)"
    );
    assert_eq!(
        get_run_answer_for_principal(db.conn(), &r.run_id, "anyone").unwrap(),
        RunAnswerAccess::Denied(AnswerDenyReason::NoOwnerPrincipal)
    );
}

/// HMAC downgrade closed at the RESUME entrypoint: an HMAC-signed approval over the paused
/// action's exact digest is refused (never a valid Ed25519 signature); no mutation runs.
#[test]
fn resume_refuses_an_hmac_signed_approval() {
    let (_sk, vk) = operator();
    let (db, ws, nonce, request) = pause_a_run("resume-hmac", &vk);
    let exec = FsToolExecutor::new(&ws.0);
    let hub_secret = b"hub-held-hmac-secret-0123456789ab";

    let approval = hmac_approval(&request, hub_secret, &nonce, Some(FUTURE));
    let r = resume_with_approval(db.conn(), &exec, &vk, &approval, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_signature_invalid");
    assert!(!r.executed);
    assert!(
        !ws.join("out.txt").exists(),
        "no mutation on an HMAC approval"
    );
}

/// Key-substitution impossible: the operator signs, but resume is asked to verify under a
/// DIFFERENT (attacker) operator key → refused. The Hub can only verify under the key it
/// was provisioned with; it never generates the key it verifies against (the provisioning
/// + source-scan guarantees are in `operator_vk`).
#[test]
fn resume_refuses_under_a_substituted_operator_key() {
    let (operator_sk, operator_vk) = operator();
    let (attacker_sk, attacker_vk) = operator();
    let (db, ws, nonce, request) = pause_a_run("resume-subst", &operator_vk);
    let exec = FsToolExecutor::new(&ws.0);

    // The REAL operator signs. Resume under the ATTACKER's key → invalid signature.
    let approval = ed_approval(&request, &operator_sk, &nonce, Some(FUTURE));
    let r = resume_with_approval(db.conn(), &exec, &attacker_vk, &approval, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_signature_invalid");
    assert!(!r.executed);

    // And an approval the ATTACKER signs is refused under the OPERATOR's provisioned key.
    let forged = ed_approval(&request, &attacker_sk, &nonce, Some(FUTURE));
    let r2 = resume_with_approval(db.conn(), &exec, &operator_vk, &forged, NOW).unwrap();
    assert_eq!(r2.decision, GateDecision::Deny);
    assert_eq!(r2.reason, "canonical_approval_signature_invalid");
    assert!(
        !ws.join("out.txt").exists(),
        "no mutation under any wrong key"
    );
}

/// An EXPIRED operator approval is refused (fail-closed); no mutation runs.
#[test]
fn resume_refuses_an_expired_approval() {
    let (sk, vk) = operator();
    let (db, ws, nonce, request) = pause_a_run("resume-exp", &vk);
    let exec = FsToolExecutor::new(&ws.0);

    let approval = ed_approval(&request, &sk, &nonce, Some(500)); // past (< NOW)
    let r = resume_with_approval(db.conn(), &exec, &vk, &approval, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_expired");
    assert!(!r.executed);
    assert!(!ws.join("out.txt").exists());
}

/// A WRONG-DIGEST approval (the operator signs a DIFFERENT action's digest, but the
/// approval carries the paused nonce) is refused at the digest cross-check — before any
/// signature verification consumes the nonce. (Wrong-principal manifests identically: the
/// principal is bound INTO the digest.)
#[test]
fn resume_refuses_a_wrong_digest_approval() {
    let (sk, vk) = operator();
    let (db, ws, nonce, _request) = pause_a_run("resume-digest", &vk);
    let exec = FsToolExecutor::new(&ws.0);

    // Sign an approval for a DIFFERENT action, but carry the paused nonce + a bogus digest.
    let other = build_request_with_policy(
        &raw("write_file", &[("path", "OTHER.txt"), ("content", "Z")]),
        &RunPolicy::default(),
    )
    .unwrap();
    let mut approval = ed_approval(&other, &sk, &nonce, Some(FUTURE));
    // The approval's digest is `other`'s — different from the pending row's. Cross-check fails.
    let err = resume_with_approval(db.conn(), &exec, &vk, &approval, NOW).unwrap_err();
    assert!(matches!(err, ResumeError::DigestMismatch));
    assert!(!ws.join("out.txt").exists());

    // Sanity: even if an attacker overwrites the digest to match the pending row, the
    // SIGNATURE (over the other digest) no longer matches the claimed digest ⇒ gate Deny.
    let pending = list_pending_requests_for_run(db.conn(), "run-resume").unwrap();
    approval.action_digest = pending[0].action_digest.clone();
    let r = resume_with_approval(db.conn(), &exec, &vk, &approval, NOW).unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "canonical_approval_signature_invalid");
    assert!(!ws.join("out.txt").exists());
}

/// An approval whose nonce matches NO pending request is refused (nothing to resume).
#[test]
fn resume_refuses_an_unknown_nonce() {
    let (sk, vk) = operator();
    let (db, ws, _nonce, request) = pause_a_run("resume-unknown", &vk);
    let exec = FsToolExecutor::new(&ws.0);

    let approval = ed_approval(
        &request,
        &sk,
        "nonce-that-was-never-persisted",
        Some(FUTURE),
    );
    let err = resume_with_approval(db.conn(), &exec, &vk, &approval, NOW).unwrap_err();
    assert!(matches!(err, ResumeError::UnknownNonce));
    assert!(!ws.join("out.txt").exists());
}
