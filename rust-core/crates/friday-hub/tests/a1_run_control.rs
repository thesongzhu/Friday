//! A1 run-controls adversarial suite — the Rust agent-run RUN-CONTROL plane
//! ([`friday_hub::agent_run_control`]): pause-detection, owner-authed cancel/reject, the
//! operator-signed resume bridge, and — the LOAD-BEARING test — the reject/cancel ↔ resume
//! coupling that makes reject/cancel REAL rather than cosmetic.
//!
//! This lives in `tests/` (NOT `src/`) for the SAME reason as `s6d_resume_ingestion`: it
//! constructs an operator SIGNING key to play the offline operator, and `friday-hub/src/**`
//! is forbidden from ever referencing `OperatorSigningKey`. The Hub never holds a signing key;
//! here the TEST holds it, exactly as the real operator does off-Hub.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, ApprovalDecision,
    CanonicalApproval, MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use friday_crypto::{OperatorSigningKey, OperatorVerifyingKey};
use friday_hub::agent_run_control::{
    cancel, detect_pause, effective_max_turns, effective_run_policy, effective_run_policy_over,
    reject, resolve_run_owner, resume,
};
use friday_hub::{
    build_request_with_policy, run_loop_with_policy, AgentError, AgentLlmClient, AgentStep,
    FsToolExecutor, LoopStatus, RawToolCall, RunPolicy, TurnTrace,
};
use friday_protocol::AgentRunConstraintsWire;
use friday_storage::{agent_run, get_pending_request, list_pending_requests_for_run, Db};

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
        .join(format!("friday-a1ctl-{}.sqlite", unique(tag)))
        .to_string_lossy()
        .into_owned()
}

struct Workspace(std::path::PathBuf);
impl Workspace {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("friday-a1ctl-ws-{}", unique(tag)));
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

fn operator() -> (OperatorSigningKey, OperatorVerifyingKey) {
    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();
    (sk, vk)
}

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

/// Encode a `CanonicalApproval` into the `signed_blob` JSON the courier carries (the SAME shape
/// the S6c CLI emits / `hub_resume_approval` decodes).
fn signed_blob(approval: &CanonicalApproval) -> Vec<u8> {
    let decision = match approval.decision {
        ApprovalDecision::Approved => "approved",
        ApprovalDecision::Denied => "denied",
    };
    serde_json::json!({
        "decision": decision,
        "approval_id": approval.approval_id,
        "action_digest": approval.action_digest,
        "expires_at": approval.expires_at.unwrap(),
        "issuer": approval.issuer,
        "signature": approval.signature,
    })
    .to_string()
    .into_bytes()
}

fn no_approval() -> impl Fn(&MutatingActionRequest) -> Option<CanonicalApproval> {
    |_req| None
}

const NOW: i64 = 1_000;
const FUTURE: i64 = 5_000_000_000_000;
const OWNER: &str = "owner:alice";

/// Drive a run to a Pause BOUND to `OWNER`, returning (db, ws, nonce, request) so a test can
/// sign + ingest an approval for the EXACT paused action. The pending row carries the owner
/// principal (the digest binds it), so the reconstructed request used to sign uses the SAME policy.
fn pause_owned_run(
    tag: &str,
    vk: &OperatorVerifyingKey,
) -> (Db, Workspace, String, MutatingActionRequest) {
    let db = Db::open_hub(&temp_db(tag)).unwrap();
    let ws = Workspace::new(tag);
    let run_id = "run-ctl";
    agent_run::create_run(db.conn(), run_id, "write a file", 1).unwrap();
    let policy = RunPolicy::new(Some(OWNER.to_string()), Vec::<String>::new(), false);
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
        &policy,
        5,
        None, // cancel: not exercised by this test
        None, // steer: not exercised by this test
        NOW,
        None, // work_item_id (#24b): test binds no WorkItem ⇒ heartbeat no-op
    )
    .unwrap();
    assert_eq!(out.status, LoopStatus::Paused);
    let nonce = list_pending_requests_for_run(db.conn(), run_id).unwrap()[0]
        .approval_id
        .clone();
    let request = build_request_with_policy(&call, &policy).unwrap();
    (db, ws, nonce, request)
}

// ─────────────────────────── pause-detection ───────────────────────────

