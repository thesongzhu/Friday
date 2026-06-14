//! The resume → WorkItem-completion leg
//! ([`friday_hub::mission_runtime::resume_agent_loop_for_mission`]) — closes the ONE gap left by
//! the dark mission-bound run path: after an operator-signed approval EXECUTES the one paused
//! mutation, advance the bound WorkItem `ProviderRouted → CompletedWithProof`.
//!
//! THE LOOPHOLE GATE is the canary of this suite: the WorkItem is advanced ONLY when the mutation
//! ACTUALLY RAN (gate Allow + executor Ok). Every refusal / exec-failure must leave the WorkItem at
//! `ProviderRouted` — minting a `CompletedWithProof` for a mutation that never ran is a FALSE PROOF
//! (a security defect). The false-proof guards below assert the WorkItem is UNCHANGED on:
//!   (i) a replayed/consumed nonce, (ii) an expired/bad-signature/HMAC approval, and
//!   (iii) `mutation_exec_failed` (gate Allow but the executor returns Err).
//! Plus the cross-mission proof-injection defense (resolve the WorkItem ONLY via the run's OWN
//! pause-time link, never a wire-supplied id) and the flag-off / non-mission byte-identical path.
//!
//! This lives in `tests/` (NOT `src/`) because it constructs an operator SIGNING key to play the
//! offline operator — `friday-hub/src/**` is forbidden from ever referencing `OperatorSigningKey`
//! (the Hub holds only a verify key). Same reason as `a1_run_control` / `s6d_resume_ingestion`.

use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, ApprovalDecision,
    CanonicalApproval, MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use friday_core::{
    ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus, Risk,
    SurfaceKind, SurfaceThread, TruthStatus, VisibilityPolicy, WorkItem, WorkItemStatus, WorkLane,
};
use friday_crypto::{OperatorSigningKey, OperatorVerifyingKey};
use friday_hub::agent_run_control::resume as bare_resume;
use friday_hub::mission_preflight::{
    attach_provider_timeline_state, MissionAttachmentOutcome, ProviderTimelineAttachment,
};
use friday_hub::mission_runtime::resume_agent_loop_for_mission;
use friday_hub::provider_timeline::PendingState;
use friday_hub::{
    build_request_with_policy, run_loop_with_policy, AgentError, AgentLlmClient, AgentStep,
    ExecError, FsToolExecutor, LoopStatus, RawToolCall, RunPolicy, ToolExecutor, ToolReceipt,
    TurnTrace,
};
use friday_storage::{agent_run, list_pending_requests_for_run, Db};

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
        .join(format!("friday-resume-mwic-{}.sqlite", unique(tag)))
        .to_string_lossy()
        .into_owned()
}

