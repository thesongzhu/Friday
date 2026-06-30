//! Attach a verified live channel proof to one Mission graph and immediately project it.
//!
//! This is an ops-only proof bridge for the last-inch UI/device gate. It does not claim the
//! channel proof by itself is END-BAR; it proves that a real, schema-validated channel live proof
//! can be consumed by the canonical Mission Workbench projection as a refs-only ChannelInbound
//! event for the same Mission mobile/desktop surfaces.

use friday_core::{
    ApprovalState, HandoffJudgmentMemory, Mission, Risk, SurfaceEvent, SurfaceEventKind,
    SurfaceKind, SurfaceThread, VisibilityPolicy, WorkItem, WorkItemStatus, WorkLane,
};
use friday_hub::channels::RedactedInbound;
use friday_hub::mission_context::MissionContextLookup;
use friday_hub::mission_runtime::{ingest_channel_inbound_for_mission, MissionBoundChannelOutcome};
use friday_hub::workbench_projection::project_workbench;
use friday_storage::{Db, StorageError};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const ACK_ENV: &str = "FRIDAY_MISSION_BOUND_CHANNEL_ATTACH_ACK";
const ACK_VALUE: &str = "attach-verified-channel-proof-to-mission";

#[derive(Debug, Deserialize)]
struct ChannelLiveWrapper {
    proof: String,
    status: String,
    capture_mode: Option<String>,
    telegram_live: TelegramLive,
    secret_policy: SecretPolicy,
}

#[derive(Debug, Deserialize)]
struct TelegramLive {
    status: String,
    proof: String,
    sender_id_present: bool,
    sender_allowlisted: bool,
    bearer_auth_accepted_correct: bool,
    forged_bearer_rejected: bool,
    non_allowlisted_sender_rejected: bool,
    bot_identity_verified: bool,
    channel_binding_created: bool,
    raw_text_chars: u64,
}

#[derive(Debug, Deserialize)]
struct SecretPolicy {
    token_logged: bool,
    token_written_to_artifact: bool,
    provider_or_channel_id_written: bool,
    raw_sender_id_written: bool,
    artifact_contains_redacted_text_only: bool,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("mission_bound_channel_live_projection_unavailable: {err}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let args = env::args().collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        usage();
        return Ok(());
    }
    if env::var(ACK_ENV).ok().as_deref() != Some(ACK_VALUE) {
        return Err(format!(
            "{ACK_ENV}={ACK_VALUE} required; refusing to write Mission graph"
        ));
    }
    let db_path = arg_value(&args, "--db").ok_or("--db is required")?;
    let mission_id = arg_value(&args, "--mission-id").ok_or("--mission-id is required")?;
    let channel_live_proof =
        arg_value(&args, "--channel-live-proof").ok_or("--channel-live-proof is required")?;
    let out_path = arg_value(&args, "--out").ok_or("--out is required")?;
    if !Path::new(&db_path).is_file() {
        return Err(format!("db not found: {db_path}"));
    }
    if !Path::new(&channel_live_proof).is_file() {
        return Err(format!(
            "channel live proof not found: {channel_live_proof}"
        ));
    }

    let wrapper = load_and_validate_wrapper(&channel_live_proof)?;
    let now_ms = now_ms();
    let proof_hash = file_sha256_hex(&channel_live_proof).map_err(|err| err.to_string())?;
    let mut db = Db::open_hub(&db_path).map_err(|err| err.to_string())?;
    let outcome = attach_to_mission(&mut db, &mission_id, &wrapper, &proof_hash, now_ms)
        .map_err(|err| err.to_string())?;
    let snapshot = project_workbench(&db, Some(&mission_id))?;
    let has_channel_refs = snapshot
        .get("channelReceiptRefs")
        .and_then(Value::as_array)
        .is_some_and(|refs| !refs.is_empty());
    let has_channel_surface = snapshot
        .get("transcriptSections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|section| {
            section
                .get("events")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .any(|event| event.get("surface").and_then(Value::as_str) == Some("telegram"));
    let status = if has_channel_refs && has_channel_surface {
        "ready"
    } else {
        "blocked"
    };
    let report = json!({
        "truth": "mission_bound_channel_live_projection_refs_only",
        "status": status,
        "missionId": mission_id,
        "channelProofSha256": proof_hash,
        "captureMode": wrapper.capture_mode,
        "attachment": outcome,
        "checks": {
            "channelReceiptRefs": has_channel_refs,
            "telegramTranscriptSurface": has_channel_surface
        },
        "caveat": "This attaches a verified live channel proof to the Mission graph for UI/device consumption; it does not claim END-BAR, release, adoption, or raw transcript sync."
    });
    fs::write(
        &out_path,
        serde_json::to_string_pretty(&report).map_err(|err| err.to_string())? + "\n",
    )
    .map_err(|err| err.to_string())?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|err| err.to_string())?
    );
    if status == "ready" {
        Ok(())
    } else {
        Err("mission projection did not surface channel refs".into())
    }
}