#[test]
fn detect_pause_reads_back_refs_only_on_a_paused_run() {
    let (_sk, vk) = operator();
    let (db, _ws, nonce, _req) = pause_owned_run("detect", &vk);
    let info = detect_pause(db.conn(), "run-ctl").unwrap().unwrap();
    assert_eq!(info.nonce, nonce);
    assert_eq!(info.action_digest.len(), 64);
    assert!(info.summary.contains("write_file"));
    // A run with no pending row is NOT a pause.
    agent_run::create_run(db.conn(), "run-other", "noop", 1).unwrap();
    assert_eq!(detect_pause(db.conn(), "run-other").unwrap(), None);
    assert_eq!(detect_pause(db.conn(), "ghost").unwrap(), None);
}

// ─────────────────────────── owner resolution + auth ───────────────────────────

#[test]
fn resolve_run_owner_anchors_on_pending_principal() {
    let (_sk, vk) = operator();
    let (db, _ws, _nonce, _req) = pause_owned_run("owner", &vk);
    assert_eq!(
        resolve_run_owner(db.conn(), "run-ctl").unwrap().as_deref(),
        Some(OWNER)
    );
    assert_eq!(resolve_run_owner(db.conn(), "ghost").unwrap(), None);
}

#[test]
fn cancel_refused_for_non_owner_and_accepted_for_owner() {
    let (_sk, vk) = operator();
    let (db, _ws, _nonce, _req) = pause_owned_run("cancel-auth", &vk);

    // A non-owner cancel is refused with NO state change.
    let r = cancel(db.conn(), "run-ctl", "mallory", None, NOW).unwrap();
    assert!(!r.accepted);
    assert_eq!(r.status, "not_owner");
    assert!(!agent_run::is_cancelled(db.conn(), "run-ctl").unwrap());

    // The owner cancels: terminal state written + audit ref.
    let r = cancel(db.conn(), "run-ctl", OWNER, Some("changed mind"), NOW).unwrap();
    assert!(r.accepted);
    assert_eq!(r.status, "cancelled");
    assert!(r.audit_ref.is_some());
    assert!(agent_run::is_cancelled(db.conn(), "run-ctl").unwrap());

    // Idempotent: a second owner cancel is an accepted no-op.
    let r = cancel(db.conn(), "run-ctl", OWNER, None, NOW).unwrap();
    assert!(r.accepted);
    assert_eq!(r.status, "already_cancelled");
}

#[test]
fn reject_refused_for_non_owner_run_mismatch_and_unknown_approval() {
    let (_sk, vk) = operator();
    let (db, _ws, nonce, _req) = pause_owned_run("reject-auth", &vk);

    // Unknown approval id ⇒ refused.
    let r = reject(db.conn(), "run-ctl", "no-such-nonce", OWNER, NOW).unwrap();
    assert_eq!(r.status, "unknown_approval");
    // A non-owner reject ⇒ refused, the pending row stays `pending`.
    let r = reject(db.conn(), "run-ctl", &nonce, "mallory", NOW).unwrap();
    assert_eq!(r.status, "not_owner");
    assert_eq!(
        get_pending_request(db.conn(), &nonce)
            .unwrap()
            .unwrap()
            .status,
        "pending"
    );
    // A reject naming a DIFFERENT run than the pending row's ⇒ run_mismatch.
    let r = reject(db.conn(), "run-WRONG", &nonce, OWNER, NOW).unwrap();
    assert_eq!(r.status, "run_mismatch");

    // The owner rejects: status='rejected' + audit ref. Idempotent re-reject is accepted.
    let r = reject(db.conn(), "run-ctl", &nonce, OWNER, NOW).unwrap();
    assert!(r.accepted);
    assert_eq!(r.status, "rejected");
    assert_eq!(
        get_pending_request(db.conn(), &nonce)
            .unwrap()
            .unwrap()
            .status,
        "rejected"
    );
    let r = reject(db.conn(), "run-ctl", &nonce, OWNER, NOW).unwrap();
    assert_eq!(r.status, "already_rejected");
}

// ─────────────────────────── THE LOAD-BEARING COUPLING ───────────────────────────