struct Workspace(std::path::PathBuf);
impl Workspace {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("friday-resume-mwic-ws-{}", unique(tag)));
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
    steps: std::cell::RefCell<std::vec::IntoIter<AgentStep>>,
}
impl Script {
    fn new(steps: Vec<AgentStep>) -> Self {
        Script {
            steps: std::cell::RefCell::new(steps.into_iter()),
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

/// An executor that ALWAYS returns Err — used for the `mutation_exec_failed` guard (gate Allow but
/// the executor fails). `FsToolExecutor` succeeds, so it cannot exercise that branch.
struct FailingExec;
impl ToolExecutor for FailingExec {
    fn execute(
        &self,
        action: &str,
        _params: &[(String, String)],
    ) -> Result<ToolReceipt, ExecError> {
        Err(ExecError::Unsupported(format!(
            "forced exec failure: {action}"
        )))
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
const PAST: i64 = 100; // an `expires_at` in the past ⇒ the gate refuses (expired).

fn judgment(lane: WorkLane) -> HandoffJudgmentMemory {
    HandoffJudgmentMemory {
        task: "Run the Mission-bound mutating agent loop".into(),
        current_blocker: None,
        target_lane_thread_agent_provider: lane.as_str().into(),
        read_first_files: vec!["rust-core/crates/friday-hub/src/mission_runtime.rs".into()],
        required_output: "Mission-bound loop completion".into(),
        done_criteria: vec!["loop bound + completed with proof".into()],
        red_lines: vec!["never complete a mutation that did not run".into()],
        why_this_route: "The WorkItem lane owns the agent loop.".into(),
        considered_options: vec!["unbound run".into()],
        deferred_options: vec!["multi-provider".into()],
        previous_pitfalls: vec!["paused run looked completed".into()],
        inheritable_context: vec!["Mission is product truth".into()],
        proof_requirements: vec!["resume completion tests".into()],
        ownership_claim_ids: Vec::new(),
    }
}

/// Seed `FridayConversation -> Mission -> WorkItem` for ONE mission, with a distinct suffix so a
/// single DB can hold two missions. `owner` is the WorkItem's bound principal (the run policy uses
/// it, so the pending digest binds it).
#[allow(clippy::too_many_arguments)]
fn seed_mission(db: &Db, suffix: &str, owner: &str) {
    let now = 1_700_000_000_000;
    let mission_id = format!("mission-{suffix}");
    let work_item_id = format!("work-{suffix}");
    // The conversation id must be canonical (`fconv_*` with an underscore prefix — schema CHECK).
    let fconv = format!("fconv_{suffix}");
    let surface = format!("surface-{suffix}");
    db.upsert_friday_conversation(&FridayConversation {
        friday_conversation_id: fconv.clone(),
        owner_principal: owner.into(),
        title: "Resume completion".into(),
        current_focus_summary: "Mission-bound mutating loop".into(),
        active_mission_ids: vec![mission_id.clone()],
        surface_thread_ids: vec![surface.clone()],
        memory_scope_ref: None,
        truth_status: TruthStatus::WiredRegistry,
        proof_refs: vec!["proof://resume-mwic".into()],
        created_at_ms: now,
        updated_at_ms: now,
    })
    .unwrap();
    db.upsert_mission(&Mission {
        mission_id: mission_id.clone(),
        friday_conversation_id: fconv.clone(),
        title: "Resume completion".into(),
        intent: "complete the bound WorkItem only on a proven mutation".into(),
        status: MissionStatus::Active,
        why_now: "resume must advance the bound WorkItem".into(),
        decision_path_summary: "advance only on executed==true".into(),
        considered_options: vec!["advance unconditionally".into()],
        deferred_options: vec!["multi-provider".into()],
        known_pitfalls: vec!["refused resume looked completed".into()],
        handoff_inheritance: vec!["preserve route judgment".into()],
        work_item_ids: vec![work_item_id.clone()],
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: vec!["proof://resume-mwic".into()],
        created_at_ms: now,
        updated_at_ms: now,
    })
    .unwrap();
    db.upsert_surface_thread(&SurfaceThread {
        surface_thread_id: surface,
        friday_conversation_id: fconv,
        mission_id: Some(mission_id.clone()),
        surface_kind: SurfaceKind::Mobile,
        channel_binding_id: None,
        delivery_route: "mobile".into(),
        visibility_policy: VisibilityPolicy::Compact,
        allowed_actions: vec!["open_mission".into()],
        last_seen_at_ms: Some(now),
        last_delivered_event_seq: Some(1),
        created_at_ms: now,
        updated_at_ms: now,
    })
    .unwrap();
    db.upsert_work_item(&WorkItem {
        work_item_id,
        mission_id,
        lane: WorkLane::DeepSeek,
        target_provider_or_agent: Some("deepseek".into()),
        status: WorkItemStatus::ReadyToDispatch,
        owner_claim_ids: Vec::new(),
        workspace_refs: Vec::new(),
        capability_id: Some("mission.resume".into()),
        risk_level: Risk::Medium,
        approval_state: ApprovalState::NotRequired,
        blocking_reason: None,
        input_refs: vec!["input://resume".into()],
        output_refs: Vec::new(),
        proof_requirements: vec!["resume completion tests".into()],
        proof_receipts: Vec::new(),
        judgment_memory: judgment(WorkLane::DeepSeek),
        created_at_ms: now,
        updated_at_ms: now,
    })
    .unwrap();
}

/// Drive a seeded WorkItem to `ProviderRouted` by replaying the pause-time provider-timeline
/// states (SentToHub → AcceptedByHub → RoutedToProvider) with `request_id = run_id` — exactly the
/// link an agent-loop pause writes (`friday://provider-timeline/{session}#{run_id}`). After this
/// the WorkItem is at `ProviderRouted` with its OWN pause-time MissionLink in place.
fn bind_to_provider_routed(db: &Db, suffix: &str, session_id: &str, run_id: &str) {
    let mission_id = format!("mission-{suffix}");
    let work_item_id = format!("work-{suffix}");
    for state in [
        PendingState::SentToHub,
        PendingState::AcceptedByHub,
        PendingState::RoutedToProvider,
    ] {
        let out = attach_provider_timeline_state(
            db,
            ProviderTimelineAttachment {
                mission_id: mission_id.clone(),
                work_item_id: work_item_id.clone(),
                friday_session_id: session_id.to_string(),
                request_id: run_id.to_string(),
                state,
                proof_ref: None,
                now_ms: 1,
            },
        )
        .unwrap();
        assert!(matches!(out, MissionAttachmentOutcome::Attached { .. }));
    }
    assert_eq!(
        db.get_work_item(&work_item_id).unwrap().unwrap().status,
        WorkItemStatus::ProviderRouted
    );
}

/// Create a real PAUSED, mutating run (a `write_file` Pause under deny-all) bound to `owner`, and
/// return (nonce, the rebuilt request a signature must cover). Mirrors `a1_run_control`'s
/// `pause_owned_run` but takes a caller-chosen `run_id`/`owner`/file so two runs can coexist.
fn pause_run(
    db: &Db,
    ws: &Workspace,
    run_id: &str,
    owner: &str,
    vk: &OperatorVerifyingKey,
    out_file: &str,
) -> (String, MutatingActionRequest) {
    agent_run::create_run(db.conn(), run_id, "write a file", 1).unwrap();
    let policy = RunPolicy::new(Some(owner.to_string()), Vec::<String>::new(), false);
    let call = raw("write_file", &[("path", out_file), ("content", "RESUMED")]);
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
        None,
        None,
        NOW,
    )
    .unwrap();
    assert_eq!(out.status, LoopStatus::Paused);
    let nonce = list_pending_requests_for_run(db.conn(), run_id).unwrap()[0]
        .approval_id
        .clone();
    let request = build_request_with_policy(&call, &policy).unwrap();
    (nonce, request)
}

fn work_status(db: &Db, suffix: &str) -> WorkItemStatus {
    db.get_work_item(&format!("work-{suffix}"))
        .unwrap()
        .unwrap()
        .status
}

// ─────────────────────────── executed==true → advance ───────────────────────────

/// THE POSITIVE CONTROL: a correctly-signed resume that EXECUTES the one paused mutation advances
/// the bound WorkItem ProviderRouted → CompletedWithProof, with proof_ref = friday://agent-run/{run}.
#[test]
fn executed_resume_advances_bound_work_item_to_completed_with_proof() {
    let (sk, vk) = operator();
    let db = Db::open_hub(&temp_db("ok")).unwrap();
    let ws = Workspace::new("ok");
    let owner = "owner:alice";
    let run_id = "run-ok";
    seed_mission(&db, "ok", owner);
    bind_to_provider_routed(&db, "ok", "friday-session-ok", run_id);
    let (nonce, request) = pause_run(&db, &ws, run_id, owner, &vk, "out-ok.txt");
    let exec = FsToolExecutor::new(&ws.0);

    let approval = ed_approval(&request, &sk, &nonce, Some(FUTURE));
    let outcome =
        resume_agent_loop_for_mission(&db, &exec, &vk, run_id, &signed_blob(&approval), NOW)
            .unwrap();

    assert!(outcome.accepted, "the mutation must have executed");
    assert_eq!(outcome.status, "mutation_completed");
    assert_eq!(
        std::fs::read_to_string(ws.join("out-ok.txt")).unwrap(),
        "RESUMED"
    );

    let item = db.get_work_item("work-ok").unwrap().unwrap();
    assert_eq!(item.status, WorkItemStatus::CompletedWithProof);
    assert!(
        item.proof_receipts
            .contains(&format!("friday://agent-run/{run_id}")),
        "the run is the completion proof: {:?}",
        item.proof_receipts
    );
    // The completion UPSERTS the SAME pause-time link (no second provider_timeline link minted),
    // so a future resolution stays unambiguous.
    let pt_links: Vec<_> = db
        .list_mission_links("mission-ok")
        .unwrap()
        .into_iter()
        .filter(|l| l.link_kind == friday_core::MissionLinkKind::ProviderTimeline)
        .collect();
    assert_eq!(
        pt_links.len(),
        1,
        "exactly one provider_timeline link (upserted, not duplicated): {pt_links:?}"
    );
    assert_eq!(
        pt_links[0].target_ref,
        format!("friday://provider-timeline/friday-session-ok#{run_id}")
    );
}

// ─────────────────────────── FALSE-PROOF GUARDS ───────────────────────────
// Each MUST leave the WorkItem at ProviderRouted with NO completion proof.

/// (i) A replayed/consumed nonce: the first resume executes + advances; a SECOND resume of the SAME
/// approval is replay-refused (executed==false) and must NOT re-touch / clobber the WorkItem.
#[test]
fn false_proof_guard_replayed_nonce_does_not_re_advance() {
    let (sk, vk) = operator();
    let db = Db::open_hub(&temp_db("replay")).unwrap();
    let ws = Workspace::new("replay");
    let owner = "owner:alice";
    let run_id = "run-replay";
    seed_mission(&db, "replay", owner);
    bind_to_provider_routed(&db, "replay", "friday-session-replay", run_id);
    let (nonce, request) = pause_run(&db, &ws, run_id, owner, &vk, "out-replay.txt");
    let exec = FsToolExecutor::new(&ws.0);
    let approval = ed_approval(&request, &sk, &nonce, Some(FUTURE));

    // First resume executes + completes.
    let first =
        resume_agent_loop_for_mission(&db, &exec, &vk, run_id, &signed_blob(&approval), NOW)
            .unwrap();
    assert!(first.accepted);
    assert_eq!(
        work_status(&db, "replay"),
        WorkItemStatus::CompletedWithProof
    );

    // REPLAY: the same approval (consumed nonce) is refused — executed==false. The WorkItem must be
    // unchanged (still CompletedWithProof, never re-driven through an illegal backward transition).
    let replay =
        resume_agent_loop_for_mission(&db, &exec, &vk, run_id, &signed_blob(&approval), NOW + 1)
            .unwrap();
    assert!(!replay.accepted, "a replayed nonce must not execute");
    assert_eq!(
        work_status(&db, "replay"),
        WorkItemStatus::CompletedWithProof
    );
}

/// (ii) An EXPIRED (and separately, a BAD-SIGNATURE) approval is a gate Deny (executed==false): the
/// WorkItem stays ProviderRouted, no proof.
#[test]
fn false_proof_guard_expired_or_bad_signature_leaves_work_item_unchanged() {
    let (sk, vk) = operator();
    let db = Db::open_hub(&temp_db("expired")).unwrap();
    let ws = Workspace::new("expired");
    let owner = "owner:alice";
    let run_id = "run-expired";
    seed_mission(&db, "expired", owner);
    bind_to_provider_routed(&db, "expired", "friday-session-expired", run_id);
    let (nonce, request) = pause_run(&db, &ws, run_id, owner, &vk, "out-expired.txt");
    let exec = FsToolExecutor::new(&ws.0);

    // Expired: a correctly-signed approval whose expires_at is in the past.
    let expired = ed_approval(&request, &sk, &nonce, Some(PAST));
    let out = resume_agent_loop_for_mission(&db, &exec, &vk, run_id, &signed_blob(&expired), NOW)
        .unwrap();
    assert!(!out.accepted, "an expired approval must not execute");
    assert!(!ws.join("out-expired.txt").exists());
    assert_eq!(work_status(&db, "expired"), WorkItemStatus::ProviderRouted);

    // Bad signature: sign with a DIFFERENT operator key (the Hub's verify key won't verify it).
    let (other_sk, _other_vk) = operator();
    let forged = ed_approval(&request, &other_sk, &nonce, Some(FUTURE));
    let out =
        resume_agent_loop_for_mission(&db, &exec, &vk, run_id, &signed_blob(&forged), NOW).unwrap();
    assert!(!out.accepted, "a wrong-key signature must not execute");
    assert!(!ws.join("out-expired.txt").exists());
    assert_eq!(work_status(&db, "expired"), WorkItemStatus::ProviderRouted);
}

/// (iii) `mutation_exec_failed`: gate Allow but the EXECUTOR returns Err (executed==false). The
/// approval verifies + the nonce is consumed, but no mutation ran — the WorkItem must stay
/// ProviderRouted (the most dangerous false-proof: the gate said yes). Uses a FailingExec.
#[test]
fn false_proof_guard_exec_failed_leaves_work_item_unchanged() {
    let (sk, vk) = operator();
    let db = Db::open_hub(&temp_db("execfail")).unwrap();
    let ws = Workspace::new("execfail");
    let owner = "owner:alice";
    let run_id = "run-execfail";
    seed_mission(&db, "execfail", owner);
    bind_to_provider_routed(&db, "execfail", "friday-session-execfail", run_id);
    // The pending row / digest are built with the SAME write_file action; the run loop itself used
    // an FsToolExecutor to PAUSE (it never executed). The RESUME uses the FailingExec.
    let (nonce, request) = pause_run(&db, &ws, run_id, owner, &vk, "out-execfail.txt");

    let approval = ed_approval(&request, &sk, &nonce, Some(FUTURE));
    let out =
        resume_agent_loop_for_mission(&db, &FailingExec, &vk, run_id, &signed_blob(&approval), NOW)
            .unwrap();
    assert!(
        !out.accepted,
        "gate Allow + executor Err is executed==false (mutation_exec_failed)"
    );
    assert_eq!(out.status, "mutation_exec_failed");
    assert_eq!(
        work_status(&db, "execfail"),
        WorkItemStatus::ProviderRouted,
        "an exec-failed mutation must NEVER complete the WorkItem"
    );
}

// ─────────────────────────── cross-mission injection ───────────────────────────

/// CROSS-MISSION PROOF INJECTION: two missions, two paused runs whose run_ids share a SUFFIX
/// (`run-x` and `extra-run-x`). Resuming `run-x` must advance ONLY mission-x's WorkItem; the other
/// (whose link target_ref ends `#extra-run-x`) must stay ProviderRouted. Proves the resolver matches
/// the EXACT trailing `#`-segment, never a substring/ends_with — and resolves the WorkItem ONLY via
/// the run's OWN link (never a wire-supplied id).
#[test]
fn cross_mission_resume_advances_only_its_own_work_item() {
    let (sk, vk) = operator();
    let db = Db::open_hub(&temp_db("xmission")).unwrap();
    let ws = Workspace::new("xmission");
    let owner = "owner:alice";

    // mission-x bound to run "run-x"; mission-y bound to run "extra-run-x" (a SUPERSTRING of run-x).
    seed_mission(&db, "x", owner);
    seed_mission(&db, "y", owner);
    bind_to_provider_routed(&db, "x", "friday-session-x", "run-x");
    bind_to_provider_routed(&db, "y", "friday-session-y", "extra-run-x");

    let (nonce_x, request_x) = pause_run(&db, &ws, "run-x", owner, &vk, "out-x.txt");
    let (_nonce_y, _request_y) = pause_run(&db, &ws, "extra-run-x", owner, &vk, "out-y.txt");
    let exec = FsToolExecutor::new(&ws.0);

    // Resume ONLY run-x with its own approval.
    let approval_x = ed_approval(&request_x, &sk, &nonce_x, Some(FUTURE));
    let out =
        resume_agent_loop_for_mission(&db, &exec, &vk, "run-x", &signed_blob(&approval_x), NOW)
            .unwrap();
    assert!(out.accepted);

    assert_eq!(
        work_status(&db, "x"),
        WorkItemStatus::CompletedWithProof,
        "the resumed run's OWN WorkItem advances"
    );
    assert_eq!(
        work_status(&db, "y"),
        WorkItemStatus::ProviderRouted,
        "the suffix-sharing foreign WorkItem must NOT be advanced (exact #-segment match)"
    );
    // The foreign mission's WorkItem carries no proof from run-x.
    let item_y = db.get_work_item("work-y").unwrap().unwrap();
    assert!(item_y.proof_receipts.is_empty());
}

// ─────────────────────────── flag-off / non-mission byte-identical ───────────────────────────

/// A run with NO resolvable bound WorkItem (an unbound paused run — no provider_timeline link) must
/// resume BYTE-IDENTICALLY to the bare `agent_run_control::resume`: same `accepted`/`status`, and no
/// WorkItem touched (there is none). Proves the no-binding fallthrough is a pure pass-through.
#[test]
fn non_mission_resume_is_byte_identical_to_bare_resume() {
    let (sk, vk) = operator();

    // (A) via the mission wrapper, on an UNBOUND run (no mission link).
    let db_a = Db::open_hub(&temp_db("nonmission-a")).unwrap();
    let ws_a = Workspace::new("nonmission-a");
    let (nonce_a, req_a) = pause_run(&db_a, &ws_a, "run-unbound", "owner:alice", &vk, "out-a.txt");
    let exec_a = FsToolExecutor::new(&ws_a.0);
    let approval_a = ed_approval(&req_a, &sk, &nonce_a, Some(FUTURE));
    let via_wrapper = resume_agent_loop_for_mission(
        &db_a,
        &exec_a,
        &vk,
        "run-unbound",
        &signed_blob(&approval_a),
        NOW,
    )
    .unwrap();

    // (B) via the BARE resume, identical setup in a fresh DB/ws.
    let db_b = Db::open_hub(&temp_db("nonmission-b")).unwrap();
    let ws_b = Workspace::new("nonmission-b");
    let (nonce_b, req_b) = pause_run(&db_b, &ws_b, "run-unbound", "owner:alice", &vk, "out-b.txt");
    let exec_b = FsToolExecutor::new(&ws_b.0);
    let approval_b = ed_approval(&req_b, &sk, &nonce_b, Some(FUTURE));
    let via_bare = bare_resume(
        db_b.conn(),
        &exec_b,
        &vk,
        "run-unbound",
        &signed_blob(&approval_b),
        NOW,
    )
    .unwrap();

    // Same op + accepted + coarse status; both executed the mutation (no WorkItem to advance).
    assert_eq!(via_wrapper.op, via_bare.op);
    assert_eq!(via_wrapper.accepted, via_bare.accepted);
    assert_eq!(via_wrapper.status, via_bare.status);
    assert!(via_wrapper.accepted);
    assert_eq!(via_wrapper.status, "mutation_completed");
    // The wrapper created NO WorkItem and NO mission link out of thin air.
    assert_eq!(
        db_a.conn()
            .query_row("SELECT count(*) FROM mission_link", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0,
        "an unbound resume must not mint a mission link"
    );
    assert_eq!(
        db_a.conn()
            .query_row("SELECT count(*) FROM work_item", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0,
        "an unbound resume must not mint a WorkItem"
    );
}

// ─────────────────────────── no double-advance (idempotency) ───────────────────────────

/// Resuming an already-`CompletedWithProof` run is idempotent: the FIRST resume completes it; a
/// SECOND (consumed-nonce) resume is executed==false ⇒ no advance, no illegal backward transition,
/// no panic. The WorkItem stays CompletedWithProof. (Same nonce can't re-execute; this asserts the
/// completion leg itself never errors on an already-completed WorkItem.)
#[test]
fn no_double_advance_on_already_completed_run() {
    let (sk, vk) = operator();
    let db = Db::open_hub(&temp_db("double")).unwrap();
    let ws = Workspace::new("double");
    let owner = "owner:alice";
    let run_id = "run-double";
    seed_mission(&db, "double", owner);
    bind_to_provider_routed(&db, "double", "friday-session-double", run_id);
    let (nonce, request) = pause_run(&db, &ws, run_id, owner, &vk, "out-double.txt");
    let exec = FsToolExecutor::new(&ws.0);
    let approval = ed_approval(&request, &sk, &nonce, Some(FUTURE));

    let first =
        resume_agent_loop_for_mission(&db, &exec, &vk, run_id, &signed_blob(&approval), NOW)
            .unwrap();
    assert!(first.accepted);
    assert_eq!(
        work_status(&db, "double"),
        WorkItemStatus::CompletedWithProof
    );
    let item_after_first = db.get_work_item("work-double").unwrap().unwrap();

    // Second resume: refused (consumed nonce) ⇒ no advance. The completion leg is never reached
    // (executed==false short-circuits), so the WorkItem is byte-for-byte unchanged.
    let second =
        resume_agent_loop_for_mission(&db, &exec, &vk, run_id, &signed_blob(&approval), NOW + 1)
            .unwrap();
    assert!(!second.accepted);
    let item_after_second = db.get_work_item("work-double").unwrap().unwrap();
    assert_eq!(item_after_first.status, item_after_second.status);
    assert_eq!(
        item_after_first.proof_receipts,
        item_after_second.proof_receipts
    );
    assert_eq!(
        item_after_first.updated_at_ms,
        item_after_second.updated_at_ms
    );
}