fn usage() {
    eprintln!(
        "usage: {ACK_ENV}={ACK_VALUE} mission_bound_channel_live_projection \\
  --db=/abs/rust-hub.sqlite --mission-id=mission... \\
  --channel-live-proof=/abs/mission_spine_channel_live_proof.json --out=/abs/report.json"
    );
}

fn attach_to_mission(
    db: &mut Db,
    mission_id: &str,
    wrapper: &ChannelLiveWrapper,
    proof_hash: &str,
    now_ms: i64,
) -> Result<Value, StorageError> {
    let mut mission = db
        .get_mission(mission_id)?
        .ok_or_else(|| StorageError::Unsupported(format!("unknown mission '{mission_id}'")))?;
    let channel_id = format!("telegram-live-proof:{}", &proof_hash[..12]);
    let work_item_id = format!("work-channel-live-proof-{}", &proof_hash[..16]);
    let surface_thread_id = format!("surface-telegram-live-proof-{}", &proof_hash[..16]);
    let proof_ref = format!("proof://channel-live/sha256/{proof_hash}");
    let body_ref = format!("friday://body/channel-live-proof/{}", &proof_hash[..16]);

    upsert_channel_work_item(db, &mission, &work_item_id, &channel_id, &proof_ref, now_ms)?;
    db.upsert_surface_thread(&SurfaceThread {
        surface_thread_id: surface_thread_id.clone(),
        friday_conversation_id: mission.friday_conversation_id.clone(),
        mission_id: Some(mission_id.to_string()),
        surface_kind: SurfaceKind::Telegram,
        channel_binding_id: None,
        delivery_route: "ops://verified-channel-live-proof".into(),
        visibility_policy: VisibilityPolicy::StatusOnly,
        allowed_actions: vec!["open".into()],
        last_seen_at_ms: Some(now_ms),
        last_delivered_event_seq: None,
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    })?;

    let redacted = RedactedInbound {
        channel_id: channel_id.clone(),
        sender_id: "allowlisted_telegram_user".into(),
        bound_principal_id: "owner_channel_live_proof".into(),
        text: format!(
            "validated Telegram live proof with {} chars after redaction",
            wrapper.telegram_live.raw_text_chars
        ),
        pii_redacted: Vec::new(),
    };
    let channel_msg_id = &proof_hash[..16];
    let recorded = ingest_channel_inbound_for_mission(
        db,
        MissionContextLookup::by_mission_work_item(
            &mission.friday_conversation_id,
            mission_id,
            &work_item_id,
        ),
        &redacted,
        channel_msg_id,
        "message",
        false,
        Risk::Low,
        &[],
        now_ms,
    )?;

    let MissionBoundChannelOutcome::Recorded {
        receipt,
        attachment: runtime_attachment,
        ..
    } = recorded
    else {
        return Err(StorageError::Unsupported(
            "mission-bound channel runtime blocked before recording".into(),
        ));
    };
    db.upsert_surface_event(&SurfaceEvent {
        surface_event_id: format!("surface-event-channel-live-proof-{}", &proof_hash[..16]),
        friday_conversation_id: mission.friday_conversation_id.clone(),
        mission_id: mission_id.to_string(),
        work_item_id: Some(work_item_id.clone()),
        surface_thread_id,
        source_surface: SurfaceKind::Telegram,
        event_kind: SurfaceEventKind::ChannelInbound,
        body_ref: Some(body_ref),
        visibility_policy: VisibilityPolicy::StatusOnly,
        proof_ref: Some(proof_ref.clone()),
        created_at_ms: now_ms,
    })?;
    let attachment = json!({
        "runtimeOutcome": "recorded",
        "activityId": receipt.activity_id,
        "disposition": receipt.disposition,
        "replayed": receipt.replayed,
        "missionAttachment": format!("{runtime_attachment:?}")
    });

    push_unique(&mut mission.work_item_ids, work_item_id);
    push_unique(&mut mission.proof_refs, proof_ref);
    mission.updated_at_ms = now_ms;
    db.upsert_mission(&mission)?;
    Ok(attachment)
}

