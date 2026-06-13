//! Mission Spine Hub preflight and attachment seam.
//!
//! This is the first Hub-level composition slice for the product graph built in
//! `friday-core`/`friday-storage`: before a routed unit of work can dispatch, the
//! Hub resolves it into `FridayConversation -> Mission -> WorkItem`, checks the
//! anti-duplicate and handoff/context/ownership guards, then attaches provider and
//! channel evidence as `MissionLink`s. Provider sessions and channel events remain
//! evidence streams; they do not become Friday conversations.

use friday_core::MemoryState;
use friday_core::{
    requires_context_passport, ApprovalState, FridayConversation, Mission, MissionLink,
    MissionLinkKind, SurfaceThread, WorkItem, WorkItemStatus,
};
use friday_storage::{memory, workflow, Db, StorageError};

use crate::channel_event::ChannelInboundReceipt;
use crate::provider_timeline::PendingState;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissionPreflightRequest {
    pub conversation: FridayConversation,
    pub mission: Mission,
    pub surface_thread: Option<SurfaceThread>,
    pub work_item: WorkItem,
    pub includes_sensitive_context: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderTimelineAttachment {
    pub mission_id: String,
    pub work_item_id: String,
    pub friday_session_id: String,
    pub request_id: String,
    pub state: PendingState,
    pub proof_ref: Option<String>,
    pub now_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MissionPreflightOutcome {
    Ready {
        mission_id: String,
        work_item_id: String,
    },
    Blocked {
        blockers: Vec<String>,
        duplicate_mission_id: Option<String>,
        duplicate_work_item_id: Option<String>,
    },
}

impl MissionPreflightOutcome {
    pub fn is_ready(&self) -> bool {
        matches!(self, MissionPreflightOutcome::Ready { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MissionAttachmentOutcome {
    Attached {
        link_id: String,
        work_item_status: WorkItemStatus,
    },
    MissionLinked {
        link_id: String,
    },
    Blocked {
        blockers: Vec<String>,
    },
}

impl MissionAttachmentOutcome {
    fn blocked(blocker: impl Into<String>) -> Self {
        MissionAttachmentOutcome::Blocked {
            blockers: vec![blocker.into()],
        }
    }
}

/// Stage a WorkItem only after it can be safely routed through the Mission Spine.
///
/// On duplicate or preflight blocker this function writes no new Mission/WorkItem
/// rows, so a second mobile/desktop/channel request cannot silently create task
/// debt before Friday explains the conflict to the user.
pub fn preflight_and_stage_work_item(
    db: &Db,
    request: MissionPreflightRequest,
) -> Result<MissionPreflightOutcome, StorageError> {
    let mut blockers = validate_preflight_request(&request);
    // Db-backed Context Passport gate (destination-binding; appended to the SAME vec so
    // collect-all-then-block semantics hold — never reordered ahead of the pure checks).
    if let Some(passport_blocker) = context_passport_blocker(db, &request)? {
        blockers.push(passport_blocker);
    }
    if !blockers.is_empty() {
        return Ok(MissionPreflightOutcome::Blocked {
            blockers,
            duplicate_mission_id: None,
            duplicate_work_item_id: None,
        });
    }

    if let Some(existing) = db.find_duplicate_mission(&request.mission)? {
        if existing.mission_id != request.mission.mission_id {
            bind_surface_to_existing_mission(db, &request, &existing.mission_id)?;
            return Ok(MissionPreflightOutcome::Blocked {
                blockers: vec!["duplicate_active_mission_before_dispatch".into()],
                duplicate_mission_id: Some(existing.mission_id),
                duplicate_work_item_id: None,
            });
        }
    }

    if let Some(existing) = db.find_duplicate_work_item(&request.work_item)? {
        if existing.work_item_id != request.work_item.work_item_id {
            bind_surface_to_existing_mission(db, &request, &existing.mission_id)?;
            return Ok(MissionPreflightOutcome::Blocked {
                blockers: vec!["duplicate_active_work_item_before_dispatch".into()],
                duplicate_mission_id: None,
                duplicate_work_item_id: Some(existing.work_item_id),
            });
        }
    }

    let mut conversation = request.conversation;
    push_unique(
        &mut conversation.active_mission_ids,
        request.mission.mission_id.clone(),
    );

    let mut mission = request.mission;
    push_unique(
        &mut mission.work_item_ids,
        request.work_item.work_item_id.clone(),
    );

    let mut surface_thread = request.surface_thread;
    if let Some(surface) = surface_thread.as_mut() {
        surface.mission_id = Some(mission.mission_id.clone());
        push_unique(
            &mut conversation.surface_thread_ids,
            surface.surface_thread_id.clone(),
        );
    }

    let mut work_item = request.work_item;
    work_item.status = WorkItemStatus::ReadyToDispatch;
    work_item.blocking_reason = None;

    db.upsert_friday_conversation(&conversation)?;
    db.upsert_mission(&mission)?;
    if let Some(surface) = surface_thread {
        db.upsert_surface_thread(&surface)?;
    }
    db.upsert_work_item(&work_item)?;

    Ok(MissionPreflightOutcome::Ready {
        mission_id: mission.mission_id,
        work_item_id: work_item.work_item_id,
    })
}

pub fn attach_channel_inbound_receipt(
    db: &Db,
    mission_id: &str,
    work_item_id: &str,
    receipt: &ChannelInboundReceipt,
    now_ms: i64,
) -> Result<MissionAttachmentOutcome, StorageError> {
    if db.get_mission(mission_id)?.is_none() {
        return Ok(MissionAttachmentOutcome::blocked("unknown_mission"));
    }
    let Some(work_item) = db.get_work_item(work_item_id)? else {
        return Ok(MissionAttachmentOutcome::blocked("unknown_work_item"));
    };
    if work_item.mission_id != mission_id {
        return Ok(MissionAttachmentOutcome::blocked(
            "work_item_mission_mismatch",
        ));
    }

    let target_ref = format!("friday://activity/{}", receipt.activity_id);
    let link_id = stable_link_id(
        "mlink_channel",
        mission_id,
        work_item_id,
        &receipt.activity_id,
    );
    db.upsert_mission_link(&MissionLink {
        link_id: link_id.clone(),
        mission_id: mission_id.to_string(),
        work_item_id: Some(work_item_id.to_string()),
        link_kind: MissionLinkKind::ChannelInbound,
        target_ref: target_ref.clone(),
        proof_ref: Some(target_ref),
        created_at_ms: now_ms,
    })?;
    Ok(MissionAttachmentOutcome::Attached {
        link_id,
        work_item_status: work_item.status,
    })
}

pub fn attach_workflow_run_ref(
    db: &Db,
    mission_id: &str,
    work_item_id: &str,
    workflow_run_id: &str,
    proof_ref: Option<String>,
    now_ms: i64,
) -> Result<MissionAttachmentOutcome, StorageError> {
    if workflow_run_id.trim().is_empty() {
        return Ok(MissionAttachmentOutcome::blocked(
            "workflow_run_id_required",
        ));
    }
    if workflow::run_state(db.conn(), workflow_run_id)?.is_none() {
        return Ok(MissionAttachmentOutcome::blocked("unknown_workflow_run"));
    }

    attach_mission_link_ref(
        db,
        mission_id,
        Some(work_item_id),
        MissionLinkKind::WorkflowRun,
        format!("friday://workflow-run/{workflow_run_id}"),
        proof_ref,
        now_ms,
    )
}

pub fn attach_memory_candidate_ref(
    db: &Db,
    mission_id: &str,
    memory_id: &str,
    now_ms: i64,
) -> Result<MissionAttachmentOutcome, StorageError> {
    if memory_id.trim().is_empty() {
        return Ok(MissionAttachmentOutcome::blocked("memory_id_required"));
    }
    let Some(row) = memory::get(db.conn(), memory_id)? else {
        return Ok(MissionAttachmentOutcome::blocked("unknown_memory_item"));
    };
    if row.state != MemoryState::Candidate {
        return Ok(MissionAttachmentOutcome::blocked(
            "memory_candidate_requires_candidate_state",
        ));
    }

    let memory_ref = format!("friday://memory/{memory_id}");
    let outcome = attach_mission_link_ref(
        db,
        mission_id,
        None,
        MissionLinkKind::MemoryCandidate,
        memory_ref.clone(),
        None,
        now_ms,
    )?;
    if matches!(
        &outcome,
        MissionAttachmentOutcome::MissionLinked { .. } | MissionAttachmentOutcome::Attached { .. }
    ) {
        let Some(mut mission) = db.get_mission(mission_id)? else {
            return Ok(MissionAttachmentOutcome::blocked("unknown_mission"));
        };
        push_unique(&mut mission.memory_candidate_refs, memory_ref);
        mission.updated_at_ms = now_ms;
        db.upsert_mission(&mission)?;
    }
    Ok(outcome)
}

pub fn attach_memory_decision_ref(
    db: &Db,
    mission_id: &str,
    memory_id: &str,
    now_ms: i64,
) -> Result<MissionAttachmentOutcome, StorageError> {
    if memory_id.trim().is_empty() {
        return Ok(MissionAttachmentOutcome::blocked("memory_id_required"));
    }
    let Some(row) = memory::get(db.conn(), memory_id)? else {
        return Ok(MissionAttachmentOutcome::blocked("unknown_memory_item"));
    };
    if !row.state.is_terminal() {
        return Ok(MissionAttachmentOutcome::blocked(
            "memory_decision_requires_terminal_state",
        ));
    }

    let link_kind = if row.state == MemoryState::Confirmed {
        MissionLinkKind::ConfirmedMemory
    } else {
        MissionLinkKind::MemoryDecision
    };
    attach_mission_link_ref(
        db,
        mission_id,
        None,
        link_kind,
        format!("friday://memory/{memory_id}#{}", row.state.as_str()),
        Some(format!(
            "friday://memory-decision/{memory_id}#{}",
            row.state.as_str()
        )),
        now_ms,
    )
}

/// Mint + attach a destination-bound Context Passport OBJECT (loop closure commit 2).
///
/// Evolved from the old ref-only version: instead of pushing an arbitrary string into
/// `context_passport_refs` (which the hollow gate trusted), this BUILDS a real
/// [`ContextPassport`] (`build_context_passport` runs `gate_transfer` — a secret/
/// raw-token item or an unapproved sensitive item makes the build fail, so the passport
/// is never minted), PERSISTS the object, links it by `passport_id`, and pushes the
/// `passport_id` as the ref. The strengthened preflight gate then re-loads + re-gates +
/// destination-checks THIS object. A build failure returns a `passport_blocked_*`
/// outcome (the secret never persists).
#[allow(clippy::too_many_arguments)]
pub fn attach_context_passport_ref(
    db: &Db,
    mission_id: &str,
    passport_id: &str,
    work_item_id: Option<&str>,
    destination_lane: friday_core::WorkLane,
    destination_target: Option<&str>,
    items: Vec<friday_core::PassportItem>,
    approved_sensitive: bool,
    now_ms: i64,
) -> Result<MissionAttachmentOutcome, StorageError> {
    if passport_id.trim().is_empty() {
        return Ok(MissionAttachmentOutcome::blocked(
            "context_passport_id_required",
        ));
    }

    // Fail-closed by construction: a passport that would carry a secret / unapproved
    // sensitive item cannot be built, so it is never persisted or linked.
    let passport = match friday_core::build_context_passport(
        passport_id.to_string(),
        mission_id.to_string(),
        work_item_id.map(|s| s.to_string()),
        destination_lane,
        destination_target.map(|s| s.to_string()),
        items,
        approved_sensitive,
        now_ms,
    ) {
        Ok(p) => p,
        Err(e) => {
            return Ok(MissionAttachmentOutcome::blocked(format!(
                "context_passport_blocked:{e}"
            )));
        }
    };

    let outcome = attach_mission_link_ref(
        db,
        mission_id,
        work_item_id,
        MissionLinkKind::ContextPassport,
        format!("friday://context-passport/{passport_id}"),
        Some(passport_id.to_string()),
        now_ms,
    )?;
    if matches!(
        &outcome,
        MissionAttachmentOutcome::MissionLinked { .. } | MissionAttachmentOutcome::Attached { .. }
    ) {
        let Some(mut mission) = db.get_mission(mission_id)? else {
            return Ok(MissionAttachmentOutcome::blocked("unknown_mission"));
        };
        // Persist the gated object, then record its id as the ref the gate resolves.
        db.upsert_context_passport(&passport)?;
        push_unique(&mut mission.context_passport_refs, passport_id.to_string());
        mission.updated_at_ms = now_ms;
        db.upsert_mission(&mission)?;
    }
    Ok(outcome)
}

pub fn attach_proof_receipt_ref(
    db: &Db,
    mission_id: &str,
    work_item_id: &str,
    proof_ref: &str,
    now_ms: i64,
) -> Result<MissionAttachmentOutcome, StorageError> {
    if proof_ref.trim().is_empty() {
        return Ok(MissionAttachmentOutcome::blocked("proof_ref_required"));
    }

    let outcome = attach_mission_link_ref(
        db,
        mission_id,
        Some(work_item_id),
        MissionLinkKind::ProofReceipt,
        proof_ref.to_string(),
        Some(proof_ref.to_string()),
        now_ms,
    )?;
    match outcome {
        MissionAttachmentOutcome::Attached { link_id, .. } => {
            let Some(mut mission) = db.get_mission(mission_id)? else {
                return Ok(MissionAttachmentOutcome::blocked("unknown_mission"));
            };
            let Some(mut work_item) = db.get_work_item(work_item_id)? else {
                return Ok(MissionAttachmentOutcome::blocked("unknown_work_item"));
            };
            push_unique(&mut mission.proof_refs, proof_ref.to_string());
            push_unique(&mut work_item.proof_receipts, proof_ref.to_string());
            mission.updated_at_ms = now_ms;
            work_item.updated_at_ms = now_ms;
            db.upsert_mission(&mission)?;
            db.upsert_work_item(&work_item)?;
            Ok(MissionAttachmentOutcome::Attached {
                link_id,
                work_item_status: work_item.status,
            })
        }
        other => Ok(other),
    }
}

pub fn attach_workspace_claim_ref(
    db: &Db,
    mission_id: &str,
    work_item_id: &str,
    claim_id: &str,
    now_ms: i64,
) -> Result<MissionAttachmentOutcome, StorageError> {
    if claim_id.trim().is_empty() {
        return Ok(MissionAttachmentOutcome::blocked(
            "workspace_claim_id_required",
        ));
    }
    let Some(claim) = db.get_workspace_claim(claim_id)? else {
        return Ok(MissionAttachmentOutcome::blocked("unknown_workspace_claim"));
    };
    if claim.mission_id != mission_id {
        return Ok(MissionAttachmentOutcome::blocked(
            "workspace_claim_mission_mismatch",
        ));
    }
    if let Some(claim_work_item_id) = claim.work_item_id.as_deref() {
        if claim_work_item_id != work_item_id {
            return Ok(MissionAttachmentOutcome::blocked(
                "workspace_claim_work_item_mismatch",
            ));
        }
    }

    let outcome = attach_mission_link_ref(
        db,
        mission_id,
        Some(work_item_id),
        MissionLinkKind::WorkspaceClaim,
        format!("friday://workspace-claim/{claim_id}"),
        claim.proof_refs.last().cloned(),
        now_ms,
    )?;
    if matches!(&outcome, MissionAttachmentOutcome::Attached { .. }) {
        let Some(mut work_item) = db.get_work_item(work_item_id)? else {
            return Ok(MissionAttachmentOutcome::blocked("unknown_work_item"));
        };
        push_unique(&mut work_item.owner_claim_ids, claim_id.to_string());
        push_unique(
            &mut work_item.judgment_memory.ownership_claim_ids,
            claim_id.to_string(),
        );
        work_item.updated_at_ms = now_ms;
        db.upsert_work_item(&work_item)?;
    }
    Ok(outcome)
}

pub fn attach_provider_timeline_state(
    db: &Db,
    attachment: ProviderTimelineAttachment,
) -> Result<MissionAttachmentOutcome, StorageError> {
    let Some(mut mission) = db.get_mission(&attachment.mission_id)? else {
        return Ok(MissionAttachmentOutcome::blocked("unknown_mission"));
    };
    let Some(mut work_item) = db.get_work_item(&attachment.work_item_id)? else {
        return Ok(MissionAttachmentOutcome::blocked("unknown_work_item"));
    };
    if work_item.mission_id != attachment.mission_id {
        return Ok(MissionAttachmentOutcome::blocked(
            "work_item_mission_mismatch",
        ));
    }
    let Some(next_status) =
        work_item_status_for_provider_state(attachment.state, attachment.proof_ref.as_deref())
    else {
        return Ok(MissionAttachmentOutcome::blocked(provider_state_blocker(
            attachment.state,
            attachment.proof_ref.as_deref(),
        )));
    };
    if work_item.status != next_status && !work_item.status.can_transition_to(next_status) {
        return Ok(MissionAttachmentOutcome::blocked(format!(
            "illegal_work_item_transition:{}->{}",
            work_item.status.as_str(),
            next_status.as_str()
        )));
    }

    work_item.status = next_status;
    work_item.updated_at_ms = attachment.now_ms;
    if next_status == WorkItemStatus::CompletedWithProof {
        if let Some(proof_ref) = attachment.proof_ref.as_ref() {
            push_unique(&mut work_item.proof_receipts, proof_ref.clone());
            push_unique(&mut mission.proof_refs, proof_ref.clone());
            mission.updated_at_ms = attachment.now_ms;
        }
    }
    db.upsert_work_item(&work_item)?;
    db.upsert_mission(&mission)?;

    let target_ref = format!(
        "friday://provider-timeline/{}#{}",
        attachment.friday_session_id, attachment.request_id
    );
    let link_id = stable_link_id(
        "mlink_provider",
        &attachment.mission_id,
        &attachment.work_item_id,
        &format!("{}_{}", attachment.friday_session_id, attachment.request_id),
    );
    db.upsert_mission_link(&MissionLink {
        link_id: link_id.clone(),
        mission_id: attachment.mission_id,
        work_item_id: Some(attachment.work_item_id),
        link_kind: MissionLinkKind::ProviderTimeline,
        target_ref,
        proof_ref: attachment.proof_ref,
        created_at_ms: attachment.now_ms,
    })?;
    Ok(MissionAttachmentOutcome::Attached {
        link_id,
        work_item_status: next_status,
    })
}

fn validate_preflight_request(request: &MissionPreflightRequest) -> Vec<String> {
    let mut blockers = Vec::new();
    if let Err(err) = request.work_item.judgment_memory.validate() {
        blockers.push(format!("invalid_handoff_judgment:{err}"));
    }
    if request.work_item.proof_requirements.is_empty() {
        blockers.push("proof_requirements_required_before_dispatch".into());
    }
    if !request
        .work_item
        .has_required_ownership_for_workspace_touch()
    {
        blockers.push("ownership_claim_required_before_workspace_touch".into());
    }
    if matches!(
        request.work_item.approval_state,
        ApprovalState::Required | ApprovalState::Rejected
    ) {
        blockers.push(format!(
            "approval_not_ready:{}",
            request.work_item.approval_state.as_str()
        ));
    }
    // NOTE: the Context Passport check is NO LONGER a pure ref-presence test (that was
    // the hollow gate — a non-empty refs list of any string satisfied it). It now LOADS
    // the referenced passport object(s) and requires one that re-clears the transfer
    // gate AND authorizes THIS destination, which needs `db` — so it lives in the
    // db-backed `context_passport_blocker` called from `preflight_and_stage_work_item`,
    // appended to the SAME blockers vec (collect-all-then-block semantics preserved).
    blockers
}

/// The strengthened, destination-binding Context Passport gate (replaces the hollow
/// ref-presence check). When a sensitive external transfer requires a passport, this
/// LOADS the Mission's referenced passport objects and requires one that BOTH (a)
/// rebuilds-and-re-gates via `build_context_passport` on load — a tampered/secret row
/// fails to load, fail-closed — AND (b) `authorizes_transfer(work_item.lane, target)`
/// for THIS destination. Returns the identical blocker string the hollow check used
/// (so existing negative assertions are unchanged) when no authorizing passport is
/// found, else `None`.
fn context_passport_blocker(
    db: &Db,
    request: &MissionPreflightRequest,
) -> Result<Option<String>, StorageError> {
    if !requires_context_passport(request.work_item.lane, request.includes_sensitive_context) {
        return Ok(None);
    }
    let lane = request.work_item.lane;
    let target = request.work_item.target_provider_or_agent.as_deref();
    for passport_id in &request.mission.context_passport_refs {
        // A row that does not rebuild-and-re-gate surfaces a load error; treat ANY
        // non-authorizing / unloadable ref as "not satisfied" and keep scanning. The
        // gate only passes on a passport that loaded cleanly AND authorizes this hop.
        if let Ok(Some(passport)) = db.get_context_passport(passport_id) {
            if passport.authorizes_transfer(lane, target) {
                return Ok(None);
            }
        }
    }
    Ok(Some(
        "context_passport_required_before_sensitive_external_transfer".into(),
    ))
}

fn bind_surface_to_existing_mission(
    db: &Db,
    request: &MissionPreflightRequest,
    mission_id: &str,
) -> Result<(), StorageError> {
    let Some(mut surface) = request.surface_thread.clone() else {
        return Ok(());
    };
    let Some(existing_mission) = db.get_mission(mission_id)? else {
        return Ok(());
    };

    let mut conversation = db
        .get_friday_conversation(&existing_mission.friday_conversation_id)?
        .unwrap_or_else(|| request.conversation.clone());
    push_unique(&mut conversation.active_mission_ids, mission_id.to_string());
    push_unique(
        &mut conversation.surface_thread_ids,
        surface.surface_thread_id.clone(),
    );
    conversation.updated_at_ms = request.conversation.updated_at_ms;

    surface.friday_conversation_id = existing_mission.friday_conversation_id;
    surface.mission_id = Some(mission_id.to_string());
    db.upsert_friday_conversation(&conversation)?;
    db.upsert_surface_thread(&surface)?;
    Ok(())
}

fn work_item_status_for_provider_state(
    state: PendingState,
    proof_ref: Option<&str>,
) -> Option<WorkItemStatus> {
    match state {
        PendingState::SentToHub => Some(WorkItemStatus::Dispatched),
        PendingState::AcceptedByHub => Some(WorkItemStatus::HubAccepted),
        PendingState::RoutedToProvider => Some(WorkItemStatus::ProviderRouted),
        PendingState::WaitingProvider => Some(WorkItemStatus::ProviderWaiting),
        PendingState::ProviderCompleted if proof_ref.is_some() => {
            Some(WorkItemStatus::CompletedWithProof)
        }
        PendingState::FailedRetryable => Some(WorkItemStatus::FailedRetryable),
        PendingState::FailedTerminal | PendingState::Blocked => {
            Some(WorkItemStatus::FailedTerminal)
        }
        PendingState::Cancelled => Some(WorkItemStatus::Cancelled),
        PendingState::Draft | PendingState::PendingLocal | PendingState::ProviderCompleted => None,
    }
}

fn attach_mission_link_ref(
    db: &Db,
    mission_id: &str,
    work_item_id: Option<&str>,
    link_kind: MissionLinkKind,
    target_ref: String,
    proof_ref: Option<String>,
    now_ms: i64,
) -> Result<MissionAttachmentOutcome, StorageError> {
    if target_ref.trim().is_empty() {
        return Ok(MissionAttachmentOutcome::blocked("target_ref_required"));
    }
    if db.get_mission(mission_id)?.is_none() {
        return Ok(MissionAttachmentOutcome::blocked("unknown_mission"));
    }

    let work_item = if let Some(work_item_id) = work_item_id {
        let Some(work_item) = db.get_work_item(work_item_id)? else {
            return Ok(MissionAttachmentOutcome::blocked("unknown_work_item"));
        };
        if work_item.mission_id != mission_id {
            return Ok(MissionAttachmentOutcome::blocked(
                "work_item_mission_mismatch",
            ));
        }
        Some(work_item)
    } else {
        None
    };

    let work_part = work_item_id.unwrap_or("mission");
    let link_id = stable_link_id(
        "mlink_ref",
        mission_id,
        work_part,
        &format!("{}_{}", link_kind.as_str(), target_ref),
    );
    db.upsert_mission_link(&MissionLink {
        link_id: link_id.clone(),
        mission_id: mission_id.to_string(),
        work_item_id: work_item_id.map(str::to_string),
        link_kind,
        target_ref,
        proof_ref,
        created_at_ms: now_ms,
    })?;

    if let Some(work_item) = work_item {
        Ok(MissionAttachmentOutcome::Attached {
            link_id,
            work_item_status: work_item.status,
        })
    } else {
        Ok(MissionAttachmentOutcome::MissionLinked { link_id })
    }
}

fn provider_state_blocker(state: PendingState, proof_ref: Option<&str>) -> &'static str {
    match state {
        PendingState::ProviderCompleted if proof_ref.is_none() => {
            "provider_completion_requires_proof_ref"
        }
        PendingState::Draft | PendingState::PendingLocal => {
            "provider_state_not_attachable_before_hub_send"
        }
        _ => "provider_state_not_attachable",
    }
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn stable_link_id(prefix: &str, mission_id: &str, work_item_id: &str, tail: &str) -> String {
    format!(
        "{}_{}_{}_{}",
        prefix,
        safe_id_part(mission_id),
        safe_id_part(work_item_id),
        safe_id_part(tail)
    )
}

fn safe_id_part(value: &str) -> String {
    value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel_event::ingest_channel_inbound;
    use crate::channels::{redact_inbound, VerifiedInbound};
    use friday_core::{
        ApprovalState, ClaimState, HandoffJudgmentMemory, MemoryScope, MissionStatus, SurfaceKind,
        TruthStatus, VisibilityPolicy, WorkLane, WorkspaceClaim, WorkspaceClaimKind,
    };
    use friday_storage::{memory, workflow, Db};
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);

    fn tmp() -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-mission-preflight-{}-{}.sqlite",
                std::process::id(),
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn conversation(now: i64) -> FridayConversation {
        FridayConversation {
            friday_conversation_id: "fconv_slice3".into(),
            owner_principal: "owner-1".into(),
            title: "Friday global secretary".into(),
            current_focus_summary: "Mission Spine Hub preflight".into(),
            active_mission_ids: Vec::new(),
            surface_thread_ids: Vec::new(),
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: vec!["proof://slice3-test".into()],
            created_at_ms: now,
            updated_at_ms: now,
        }
    }

    fn mission(
        mission_id: &str,
        intent: &str,
        context_passport_refs: Vec<String>,
        now: i64,
    ) -> Mission {
        Mission {
            mission_id: mission_id.into(),
            friday_conversation_id: "fconv_slice3".into(),
            title: "Coordinate Friday work".into(),
            intent: intent.into(),
            status: MissionStatus::Active,
            why_now: "The user needs one Friday brain across surfaces.".into(),
            decision_path_summary: "Use Mission as product center, not provider chat.".into(),
            considered_options: vec!["provider-thread-first".into(), "mission-spine".into()],
            deferred_options: vec!["final UI wiring".into()],
            known_pitfalls: vec!["ack is not completion".into()],
            handoff_inheritance: vec!["carry judgment path".into()],
            work_item_ids: Vec::new(),
            memory_candidate_refs: Vec::new(),
            context_passport_refs,
            proof_refs: vec!["proof://slice3-test".into()],
            created_at_ms: now,
            updated_at_ms: now,
        }
    }

    fn judgment() -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "Wire Mission preflight".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: "codex/backend".into(),
            read_first_files: vec!["rust-core/crates/friday-hub/src/lib.rs".into()],
            required_output: "Hub preflight and attachment tests".into(),
            done_criteria: vec!["tests pass".into()],
            red_lines: vec!["do not claim UI ready".into()],
            why_this_route: "Hub owns dispatch decisions.".into(),
            considered_options: vec!["storage-only".into(), "hub-preflight".into()],
            deferred_options: vec!["native UI".into()],
            previous_pitfalls: vec!["provider ack looked like done".into()],
            inheritable_context: vec!["Mission is canonical product state".into()],
            proof_requirements: vec!["cargo test -p friday-hub mission_preflight".into()],
            ownership_claim_ids: vec!["own-test".into()],
        }
    }

    fn work_item(
        work_item_id: &str,
        mission_id: &str,
        lane: WorkLane,
        owner_claim_ids: Vec<String>,
        now: i64,
    ) -> WorkItem {
        WorkItem {
            work_item_id: work_item_id.into(),
            mission_id: mission_id.into(),
            lane,
            target_provider_or_agent: Some("codex".into()),
            status: WorkItemStatus::Draft,
            owner_claim_ids,
            workspace_refs: Vec::new(),
            capability_id: Some("mission.preflight".into()),
            risk_level: friday_core::Risk::Medium,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["input://handoff".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["focused rust test".into()],
            proof_receipts: Vec::new(),
            judgment_memory: judgment(),
            created_at_ms: now,
            updated_at_ms: now,
        }
    }

    fn surface(mission_id: &str, now: i64) -> SurfaceThread {
        SurfaceThread {
            surface_thread_id: "surface-mobile-1".into(),
            friday_conversation_id: "fconv_slice3".into(),
            mission_id: Some(mission_id.into()),
            surface_kind: SurfaceKind::Mobile,
            channel_binding_id: None,
            delivery_route: "local-mobile".into(),
            visibility_policy: VisibilityPolicy::Compact,
            allowed_actions: vec!["open".into()],
            last_seen_at_ms: Some(now),
            last_delivered_event_seq: None,
            created_at_ms: now,
            updated_at_ms: now,
        }
    }

    fn workspace_claim(claim_id: &str, mission_id: &str, work_item_id: &str) -> WorkspaceClaim {
        WorkspaceClaim {
            claim_id: claim_id.into(),
            mission_id: mission_id.into(),
            work_item_id: Some(work_item_id.into()),
            owner_principal: "owner-1".into(),
            owner_agent: "codex".into(),
            workspace_ref: "/tmp/friday-mission-preflight".into(),
            claim_kind: WorkspaceClaimKind::Workspace,
            state: ClaimState::Active,
            reason: "attach workspace ownership to mission work".into(),
            safe_release_policy: "release only with proof".into(),
            proof_requirements: vec!["release proof".into()],
            proof_refs: Vec::new(),
            created_at_ms: 1,
            updated_at_ms: 1,
            released_at_ms: None,
        }
    }

    fn request(
        mission_id: &str,
        work_item_id: &str,
        intent: &str,
        lane: WorkLane,
        context_passport_refs: Vec<String>,
        sensitive: bool,
        now: i64,
    ) -> MissionPreflightRequest {
        MissionPreflightRequest {
            conversation: conversation(now),
            mission: mission(mission_id, intent, context_passport_refs, now),
            surface_thread: Some(surface(mission_id, now)),
            work_item: work_item(work_item_id, mission_id, lane, Vec::new(), now),
            includes_sensitive_context: sensitive,
        }
    }

    #[test]
    fn duplicate_mission_is_blocked_before_second_work_item_is_written() {
        let db = Db::open_hub(&tmp()).unwrap();
        assert!(preflight_and_stage_work_item(
            &db,
            request(
                "mission-1",
                "work-1",
                "ship global secretary",
                WorkLane::FridayHub,
                Vec::new(),
                false,
                1,
            ),
        )
        .unwrap()
        .is_ready());

        let outcome = preflight_and_stage_work_item(
            &db,
            request(
                "mission-2",
                "work-2",
                "ship global secretary",
                WorkLane::FridayHub,
                Vec::new(),
                false,
                2,
            ),
        )
        .unwrap();
        assert_eq!(
            outcome,
            MissionPreflightOutcome::Blocked {
                blockers: vec!["duplicate_active_mission_before_dispatch".into()],
                duplicate_mission_id: Some("mission-1".into()),
                duplicate_work_item_id: None
            }
        );
        assert_eq!(db.count("mission").unwrap(), 1);
        assert_eq!(db.count("work_item").unwrap(), 1);
    }

    #[test]
    fn multi_surface_duplicate_input_blocks_before_second_work_item_is_written() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mut mobile = request(
            "mission-mobile",
            "work-mobile",
            "finish the same Mission-bound provider proof",
            WorkLane::DeepSeek,
            Vec::new(),
            false,
            1,
        );
        mobile.surface_thread.as_mut().unwrap().surface_thread_id = "surface-mobile".into();
        mobile.surface_thread.as_mut().unwrap().surface_kind = SurfaceKind::Mobile;
        assert!(preflight_and_stage_work_item(&db, mobile)
            .unwrap()
            .is_ready());

        let mut desktop = request(
            "mission-desktop",
            "work-desktop",
            "finish the same Mission-bound provider proof",
            WorkLane::DeepSeek,
            Vec::new(),
            false,
            2,
        );
        desktop.surface_thread.as_mut().unwrap().surface_thread_id = "surface-desktop".into();
        desktop.surface_thread.as_mut().unwrap().surface_kind = SurfaceKind::Desktop;
        desktop.surface_thread.as_mut().unwrap().visibility_policy = VisibilityPolicy::RichProof;
        let duplicate_from_desktop = preflight_and_stage_work_item(&db, desktop).unwrap();
        assert_eq!(
            duplicate_from_desktop,
            MissionPreflightOutcome::Blocked {
                blockers: vec!["duplicate_active_mission_before_dispatch".into()],
                duplicate_mission_id: Some("mission-mobile".into()),
                duplicate_work_item_id: None
            }
        );

        let mut channel = request(
            "mission-channel",
            "work-channel",
            "finish the same Mission-bound provider proof",
            WorkLane::DeepSeek,
            Vec::new(),
            false,
            3,
        );
        channel.surface_thread.as_mut().unwrap().surface_thread_id = "surface-channel".into();
        channel.surface_thread.as_mut().unwrap().surface_kind = SurfaceKind::Telegram;
        channel.surface_thread.as_mut().unwrap().visibility_policy = VisibilityPolicy::StatusOnly;
        let duplicate_from_channel = preflight_and_stage_work_item(&db, channel).unwrap();
        assert_eq!(
            duplicate_from_channel,
            MissionPreflightOutcome::Blocked {
                blockers: vec!["duplicate_active_mission_before_dispatch".into()],
                duplicate_mission_id: Some("mission-mobile".into()),
                duplicate_work_item_id: None
            }
        );

        assert_eq!(db.count("mission").unwrap(), 1);
        assert_eq!(db.count("work_item").unwrap(), 1);
        assert_eq!(
            db.count("surface_thread").unwrap(),
            3,
            "duplicate surfaces should bind to the existing Mission without creating task debt"
        );
        for surface_thread_id in ["surface-mobile", "surface-desktop", "surface-channel"] {
            assert_eq!(
                db.get_surface_thread(surface_thread_id)
                    .unwrap()
                    .unwrap()
                    .mission_id
                    .as_deref(),
                Some("mission-mobile")
            );
        }
        let projection = db.list_mission_surface_projections("fconv_slice3").unwrap();
        assert_eq!(projection.len(), 3);
        let surfaces: std::collections::BTreeSet<_> = projection
            .iter()
            .map(|surface| surface.surface_kind.as_str())
            .collect();
        assert_eq!(
            surfaces,
            std::collections::BTreeSet::from(["desktop", "mobile", "telegram"])
        );
        assert!(projection
            .iter()
            .all(|surface| surface.mission_id == "mission-mobile"));
    }

    #[test]
    fn duplicate_work_item_blocks_but_binds_new_surface_to_existing_mission() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mut mobile = request(
            "mission-shared",
            "work-mobile",
            "resolve one Mission then ask DeepSeek",
            WorkLane::DeepSeek,
            Vec::new(),
            false,
            1,
        );
        mobile.surface_thread.as_mut().unwrap().surface_thread_id = "surface-mobile".into();
        mobile.surface_thread.as_mut().unwrap().surface_kind = SurfaceKind::Mobile;
        assert!(preflight_and_stage_work_item(&db, mobile)
            .unwrap()
            .is_ready());

        let mut desktop = request(
            "mission-shared",
            "work-desktop",
            "resolve one Mission then ask DeepSeek",
            WorkLane::DeepSeek,
            Vec::new(),
            false,
            2,
        );
        desktop.surface_thread.as_mut().unwrap().surface_thread_id = "surface-desktop".into();
        desktop.surface_thread.as_mut().unwrap().surface_kind = SurfaceKind::Desktop;
        desktop.surface_thread.as_mut().unwrap().visibility_policy = VisibilityPolicy::RichProof;
        let outcome = preflight_and_stage_work_item(&db, desktop).unwrap();
        assert_eq!(
            outcome,
            MissionPreflightOutcome::Blocked {
                blockers: vec!["duplicate_active_work_item_before_dispatch".into()],
                duplicate_mission_id: None,
                duplicate_work_item_id: Some("work-mobile".into())
            }
        );

        assert_eq!(db.count("mission").unwrap(), 1);
        assert_eq!(db.count("work_item").unwrap(), 1);
        assert_eq!(db.count("surface_thread").unwrap(), 2);
        let projection = db.list_mission_surface_projections("fconv_slice3").unwrap();
        assert_eq!(projection.len(), 2);
        assert!(projection
            .iter()
            .any(|surface| surface.surface_kind == SurfaceKind::Mobile
                && surface.mission_id == "mission-shared"));
        assert!(projection
            .iter()
            .any(|surface| surface.surface_kind == SurfaceKind::Desktop
                && surface.mission_id == "mission-shared"));
    }

    #[test]
    fn sensitive_external_transfer_requires_context_passport_before_ready() {
        let db = Db::open_hub(&tmp()).unwrap();
        let blocked = preflight_and_stage_work_item(
            &db,
            request(
                "mission-ctx",
                "work-ctx",
                "handoff sensitive context",
                WorkLane::Codex,
                Vec::new(),
                true,
                1,
            ),
        )
        .unwrap();
        assert!(matches!(
            blocked,
            MissionPreflightOutcome::Blocked { blockers, .. }
                if blockers.contains(&"context_passport_required_before_sensitive_external_transfer".to_string())
        ));
        assert_eq!(db.count("work_item").unwrap(), 0);

        // A BOGUS ref (a string the gate cannot resolve to a real authorizing passport)
        // must NOT satisfy the strengthened gate — this is the hollow bug being closed.
        let still_blocked = preflight_and_stage_work_item(
            &db,
            request(
                "mission-ctx",
                "work-ctx",
                "handoff sensitive context",
                WorkLane::Codex,
                vec!["ctxp://not-a-real-passport".into()],
                true,
                2,
            ),
        )
        .unwrap();
        assert!(matches!(
            still_blocked,
            MissionPreflightOutcome::Blocked { blockers, .. }
                if blockers.contains(&"context_passport_required_before_sensitive_external_transfer".to_string())
        ));
        assert_eq!(db.count("work_item").unwrap(), 0);

        // Mint a REAL passport bound to the destination (Codex/codex), then stage: the
        // gate loads + re-gates + destination-checks the object and passes.
        let passport = friday_core::build_context_passport(
            "passport-ctx",
            "mission-ctx",
            Some("work-ctx".to_string()),
            WorkLane::Codex,
            Some("codex".to_string()),
            vec![friday_core::PassportItem {
                kind: friday_core::PassportItemKind::Summary,
                label: "handoff summary".into(),
                included: true,
                sensitive: true,
            }],
            true, // sensitive item explicitly approved
            2,
        )
        .unwrap();
        db.upsert_context_passport(&passport).unwrap();

        let ready = preflight_and_stage_work_item(
            &db,
            request(
                "mission-ctx",
                "work-ctx",
                "handoff sensitive context",
                WorkLane::Codex,
                vec!["passport-ctx".into()],
                true,
                3,
            ),
        )
        .unwrap();
        assert!(ready.is_ready());
        assert_eq!(
            db.get_work_item("work-ctx").unwrap().unwrap().status,
            WorkItemStatus::ReadyToDispatch
        );
    }

    #[test]
    fn passport_for_the_wrong_destination_fails_closed() {
        let db = Db::open_hub(&tmp()).unwrap();
        // Mint a passport bound to Claude, but request a transfer to Codex.
        let passport = friday_core::build_context_passport(
            "passport-claude",
            "mission-dest",
            None,
            WorkLane::Claude,
            None,
            vec![friday_core::PassportItem {
                kind: friday_core::PassportItemKind::Summary,
                label: "claude-bound summary".into(),
                included: true,
                sensitive: false,
            }],
            false,
            1,
        )
        .unwrap();
        db.upsert_context_passport(&passport).unwrap();

        // The Codex transfer cites the Claude passport — destination mismatch must block.
        let blocked = preflight_and_stage_work_item(
            &db,
            request(
                "mission-dest",
                "work-dest",
                "destination-mismatch transfer",
                WorkLane::Codex,
                vec!["passport-claude".into()],
                true,
                2,
            ),
        )
        .unwrap();
        assert!(matches!(
            blocked,
            MissionPreflightOutcome::Blocked { blockers, .. }
                if blockers.contains(&"context_passport_required_before_sensitive_external_transfer".to_string())
        ));
        assert_eq!(db.count("work_item").unwrap(), 0);
    }

    #[test]
    fn provider_ack_attaches_without_completion_and_completion_requires_proof() {
        let db = Db::open_hub(&tmp()).unwrap();
        assert!(preflight_and_stage_work_item(
            &db,
            request(
                "mission-provider",
                "work-provider",
                "provider routed task",
                WorkLane::Codex,
                Vec::new(),
                false,
                1,
            ),
        )
        .unwrap()
        .is_ready());

        for (state, expected) in [
            (PendingState::SentToHub, WorkItemStatus::Dispatched),
            (PendingState::AcceptedByHub, WorkItemStatus::HubAccepted),
            (
                PendingState::RoutedToProvider,
                WorkItemStatus::ProviderRouted,
            ),
            (
                PendingState::WaitingProvider,
                WorkItemStatus::ProviderWaiting,
            ),
        ] {
            let attached = attach_provider_timeline_state(
                &db,
                ProviderTimelineAttachment {
                    mission_id: "mission-provider".into(),
                    work_item_id: "work-provider".into(),
                    friday_session_id: "friday-session-codex".into(),
                    request_id: "req-1".into(),
                    state,
                    proof_ref: None,
                    now_ms: 10,
                },
            )
            .unwrap();
            assert!(matches!(
                attached,
                MissionAttachmentOutcome::Attached {
                    work_item_status,
                    ..
                } if work_item_status == expected
            ));
        }
        let item = db.get_work_item("work-provider").unwrap().unwrap();
        assert_eq!(item.status, WorkItemStatus::ProviderWaiting);
        assert!(item.proof_receipts.is_empty());

        let no_proof = attach_provider_timeline_state(
            &db,
            ProviderTimelineAttachment {
                mission_id: "mission-provider".into(),
                work_item_id: "work-provider".into(),
                friday_session_id: "friday-session-codex".into(),
                request_id: "req-1".into(),
                state: PendingState::ProviderCompleted,
                proof_ref: None,
                now_ms: 11,
            },
        )
        .unwrap();
        assert!(matches!(
            no_proof,
            MissionAttachmentOutcome::Blocked { blockers }
                if blockers.contains(&"provider_completion_requires_proof_ref".to_string())
        ));
        assert_eq!(
            db.get_work_item("work-provider").unwrap().unwrap().status,
            WorkItemStatus::ProviderWaiting
        );

        let completed = attach_provider_timeline_state(
            &db,
            ProviderTimelineAttachment {
                mission_id: "mission-provider".into(),
                work_item_id: "work-provider".into(),
                friday_session_id: "friday-session-codex".into(),
                request_id: "req-1".into(),
                state: PendingState::ProviderCompleted,
                proof_ref: Some("proof://provider-completed".into()),
                now_ms: 12,
            },
        )
        .unwrap();
        assert!(matches!(
            completed,
            MissionAttachmentOutcome::Attached {
                work_item_status: WorkItemStatus::CompletedWithProof,
                ..
            }
        ));
        let item = db.get_work_item("work-provider").unwrap().unwrap();
        assert_eq!(item.status, WorkItemStatus::CompletedWithProof);
        assert_eq!(item.proof_receipts, vec!["proof://provider-completed"]);
        assert!(db
            .get_mission("mission-provider")
            .unwrap()
            .unwrap()
            .proof_refs
            .contains(&"proof://provider-completed".to_string()));
        let links = db.list_mission_links("mission-provider").unwrap();
        assert!(links
            .iter()
            .any(|link| link.link_kind == MissionLinkKind::ProviderTimeline));
    }

    #[test]
    fn attachments_refuse_work_item_from_another_mission() {
        let db = Db::open_hub(&tmp()).unwrap();
        assert!(preflight_and_stage_work_item(
            &db,
            request(
                "mission-a",
                "work-a",
                "mission A",
                WorkLane::Codex,
                Vec::new(),
                false,
                1,
            ),
        )
        .unwrap()
        .is_ready());
        assert!(preflight_and_stage_work_item(
            &db,
            request(
                "mission-b",
                "work-b",
                "mission B",
                WorkLane::Codex,
                Vec::new(),
                false,
                2,
            ),
        )
        .unwrap()
        .is_ready());

        let provider_mismatch = attach_provider_timeline_state(
            &db,
            ProviderTimelineAttachment {
                mission_id: "mission-a".into(),
                work_item_id: "work-b".into(),
                friday_session_id: "friday-session-codex".into(),
                request_id: "req-mismatch".into(),
                state: PendingState::SentToHub,
                proof_ref: None,
                now_ms: 3,
            },
        )
        .unwrap();
        assert!(matches!(
            provider_mismatch,
            MissionAttachmentOutcome::Blocked { blockers }
                if blockers.contains(&"work_item_mission_mismatch".to_string())
        ));

        let receipt = ChannelInboundReceipt {
            channel_id: "tg:room-1".into(),
            sender_id: "u-1".into(),
            activity_id: "chan:tg:room-1:mismatch".into(),
            disposition: "recorded".into(),
            pii_kinds_redacted: Vec::new(),
            blocker: None,
            replayed: false,
        };
        let channel_mismatch =
            attach_channel_inbound_receipt(&db, "mission-a", "work-b", &receipt, 4).unwrap();
        assert!(matches!(
            channel_mismatch,
            MissionAttachmentOutcome::Blocked { blockers }
                if blockers.contains(&"work_item_mission_mismatch".to_string())
        ));
        assert!(db.list_mission_links("mission-a").unwrap().is_empty());
    }

    #[test]
    fn channel_inbound_receipt_attaches_as_trace_not_execution() {
        let mut db = Db::open_hub(&tmp()).unwrap();
        assert!(preflight_and_stage_work_item(
            &db,
            request(
                "mission-channel",
                "work-channel",
                "channel message joins mission",
                WorkLane::Channel,
                Vec::new(),
                false,
                1,
            ),
        )
        .unwrap()
        .is_ready());

        let verified = VerifiedInbound {
            channel_id: "tg:room-1".into(),
            sender_id: "u-1".into(),
            bound_principal_id: "owner-1".into(),
        };
        let redacted = redact_inbound(verified, "hello Friday".into());
        let receipt = ingest_channel_inbound(
            &mut db,
            &redacted,
            "m-1",
            "message",
            false,
            friday_core::Risk::Low,
            &[],
            2,
        )
        .unwrap();
        assert_eq!(receipt.disposition, "recorded");
        assert_eq!(db.count("token_ledger").unwrap(), 0);

        let attached =
            attach_channel_inbound_receipt(&db, "mission-channel", "work-channel", &receipt, 3)
                .unwrap();
        assert!(matches!(
            attached,
            MissionAttachmentOutcome::Attached { .. }
        ));
        let links = db.list_mission_links("mission-channel").unwrap();
        let link = links
            .iter()
            .find(|link| link.link_kind == MissionLinkKind::ChannelInbound)
            .expect("channel inbound link");
        assert_eq!(link.target_ref, "friday://activity/chan:tg:room-1:m-1");
        assert_eq!(
            db.get_work_item("work-channel").unwrap().unwrap().status,
            WorkItemStatus::ReadyToDispatch
        );
    }

    #[test]
    fn workflow_run_ref_requires_existing_run_and_does_not_complete_work_item() {
        let db = Db::open_hub(&tmp()).unwrap();
        assert!(preflight_and_stage_work_item(
            &db,
            request(
                "mission-workflow",
                "work-workflow",
                "workflow run joins mission",
                WorkLane::Workflow,
                Vec::new(),
                false,
                1,
            ),
        )
        .unwrap()
        .is_ready());

        let unknown = attach_workflow_run_ref(
            &db,
            "mission-workflow",
            "work-workflow",
            "wf-missing",
            None,
            2,
        )
        .unwrap();
        assert!(matches!(
            unknown,
            MissionAttachmentOutcome::Blocked { blockers }
                if blockers.contains(&"unknown_workflow_run".to_string())
        ));

        workflow::create_run(db.conn(), "wf-run-1", "mission workflow", 3).unwrap();
        let attached = attach_workflow_run_ref(
            &db,
            "mission-workflow",
            "work-workflow",
            "wf-run-1",
            Some("proof://workflow-scheduled".into()),
            4,
        )
        .unwrap();
        assert!(matches!(
            attached,
            MissionAttachmentOutcome::Attached {
                work_item_status: WorkItemStatus::ReadyToDispatch,
                ..
            }
        ));

        let links = db.list_mission_links("mission-workflow").unwrap();
        let link = links
            .iter()
            .find(|link| link.link_kind == MissionLinkKind::WorkflowRun)
            .expect("workflow run link");
        assert_eq!(link.target_ref, "friday://workflow-run/wf-run-1");
        assert_eq!(
            link.proof_ref.as_deref(),
            Some("proof://workflow-scheduled")
        );
        assert_eq!(
            db.get_work_item("work-workflow").unwrap().unwrap().status,
            WorkItemStatus::ReadyToDispatch
        );
    }

    #[test]
    fn workspace_claim_ref_attaches_ownership_without_claiming_completion() {
        let db = Db::open_hub(&tmp()).unwrap();
        assert!(preflight_and_stage_work_item(
            &db,
            request(
                "mission-claim",
                "work-claim",
                "workspace claim joins mission",
                WorkLane::Codex,
                Vec::new(),
                false,
                1,
            ),
        )
        .unwrap()
        .is_ready());

        db.upsert_workspace_claim(&workspace_claim(
            "claim-workspace-1",
            "mission-claim",
            "work-claim",
        ))
        .unwrap();
        let attached =
            attach_workspace_claim_ref(&db, "mission-claim", "work-claim", "claim-workspace-1", 2)
                .unwrap();
        assert!(matches!(
            attached,
            MissionAttachmentOutcome::Attached {
                work_item_status: WorkItemStatus::ReadyToDispatch,
                ..
            }
        ));
        let attached_work_item = db.get_work_item("work-claim").unwrap().unwrap();
        assert_eq!(attached_work_item.status, WorkItemStatus::ReadyToDispatch);
        assert!(attached_work_item
            .owner_claim_ids
            .contains(&"claim-workspace-1".to_string()));
        assert!(attached_work_item
            .judgment_memory
            .ownership_claim_ids
            .contains(&"claim-workspace-1".to_string()));
        let link = db
            .list_mission_links("mission-claim")
            .unwrap()
            .into_iter()
            .find(|link| link.link_kind == MissionLinkKind::WorkspaceClaim)
            .expect("workspace claim link");
        assert_eq!(
            link.target_ref,
            "friday://workspace-claim/claim-workspace-1"
        );

        db.upsert_work_item(&work_item(
            "work-other",
            "mission-claim",
            WorkLane::Codex,
            Vec::new(),
            3,
        ))
        .unwrap();
        db.upsert_workspace_claim(&workspace_claim(
            "claim-wrong-work",
            "mission-claim",
            "work-other",
        ))
        .unwrap();
        let mismatch =
            attach_workspace_claim_ref(&db, "mission-claim", "work-claim", "claim-wrong-work", 4)
                .unwrap();
        assert!(matches!(
            mismatch,
            MissionAttachmentOutcome::Blocked { blockers }
                if blockers.contains(&"workspace_claim_work_item_mismatch".to_string())
        ));
    }

    #[test]
    fn memory_links_keep_candidates_non_authoritative_until_explicit_decision() {
        let db = Db::open_hub(&tmp()).unwrap();
        assert!(preflight_and_stage_work_item(
            &db,
            request(
                "mission-memory",
                "work-memory",
                "memory trace joins mission",
                WorkLane::FridayHub,
                Vec::new(),
                false,
                1,
            ),
        )
        .unwrap()
        .is_ready());

        memory::record_candidate(
            db.conn(),
            &memory::NewMemoryCandidate {
                memory_id: "mem-candidate",
                scope: MemoryScope::Global,
                content_ref: Some("blob://mem-candidate"),
                content: Some("User prefers concise Friday status updates."),
                principal_id: Some("owner-1"),
                sensitive: false,
                created_at: 2,
            },
        )
        .unwrap();
        let no_decision_yet =
            attach_memory_decision_ref(&db, "mission-memory", "mem-candidate", 3).unwrap();
        assert!(matches!(
            no_decision_yet,
            MissionAttachmentOutcome::Blocked { blockers }
                if blockers.contains(&"memory_decision_requires_terminal_state".to_string())
        ));

        let candidate =
            attach_memory_candidate_ref(&db, "mission-memory", "mem-candidate", 4).unwrap();
        assert!(matches!(
            candidate,
            MissionAttachmentOutcome::MissionLinked { .. }
        ));
        let mission = db.get_mission("mission-memory").unwrap().unwrap();
        assert_eq!(
            mission.memory_candidate_refs,
            vec!["friday://memory/mem-candidate"]
        );
        let candidate_link = db
            .list_mission_links("mission-memory")
            .unwrap()
            .into_iter()
            .find(|link| link.link_kind == MissionLinkKind::MemoryCandidate)
            .expect("memory candidate link");
        assert!(!candidate_link.link_kind.grants_memory_authority());

        memory::confirm(db.conn(), "mem-candidate", 5).unwrap();
        let confirmed =
            attach_memory_decision_ref(&db, "mission-memory", "mem-candidate", 6).unwrap();
        assert!(matches!(
            confirmed,
            MissionAttachmentOutcome::MissionLinked { .. }
        ));
        let confirmed_link = db
            .list_mission_links("mission-memory")
            .unwrap()
            .into_iter()
            .find(|link| link.link_kind == MissionLinkKind::ConfirmedMemory)
            .expect("confirmed memory link");
        assert!(confirmed_link.link_kind.grants_memory_authority());

        memory::record_candidate(
            db.conn(),
            &memory::NewMemoryCandidate {
                memory_id: "mem-rejected",
                scope: MemoryScope::Global,
                content_ref: None,
                content: Some("Rejected fact"),
                principal_id: Some("owner-1"),
                sensitive: false,
                created_at: 7,
            },
        )
        .unwrap();
        memory::reject(db.conn(), "mem-rejected", 8).unwrap();
        attach_memory_decision_ref(&db, "mission-memory", "mem-rejected", 9).unwrap();
        let rejected_link = db
            .list_mission_links("mission-memory")
            .unwrap()
            .into_iter()
            .find(|link| {
                link.link_kind == MissionLinkKind::MemoryDecision
                    && link.target_ref == "friday://memory/mem-rejected#rejected"
            })
            .expect("rejected memory decision link");
        assert!(!rejected_link.link_kind.grants_memory_authority());
    }

    #[test]
    fn context_passport_and_proof_receipt_update_refs_without_claiming_completion() {
        let db = Db::open_hub(&tmp()).unwrap();
        assert!(preflight_and_stage_work_item(
            &db,
            request(
                "mission-proof",
                "work-proof",
                "proof receipt joins mission",
                WorkLane::FridayHub,
                Vec::new(),
                false,
                1,
            ),
        )
        .unwrap()
        .is_ready());

        let passport = attach_context_passport_ref(
            &db,
            "mission-proof",
            "passport-share",
            None,
            WorkLane::FridayHub,
            None,
            vec![friday_core::PassportItem {
                kind: friday_core::PassportItemKind::Summary,
                label: "approved share".into(),
                included: true,
                sensitive: false,
            }],
            false,
            2,
        )
        .unwrap();
        assert!(matches!(
            passport,
            MissionAttachmentOutcome::MissionLinked { .. }
        ));
        // The ref pushed is now the passport_id (resolving to the persisted object),
        // and the object itself is retrievable + re-gates on load.
        let mission = db.get_mission("mission-proof").unwrap().unwrap();
        assert_eq!(mission.context_passport_refs, vec!["passport-share"]);
        assert!(db.get_context_passport("passport-share").unwrap().is_some());

        let proof = attach_proof_receipt_ref(
            &db,
            "mission-proof",
            "work-proof",
            "proof://human-visible-receipt",
            3,
        )
        .unwrap();
        assert!(matches!(
            proof,
            MissionAttachmentOutcome::Attached {
                work_item_status: WorkItemStatus::ReadyToDispatch,
                ..
            }
        ));
        let mission = db.get_mission("mission-proof").unwrap().unwrap();
        assert!(mission
            .proof_refs
            .contains(&"proof://human-visible-receipt".to_string()));
        let work_item = db.get_work_item("work-proof").unwrap().unwrap();
        assert_eq!(work_item.status, WorkItemStatus::ReadyToDispatch);
        assert_eq!(
            work_item.proof_receipts,
            vec!["proof://human-visible-receipt"]
        );
        let proof_link = db
            .list_mission_links("mission-proof")
            .unwrap()
            .into_iter()
            .find(|link| link.link_kind == MissionLinkKind::ProofReceipt)
            .expect("proof receipt link");
        assert_eq!(
            proof_link.proof_ref.as_deref(),
            Some("proof://human-visible-receipt")
        );
    }
}