/// REAL, not cosmetic: after the owner REJECTS a pending approval, a LATER correctly-signed
/// resume for that SAME approval_id must NOT execute the mutation. Without the resume handler's
/// pre-check this would still run (the S6 spine only consults `consumed_approval`, not the
/// pending status) — this is the bug the advisor flagged and the test that proves the fix.
#[test]
fn rejected_approval_cannot_be_resumed_no_mutation() {
    let (sk, vk) = operator();
    let (db, ws, nonce, request) = pause_owned_run("reject-resume", &vk);
    let exec = FsToolExecutor::new(&ws.0);

    // Owner rejects the pending approval.
    let r = reject(db.conn(), "run-ctl", &nonce, OWNER, NOW).unwrap();
    assert!(r.accepted);

    // A correctly-signed resume for the SAME nonce is now REFUSED before the spine can execute.
    let approval = ed_approval(&request, &sk, &nonce, Some(FUTURE));
    let out = resume(
        db.conn(),
        &exec,
        &vk,
        "run-ctl",
        &signed_blob(&approval),
        NOW,
    )
    .unwrap();
    assert!(!out.accepted, "a rejected approval must not resume");
    assert_eq!(out.status, "approval_rejected");
    assert!(
        !ws.join("out.txt").exists(),
        "the rejected mutation must NOT have executed"
    );
}

/// Same coupling for CANCEL: after the owner cancels the run, a correctly-signed resume is
/// refused and no mutation runs.
#[test]
fn cancelled_run_cannot_be_resumed_no_mutation() {
    let (sk, vk) = operator();
    let (db, ws, nonce, request) = pause_owned_run("cancel-resume", &vk);
    let exec = FsToolExecutor::new(&ws.0);

    let r = cancel(db.conn(), "run-ctl", OWNER, None, NOW).unwrap();
    assert!(r.accepted);

    let approval = ed_approval(&request, &sk, &nonce, Some(FUTURE));
    let out = resume(
        db.conn(),
        &exec,
        &vk,
        "run-ctl",
        &signed_blob(&approval),
        NOW,
    )
    .unwrap();
    assert!(!out.accepted, "a cancelled run must not resume");
    assert_eq!(out.status, "run_cancelled");
    assert!(
        !ws.join("out.txt").exists(),
        "the cancelled run's mutation must NOT have executed"
    );
}

/// THE WIRE-RUN BINDING (security MUST-FIX). The spine selects the run to execute SOLELY from the
/// blob's nonce (`pending.run_id`) and takes no run_id, while the TS route owner-gates the run named
/// by the WIRE run_id. Without the resume handler's `pending.run_id == run_id` pre-check, an
/// attacker who owns run A could resume A on the wire while carrying a nonce whose pending row
/// belongs to victim run B — executing B's mutation past A's owner gate. This proves the binding:
/// a resume whose wire run_id != the blob's `pending.run_id` is REFUSED (`run_mismatch`) and NO
/// mutation runs. (The wire run here is a real, non-cancelled run, so the check lands on the binding
/// — not on the cancel pre-check.)
#[test]
fn resume_wire_run_mismatch_is_refused_no_mutation() {
    let (sk, vk) = operator();
    // The victim run is paused on a mutation; `nonce`/`request` describe THAT pending action.
    let (db, ws, nonce, request) = pause_owned_run("wire-mismatch", &vk);
    let exec = FsToolExecutor::new(&ws.0);

    // A SECOND, real, non-cancelled run the attacker controls on the wire (NOT the run the nonce
    // belongs to). It exists so the resume passes the `is_cancelled` pre-check and lands squarely on
    // the wire-run binding rather than failing for an unrelated reason.
    agent_run::create_run(db.conn(), "run-attacker", "attacker run", 1).unwrap();

    // A correctly-signed approval for the VICTIM's paused action, but the resume names the ATTACKER's
    // wire run_id. The binding must refuse before the spine can consume the nonce + execute.
    let approval = ed_approval(&request, &sk, &nonce, Some(FUTURE));
    let out = resume(
        db.conn(),
        &exec,
        &vk,
        "run-attacker",
        &signed_blob(&approval),
        NOW,
    )
    .unwrap();
    assert!(
        !out.accepted,
        "a resume whose wire run_id != the nonce's pending.run_id must be refused"
    );
    assert_eq!(out.status, "run_mismatch");
    assert!(
        out.audit_ref.is_none(),
        "a refused-before-spine resume writes no receipt"
    );
    assert!(
        !ws.join("out.txt").exists(),
        "the mismatched resume must NOT have executed the victim's mutation"
    );
    // The victim's pending row is untouched (still `pending`, nonce NOT consumed) — so the legitimate
    // owner can still resume it on the correct wire run_id.
    assert_eq!(
        get_pending_request(db.conn(), &nonce)
            .unwrap()
            .unwrap()
            .status,
        "pending"
    );

    // POSITIVE CONTROL: the SAME approval on the CORRECT wire run_id (the victim's) executes — the
    // binding refuses only the mismatch, never a legitimate resume.
    let out = resume(
        db.conn(),
        &exec,
        &vk,
        "run-ctl",
        &signed_blob(&approval),
        NOW,
    )
    .unwrap();
    assert!(out.accepted, "the matching wire run_id resumes normally");
    assert_eq!(out.status, "mutation_completed");
    assert_eq!(
        std::fs::read_to_string(ws.join("out.txt")).unwrap(),
        "RESUMED"
    );
}