fn upsert_channel_work_item(
    db: &Db,
    mission: &Mission,
    work_item_id: &str,
    channel_id: &str,
    proof_ref: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    db.upsert_work_item(&WorkItem {
        work_item_id: work_item_id.to_string(),
        mission_id: mission.mission_id.clone(),
        lane: WorkLane::Channel,
        target_provider_or_agent: Some(channel_id.to_string()),
        status: WorkItemStatus::ReadyToDispatch,
        owner_claim_ids: Vec::new(),
        workspace_refs: Vec::new(),
        capability_id: Some("capability.channel.live-proof-consumption".into()),
        risk_level: Risk::Low,
        approval_state: ApprovalState::NotRequired,
        blocking_reason: None,
        input_refs: vec![proof_ref.to_string()],
        output_refs: Vec::new(),
        proof_requirements: vec!["channel live proof must remain redacted and refs-only".into()],
        proof_receipts: Vec::new(),
        judgment_memory: HandoffJudgmentMemory {
            task: "Attach verified channel live proof to the Mission graph".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: "bound telegram channel live proof".into(),
            read_first_files: vec![proof_ref.to_string()],
            required_output: "Mission Workbench projection surfaces a redacted ChannelInbound ref".into(),
            done_criteria: vec![
                "channelReceiptRefs is non-empty".into(),
                "telegram transcript event is visible".into(),
            ],
            red_lines: vec![
                "do not store raw Telegram token/sender/text".into(),
                "do not claim END-BAR from channel proof alone".into(),
            ],
            why_this_route: "The UI/device strict gate needs the same Mission graph to carry a channel evidence leg.".into(),
            considered_options: vec![
                "attach a fake UI observation".into(),
                "attach verified channel proof through Mission graph".into(),
            ],
            deferred_options: vec!["release/adoption proof remains separate".into()],
            previous_pitfalls: vec!["channel proof file alone is not UI consumption proof".into()],
            inheritable_context: vec!["refs-only workbench projection is the source of truth".into()],
            proof_requirements: vec!["schema-validated live channel proof".into()],
            ownership_claim_ids: Vec::new(),
        },
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
    })
}

fn load_and_validate_wrapper(path: &str) -> Result<ChannelLiveWrapper, String> {
    let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let wrapper: ChannelLiveWrapper = serde_json::from_str(&text).map_err(|err| err.to_string())?;
    let mut failures = Vec::new();
    if wrapper.proof != "mission_spine_channel_live_proof" {
        failures.push("wrapper_proof_mismatch");
    }
    if wrapper.status != "passed" {
        failures.push("wrapper_status_not_passed");
    }
    let telegram = &wrapper.telegram_live;
    if telegram.status != "passed" {
        failures.push("telegram_status_not_passed");
    }
    if telegram.proof != "telegram_inbound_through_rust_channels_pipeline" {
        failures.push("telegram_proof_mismatch");
    }
    for (ok, name) in [
        (telegram.sender_id_present, "sender_id_missing"),
        (telegram.sender_allowlisted, "sender_not_allowlisted"),
        (
            telegram.bearer_auth_accepted_correct,
            "bearer_auth_not_accepted",
        ),
        (
            telegram.forged_bearer_rejected,
            "forged_bearer_not_rejected",
        ),
        (
            telegram.non_allowlisted_sender_rejected,
            "non_allowlisted_sender_not_rejected",
        ),
        (telegram.bot_identity_verified, "bot_identity_not_verified"),
        (telegram.channel_binding_created, "channel_binding_missing"),
        (
            wrapper.secret_policy.artifact_contains_redacted_text_only,
            "artifact_not_redacted_only",
        ),
    ] {
        if !ok {
            failures.push(name);
        }
    }
    if wrapper.secret_policy.token_logged
        || wrapper.secret_policy.token_written_to_artifact
        || wrapper.secret_policy.provider_or_channel_id_written
        || wrapper.secret_policy.raw_sender_id_written
    {
        failures.push("secret_policy_leak");
    }
    if telegram.raw_text_chars == 0 {
        failures.push("raw_text_chars_missing");
    }
    if failures.is_empty() {
        Ok(wrapper)
    } else {
        Err(format!(
            "channel live proof blocked: {}",
            failures.join(",")
        ))
    }
}

fn file_sha256_hex(path: &str) -> std::io::Result<String> {
    let bytes = fs::read(path)?;
    let digest = Sha256::digest(bytes);
    Ok(format!("{digest:x}"))
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
        .or_else(|| {
            let prefix = format!("{name}=");
            args.iter()
                .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_string))
        })
}
