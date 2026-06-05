//! Mission-bound runtime producer wrappers.
//!
//! `mission_context` resolves refs into the canonical Mission graph; this module is
//! the next Hub boundary: channel/workflow producers must acquire a validated
//! `MissionRuntimeEnvelope` before recording or executing live work. The low-level
//! channel/workflow functions remain useful substrates, but product entrypoints
//! should call these wrappers so detached channel events or workflow runs cannot
//! masquerade as Friday work.

use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
use friday_core::{Risk, RouteDecisionCard, WorkLane};
use friday_crypto::SecureStore;
use friday_deepseek::{DeepSeekClient, Transport};
use friday_storage::channel::get_channel;
use friday_storage::{Db, StorageError};

use crate::channel_event::{channel_event_id, ingest_channel_inbound, ChannelInboundReceipt};
use crate::channels::{redact_inbound, resolve_and_verify, InboundRejection, RedactedInbound};
use crate::mission_context::{
    resolve_mission_context, route_decision_card_for_context, MissionContextLookup,
    MissionContextResolution, ResolvedMissionContext,
};
use crate::mission_preflight::{
    attach_channel_inbound_receipt, attach_provider_timeline_state, attach_workflow_run_ref,
    MissionAttachmentOutcome, ProviderTimelineAttachment,
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

    record_friday_ask(
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
    let attachment = attach_completed_provider_state_for_ask(
        db,
        &envelope.context.mission_id,
        &envelope.context.work_item_id,
        session_id,
        ledger_id,
        &proof_ref,
        now_ms,
    )
    .map_err(RecordAskError::Storage)?;

    Ok(MissionBoundAskOutcome::Answered {
        envelope,
        ledger_id: ledger_id.to_string(),
        result_link: proof_ref,
        attachment,
    })
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
    mission_id: &str,
    work_item_id: &str,
    session_id: &str,
    ledger_id: &str,
    proof_ref: &str,
    now_ms: i64,
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
        last = attach_provider_timeline_state(
            db,
            ProviderTimelineAttachment {
                mission_id: mission_id.to_string(),
                work_item_id: work_item_id.to_string(),
                friday_session_id: session_id.to_string(),
                request_id: ledger_id.to_string(),
                state,
                proof_ref: (state == PendingState::ProviderCompleted)
                    .then(|| proof_ref.to_string()),
                now_ms,
            },
        )?;
        if matches!(last, MissionAttachmentOutcome::Blocked { .. }) {
            return Ok(last);
        }
    }
    Ok(last)
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
}