// ─────────────────────────── resume happy path + fail-closed ───────────────────────────

/// The positive control: a correctly-signed resume of a non-cancelled/non-rejected paused run
/// executes EXACTLY one mutation (delegating to the S6 spine).
#[test]
fn resume_executes_the_approved_mutation() {
    let (sk, vk) = operator();
    let (db, ws, nonce, request) = pause_owned_run("resume-ok", &vk);
    let exec = FsToolExecutor::new(&ws.0);

    let approval = ed_approval(&request, &sk, &nonce, Some(FUTURE));
    let out = resume(
        db.conn(),
        &exec,
        &vk,
        "run-ctl",
        &signed_blob(&approval),
        NOW,
    )
    .unwrap();
    assert!(out.accepted);
    assert_eq!(out.status, "mutation_completed");
    assert!(out.audit_ref.is_some());
    assert_eq!(
        std::fs::read_to_string(ws.join("out.txt")).unwrap(),
        "RESUMED"
    );
}

#[test]
fn resume_malformed_blob_is_fail_closed() {
    let (_sk, vk) = operator();
    let (db, ws, _nonce, _req) = pause_owned_run("resume-bad", &vk);
    let exec = FsToolExecutor::new(&ws.0);
    let out = resume(db.conn(), &exec, &vk, "run-ctl", b"not json", NOW).unwrap();
    assert!(!out.accepted);
    assert_eq!(out.status, "malformed_blob");
    assert!(!ws.join("out.txt").exists());
}

/// An HMAC-signed approval carried in the blob is refused by the spine (downgrade closed), and
/// no mutation runs — the resume bridge does not weaken the S6 verification.
#[test]
fn resume_hmac_blob_is_refused() {
    let (_sk, vk) = operator();
    let (db, ws, nonce, request) = pause_owned_run("resume-hmac", &vk);
    let exec = FsToolExecutor::new(&ws.0);
    let digest = friday_crypto::action_digest(&canonical_action_bytes(&request));
    let mut a = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: nonce,
        action_digest: digest,
        expires_at: Some(FUTURE),
        issuer: Some(CANONICAL_GATE_ISSUER.to_string()),
        signature: None,
    };
    a.signature = Some(friday_crypto::sign_approval(
        &canonical_approval_signature_bytes(&a),
        b"hub-held-hmac-secret-0123456789ab",
    ));
    let out = resume(db.conn(), &exec, &vk, "run-ctl", &signed_blob(&a), NOW).unwrap();
    assert!(!out.accepted, "an HMAC blob is a gate Deny");
    assert!(!ws.join("out.txt").exists());
}

// ─────────────────────────── constraints mapping (pure) ───────────────────────────

