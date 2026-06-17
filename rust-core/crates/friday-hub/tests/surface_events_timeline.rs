//! FRIDAY_SURFACE_EVENTS — the surface_event timeline PRODUCER, proven end-to-end through a real
//! [`friday_hub::runtime::HubRuntime`] mission-bound run (the live `run_agent_loop_for_mission`
//! entry, the SAME one the production WS dispatch arm reaches) and the existing workbench-timeline
//! READER (`workbench_projection::project_workbench`).
//!
//! Registry path #6: storage + struct + persist + the workbench READER all exist, but NOTHING
//! emitted `surface_event` rows on the live path, so the Mission Workbench timeline was empty. This
//! suite proves the PRODUCER now fills it WITHOUT touching the reader:
//!
//! - Flag ON: an intake-birth row (via the live `mission_intake_result_for_db`), a run-start row,
//!   and a run-proof row exist for the mission (`list_surface_events_for_mission`), and the
//!   `project_workbench` timeline now INCLUDES them (the `surface-event` refs in the snapshot).
//! - Flag OFF: the SAME run writes ZERO surface_event rows, and the projection timeline is
//!   byte-identical-minus-events (no `surface-event` ref at all).
//! - The audit chain stays clean in both arms.
//!
//! The producer resolves the surface_thread by the thread row's OWN `mission_id` (the live
//! `by_mission_work_item` lookup leaves the context's `surface_thread_id` None), so this test drives
//! the SAME resolution the prod path does — it does NOT thread a surface_thread_id through the
//! lookup (that would be a green-but-dead producer).
//!
//! This lives in `tests/` (not `src/`) because the env-flag-ON arm reads `std::env`
//! (`FRIDAY_SURFACE_EVENTS`); the byte-identical-OFF behavioral proof + the pure-matcher unit test
//! live in-crate where the bool is injected directly.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};

use friday_core::{
    FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus, Risk, SurfaceKind,
    SurfaceThread, TruthStatus, VisibilityPolicy, WorkItem, WorkItemStatus, WorkLane,
};
use friday_deepseek::{DeepSeekClient, DeepSeekError, Transport};
use friday_hub::mission_context::MissionContextLookup;
use friday_hub::runtime::{DenyAllApprovals, HubConfig, HubRuntime, MissionBoundLoopOutcome};
use friday_hub::workbench_projection::project_workbench;
use friday_hub::{DeepSeekAgentLlmClient, LoopStatus};
use friday_protocol::{Message, MissionIntakeRequestWire};
use friday_storage::Db;
use serde_json::Value;

const SECRET: &[u8] = b"surface-events-test-secret-0123456789"; // pragma: allowlist secret

static C: AtomicU64 = AtomicU64::new(0);

fn unique(tag: &str) -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        tag,
        C.fetch_add(1, Ordering::Relaxed)
    )
}

struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("friday-surface-events-ws-{}", unique(tag)));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn join(&self, name: &str) -> std::path::PathBuf {
        self.0.join(name)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tmp_db(tag: &str) -> String {
    std::env::temp_dir()
        .join(format!("friday-surface-events-{}.sqlite", unique(tag)))
        .to_string_lossy()
        .into_owned()
}

/// Scripted DeepSeek transport: GET /models → one flash model; POST /chat → the next scripted
/// assistant `content` (a tool-call JSON the strict parser reads). Mirrors the in-crate runtime
/// tests' transport.
struct ScriptTransport {
    contents: Vec<String>,
    post_calls: Rc<Cell<usize>>,
}
impl ScriptTransport {
    fn new(contents: &[&str]) -> Self {
        Self {
            contents: contents.iter().map(|s| s.to_string()).collect(),
            post_calls: Rc::new(Cell::new(0)),
        }
    }
}
impl Transport for ScriptTransport {
    fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
        Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
    }
    fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
        let n = self.post_calls.get();
        self.post_calls.set(n + 1);
        let content = self
            .contents
            .get(n)
            .cloned()
            .unwrap_or_else(|| "{\"tool\":\"none\"}".to_string());
        Ok(serde_json::json!({
            "model":"deepseek-v4-flash",
            "choices":[{"message":{"content":content},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
        }))
    }
}

fn runtime_with(tag: &str) -> (HubRuntime<ScriptTransport>, TempDir) {
    let ws = TempDir::new(tag);
    // A read_file then a finish: the loop executes ONE tool then Finishes (CompletedWithProof).
    let transport = ScriptTransport::new(&[
        "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
        "{\"tool\":\"none\"}",
    ]);
    let client = DeepSeekClient::with_transport(transport, "k".into());
    let agent = DeepSeekAgentLlmClient::new(client);
    let rt = HubRuntime::new(
        HubConfig {
            db_path: tmp_db(tag),
            workspace_root: ws.0.clone(),
            secret: SECRET.to_vec(),
            max_turns: 6,
            principal_id: Some("owner-surface".to_string()),
            disabled_tools: vec![],
            read_only: false,
            operator_vk: None,
        },
        agent,
        Box::new(DenyAllApprovals),
    )
    .unwrap();
    (rt, ws)
}

// The conversation id MUST be `fconv_`-shaped (the intake path validates it). The mission id is the
// REAL producer HYPHEN shape (`mission-…`, the only shape the live hub mints) — project_workbench has
// no id-shape gate, so this reflects producer reality (cf. the no-false-closure regression in
// `workbench_projection`).
const FCONV: &str = "fconv_surface";
const MISSION: &str = "mission-surface";
const WORK_ITEM: &str = "work_surface";
const SURFACE: &str = "surface_mobile_surface";

fn judgment() -> HandoffJudgmentMemory {
    HandoffJudgmentMemory {
        task: "Run the Mission-bound agent loop and emit timeline events".into(),
        current_blocker: None,
        target_lane_thread_agent_provider: WorkLane::DeepSeek.as_str().into(),
        read_first_files: vec!["rust-core/crates/friday-hub/src/surface_events.rs".into()],
        required_output: "Mission-bound loop completion with timeline events".into(),
        done_criteria: vec!["surface_event rows folded into the workbench timeline".into()],
        red_lines: vec!["never fail the run on a surface_event write".into()],
        why_this_route: "The WorkItem lane owns the agent loop.".into(),
        considered_options: vec!["no timeline".into()],
        deferred_options: vec!["multi-provider".into()],
        previous_pitfalls: vec!["empty workbench timeline".into()],
        inheritable_context: vec!["Mission is product truth".into()],
        proof_requirements: vec!["surface_event timeline tests".into()],
        ownership_claim_ids: Vec::new(),
    }
}

/// Seed a `FridayConversation -> Mission -> WorkItem` (+ a Mission-bound SurfaceThread, the thread
/// the producer resolves BY MISSION) and a route_decision so `project_workbench` projects the
/// mission. Mirrors the in-crate `seed_loop_mission` with a `fconv_` conversation id + a real
/// producer-shaped HYPHEN `mission-` id (the only shape the live hub mints).
fn seed_mission(db: &Db) {
    let now = 1_700_000_000_000;
    db.upsert_friday_conversation(&FridayConversation {
        friday_conversation_id: FCONV.into(),
        owner_principal: "owner-surface".into(),
        title: "Surface events".into(),
        current_focus_summary: "Mission-bound agent loop timeline".into(),
        active_mission_ids: vec![MISSION.into()],
        surface_thread_ids: vec![SURFACE.into()],
        memory_scope_ref: None,
        truth_status: TruthStatus::WiredRegistry,
        proof_refs: vec!["proof://surface-events-test".into()],
        created_at_ms: now,
        updated_at_ms: now,
    })
    .unwrap();
    db.upsert_mission(&Mission {
        mission_id: MISSION.into(),
        friday_conversation_id: FCONV.into(),
        title: "Surface events".into(),
        intent: "bind the agent loop and emit timeline events".into(),
        status: MissionStatus::Active,
        why_now: "the workbench timeline must show run lifecycle".into(),
        decision_path_summary: "resolve mission context before the loop".into(),
        considered_options: vec!["no timeline".into()],
        deferred_options: vec!["multi-provider".into()],
        known_pitfalls: vec!["empty timeline".into()],
        handoff_inheritance: vec!["preserve route judgment".into()],
        work_item_ids: vec![WORK_ITEM.into()],
        memory_candidate_refs: Vec::new(),
        context_passport_refs: Vec::new(),
        proof_refs: vec!["proof://surface-events-test".into()],
        created_at_ms: now,
        updated_at_ms: now,
    })
    .unwrap();
    db.upsert_surface_thread(&SurfaceThread {
        surface_thread_id: SURFACE.into(),
        friday_conversation_id: FCONV.into(),
        mission_id: Some(MISSION.into()),
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
        work_item_id: WORK_ITEM.into(),
        mission_id: MISSION.into(),
        lane: WorkLane::DeepSeek,
        target_provider_or_agent: Some("deepseek".into()),
        status: WorkItemStatus::ReadyToDispatch,
        owner_claim_ids: Vec::new(),
        workspace_refs: Vec::new(),
        capability_id: Some("mission.surface".into()),
        risk_level: Risk::Medium,
        approval_state: friday_core::ApprovalState::NotRequired,
        blocking_reason: None,
        input_refs: vec!["input://surface".into()],
        output_refs: Vec::new(),
        proof_requirements: vec!["surface_event timeline tests".into()],
        proof_receipts: Vec::new(),
        judgment_memory: judgment(),
        created_at_ms: now,
        updated_at_ms: now,
    })
    .unwrap();
}

fn lookup() -> MissionContextLookup {
    // by_mission_work_item ⇒ the resolved context's surface_thread_id is None ⇒ the producer MUST
    // resolve the bound thread by mission (the live path; NOT a threaded surface_thread_id).
    MissionContextLookup::by_mission_work_item(FCONV, MISSION, WORK_ITEM)
}

/// Run the mission-bound loop to a Finished completion (drives `run_agent_loop_for_mission`, the
/// live entry). The notes.md the read_file tool reads is written into the workspace first.
fn run_to_completion(rt: &HubRuntime<ScriptTransport>, ws: &TempDir, run_id: &str) {
    std::fs::write(ws.join("notes.md"), b"surface-events note").unwrap();
    let outcome = rt
        .run_agent_loop_for_mission(
            lookup(),
            "friday-hub-session",
            run_id,
            "read the notes",
            1000,
        )
        .unwrap();
    let MissionBoundLoopOutcome::Ran { outcome, .. } = outcome else {
        panic!("expected a Mission-bound loop run, got {outcome:?}");
    };
    assert_eq!(
        outcome.status,
        LoopStatus::Finished,
        "the scripted loop reads one file then finishes"
    );
    // The WorkItem is completed with proof (the run is the proof).
    assert_eq!(
        rt.db().get_work_item(WORK_ITEM).unwrap().unwrap().status,
        WorkItemStatus::CompletedWithProof
    );
}

/// Count the `surface_event`-ROW timeline entries the EXISTING reader (`append_surface_events`)
/// folds into the projection. Keyed on the reader's `timeline://mission/{m}/surface-event/{i}`
/// ref, which is UNIQUE to a `surface_event` row — deliberately NOT a substring of
/// `event_surface_*` ids, since the unrelated existing `MissionSurfaceProjection` events render as
/// `event_surface_projection_*` with a `.../surface-projection/...` ref. A non-zero count proves
/// the reader is now populated by the PRODUCER (the reader itself is UNCHANGED).
fn surface_event_refs_in_projection(snapshot: &Value) -> usize {
    serde_json::to_string(snapshot)
        .unwrap()
        .matches("/surface-event/")
        .count()
}

// ─────────────────────────── flag ON then OFF, in ONE sequential test ───────────────────────────
//
// `FRIDAY_SURFACE_EVENTS` is process-global. Each `tests/*.rs` file is its own binary, so the ONLY
// thing that could race the env read in THIS binary is another `#[test]` fn in THIS file mutating
// the var concurrently. Both arms therefore live in ONE sequential `#[test]` (no concurrency, no
// race) on FRESH per-arm DBs. The byte-identical-OFF behavioral proof with the bool injected
// directly (no env at all) is the in-crate
// `runtime::tests::surface_events_run_path_off_is_byte_identical_on_emits_run_rows`.
#[test]
fn flag_on_emits_lifecycle_events_and_reader_includes_them_then_off_is_clean() {
    // ── ON phase: produced + folded into the timeline ──────────────────────────────────────
    std::env::set_var(friday_hub::FRIDAY_SURFACE_EVENTS, "1");
    let (rt, ws) = runtime_with("on");
    seed_mission(rt.db());

    // INTAKE-BIRTH: drive the live intake producer (env flag ON) on the SAME canonical mission ids
    // already seeded — the READY path emits the birth surface_event. (The intake upserts over the
    // seeded rows idempotently.)
    let intake = friday_hub::hub_server::mission_intake_result_for_db(
        rt.db(),
        "req-surface-on",
        intake_request(),
        Some("owner-surface"), // (FIX-Q3b) authenticated owner == the request's owner_principal
        900,
    );
    // The intake resolved READY (a row exists) — not an Error envelope.
    assert!(
        matches!(intake.message, Message::MissionIntakeResult { .. }),
        "intake should resolve to a MissionIntakeResult, got {:?}",
        intake.message
    );

    // RUN-START + RUN-PROOF: drive the mission-bound loop to completion.
    run_to_completion(&rt, &ws, "run-surface-on");

    // (1) The producer wrote the lifecycle surface_event rows for the mission.
    let events = rt.db().list_surface_events_for_mission(MISSION).unwrap();
    let kinds: Vec<&str> = events.iter().map(|e| e.event_kind.as_str()).collect();
    assert!(
        kinds.contains(&"system_status"),
        "intake-birth (system_status) row present: {kinds:?}"
    );
    assert!(
        kinds.contains(&"provider_trace"),
        "run-start (provider_trace) row present: {kinds:?}"
    );
    assert!(
        kinds.contains(&"proof_receipt"),
        "run-proof (proof_receipt) row present: {kinds:?}"
    );
    // ORDER: the reader sorts by (created_at_ms, surface_event_id). The lifecycle must read
    // birth → start → proof. intake-birth (900) < run-start (1000) < run-proof (1001 = now_ms+1);
    // the proof bump guards the equal-stamp id-tiebreak that would otherwise put proof before start.
    let birth_idx = kinds.iter().position(|k| *k == "system_status").unwrap();
    let start_idx = kinds.iter().position(|k| *k == "provider_trace").unwrap();
    let proof_idx = kinds.iter().position(|k| *k == "proof_receipt").unwrap();
    assert!(
        birth_idx < start_idx && start_idx < proof_idx,
        "timeline order must be birth → run-start → run-proof: {kinds:?}"
    );
    // Each row is correctly linked to the mission + the bound surface thread (validate passed).
    for event in &events {
        assert_eq!(event.mission_id, MISSION);
        assert_eq!(event.friday_conversation_id, FCONV);
        assert_eq!(event.surface_thread_id, SURFACE);
        assert_eq!(event.source_surface, SurfaceKind::Mobile);
    }

    // (2) The EXISTING reader now folds them into the workbench timeline.
    let snapshot = project_workbench(rt.db(), Some(MISSION)).unwrap();
    let count = surface_event_refs_in_projection(&snapshot);
    assert!(
        count >= 3,
        "the workbench timeline includes the >=3 surface_event rows, found {count}: {snapshot}"
    );

    // (3) The audit chain stays clean — the producer never corrupts it.
    assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());

    // ── OFF phase: zero rows, timeline byte-identical-minus-events ──────────────────────────
    // Explicit "0" (NOT remove_var) so the read at call time below is deterministically OFF. Fresh
    // DB/ws so the OFF arm cannot see the ON arm's rows.
    std::env::set_var(friday_hub::FRIDAY_SURFACE_EVENTS, "0");
    let (rt_off, ws_off) = runtime_with("off");
    seed_mission(rt_off.db());

    let _intake_off = friday_hub::hub_server::mission_intake_result_for_db(
        rt_off.db(),
        "req-surface-off",
        intake_request(),
        Some("owner-surface"), // (FIX-Q3b) authenticated owner == the request's owner_principal
        900,
    );
    run_to_completion(&rt_off, &ws_off, "run-surface-off");

    // (1) ZERO surface_event rows — the producer is fully skipped.
    let events_off = rt_off
        .db()
        .list_surface_events_for_mission(MISSION)
        .unwrap();
    assert!(
        events_off.is_empty(),
        "flag-OFF writes NO surface_event rows, found {events_off:?}"
    );

    // (2) The projection timeline carries NO surface_event ref (byte-identical-minus-events).
    let snapshot_off = project_workbench(rt_off.db(), Some(MISSION)).unwrap();
    assert_eq!(
        surface_event_refs_in_projection(&snapshot_off),
        0,
        "flag-OFF timeline has no surface_event ref: {snapshot_off}"
    );

    // (3) The run still completed with proof (the producer never gates the run).
    assert_eq!(
        rt_off
            .db()
            .get_work_item(WORK_ITEM)
            .unwrap()
            .unwrap()
            .status,
        WorkItemStatus::CompletedWithProof
    );
    assert!(friday_storage::audit::verify_audit_chain(rt_off.db().conn()).is_ok());

    // Hygiene: leave the process env clean for any later test in this binary.
    std::env::remove_var(friday_hub::FRIDAY_SURFACE_EVENTS);
}

/// Build the intake request wire targeting the SAME canonical mission/work-item/conversation ids the
/// seed uses, so the live intake producer resolves them READY (idempotent upsert over the seed).
fn intake_request() -> MissionIntakeRequestWire {
    MissionIntakeRequestWire {
        friday_conversation_id: FCONV.into(),
        owner_principal: "owner-surface".into(),
        surface_thread_id: SURFACE.into(),
        surface_kind: "mobile".into(),
        delivery_route: "mobile".into(),
        visibility_policy: "compact".into(),
        mission_id: MISSION.into(),
        work_item_id: WORK_ITEM.into(),
        title: "Surface events".into(),
        intent: "bind the agent loop and emit timeline events".into(),
        lane: "deepseek".into(),
        target_provider_or_agent: Some("deepseek".into()),
        capability_id: Some("mission.surface".into()),
        body_ref: None,
        proof_requirements: Vec::new(),
        includes_sensitive_context: false,
    }
}
