//! Mission-bound runtime producer wrappers.
//!
//! `mission_context` resolves refs into the canonical Mission graph; this module is
//! the next Hub boundary: channel/workflow producers must acquire a validated
//! `MissionRuntimeEnvelope` before recording or executing live work. The low-level
//! channel/workflow functions remain useful substrates, but product entrypoints
//! should call these wrappers so detached channel events or workflow runs cannot
//! masquerade as Friday work.

use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
use friday_core::{MissionLinkKind, ProofRequirementKind, Risk, RouteDecisionCard, WorkLane};
use friday_crypto::{OperatorVerifyingKey, SecureStore};
use friday_deepseek::{DeepSeekClient, Transport};
use friday_storage::channel::get_channel;
use friday_storage::{get_run_result_ref, persist_run_result, Db, RunResult, StorageError};

use crate::agent_run_control::{resume_hooked as agent_run_control_resume_hooked, ControlOutcome};
use crate::channel_event::{channel_event_id, ingest_channel_inbound, ChannelInboundReceipt};
use crate::channels::{redact_inbound, resolve_and_verify, InboundRejection, RedactedInbound};
use crate::mission_context::{
    resolve_mission_context, route_decision_card_for_context, MissionContextLookup,
    MissionContextResolution, ResolvedMissionContext,
};
use crate::mission_preflight::{
    attach_channel_inbound_receipt, attach_provider_timeline_state_guarded_with_completion_receipt,
    attach_provider_timeline_state_off_path_in, attach_workflow_run_ref, MissionAttachmentOutcome,
    ProviderTimelineAttachment,
};
use crate::planner::WorkflowDefinition;
use crate::provider_timeline::PendingState;
use crate::workflow_exec::{resume_workflow, run_workflow, WorkflowOutcome};
use crate::{record_friday_ask, RecordAskError, ToolExecutor};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissionRuntimeRequest {
    pub lookup: MissionContextLookup,
    pub expected_lane: WorkLane,
    /// Optional exact target check. Provider dispatch checks provider/session; channel
    /// producers use this for the channel id; workflow producers may leave it open.
    pub expected_target: Option<String>,
    pub decision_id: String,
    pub trace_refs: Vec<String>,
    pub now_ms: i64,
    pub expires_at_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissionRuntimeEnvelope {
    pub context: ResolvedMissionContext,
    pub route_decision: RouteDecisionCard,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MissionRuntimeOutcome {
    Ready(Box<MissionRuntimeEnvelope>),
    Blocked { blockers: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MissionBoundChannelOutcome {
    Blocked {
        blockers: Vec<String>,
    },
    Recorded {
        envelope: Box<MissionRuntimeEnvelope>,
        receipt: ChannelInboundReceipt,
        attachment: MissionAttachmentOutcome,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MissionBoundChannelIngressOutcome {
    AuthRejected {
        reason: String,
    },
    Blocked {
        blockers: Vec<String>,
    },
    Recorded {
        envelope: Box<MissionRuntimeEnvelope>,
        receipt: ChannelInboundReceipt,
        attachment: MissionAttachmentOutcome,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MissionBoundWorkflowOutcome {
    Blocked {
        blockers: Vec<String>,
    },
    Ran {
        envelope: Box<MissionRuntimeEnvelope>,
        workflow: WorkflowOutcome,
        attachment: MissionAttachmentOutcome,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MissionBoundAskOutcome {
    Blocked {
        blockers: Vec<String>,
    },
    Answered {
        envelope: Box<MissionRuntimeEnvelope>,
        ledger_id: String,
        result_link: String,
        attachment: MissionAttachmentOutcome,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgentLoopProviderRestState {
    Routed,
    Completed,
    FailedTerminal,
}

pub fn resolve_mission_runtime_envelope(
    db: &Db,
    request: MissionRuntimeRequest,
) -> Result<MissionRuntimeOutcome, StorageError> {
    let context = match resolve_mission_context(db, request.lookup)? {
        MissionContextResolution::Resolved(context) => context,
        MissionContextResolution::Blocked { blockers } => {
            return Ok(MissionRuntimeOutcome::Blocked { blockers });
        }
    };

    let Some(work_item) = db.get_work_item(&context.work_item_id)? else {
        return Ok(MissionRuntimeOutcome::Blocked {
            blockers: vec!["mission_runtime_unknown_work_item".into()],
        });
    };
    let mut blockers = Vec::new();
    if !work_item.is_active_like() {
        blockers.push("mission_runtime_work_item_terminal".into());
    }
    if work_item.lane != request.expected_lane {
        blockers.push("mission_runtime_lane_mismatch".into());
    }
    if let Some(expected_target) = request.expected_target.as_deref() {
        match work_item.target_provider_or_agent.as_deref() {
            Some(actual) if actual == expected_target => {}
            Some(_) => blockers.push("mission_runtime_target_mismatch".into()),
            None => blockers.push("mission_runtime_target_required".into()),
        }
    }
    if !blockers.is_empty() {
        return Ok(MissionRuntimeOutcome::Blocked { blockers });
    }

    let route_decision = route_decision_card_for_context(
        db,
        &context,
        request.decision_id,
        request.trace_refs,
        request.now_ms,
        request.expires_at_ms,
    )?;
    if route_decision.selected_lane != request.expected_lane {
        return Ok(MissionRuntimeOutcome::Blocked {
            blockers: vec!["mission_runtime_route_decision_lane_mismatch".into()],
        });
    }
    if let Some(expected_target) = request.expected_target.as_deref() {
        if route_decision.selected_provider_or_agent.as_deref() != Some(expected_target) {
            return Ok(MissionRuntimeOutcome::Blocked {
                blockers: vec!["mission_runtime_route_decision_target_mismatch".into()],
            });
        }
    }
    db.upsert_route_decision(&route_decision)?;

    Ok(MissionRuntimeOutcome::Ready(Box::new(
        MissionRuntimeEnvelope {
            context,
            route_decision,
        },
    )))
}

#[allow(clippy::too_many_arguments)]
pub fn ingest_channel_inbound_for_mission(
    db: &mut Db,
    mission_lookup: MissionContextLookup,
    redacted: &RedactedInbound,
    channel_msg_id: &str,
    action: &str,
    mutating: bool,
    base_risk: Risk,
    params: &[(String, String)],
    now_ms: i64,
) -> Result<MissionBoundChannelOutcome, StorageError> {
    let activity_id = channel_event_id(&redacted.channel_id, channel_msg_id);
    let envelope = match resolve_mission_runtime_envelope(
        db,
        MissionRuntimeRequest {
            lookup: mission_lookup,
            expected_lane: WorkLane::Channel,
            expected_target: Some(redacted.channel_id.clone()),
            decision_id: format!("route-decision:channel:{activity_id}"),
            trace_refs: vec![
                format!("channel:{}:{}", redacted.channel_id, channel_msg_id),
                format!("friday://activity/{activity_id}"),
            ],
            now_ms,
            expires_at_ms: None,
        },
    )? {
        MissionRuntimeOutcome::Ready(envelope) => envelope,
        MissionRuntimeOutcome::Blocked { blockers } => {
            return Ok(MissionBoundChannelOutcome::Blocked { blockers });
        }
    };

    let receipt = ingest_channel_inbound(
        db,
        redacted,
        channel_msg_id,
        action,
        mutating,
        base_risk,
        params,
        now_ms,
    )?;
    let attachment = attach_channel_inbound_receipt(
        db,
        &envelope.context.mission_id,
        &envelope.context.work_item_id,
        &receipt,
        now_ms,
    )?;
    Ok(MissionBoundChannelOutcome::Recorded {
        envelope,
        receipt,
        attachment,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn ingest_authenticated_channel_inbound_for_mission<S: SecureStore>(
    db: &mut Db,
    store: &S,
    mission_lookup: MissionContextLookup,
    channel_id: &str,
    presented_bearer: &str,
    sender_id: &str,
    raw_text: String,
    channel_msg_id: &str,
    action: &str,
    mutating: bool,
    base_risk: Risk,
    params: &[(String, String)],
    now_ms: i64,
) -> Result<MissionBoundChannelIngressOutcome, StorageError> {
    let Some(binding) = get_channel(db.conn(), channel_id)? else {
        return Ok(MissionBoundChannelIngressOutcome::AuthRejected {
            reason: "unknown_channel".into(),
        });
    };
    let verified = match resolve_and_verify(store, &binding, presented_bearer, sender_id) {
        Ok(verified) => verified,
        Err(reason) => {
            return Ok(MissionBoundChannelIngressOutcome::AuthRejected {
                reason: inbound_rejection_label(reason).into(),
            });
        }
    };
    let redacted = redact_inbound(verified, raw_text);
    match ingest_channel_inbound_for_mission(
        db,
        mission_lookup,
        &redacted,
        channel_msg_id,
        action,
        mutating,
        base_risk,
        params,
        now_ms,
    )? {
        MissionBoundChannelOutcome::Blocked { blockers } => {
            Ok(MissionBoundChannelIngressOutcome::Blocked { blockers })
        }
        MissionBoundChannelOutcome::Recorded {
            envelope,
            receipt,
            attachment,
        } => Ok(MissionBoundChannelIngressOutcome::Recorded {
            envelope,
            receipt,
            attachment,
        }),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn ask_friday_for_mission<T: Transport>(
    db: &mut Db,
    client: &DeepSeekClient<T>,
    mission_lookup: MissionContextLookup,
    ledger_id: &str,
    session_id: &str,
    activity_id: &str,
    prompt: &str,
    max_tokens: u32,
    now_ms: i64,
) -> Result<MissionBoundAskOutcome, RecordAskError> {
    let envelope = match resolve_mission_runtime_envelope(
        db,
        MissionRuntimeRequest {
            lookup: mission_lookup,
            expected_lane: WorkLane::DeepSeek,
            expected_target: Some("deepseek".to_string()),
            decision_id: format!("route-decision:ask:{ledger_id}"),
            trace_refs: vec![
                format!("token_ledger:{ledger_id}"),
                format!("friday://activity/{activity_id}"),
            ],
            now_ms,
            expires_at_ms: None,
        },
    )
    .map_err(RecordAskError::Storage)?
    {
        MissionRuntimeOutcome::Ready(envelope) => envelope,
        MissionRuntimeOutcome::Blocked { blockers } => {
            return Ok(MissionBoundAskOutcome::Blocked { blockers });
        }
    };

    let ask_outcome = record_friday_ask(
        db,
        client,
        ledger_id,
        session_id,
        activity_id,
        prompt,
        max_tokens,
        now_ms,
    )?;

    let proof_ref = format!("friday://activity/{activity_id}");
    let outcome_proof_receipt = answer_produced_outcome_receipt_for_work_item(
        db,
        &envelope.context.work_item_id,
        ledger_id,
        &ask_outcome.content,
        now_ms,
    )
    .map_err(RecordAskError::Storage)?;
    let attachment = attach_completed_provider_state_for_ask(
        db,
        CompletedAskProviderAttachment {
            mission_id: &envelope.context.mission_id,
            work_item_id: &envelope.context.work_item_id,
            session_id,
            ledger_id,
            proof_ref: &proof_ref,
            completion_proof_receipt: outcome_proof_receipt.as_deref(),
            now_ms,
        },
    )
    .map_err(RecordAskError::Storage)?;

    Ok(MissionBoundAskOutcome::Answered {
        envelope,
        ledger_id: ledger_id.to_string(),
        result_link: proof_ref,
        attachment,
    })
}

struct CompletedAskProviderAttachment<'a> {
    mission_id: &'a str,
    work_item_id: &'a str,
    session_id: &'a str,
    ledger_id: &'a str,
    proof_ref: &'a str,
    completion_proof_receipt: Option<&'a str>,
    now_ms: i64,
}

pub(crate) fn answer_produced_outcome_receipt_for_work_item(
    db: &Db,
    work_item_id: &str,
    proof_id: &str,
    answer: &str,
    now_ms: i64,
) -> Result<Option<String>, StorageError> {
    if !friday_core::outcome_checked_proof_enabled() {
        return Ok(None);
    }
    let Some(work_item) = db.get_work_item(work_item_id)? else {
        return Ok(None);
    };
    let requires_answer_produced = work_item
        .outcome_requirement_specs()
        .iter()
        .any(|spec| spec.kind == ProofRequirementKind::AnswerProduced);
    if !requires_answer_produced {
        return Ok(None);
    }
    persist_run_result(
        db.conn(),
        proof_id,
        &RunResult::new(
            "finished",
            answer,
            Some(format!("friday://activity/{proof_id}")),
        ),
        now_ms,
    )?;
    let Some(result_ref) = get_run_result_ref(db.conn(), proof_id)? else {
        return Err(StorageError::Unsupported(format!(
            "outcome proof run_result '{proof_id}' was not persisted"
        )));
    };
    Ok(Some(format!(
        "proof://outcome/{}/{proof_id}?signal=answer_sha256={};answer_len={}",
        ProofRequirementKind::AnswerProduced.as_str(),
        result_ref.answer_sha256,
        result_ref.answer_len
    )))
}

#[allow(clippy::too_many_arguments)]
pub fn run_workflow_for_mission(
    def: &WorkflowDefinition,
    executor: &dyn ToolExecutor,
    db: &Db,
    mission_lookup: MissionContextLookup,
    run_id: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    now_ms: i64,
) -> Result<MissionBoundWorkflowOutcome, StorageError> {
    let envelope = match resolve_workflow_envelope(db, mission_lookup, def, run_id, now_ms)? {
        MissionRuntimeOutcome::Ready(envelope) => envelope,
        MissionRuntimeOutcome::Blocked { blockers } => {
            return Ok(MissionBoundWorkflowOutcome::Blocked { blockers });
        }
    };
    let workflow = run_workflow(def, executor, db.conn(), run_id, secret, approve, now_ms)?;
    let attachment = attach_workflow_run_ref(
        db,
        &envelope.context.mission_id,
        &envelope.context.work_item_id,
        run_id,
        Some(route_decision_ref(&envelope)),
        now_ms,
    )?;
    Ok(MissionBoundWorkflowOutcome::Ran {
        envelope,
        workflow,
        attachment,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn resume_workflow_for_mission(
    def: &WorkflowDefinition,
    executor: &dyn ToolExecutor,
    db: &Db,
    mission_lookup: MissionContextLookup,
    run_id: &str,
    secret: &[u8],
    approve: &dyn Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
    now_ms: i64,
) -> Result<MissionBoundWorkflowOutcome, StorageError> {
    let envelope = match resolve_workflow_envelope(db, mission_lookup, def, run_id, now_ms)? {
        MissionRuntimeOutcome::Ready(envelope) => envelope,
        MissionRuntimeOutcome::Blocked { blockers } => {
            return Ok(MissionBoundWorkflowOutcome::Blocked { blockers });
        }
    };
    let workflow = resume_workflow(def, executor, db.conn(), run_id, secret, approve, now_ms)?;
    let attachment = attach_workflow_run_ref(
        db,
        &envelope.context.mission_id,
        &envelope.context.work_item_id,
        run_id,
        Some(route_decision_ref(&envelope)),
        now_ms,
    )?;
    Ok(MissionBoundWorkflowOutcome::Ran {
        envelope,
        workflow,
        attachment,
    })
}

fn resolve_workflow_envelope(
    db: &Db,
    mission_lookup: MissionContextLookup,
    def: &WorkflowDefinition,
    run_id: &str,
    now_ms: i64,
) -> Result<MissionRuntimeOutcome, StorageError> {
    resolve_mission_runtime_envelope(
        db,
        MissionRuntimeRequest {
            lookup: mission_lookup,
            expected_lane: WorkLane::Workflow,
            expected_target: None,
            decision_id: format!("route-decision:workflow:{run_id}"),
            trace_refs: vec![
                format!("workflow_definition:{}", def.name),
                format!("friday://workflow-run/{run_id}"),
            ],
            now_ms,
            expires_at_ms: None,
        },
    )
}

fn route_decision_ref(envelope: &MissionRuntimeEnvelope) -> String {
    format!(
        "friday://route-decision/{}",
        envelope.route_decision.decision_id
    )
}

fn inbound_rejection_label(reason: InboundRejection) -> &'static str {
    match reason {
        InboundRejection::ChannelDisabled => "channel_disabled",
        InboundRejection::NoAuthConfigured => "no_auth_configured",
        InboundRejection::BadBearer => "bad_bearer",
        InboundRejection::SenderNotAllowed => "sender_not_allowed",
    }
}

fn attach_completed_provider_state_for_ask(
    db: &Db,
    input: CompletedAskProviderAttachment<'_>,
) -> Result<MissionAttachmentOutcome, StorageError> {
    let mut last = MissionAttachmentOutcome::Blocked {
        blockers: vec!["provider_state_not_attached".into()],
    };
    for state in [
        PendingState::SentToHub,
        PendingState::AcceptedByHub,
        PendingState::RoutedToProvider,
        PendingState::WaitingProvider,
        PendingState::ProviderCompleted,
    ] {
        last = attach_provider_timeline_state_guarded_with_completion_receipt(
            db,
            ProviderTimelineAttachment {
                mission_id: input.mission_id.to_string(),
                work_item_id: input.work_item_id.to_string(),
                friday_session_id: input.session_id.to_string(),
                request_id: input.ledger_id.to_string(),
                state,
                proof_ref: (state == PendingState::ProviderCompleted)
                    .then(|| input.proof_ref.to_string()),
                now_ms: input.now_ms,
            },
            false,
            false,
            (state == PendingState::ProviderCompleted)
                .then_some(input.completion_proof_receipt)
                .flatten(),
        )?;
        if matches!(last, MissionAttachmentOutcome::Blocked { .. }) {
            return Ok(last);
        }
    }
    Ok(last)
}

/// S1.3 — record the Mission binding for an agent-LOOP run by driving the SAME
/// provider-timeline attachment the single-shot ask path uses
/// ([`attach_provider_timeline_state`]). The agent loop is a Hub-orchestrated,
/// DeepSeek-routed run, so it binds to its Mission exactly like the ask does.
///
/// The `MissionLink` that actually ties THIS run to the Mission is written by the FIRST
/// attachment call (target `friday://provider-timeline/{session}#{run_id}`, request_id =
/// `run_id`) and upserted (same `link_id`) on each subsequent state; the later states only
/// advance the WorkItem status. The status mapping is TRUTH-honest — it never over-claims:
///
/// - `completed` (the loop `Finished`) → full progression to `ProviderCompleted` with the
///   run as proof (`proof_ref` = `friday://agent-run/{run_id}`), completing the WorkItem so
///   its result/billing tie to the Mission.
/// - otherwise (Paused / Blocked / Bounded / Errored) → drive ONLY to `RoutedToProvider`.
///   That is TRUE for every `Ok` loop outcome (the route was selected and the client was
///   called), and it deliberately does NOT claim `ProviderWaiting`/`CompletedWithProof` for
///   a paused or dead run. The binding link still exists, tied to the run.
///
/// (WI-1, M-6) `guarded` is the DARK WorkItem guarded-transition flag, threaded in as a pure
/// bool from the run-loop entrypoint's single env read (see
/// [`crate::runtime::HubRuntime::run_agent_loop_for_mission_with_overrides`]). It is forwarded
/// verbatim to every per-state [`attach_provider_timeline_state_guarded`] call. `false` (the prod
/// default): each legal status hop advances via the pre-WI-1 inline write — BYTE-IDENTICAL to
/// before (no audit row, no primitive call). `true`: each legal hop advances through
/// [`friday_storage::Db::transition_work_item_status`], writing one hash-chained `audit_ledger`
/// lifecycle row per transition in its own transaction. A completed loop drives 5 legal hops
/// (ReadyToDispatch → … → CompletedWithProof) ⇒ 5 lifecycle audit rows. The resulting WorkItem
/// status and the MissionLink (its `created_at_ms` is preserved from the first hop = base
/// `now_ms`) are unchanged either way. The ON path has TWO deltas vs OFF: (a) those hash-chained
/// audit rows, and (b) an ON-only `updated_at_ms` +offset (≤ +4ms, one per hop index) on the
/// WorkItem and, on completion, the Mission row — a direct consequence of the per-hop `now_ms`
/// below. NOTE: ON-path only, each hop is given a distinct `now_ms` (a per-hop monotonic offset)
/// so the per-hop audit_ids — derived from `(work_item_id, now_ms)`, the `audit_ledger` PRIMARY
/// KEY — are unique across the multi-hop drive and the run never errors on a PK collision. OFF
/// keeps the single caller-side `now_ms` (byte-identical to pre-WI-1).
///
/// The COMBINED all-at-once agent-loop binding drive (`SentToHub -> AcceptedByHub ->
/// RoutedToProvider`, plus either the completion or terminal-failure rest hop), run AFTER the
/// loop. This is the PRODUCTION drive — the pre-#24b order, RESTORED in the panel-BLOCK fix.
///
/// (#24b history) The original #24b SPLIT this into a pre-dispatch leg (before the loop, advancing
/// the row to `ProviderRouted`) + a completion leg (after), so the during-call status would be
/// `ProviderRouted`. An adversarial panel BLOCKED that reorder for two LIVE degrades: a loop `Err`
/// left the row stranded at `ProviderRouted` (an orphan, not the retryable `ReadyToDispatch`), and
/// the pre-dispatch `?` made any `StorageError` fatal BEFORE the answer persisted. The fix REVERTS
/// to driving the whole binding AFTER the loop (here), so an errored run stays `ReadyToDispatch`
/// (retryable) and the binding can only fail after the loop returned (answer durable). The
/// crash-during-call state is therefore `ReadyToDispatch + executing == 1 + stale`, reconciled by
/// PASS-2 via the additive `ReadyToDispatch -> FailedTerminal` edge (see `crash_recovery`). The
/// FINAL hop of this drive clears `executing` atomically with its status write (degrade-3 fix; see
/// [`drive_provider_states`]). The split legs are retained as `#[cfg(test)]` scaffolding only.
#[allow(clippy::too_many_arguments)]
pub(crate) fn attach_agent_loop_provider_state(
    db: &Db,
    mission_id: &str,
    work_item_id: &str,
    session_id: &str,
    run_id: &str,
    rest_state: AgentLoopProviderRestState,
    proof_ref: &str,
    completion_proof_receipt: Option<&str>,
    guarded: bool,
    now_ms: i64,
) -> Result<MissionAttachmentOutcome, StorageError> {
    let mut states = vec![
        PendingState::SentToHub,
        PendingState::AcceptedByHub,
        PendingState::RoutedToProvider,
    ];
    match rest_state {
        AgentLoopProviderRestState::Routed => {}
        AgentLoopProviderRestState::Completed => {
            states.push(PendingState::WaitingProvider);
            states.push(PendingState::ProviderCompleted);
        }
        AgentLoopProviderRestState::FailedTerminal => {
            states.push(PendingState::FailedTerminal);
        }
    }
    drive_provider_states(
        db,
        mission_id,
        work_item_id,
        session_id,
        run_id,
        &states,
        0,
        proof_ref,
        completion_proof_receipt,
        guarded,
        now_ms,
    )
}

// (#24b history) The original #24b SPLIT the binding into a pre-dispatch leg (driving
// `SentToHub -> AcceptedByHub -> RoutedToProvider` BEFORE the loop) and a completion leg (after).
// The adversarial panel BLOCKED that reorder for two live degrades (a loop `Err` stranding the row
// at `ProviderRouted`, and a pre-dispatch `StorageError` aborting the run before the answer
// persisted). The fix REVERTED to the combined post-loop `attach_agent_loop_provider_state` above,
// so the split-leg functions are gone — `drive_provider_states` (below) is now driven only by the
// combined entrypoint, with a `start_idx` of 0 for every caller.

/// Shared driver for a run of provider-timeline hops on the SAME bound WorkItem. `start_idx` seeds
/// the guarded per-hop `now_ms` offset so a caller can split the drive into pre-/post-loop legs
/// without an `audit_ledger` PK collision (the audit_id is derived from `(work_item_id, now_ms)`).
#[allow(clippy::too_many_arguments)]
fn drive_provider_states(
    db: &Db,
    mission_id: &str,
    work_item_id: &str,
    session_id: &str,
    run_id: &str,
    states: &[PendingState],
    start_idx: usize,
    proof_ref: &str,
    completion_proof_receipt: Option<&str>,
    guarded: bool,
    now_ms: i64,
) -> Result<MissionAttachmentOutcome, StorageError> {
    let mut last = MissionAttachmentOutcome::Blocked {
        blockers: vec!["provider_state_not_attached".into()],
    };
    for (idx, &state) in states.iter().enumerate() {
        // WI-1 (M-6) audit_id uniqueness: the guarded primitive derives each lifecycle row's
        // audit_id from `(work_item_id, now_ms)`, and that id is the `audit_ledger` PRIMARY KEY.
        // This loop drives MULTIPLE hops for the SAME work_item, so reusing the single caller-side
        // `now_ms` across hops would collide on the 2nd row's id and the primitive would return Err
        // — erroring the run. ONLY on the guarded path we give each hop a distinct `now_ms` (the
        // per-hop monotonic offset, seeded by `start_idx` so split legs never collide), so the
        // audit_ids are unique and the chain extends cleanly. The OFF path is UNCHANGED — it keeps
        // the single `now_ms`, so it stays BYTE-IDENTICAL to the pre-WI-1 inline write (which is
        // PK-idempotent on `upsert_work_item` and never wrote an audit row, so it never had this
        // constraint).
        let hop_now_ms = if guarded {
            now_ms + (start_idx + idx) as i64
        } else {
            now_ms
        };
        // (#24b degrade-3 fix) Clear the durable `executing` marker ATOMICALLY with the FINAL hop's
        // status write. Every caller of this driver is the agent-loop binding, whose final hop is
        // the run's resting state (`ProviderRouted` on pause/await, `FailedTerminal` on terminal
        // failure, `CompletedWithProof` on completion) — a state where `executing` MUST be 0.
        // Doing the clear in the SAME tx as that
        // status write means a swallowed best-effort loop tail-clear can NEVER strand
        // `executing == 1` on a live paused run (which PASS-2 would then falsely reconcile). The
        // non-final in-flight hops keep `false` (the marker is still live mid-drive).
        let clear_executing = idx + 1 == states.len();
        last = attach_provider_timeline_state_guarded_with_completion_receipt(
            db,
            ProviderTimelineAttachment {
                mission_id: mission_id.to_string(),
                work_item_id: work_item_id.to_string(),
                friday_session_id: session_id.to_string(),
                request_id: run_id.to_string(),
                state,
                proof_ref: (state == PendingState::ProviderCompleted)
                    .then(|| proof_ref.to_string()),
                now_ms: hop_now_ms,
            },
            guarded,
            clear_executing,
            (state == PendingState::ProviderCompleted)
                .then_some(())
                .and(completion_proof_receipt),
        )?;
        if matches!(last, MissionAttachmentOutcome::Blocked { .. }) {
            return Ok(last);
        }
    }
    Ok(last)
}

/// RESUME a paused, mutating, MISSION-BOUND agent-loop run AND — only on a proven execution —
/// advance its bound WorkItem `ProviderRouted → CompletedWithProof`. This closes the ONE gap left
/// by the dark mission-bound run path: after the operator's Ed25519-signed approval executes the
/// one paused mutation, NOTHING previously advanced the WorkItem off `ProviderRouted` (the
/// pause-time bind state — see `attach_agent_loop_provider_state` with
/// `AgentLoopProviderRestState::Routed`).
///
/// ## THE LOOPHOLE GATE (a false proof is a security defect)
/// The WorkItem is advanced ONLY when the ONE approved mutation actually ran — gate `Allow` AND
/// executor `Ok`. This is delegated VERBATIM to [`crate::agent_run_control::resume`] (which itself
/// delegates to the S6 [`crate::resume::resume_with_approval`] spine): its returned
/// [`ControlOutcome::accepted`] field is set to `outcome.executed` (agent_run_control.rs:472), and
/// EVERY non-execution path — gate `Deny` (replayed/consumed nonce, expired/bad-signature/HMAC
/// approval), `mutation_exec_failed` (gate Allow but executor `Err`), every `ResumeError`, and the
/// fail-closed pre-checks (`malformed_blob`/`run_mismatch`/`run_cancelled`/`approval_rejected`) —
/// returns `accepted: false`. So `accepted == true` ⟺ `executed == true` ⟺ the mutation ran. We
/// gate the advance STRICTLY on `outcome.accepted`. If it is false we return the spine's outcome
/// UNMODIFIED and the WorkItem is left UNCHANGED (stays `ProviderRouted`): no proof, no
/// audit-completion row, no false proof.
///
/// ## Cross-mission proof-injection defense
/// We NEVER trust a wire-supplied work_item_id. The WorkItem is resolved ONLY via the run's OWN
/// pause-time `provider_timeline` MissionLink — the link whose `target_ref` encodes EXACTLY this
/// `run_id` as its trailing `#`-segment (`friday://provider-timeline/{session}#{run_id}`,
/// resolved by [`friday_storage::Db::find_provider_timeline_link_by_run_id`], which matches the
/// last `#`-segment EXACTLY and fail-closes on zero or ambiguous matches). That link carries the
/// bound `mission_id` + `work_item_id` directly; an attacker cannot steer the completion to a
/// foreign WorkItem. If no own-link resolves (a non-mission run, or a foreign nonce), we DO NOT
/// advance — we return the spine's outcome unchanged (so a flag-on non-mission resume is
/// byte-identical to a bare `agent_run_control::resume`).
///
/// ## The partial advance (no backward / duplicate transition)
/// The bound WorkItem is already at `ProviderRouted`, so we drive ONLY the remaining legal hops
/// `RoutedToProvider → WaitingProvider → ProviderCompleted` via
/// [`attach_provider_timeline_state_guarded`] with `proof_ref = friday://agent-run/{run_id}`,
/// reusing the SAME `friday_session_id` (parsed from the matched link's `target_ref`) and
/// `request_id = run_id` so the completion UPSERTS the same MissionLink rather than minting a
/// second (which would later make the run_id resolution ambiguous). We do NOT re-drive
/// `SentToHub`/`AcceptedByHub` (the item is past them — re-running would be an illegal backward
/// transition). `guarded = false` (the pre-WI-1 inline write) is used here so the advance writes
/// no extra audit row and never risks an `audit_ledger` PK collision; the completion proof_ref is
/// always supplied, and `transition_work_item_status` / `work_item_status_for_provider_state`
/// reject a proof-less `CompletedWithProof` as the final backstop.
///
/// A non-advancing attachment outcome (e.g. the idempotent already-`CompletedWithProof` case →
/// `Blocked{illegal_work_item_transition:...}`) is NON-FATAL: we still return the spine's
/// `accepted` outcome (the mutation DID run). The advance is a pure side-effect; it never alters
/// the returned [`ControlOutcome`].
///
/// **Crash-window atomicity (H3 fix).** The spine's `run_result=mutation_completed` write AND this
/// WorkItem advance now commit in ONE transaction: the advance runs as the spine's `on_executed`
/// hook INSIDE the success transaction (`resume_with_approval_hooked`), so a crash leaves BOTH the
/// run_result and the WorkItem hop, or NEITHER. The earlier non-atomic boundary — which could leave
/// `run_result=mutation_completed` with the WorkItem stuck at `ProviderRouted`/`ProviderWaiting` (an
/// UNDER-claim) — is closed. The residual under-claim is ONLY the executor-side one: the executor's
/// file write is the irreducible non-rollbackable side effect committed OUTSIDE the transaction, so
/// a crash after the file write but before the fold commits degrades to `executed==false` (nonce
/// consumed, run_result + WorkItem both absent) on the next resume — never a false proof, never a
/// re-advance (the consumed nonce replay-refuses). The abort predicate is UNCHANGED: the advance
/// still runs ONLY when the spine returned an `accepted` (executed) outcome under a fresh Ed25519
/// verify.
///
/// Returns `Result<ControlOutcome, StorageError>` — a drop-in for the bare
/// `agent_run_control::resume` at the wire seam (same `send_control_result` / `storage_failed`
/// fallback shape).
pub fn resume_agent_loop_for_mission(
    db: &Db,
    executor: &dyn ToolExecutor,
    operator_vk: &OperatorVerifyingKey,
    run_id: &str,
    signed_blob: &[u8],
    now_ms: i64,
) -> Result<ControlOutcome, StorageError> {
    // (a) Resolve the bound WorkItem from the run's OWN pause-time provider_timeline link ONLY
    //     (never a wire-supplied id) — a READ on the pre-pause binding, done BEFORE the spine runs
    //     (the resume never mutates this link). No own-link (non-mission run / foreign nonce), a
    //     non-provider_timeline kind, or no bound WorkItem ⇒ NO advance hook: the resume runs
    //     byte-identically to a bare `agent_run_control::resume` on a non-mission run.
    let advance_binding = match db.find_provider_timeline_link_by_run_id(run_id)? {
        Some(link)
            if link.link_kind == MissionLinkKind::ProviderTimeline
                && link.work_item_id.is_some() =>
        {
            // The pause-time link's target_ref is `friday://provider-timeline/{session}#{run_id}`.
            // Parse the session BACK out so the completion reuses the SAME link_id
            // (mission_id+work_item+session+run) and UPSERTS the existing link instead of minting a
            // second one (which would make a future run_id resolution ambiguous → fail-closed). The
            // run_id segment was matched EXACTLY by the resolver, so the session is everything
            // between the `provider-timeline/` prefix and the `#`.
            let session_id =
                provider_timeline_session_from_target(&link.target_ref).unwrap_or_default();
            Some((
                link.mission_id.clone(),
                link.work_item_id.clone().expect("work_item_id is some"),
                session_id,
            ))
        }
        // Defense-in-depth: the storage query already filters to provider_timeline.
        _ => None,
    };

    // (b) The completion hook: drive ONLY the remaining legal hops WaitingProvider →
    //     ProviderCompleted with the run as proof. It runs INSIDE the spine's success transaction
    //     (so the WorkItem advance and the `run_result` commit atomically), ONLY when the spine
    //     executed the mutation (gate Allow + executor Ok) — `resume_with_approval_hooked` invokes
    //     it solely on the executed-`Ok` arm, AFTER the nonce is consumed and the executor ran. A
    //     non-advancing attachment outcome (e.g. an already-completed run ⇒ illegal/duplicate
    //     transition) is NON-FATAL: the mutation DID run, so we stop driving hops but never error
    //     the resume (the advance is a side-effect that never changes the returned ControlOutcome).
    let proof_ref = format!("friday://agent-run/{run_id}");
    let mut advance_hook =
        advance_binding
            .as_ref()
            .map(|(mission_id, work_item_id, session_id)| {
                move |tx: &rusqlite::Transaction<'_>| -> Result<(), StorageError> {
                    for state in [
                        PendingState::WaitingProvider,
                        PendingState::ProviderCompleted,
                    ] {
                        let attachment = attach_provider_timeline_state_off_path_in(
                            tx,
                            ProviderTimelineAttachment {
                                mission_id: mission_id.clone(),
                                work_item_id: work_item_id.clone(),
                                friday_session_id: session_id.clone(),
                                request_id: run_id.to_string(),
                                state,
                                proof_ref: (state == PendingState::ProviderCompleted)
                                    .then(|| proof_ref.clone()),
                                now_ms,
                            },
                            // (#24b degrade-3) Clear `executing` on the resume completion hop too: a
                            // resumed run that reaches `CompletedWithProof` must not leave a stale
                            // marker (terminal rows are already never reconciled by PASS-2, but clearing
                            // keeps the marker truthful for observability). Lands in the SAME fold tx.
                            /* clear_executing = */
                            state == PendingState::ProviderCompleted,
                            // No separate completion-proof receipt: the proof_ref above is supplied.
                            None,
                        )?;
                        if matches!(attachment, MissionAttachmentOutcome::Blocked { .. }) {
                            break;
                        }
                    }
                    Ok(())
                }
            });

    // (c) Delegate to the EXISTING resume spine. This verifies the Ed25519 signature, enforces
    //     single-use (nonce consume), runs the reject/cancel + wire-run-binding pre-checks, and
    //     executes the ONE approved mutation. We add no verification/execution — the only addition
    //     is the post-execute completion hook, folded into the spine's success transaction.
    let hook = advance_hook
        .as_mut()
        .map(|h| h as crate::resume::ResumeCompletionHook<'_>);
    agent_run_control_resume_hooked(
        db.conn(),
        executor,
        operator_vk,
        run_id,
        signed_blob,
        now_ms,
        hook,
    )
}

/// Parse the `{session}` out of a provider-timeline `target_ref`
/// (`friday://provider-timeline/{session}#{run_id}`): everything between the `provider-timeline/`
/// prefix and the LAST `#`. Returns `None` if the ref is not in that shape.
fn provider_timeline_session_from_target(target_ref: &str) -> Option<String> {
    const PREFIX: &str = "friday://provider-timeline/";
    let rest = target_ref.strip_prefix(PREFIX)?;
    let (session, _run) = rest.rsplit_once('#')?;
    if session.is_empty() {
        return None;
    }
    Some(session.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::{provision_channel_auth, redact_inbound, VerifiedInbound};
    use crate::{ExecError, ToolReceipt};
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus,
        SurfaceKind, TruthStatus, VisibilityPolicy, WorkItem, WorkItemStatus,
    };
    use friday_crypto::InMemorySecureStore;
    use friday_storage::audit::verify_audit_chain;
    use friday_storage::channel::ChannelKind;
    use friday_storage::{workflow, Db};
    use std::cell::Cell;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use crate::workflow_exec::WorkflowRunStatus;

    static C: AtomicU64 = AtomicU64::new(0);
    const SECRET: &[u8] = b"mission-runtime-secret-0123456789";

    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-mission-runtime-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    struct CountingExec {
        calls: Cell<usize>,
    }

    impl ToolExecutor for CountingExec {
        fn execute(
            &self,
            action: &str,
            _params: &[(String, String)],
        ) -> Result<ToolReceipt, ExecError> {
            self.calls.set(self.calls.get() + 1);
            Ok(ToolReceipt {
                action: action.to_string(),
                summary: format!("ran {action}"),
                content: None,
            })
        }
    }

    struct AskTransport {
        gets: Rc<Cell<usize>>,
        posts: Rc<Cell<usize>>,
    }

    impl friday_deepseek::Transport for AskTransport {
        fn get_json(
            &self,
            _url: &str,
            _bearer: &str,
        ) -> Result<serde_json::Value, friday_deepseek::DeepSeekError> {
            self.gets.set(self.gets.get() + 1);
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }

        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &serde_json::Value,
        ) -> Result<serde_json::Value, friday_deepseek::DeepSeekError> {
            self.posts.set(self.posts.get() + 1);
            Ok(serde_json::json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":"mission ask answer"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}
            }))
        }
    }

    fn deny_all(_r: &MutatingActionRequest) -> Option<CanonicalApproval> {
        None
    }

    fn seed_work_item(db: &Db, lane: WorkLane, target: Option<&str>, status: WorkItemStatus) {
        let now = 1_700_000_000_000;
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: "fconv_runtime".into(),
            owner_principal: "owner-1".into(),
            title: "Mission runtime".into(),
            current_focus_summary: "Mission-bound channel/workflow producers".into(),
            active_mission_ids: vec!["mission-runtime".into()],
            surface_thread_ids: vec!["surface-mobile-runtime".into()],
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: vec!["proof://mission-runtime-test".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: "mission-runtime".into(),
            friday_conversation_id: "fconv_runtime".into(),
            title: "Mission runtime".into(),
            intent: "prevent detached runtime producers".into(),
            status: MissionStatus::Active,
            why_now: "channel/workflow entries must not invent product state".into(),
            decision_path_summary: "resolve Mission context before producer writes".into(),
            considered_options: vec!["detached event/run".into()],
            deferred_options: vec!["native UI rendering".into()],
            known_pitfalls: vec!["ack is not completion".into()],
            handoff_inheritance: vec!["preserve route judgment".into()],
            work_item_ids: vec!["work-runtime".into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://mission-runtime-test".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_surface_thread(&friday_core::SurfaceThread {
            surface_thread_id: "surface-mobile-runtime".into(),
            friday_conversation_id: "fconv_runtime".into(),
            mission_id: Some("mission-runtime".into()),
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
            work_item_id: "work-runtime".into(),
            mission_id: "mission-runtime".into(),
            lane,
            target_provider_or_agent: target.map(str::to_string),
            status,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("mission.runtime".into()),
            risk_level: Risk::Medium,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["input://runtime".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["mission runtime tests".into()],
            proof_receipts: Vec::new(),
            judgment_memory: judgment(lane),
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
    }

    fn judgment(lane: WorkLane) -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "Bind runtime producer to Mission".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: lane.as_str().into(),
            read_first_files: vec!["rust-core/crates/friday-hub/src/mission_runtime.rs".into()],
            required_output: "Mission runtime envelope".into(),
            done_criteria: vec!["detached producer blocked".into()],
            red_lines: vec!["do not execute before Mission context".into()],
            why_this_route: "The WorkItem lane owns this producer entry.".into(),
            considered_options: vec!["let channel/workflow self-attach".into()],
            deferred_options: vec!["route decision persistence table".into()],
            previous_pitfalls: vec!["provider ack looked like done".into()],
            inheritable_context: vec!["Mission is product truth".into()],
            proof_requirements: vec!["mission_runtime tests".into()],
            ownership_claim_ids: Vec::new(),
        }
    }

    fn lookup() -> MissionContextLookup {
        MissionContextLookup::by_work_item("fconv_runtime", "mission-runtime", "work-runtime")
    }

    fn read_only_workflow() -> WorkflowDefinition {
        WorkflowDefinition {
            name: "research".into(),
            steps: vec![crate::planner::WorkflowStep {
                id: "read".into(),
                action: "read_file".into(),
                params: vec![("path".into(), "notes.md".into())],
                force_checkpoint: false,
                evidence_required: false,
            }],
        }
    }

    fn redacted_channel() -> RedactedInbound {
        redact_inbound(
            VerifiedInbound {
                channel_id: "tg:room-1".into(),
                sender_id: "u-1".into(),
                bound_principal_id: "owner-1".into(),
            },
            "hello Friday".into(),
        )
    }

    fn provision_runtime_channel(db: &Db) -> (InMemorySecureStore, String, String) {
        let mut store = InMemorySecureStore::new();
        let channel_id = "tg:room-1".to_string();
        let bearer = provision_channel_auth(
            &mut store,
            db.conn(),
            &channel_id,
            ChannelKind::Telegram,
            "owner-1",
            &["u-1".to_string()],
            b"mission-channel-secret-0123456789",
            1,
        )
        .unwrap();
        (store, channel_id, bearer)
    }

    fn deepseek_client(
        gets: Rc<Cell<usize>>,
        posts: Rc<Cell<usize>>,
    ) -> DeepSeekClient<AskTransport> {
        DeepSeekClient::with_transport(AskTransport { gets, posts }, "k".into())
    }

    #[test]
    fn workflow_producer_blocks_missing_context_before_creating_run() {
        let db = Db::open_hub(&tmp("missing-context")).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let outcome = run_workflow_for_mission(
            &read_only_workflow(),
            &exec,
            &db,
            MissionContextLookup::default(),
            "wf-run-1",
            SECRET,
            &deny_all,
            1,
        )
        .unwrap();

        assert_eq!(
            outcome,
            MissionBoundWorkflowOutcome::Blocked {
                blockers: vec!["mission_context_lookup_required".into()]
            }
        );
        assert_eq!(workflow::run_state(db.conn(), "wf-run-1").unwrap(), None);
        assert_eq!(exec.calls.get(), 0);
    }

    #[test]
    fn workflow_producer_requires_workflow_lane_before_execution() {
        let db = Db::open_hub(&tmp("lane-mismatch")).unwrap();
        seed_work_item(
            &db,
            WorkLane::Channel,
            Some("tg:room-1"),
            WorkItemStatus::ReadyToDispatch,
        );
        let exec = CountingExec {
            calls: Cell::new(0),
        };

        let outcome = run_workflow_for_mission(
            &read_only_workflow(),
            &exec,
            &db,
            lookup(),
            "wf-run-1",
            SECRET,
            &deny_all,
            2,
        )
        .unwrap();

        assert!(matches!(
            outcome,
            MissionBoundWorkflowOutcome::Blocked { blockers }
                if blockers.contains(&"mission_runtime_lane_mismatch".to_string())
        ));
        assert_eq!(workflow::run_state(db.conn(), "wf-run-1").unwrap(), None);
        assert_eq!(exec.calls.get(), 0);
    }

    #[test]
    fn workflow_producer_runs_and_attaches_ref_after_route_decision() {
        let db = Db::open_hub(&tmp("workflow-ok")).unwrap();
        seed_work_item(
            &db,
            WorkLane::Workflow,
            None,
            WorkItemStatus::ReadyToDispatch,
        );
        let exec = CountingExec {
            calls: Cell::new(0),
        };

        let outcome = run_workflow_for_mission(
            &read_only_workflow(),
            &exec,
            &db,
            lookup(),
            "wf-run-1",
            SECRET,
            &deny_all,
            3,
        )
        .unwrap();

        let MissionBoundWorkflowOutcome::Ran {
            envelope,
            workflow,
            attachment,
        } = outcome
        else {
            panic!("expected mission-bound workflow run");
        };
        assert_eq!(envelope.route_decision.selected_lane, WorkLane::Workflow);
        assert_eq!(workflow.status, WorkflowRunStatus::Completed);
        assert_eq!(exec.calls.get(), 1);
        assert!(matches!(
            attachment,
            MissionAttachmentOutcome::Attached { .. }
        ));
        let links = db.list_mission_links("mission-runtime").unwrap();
        assert!(links
            .iter()
            .any(|link| link.target_ref == "friday://workflow-run/wf-run-1"
                && link.proof_ref.as_deref()
                    == Some("friday://route-decision/route-decision:workflow:wf-run-1")));
        let stored_route = db
            .get_route_decision("route-decision:workflow:wf-run-1")
            .unwrap()
            .unwrap();
        assert_eq!(stored_route.selected_lane, WorkLane::Workflow);
        assert_eq!(
            stored_route.why_this_route,
            "The WorkItem lane owns this producer entry."
        );
        assert!(links.iter().any(|link| link.link_kind
            == friday_core::MissionLinkKind::RouteDecision
            && !link.link_kind.grants_memory_authority()));
    }

    #[test]
    fn channel_producer_blocks_wrong_channel_target_before_event_write() {
        let mut db = Db::open_hub(&tmp("channel-target-mismatch")).unwrap();
        seed_work_item(
            &db,
            WorkLane::Channel,
            Some("tg:other-room"),
            WorkItemStatus::ReadyToDispatch,
        );
        let redacted = redacted_channel();

        let outcome = ingest_channel_inbound_for_mission(
            &mut db,
            lookup(),
            &redacted,
            "m-1",
            "message",
            false,
            Risk::Low,
            &[],
            4,
        )
        .unwrap();

        assert!(matches!(
            outcome,
            MissionBoundChannelOutcome::Blocked { blockers }
                if blockers.contains(&"mission_runtime_target_mismatch".to_string())
        ));
        assert_eq!(db.count("activity_item").unwrap(), 0);
        assert_eq!(db.count("audit_ledger").unwrap(), 0);
    }

    #[test]
    fn channel_producer_records_and_attaches_only_with_matching_context() {
        let mut db = Db::open_hub(&tmp("channel-ok")).unwrap();
        seed_work_item(
            &db,
            WorkLane::Channel,
            Some("tg:room-1"),
            WorkItemStatus::ReadyToDispatch,
        );
        let redacted = redacted_channel();

        let outcome = ingest_channel_inbound_for_mission(
            &mut db,
            lookup(),
            &redacted,
            "m-1",
            "message",
            false,
            Risk::Low,
            &[],
            5,
        )
        .unwrap();

        let MissionBoundChannelOutcome::Recorded {
            envelope,
            receipt,
            attachment,
        } = outcome
        else {
            panic!("expected mission-bound channel receipt");
        };
        assert_eq!(envelope.route_decision.selected_lane, WorkLane::Channel);
        assert_eq!(
            envelope
                .route_decision
                .selected_provider_or_agent
                .as_deref(),
            Some("tg:room-1")
        );
        assert_eq!(receipt.activity_id, "chan:tg:room-1:m-1");
        assert!(matches!(
            attachment,
            MissionAttachmentOutcome::Attached { .. }
        ));
        assert_eq!(db.count("activity_item").unwrap(), 1);
        assert!(db
            .list_mission_links("mission-runtime")
            .unwrap()
            .iter()
            .any(|link| link.target_ref == "friday://activity/chan:tg:room-1:m-1"));
        let stored_route = db
            .get_route_decision("route-decision:channel:chan:tg:room-1:m-1")
            .unwrap()
            .unwrap();
        assert_eq!(stored_route.selected_lane, WorkLane::Channel);
        assert_eq!(
            stored_route.selected_provider_or_agent.as_deref(),
            Some("tg:room-1")
        );
        let projections = db
            .list_route_decision_projections_for_mission("mission-runtime")
            .unwrap();
        assert_eq!(projections.len(), 1);
        assert_eq!(
            projections[0].selected_target_label.as_deref(),
            Some("bound_channel")
        );
        let rendered_projection = format!("{:?}", projections[0]);
        assert!(!rendered_projection.contains("tg:room-1"));
    }

    #[test]
    fn authenticated_channel_ingress_rejects_bad_bearer_before_event_write() {
        let mut db = Db::open_hub(&tmp("channel-auth-bad")).unwrap();
        seed_work_item(
            &db,
            WorkLane::Channel,
            Some("tg:room-1"),
            WorkItemStatus::ReadyToDispatch,
        );
        let (store, channel_id, _bearer) = provision_runtime_channel(&db);

        let outcome = ingest_authenticated_channel_inbound_for_mission(
            &mut db,
            &store,
            lookup(),
            &channel_id,
            "forged-bearer",
            "u-1",
            "hello Friday".into(),
            "m-1",
            "message",
            false,
            Risk::Low,
            &[],
            6,
        )
        .unwrap();

        assert_eq!(
            outcome,
            MissionBoundChannelIngressOutcome::AuthRejected {
                reason: "bad_bearer".into()
            }
        );
        assert_eq!(db.count("activity_item").unwrap(), 0);
        assert_eq!(db.count("audit_ledger").unwrap(), 0);
        assert_eq!(db.count("mission_link").unwrap(), 0);
        assert_eq!(db.count("route_decision").unwrap(), 0);
    }

    #[test]
    fn authenticated_channel_ingress_blocks_missing_mission_before_event_write() {
        let mut db = Db::open_hub(&tmp("channel-missing-mission")).unwrap();
        let (store, channel_id, bearer) = provision_runtime_channel(&db);

        let outcome = ingest_authenticated_channel_inbound_for_mission(
            &mut db,
            &store,
            MissionContextLookup::default(),
            &channel_id,
            &bearer,
            "u-1",
            "hello Friday".into(),
            "m-1",
            "message",
            false,
            Risk::Low,
            &[],
            7,
        )
        .unwrap();

        assert_eq!(
            outcome,
            MissionBoundChannelIngressOutcome::Blocked {
                blockers: vec!["mission_context_lookup_required".into()]
            }
        );
        assert_eq!(db.count("activity_item").unwrap(), 0);
        assert_eq!(db.count("audit_ledger").unwrap(), 0);
        assert_eq!(db.count("mission_link").unwrap(), 0);
        assert_eq!(db.count("route_decision").unwrap(), 0);
    }

    #[test]
    fn authenticated_channel_ingress_records_redacted_receipt_and_mission_trace() {
        let mut db = Db::open_hub(&tmp("channel-ingress-ok")).unwrap();
        seed_work_item(
            &db,
            WorkLane::Channel,
            Some("tg:room-1"),
            WorkItemStatus::ReadyToDispatch,
        );
        let (store, channel_id, bearer) = provision_runtime_channel(&db);

        let outcome = ingest_authenticated_channel_inbound_for_mission(
            &mut db,
            &store,
            lookup(),
            &channel_id,
            &bearer,
            "u-1",
            "please track card 4111111111111111 for Friday".into(),
            "m-1",
            "message",
            false,
            Risk::Low,
            &[],
            8,
        )
        .unwrap();

        let MissionBoundChannelIngressOutcome::Recorded {
            envelope,
            receipt,
            attachment,
        } = outcome
        else {
            panic!("expected authenticated Mission-bound channel ingress");
        };
        assert_eq!(envelope.route_decision.selected_lane, WorkLane::Channel);
        assert_eq!(
            envelope
                .route_decision
                .selected_provider_or_agent
                .as_deref(),
            Some("tg:room-1")
        );
        assert_eq!(receipt.activity_id, "chan:tg:room-1:m-1");
        assert_eq!(receipt.pii_kinds_redacted, vec!["credit_card"]);
        assert!(matches!(
            attachment,
            MissionAttachmentOutcome::Attached { .. }
        ));
        assert_eq!(db.count("activity_item").unwrap(), 1);
        assert_eq!(db.count("audit_ledger").unwrap(), 1);
        let links = db.list_mission_links("mission-runtime").unwrap();
        assert!(links
            .iter()
            .any(|link| link.target_ref == "friday://activity/chan:tg:room-1:m-1"));
        let route = db
            .get_route_decision("route-decision:channel:chan:tg:room-1:m-1")
            .unwrap()
            .unwrap();
        assert_eq!(route.selected_lane, WorkLane::Channel);
        let rendered = format!("{receipt:?} {links:?} {route:?}");
        for forbidden in ["4111111111111111", "mission-channel-secret"] {
            assert!(
                !rendered.contains(forbidden),
                "channel ingress leaked {forbidden}: {rendered}"
            );
        }
    }

    #[test]
    fn authenticated_channel_replay_does_not_duplicate_event_audit_or_mission_trace() {
        let mut db = Db::open_hub(&tmp("channel-ingress-replay")).unwrap();
        seed_work_item(
            &db,
            WorkLane::Channel,
            Some("tg:room-1"),
            WorkItemStatus::ReadyToDispatch,
        );
        let (store, channel_id, bearer) = provision_runtime_channel(&db);

        let first = ingest_authenticated_channel_inbound_for_mission(
            &mut db,
            &store,
            lookup(),
            &channel_id,
            &bearer,
            "u-1",
            "please summarize current proof".into(),
            "m-replay",
            "message",
            false,
            Risk::Low,
            &[],
            9,
        )
        .unwrap();
        let MissionBoundChannelIngressOutcome::Recorded { receipt: first, .. } = first else {
            panic!("expected first channel ingress to record");
        };
        assert!(!first.replayed);
        assert_eq!(db.count("activity_item").unwrap(), 1);
        assert_eq!(db.count("audit_ledger").unwrap(), 1);
        assert_eq!(db.count("mission_link").unwrap(), 2);
        assert_eq!(db.count("route_decision").unwrap(), 1);
        assert_eq!(db.count("work_item").unwrap(), 1);

        let replay = ingest_authenticated_channel_inbound_for_mission(
            &mut db,
            &store,
            lookup(),
            &channel_id,
            &bearer,
            "u-1",
            "please summarize current proof".into(),
            "m-replay",
            "message",
            false,
            Risk::Low,
            &[],
            10,
        )
        .unwrap();
        let MissionBoundChannelIngressOutcome::Recorded { receipt, .. } = replay else {
            panic!("expected replay channel ingress to return a recorded receipt");
        };
        assert!(receipt.replayed);
        assert_eq!(
            receipt.activity_id, first.activity_id,
            "same channel msg id should resolve to same activity ref"
        );
        assert_eq!(
            db.count("activity_item").unwrap(),
            1,
            "channel replay must not append a second Activity"
        );
        assert_eq!(
            db.count("audit_ledger").unwrap(),
            1,
            "channel replay must not append a second audit receipt"
        );
        assert_eq!(
            db.count("mission_link").unwrap(),
            2,
            "channel replay must upsert the same route/channel Mission trace only"
        );
        assert_eq!(db.count("route_decision").unwrap(), 1);
        assert_eq!(
            db.count("work_item").unwrap(),
            1,
            "channel replay must not create duplicate WorkItems"
        );
    }

    #[test]
    fn mission_bound_ask_blocks_missing_context_before_model_call() {
        let mut db = Db::open_hub(&tmp("ask-missing-context")).unwrap();
        let gets = Rc::new(Cell::new(0));
        let posts = Rc::new(Cell::new(0));
        let client = deepseek_client(gets.clone(), posts.clone());

        let outcome = ask_friday_for_mission(
            &mut db,
            &client,
            MissionContextLookup::default(),
            "ledger-ask-1",
            "friday-hub-session",
            "activity-ask-1",
            "what next?",
            64,
            6,
        )
        .unwrap();

        assert_eq!(
            outcome,
            MissionBoundAskOutcome::Blocked {
                blockers: vec!["mission_context_lookup_required".into()]
            }
        );
        assert_eq!(gets.get(), 0, "blocked ask must not discover models");
        assert_eq!(posts.get(), 0, "blocked ask must not call the model");
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("activity_item").unwrap(), 0);
        assert_eq!(db.count("audit_ledger").unwrap(), 0);
    }

    #[test]
    fn mission_bound_ask_ledgers_and_completes_work_item_with_proof() {
        let mut db = Db::open_hub(&tmp("ask-ok")).unwrap();
        seed_work_item(
            &db,
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );
        let gets = Rc::new(Cell::new(0));
        let posts = Rc::new(Cell::new(0));
        let client = deepseek_client(gets.clone(), posts.clone());

        let outcome = ask_friday_for_mission(
            &mut db,
            &client,
            lookup(),
            "ledger-ask-1",
            "friday-hub-session",
            "activity-ask-1",
            "what next?",
            64,
            7,
        )
        .unwrap();

        let MissionBoundAskOutcome::Answered {
            envelope,
            ledger_id,
            result_link,
            attachment,
        } = outcome
        else {
            panic!("expected mission-bound ask answer");
        };
        assert_eq!(envelope.route_decision.selected_lane, WorkLane::DeepSeek);
        assert_eq!(
            envelope
                .route_decision
                .selected_provider_or_agent
                .as_deref(),
            Some("deepseek")
        );
        assert_eq!(ledger_id, "ledger-ask-1");
        assert_eq!(result_link, "friday://activity/activity-ask-1");
        assert!(matches!(
            attachment,
            MissionAttachmentOutcome::Attached {
                work_item_status: WorkItemStatus::CompletedWithProof,
                ..
            }
        ));
        assert_eq!(gets.get(), 1);
        assert_eq!(posts.get(), 1);
        assert_eq!(db.count("token_ledger").unwrap(), 1);
        let work_item = db.get_work_item("work-runtime").unwrap().unwrap();
        assert_eq!(work_item.status, WorkItemStatus::CompletedWithProof);
        assert!(work_item
            .proof_receipts
            .contains(&"friday://activity/activity-ask-1".to_string()));
        let mission = db.get_mission("mission-runtime").unwrap().unwrap();
        assert!(mission
            .proof_refs
            .contains(&"friday://activity/activity-ask-1".to_string()));
        let route = db
            .get_route_decision("route-decision:ask:ledger-ask-1")
            .unwrap()
            .unwrap();
        assert_eq!(route.selected_lane, WorkLane::DeepSeek);
        let links = db.list_mission_links("mission-runtime").unwrap();
        assert!(links.iter().any(|link| {
            link.link_kind == friday_core::MissionLinkKind::ProviderTimeline
                && link.target_ref == "friday://provider-timeline/friday-hub-session#ledger-ask-1"
                && link.proof_ref.as_deref() == Some("friday://activity/activity-ask-1")
        }));
    }

    #[test]
    fn mission_bound_ask_mints_typed_outcome_receipt_when_required() {
        let _guard =
            crate::test_env::EnvVarGuard::set(friday_core::OUTCOME_CHECKED_PROOF_FLAG, "1");
        let mut db = Db::open_hub(&tmp("ask-outcome-proof")).unwrap();
        seed_work_item(
            &db,
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );
        let mut work_item = db.get_work_item("work-runtime").unwrap().unwrap();
        work_item.proof_requirements = vec!["outcome:AnswerProduced:>=1".into()];
        db.upsert_work_item(&work_item).unwrap();
        let gets = Rc::new(Cell::new(0));
        let posts = Rc::new(Cell::new(0));
        let client = deepseek_client(gets.clone(), posts.clone());

        let outcome = ask_friday_for_mission(
            &mut db,
            &client,
            lookup(),
            "ledger-ask-outcome-1",
            "friday-hub-session",
            "activity-ask-outcome-1",
            "what next?",
            64,
            7,
        )
        .unwrap();

        let MissionBoundAskOutcome::Answered {
            result_link,
            attachment,
            ..
        } = outcome
        else {
            panic!("expected mission-bound ask answer");
        };
        assert_eq!(result_link, "friday://activity/activity-ask-outcome-1");
        assert!(matches!(
            attachment,
            MissionAttachmentOutcome::Attached {
                work_item_status: WorkItemStatus::CompletedWithProof,
                ..
            }
        ));
        let work_item = db.get_work_item("work-runtime").unwrap().unwrap();
        assert_eq!(work_item.status, WorkItemStatus::CompletedWithProof);
        let result_ref = friday_storage::get_run_result_ref(db.conn(), "ledger-ask-outcome-1")
            .unwrap()
            .unwrap();
        assert_eq!(result_ref.answer_len, 18);
        assert_eq!(
            work_item.proof_receipts,
            vec![format!(
                "proof://outcome/AnswerProduced/ledger-ask-outcome-1?signal=answer_sha256={};answer_len={}",
                result_ref.answer_sha256, result_ref.answer_len
            )]
        );
        assert!(!work_item
            .proof_receipts
            .contains(&"friday://activity/activity-ask-outcome-1".to_string()));
        let mission = db.get_mission("mission-runtime").unwrap().unwrap();
        assert!(mission
            .proof_refs
            .contains(&"friday://activity/activity-ask-outcome-1".to_string()));
        let links = db.list_mission_links("mission-runtime").unwrap();
        assert!(links.iter().any(|link| {
            link.link_kind == friday_core::MissionLinkKind::ProviderTimeline
                && link.target_ref
                    == "friday://provider-timeline/friday-hub-session#ledger-ask-outcome-1"
                && link.proof_ref.as_deref() == Some("friday://activity/activity-ask-outcome-1")
        }));
        assert_eq!(gets.get(), 1);
        assert_eq!(posts.get(), 1);
    }

    // ===================== WI-1 (M-6) guarded transition — PRODUCTION caller shape =============

    /// Count the hash-chained `audit_ledger` lifecycle rows the guarded primitive writes.
    fn lifecycle_audit_rows(db: &Db) -> i64 {
        db.conn()
            .query_row(
                "SELECT COUNT(*) FROM audit_ledger WHERE action LIKE 'work_item.lifecycle:%'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
    }

    /// The PRODUCTION caller shape: [`attach_agent_loop_provider_state`] drives ALL hops with a
    /// SINGLE `now_ms` (the one threaded from `runtime.rs`'s agent-loop seam). Under `guarded=true`
    /// this must NOT error/collide on the per-hop audit row — the run completes with proof AND the
    /// expected number of hash-chained audit rows, and the chain verifies. (A regression here would
    /// surface as an `Err` propagating out of the run, which is exactly what WI-1 must NOT do.)
    #[test]
    fn wi1_agent_loop_single_now_ms_completes_and_writes_chained_audit_rows() {
        let db = Db::open_hub(&tmp("wi1-loop-on")).unwrap();
        seed_work_item(
            &db,
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );
        let now = 1_700_000_111_000;

        let outcome = attach_agent_loop_provider_state(
            &db,
            "mission-runtime",
            "work-runtime",
            "friday-session-loop",
            "run-loop-1",
            AgentLoopProviderRestState::Completed,
            "friday://agent-run/run-loop-1",
            None,
            /* guarded = */ true,
            now,
        )
        .unwrap();

        assert!(
            matches!(
                outcome,
                MissionAttachmentOutcome::Attached {
                    work_item_status: WorkItemStatus::CompletedWithProof,
                    ..
                }
            ),
            "guarded agent-loop run must complete with proof, got {outcome:?}"
        );
        let item = db.get_work_item("work-runtime").unwrap().unwrap();
        assert_eq!(item.status, WorkItemStatus::CompletedWithProof);
        assert!(item
            .proof_receipts
            .contains(&"friday://agent-run/run-loop-1".to_string()));

        // WI-1 honesty pin: the ON-only `updated_at_ms` +offset is EXACTLY the documented value,
        // not an arbitrary drift. 5 status-changing hops are driven (idx 0..=4); each enters the
        // guarded branch and the primitive sets `updated_at_ms = base_now_ms + idx` (mission.rs).
        // The final hop is the CompletedWithProof transition at idx=4, so the persisted WorkItem
        // `updated_at_ms` MUST equal base_now_ms + 4. A future change can't silently widen it.
        let final_hop_idx = 4;
        assert_eq!(
            item.updated_at_ms,
            now + final_hop_idx,
            "ON-path WorkItem updated_at_ms must be the base now_ms + final hop index, not a wider drift"
        );

        // 5 legal hops (ReadyToDispatch → … → CompletedWithProof) ⇒ 5 lifecycle audit rows,
        // each with a DISTINCT audit_id despite the single caller-side now_ms, and the chain verifies.
        assert_eq!(lifecycle_audit_rows(&db), 5);
        assert_eq!(
            verify_audit_chain(db.conn()).unwrap(),
            6,
            "5 WorkItem lifecycle rows + 1 mission auto-close row (M2: the active->done auto-close now also chains its own receipt); the whole chain verifies"
        );
    }

    /// Same production shape, flag OFF: byte-identical to pre-WI-1 — completes with proof and
    /// writes NO lifecycle audit row from the guarded primitive.
    #[test]
    fn wi1_agent_loop_single_now_ms_flag_off_writes_no_audit_row() {
        let db = Db::open_hub(&tmp("wi1-loop-off")).unwrap();
        seed_work_item(
            &db,
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );
        let now = 1_700_000_222_000;

        let outcome = attach_agent_loop_provider_state(
            &db,
            "mission-runtime",
            "work-runtime",
            "friday-session-loop",
            "run-loop-2",
            AgentLoopProviderRestState::Completed,
            "friday://agent-run/run-loop-2",
            None,
            /* guarded = */ false,
            now,
        )
        .unwrap();

        assert!(matches!(
            outcome,
            MissionAttachmentOutcome::Attached {
                work_item_status: WorkItemStatus::CompletedWithProof,
                ..
            }
        ));
        assert_eq!(
            db.get_work_item("work-runtime").unwrap().unwrap().status,
            WorkItemStatus::CompletedWithProof
        );
        assert_eq!(lifecycle_audit_rows(&db), 0);
    }

    // ===================== resume → WorkItem-completion: pure (no-signing) seams ===============

    #[test]
    fn provider_timeline_session_parser_extracts_session_or_none() {
        // The canonical pause-time shape: session is between the prefix and the LAST '#'.
        assert_eq!(
            provider_timeline_session_from_target(
                "friday://provider-timeline/friday-hub-session#run-1"
            )
            .as_deref(),
            Some("friday-hub-session")
        );
        // A session is allowed to contain '#'? No — we split on the LAST '#', so a session with an
        // embedded '#' keeps the left part; the run_id is always the final segment (run ids have
        // no '#'). This documents the rsplit behavior.
        assert_eq!(
            provider_timeline_session_from_target("friday://provider-timeline/a#b#run-1")
                .as_deref(),
            Some("a#b")
        );
        // Not the provider-timeline shape ⇒ None (the wrong prefix / no '#').
        assert_eq!(
            provider_timeline_session_from_target("friday://agent-run/run-1"),
            None
        );
        assert_eq!(
            provider_timeline_session_from_target("friday://provider-timeline/run-1"),
            None,
            "no '#' ⇒ not the bound shape"
        );
        assert_eq!(
            provider_timeline_session_from_target("friday://provider-timeline/#run-1"),
            None,
            "empty session ⇒ None"
        );
    }

    /// The run-id resolver matches the EXACT trailing '#'-segment and fail-closes on zero / ambiguous
    /// matches — the cross-mission injection defense, exercised WITHOUT any signing (a pure storage
    /// property). Seeds two provider_timeline links sharing a run_id SUFFIX and asserts exact match.
    #[test]
    fn resolve_provider_timeline_link_by_run_id_is_exact_and_fail_closed() {
        let db = Db::open_hub(&tmp("resolve-runid")).unwrap();
        // Reuse the existing seed helper (mission-runtime / work-runtime) for the first link...
        seed_work_item(
            &db,
            WorkLane::DeepSeek,
            Some("deepseek"),
            WorkItemStatus::ReadyToDispatch,
        );
        // Drive RoutedToProvider for run "run-z" (writes the pause-time link target_ref).
        attach_agent_loop_provider_state(
            &db,
            "mission-runtime",
            "work-runtime",
            "sess-z",
            "run-z",
            AgentLoopProviderRestState::Routed,
            "friday://agent-run/run-z",
            None,
            /* guarded = */ false,
            10,
        )
        .unwrap();

        // EXACT match: "run-z" resolves to the bound work-runtime link.
        let link = db
            .find_provider_timeline_link_by_run_id("run-z")
            .unwrap()
            .expect("run-z must resolve its own link");
        assert_eq!(link.work_item_id.as_deref(), Some("work-runtime"));
        assert_eq!(link.target_ref, "friday://provider-timeline/sess-z#run-z");

        // SUPERSTRING must NOT match (exact trailing-segment): a search for "z" or "n-z" finds nothing.
        assert!(db
            .find_provider_timeline_link_by_run_id("z")
            .unwrap()
            .is_none());
        assert!(db
            .find_provider_timeline_link_by_run_id("n-z")
            .unwrap()
            .is_none());
        // An unrelated run resolves to nothing.
        assert!(db
            .find_provider_timeline_link_by_run_id("run-absent")
            .unwrap()
            .is_none());
    }
}