#[test]
fn effective_run_policy_maps_constraints_tightening_only() {
    // None ⇒ unconstrained policy (read-only off, no disabled tools).
    let p = effective_run_policy(Some(OWNER), None);
    assert_eq!(p.principal_id(), Some(OWNER));
    assert!(!p.is_read_only());
    assert!(!p.is_tool_disabled("run_command"));

    // A constraints block tightens: read_only on, the disabled set applied verbatim.
    let c = AgentRunConstraintsWire {
        read_only: true,
        disabled_tools: vec!["run_command".into()],
        max_turns: Some(2),
    };
    let p = effective_run_policy(Some(OWNER), Some(&c));
    assert!(p.is_read_only());
    assert!(p.is_tool_disabled("run_command"));

    // max_turns can only LOWER the runtime ceiling, never raise it.
    assert_eq!(effective_max_turns(8, Some(&c)), 2);
    let raise = AgentRunConstraintsWire {
        max_turns: Some(100),
        ..Default::default()
    };
    assert_eq!(
        effective_max_turns(8, Some(&raise)),
        8,
        "a higher asserted cap cannot raise the ceiling"
    );
    assert_eq!(effective_max_turns(8, None), 8, "None ⇒ runtime default");
}

/// (A1 APPLICATION) `effective_run_policy_over` COMPOSES onto an arbitrary boot policy so the
/// only-tighten invariant holds UNCONDITIONALLY — the load-bearing property the live dispatch
/// relies on (a constraint can NEVER loosen a boot-configured restriction).
#[test]
fn effective_run_policy_over_composes_only_tightens() {
    // None over ANY boot ⇒ the boot policy unchanged (the absent-constraint path).
    let boot_unconstrained = RunPolicy::new(Some(OWNER.into()), Vec::<String>::new(), false);
    let p = effective_run_policy_over(&boot_unconstrained, None);
    assert_eq!(p.principal_id(), Some(OWNER));
    assert!(!p.is_read_only());

    // A boot policy that is ITSELF read-only + disables `delete_file`.
    let boot_strict = RunPolicy::new(Some(OWNER.into()), vec!["delete_file".to_string()], true);

    // (1) None ⇒ boot strictness preserved (NOT reset to unconstrained — the REPLACE bug).
    let p = effective_run_policy_over(&boot_strict, None);
    assert!(p.is_read_only(), "None must NOT loosen a read-only boot");
    assert!(
        p.is_tool_disabled("delete_file"),
        "None must NOT re-enable a boot-disabled tool"
    );

    // (2) A constraint that tries to LOOSEN (read_only:false + a DIFFERENT disabled set) cannot:
    //     read_only stays true (OR), and the boot-disabled tool stays disabled (UNION).
    let loosen = AgentRunConstraintsWire {
        read_only: false,
        disabled_tools: vec!["run_command".into()],
        max_turns: None,
    };
    let p = effective_run_policy_over(&boot_strict, Some(&loosen));
    assert!(p.is_read_only(), "OR: boot read-only cannot be turned off");
    assert!(
        p.is_tool_disabled("delete_file"),
        "UNION: boot-disabled delete_file stays disabled"
    );
    assert!(
        p.is_tool_disabled("run_command"),
        "UNION: the constraint ADDS run_command to the disabled set"
    );
    assert_eq!(p.principal_id(), Some(OWNER), "owner is preserved verbatim");

    // (3) A constraint TIGHTENS an unconstrained boot: read_only on, tool disabled.
    let tighten = AgentRunConstraintsWire {
        read_only: true,
        disabled_tools: vec!["write_file".into()],
        max_turns: Some(1),
    };
    let p = effective_run_policy_over(&boot_unconstrained, Some(&tighten));
    assert!(p.is_read_only());
    assert!(p.is_tool_disabled("write_file"));
}

/// `RunPolicy::tightened_by` directly: empty/whitespace entries are dropped (cannot widen), and
/// composing with `(false, [])` is a NO-OP equal to the receiver.
#[test]
fn tightened_by_drops_empties_and_noop_on_empty_constraint() {
    let boot = RunPolicy::new(Some(OWNER.into()), vec!["delete_file".to_string()], false);

    // (false, []) over a non-read-only boot ⇒ equal to boot (no widening, no narrowing).
    let same = boot.tightened_by(false, &[]);
    assert!(!same.is_read_only());
    assert!(same.is_tool_disabled("delete_file"));
    assert!(!same.is_tool_disabled("write_file"));

    // Empty / whitespace entries are normalized away (cannot pollute the disabled set).
    let p = boot.tightened_by(true, &["".into(), "   ".into(), "write_file".into()]);
    assert!(p.is_read_only());
    assert!(p.is_tool_disabled("delete_file"));
    assert!(p.is_tool_disabled("write_file"));
    assert!(!p.is_tool_disabled(""), "empty entry never disables");
}
