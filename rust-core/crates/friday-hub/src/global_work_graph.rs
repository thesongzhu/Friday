//! Hub-owned global work graph, adoption, and advisor preflight.
//!
//! This module is deliberately read-model-first. It discovers only from Hub
//! storage metadata and proof refs, emits redacted refs, and never scans process
//! contents, controls providers, kills processes, confirms memory, or claims
//! provider-native sync.

use std::collections::{BTreeMap, BTreeSet};

use friday_core::{
    AdoptionCommandResult, AdoptionCommandStatus, AdoptionProposal, AdoptionProposalStatus,
    AdvisorPreflight, AdvisorRecommendation, ApprovalState, ClaimState, GlobalWorkGraphSnapshot,
    LeaseState, MissionLink, MissionLinkKind, OwnershipStatus, ProcessKind, RouteDecisionCard,
    SyncMode, WorkGraphConflict, WorkGraphConflictKind, WorkGraphConflictSeverity, WorkGraphNode,
    WorkGraphNodeKind, WorkGraphTruthLabel, WorkItem, WorkLane,
};
use friday_storage::{channel, Db, StorageError};

type AdoptedTargetLinks = BTreeMap<String, (String, Option<String>, Option<String>)>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdoptionProposalRequest {
    pub observed_node_ref: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub now_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdoptionCommand {
    pub proposal_ref: String,
    pub observed_node_ref: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub operator_confirmed: bool,
    pub operator_confirmation_ref: Option<String>,
    pub now_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdvisorPreflightRequest {
    pub friday_conversation_id: String,
    pub candidate_mission_intent: String,
    pub existing_mission_id: Option<String>,
    pub candidate_lane: WorkLane,
    pub target_provider_or_agent: Option<String>,
    pub workspace_refs: Vec<String>,
    pub port_bindings: Vec<String>,
    pub includes_sensitive_context: bool,
    pub risk_level: friday_core::Risk,
    pub approval_state: ApprovalState,
    pub observed_node_ref: Option<String>,
}

pub fn discover_global_work_graph(
    db: &Db,
    now_ms: i64,
) -> Result<GlobalWorkGraphSnapshot, StorageError> {
    let active_missions = db.list_active_missions()?;
    let active_work_items = db.list_active_work_items()?;
    let adopted_targets = adopted_target_links(db, &active_missions)?;
    let mut nodes = Vec::new();

    for mission in &active_missions {
        nodes.push(WorkGraphNode {
            node_ref: redacted_ref("mission", &mission.mission_id),
            kind: WorkGraphNodeKind::Mission,
            truth_label: WorkGraphTruthLabel::FridayOwned,
            mission_id: Some(mission.mission_id.clone()),
            work_item_id: None,
            lane: None,
            safe_title: mission.title.clone(),
            status_label: mission.status.as_str().to_string(),
            evidence_refs: vec![redacted_ref("mission", &mission.mission_id)],
            proof_refs: filter_safe_refs(&mission.proof_refs),
            blockers: Vec::new(),
            control_allowed: true,
            updated_at_ms: mission.updated_at_ms,
        });

        for memory_ref in &mission.memory_candidate_refs {
            nodes.push(WorkGraphNode {
                node_ref: redacted_ref("memory-candidate", memory_ref),
                kind: WorkGraphNodeKind::MemoryCandidate,
                truth_label: WorkGraphTruthLabel::ObservedOnly,
                mission_id: Some(mission.mission_id.clone()),
                work_item_id: None,
                lane: None,
                safe_title: "memory candidate".to_string(),
                status_label: "review_only".to_string(),
                evidence_refs: vec![redacted_ref("memory-candidate", memory_ref)],
                proof_refs: Vec::new(),
                blockers: vec!["candidate_memory_is_not_confirmed_memory".to_string()],
                control_allowed: false,
                updated_at_ms: mission.updated_at_ms,
            });
        }

        for proof_ref in &mission.proof_refs {
            if let Some(safe_ref) = safe_ref(proof_ref) {
                nodes.push(WorkGraphNode {
                    node_ref: redacted_ref("proof-receipt", &safe_ref),
                    kind: WorkGraphNodeKind::ProofReceipt,
                    truth_label: WorkGraphTruthLabel::FridayOwned,
                    mission_id: Some(mission.mission_id.clone()),
                    work_item_id: None,
                    lane: None,
                    safe_title: "proof receipt".to_string(),
                    status_label: "proof_ref".to_string(),
                    evidence_refs: vec![safe_ref.clone()],
                    proof_refs: vec![safe_ref],
                    blockers: Vec::new(),
                    control_allowed: false,
                    updated_at_ms: mission.updated_at_ms,
                });
            }
        }
    }

    for item in &active_work_items {
        nodes.push(WorkGraphNode {
            node_ref: redacted_ref("work-item", &item.work_item_id),
            kind: WorkGraphNodeKind::WorkItem,
            truth_label: WorkGraphTruthLabel::FridayOwned,
            mission_id: Some(item.mission_id.clone()),
            work_item_id: Some(item.work_item_id.clone()),
            lane: Some(item.lane),
            safe_title: item.judgment_memory.task.clone(),
            status_label: item.status.as_str().to_string(),
            evidence_refs: redacted_vec("work-input", &item.input_refs),
            proof_refs: filter_safe_refs(&item.proof_receipts),
            blockers: if item.completion_is_proven() {
                Vec::new()
            } else {
                vec!["work_item_not_completed_with_proof".to_string()]
            },
            control_allowed: true,
            updated_at_ms: item.updated_at_ms,
        });
    }

    for claim in db.list_active_workspace_claims()? {
        let kind = match claim.claim_kind {
            friday_core::WorkspaceClaimKind::Worktree => WorkGraphNodeKind::Worktree,
            friday_core::WorkspaceClaimKind::Port => WorkGraphNodeKind::Port,
            friday_core::WorkspaceClaimKind::Process => WorkGraphNodeKind::Process,
            friday_core::WorkspaceClaimKind::ProviderSession => {
                WorkGraphNodeKind::ProviderAppSession
            }
            _ => WorkGraphNodeKind::Worktree,
        };
        let mut node = WorkGraphNode {
            node_ref: redacted_ref("workspace-claim", &claim.claim_id),
            kind,
            truth_label: claim_truth_label(claim.state),
            mission_id: Some(claim.mission_id.clone()),
            work_item_id: claim.work_item_id.clone(),
            lane: None,
            safe_title: claim.claim_kind.as_str().to_string(),
            status_label: claim.state.as_str().to_string(),
            evidence_refs: vec![
                redacted_ref("workspace-claim", &claim.claim_id),
                redacted_ref("workspace-ref", &claim.workspace_ref),
            ],
            proof_refs: filter_safe_refs(&claim.proof_refs),
            blockers: claim_blockers(claim.state),
            control_allowed: claim.state == ClaimState::Active,
            updated_at_ms: claim.updated_at_ms,
        };
        mark_adopted_if_linked(&mut node, &adopted_targets);
        nodes.push(node);
    }

    for lease in db.list_active_process_leases()? {
        let mut node = WorkGraphNode {
            node_ref: redacted_ref("process-lease", &lease.lease_id),
            kind: process_kind_to_node_kind(lease.process_kind),
            truth_label: WorkGraphTruthLabel::FridayOwned,
            mission_id: Some(lease.mission_id.clone()),
            work_item_id: lease.work_item_id.clone(),
            lane: None,
            safe_title: lease.process_kind.as_str().to_string(),
            status_label: lease.state.as_str().to_string(),
            evidence_refs: process_lease_evidence_refs(&lease),
            proof_refs: filter_safe_refs(&lease.proof_refs),
            blockers: lease_blockers(lease.state),
            control_allowed: lease.can_request_stop(),
            updated_at_ms: lease.updated_at_ms,
        };
        mark_adopted_if_linked(&mut node, &adopted_targets);
        nodes.push(node);

        for binding in &lease.port_bindings {
            let port_ref = redacted_ref("port-binding", binding);
            let mut port_node = WorkGraphNode {
                node_ref: port_ref.clone(),
                kind: WorkGraphNodeKind::Port,
                truth_label: WorkGraphTruthLabel::FridayOwned,
                mission_id: Some(lease.mission_id.clone()),
                work_item_id: lease.work_item_id.clone(),
                lane: None,
                safe_title: "port listener".to_string(),
                status_label: lease.state.as_str().to_string(),
                evidence_refs: vec![port_ref],
                proof_refs: filter_safe_refs(&lease.proof_refs),
                blockers: lease_blockers(lease.state),
                control_allowed: lease.can_request_stop(),
                updated_at_ms: lease.updated_at_ms,
            };
            mark_adopted_if_linked(&mut port_node, &adopted_targets);
            nodes.push(port_node);
        }
    }

    for observation in db.list_process_observations()? {
        let mut node = WorkGraphNode::observed(
            redacted_ref("process-observation", &observation.observation_id),
            process_kind_to_node_kind(observation.process_kind),
            observation.observed_at_ms,
        );
        node.safe_title = observation.process_kind.as_str().to_string();
        node.status_label = observation.ownership_status.as_str().to_string();
        node.truth_label = observation_truth_label(observation.ownership_status);
        node.evidence_refs = process_observation_evidence_refs(&observation);
        node.control_allowed = observation.is_control_allowed_without_adoption();
        if node.truth_label != WorkGraphTruthLabel::FridayOwned {
            node.blockers = vec!["operator_adoption_required_before_control".to_string()];
        }
        mark_adopted_if_linked(&mut node, &adopted_targets);
        nodes.push(node);
    }

    for projection in db.list_provider_session_projections()? {
        let mut blockers = vec!["provider_session_is_execution_lane_not_mission_truth".to_string()];
        let truth_label = match projection.sync_mode {
            SyncMode::ProviderAppServerLocal | SyncMode::FridayLocalMirror => {
                WorkGraphTruthLabel::ObservedOnly
            }
            SyncMode::ProviderNativeLinkOnly | SyncMode::UnsupportedTruthLabeled => {
                blockers.push("insufficient_official_provider_sync_proof".to_string());
                WorkGraphTruthLabel::LinkedOnly
            }
            SyncMode::ProviderNativeSynced => {
                blockers.push("native_sync_claim_not_used_without_live_proof".to_string());
                WorkGraphTruthLabel::LinkedOnly
            }
        };
        let mut node = WorkGraphNode {
            node_ref: redacted_ref("provider-session", &projection.friday_session_id),
            kind: provider_to_node_kind(&projection.provider),
            truth_label,
            mission_id: None,
            work_item_id: None,
            lane: provider_to_lane(&projection.provider),
            safe_title: format!("{} provider session", projection.provider),
            status_label: "truth_labeled_provider_link".to_string(),
            evidence_refs: vec![
                redacted_ref("provider-session", &projection.friday_session_id),
                redacted_ref("provider-workspace", &projection.workspace_id),
            ],
            proof_refs: Vec::new(),
            blockers,
            control_allowed: false,
            updated_at_ms: projection.last_provider_seen_at.unwrap_or(now_ms),
        };
        mark_adopted_if_linked(&mut node, &adopted_targets);
        nodes.push(node);
    }

    for row in channel::list_channels(db.conn())? {
        nodes.push(WorkGraphNode {
            node_ref: redacted_ref("channel-binding", &row.channel_id),
            kind: WorkGraphNodeKind::ChannelTask,
            truth_label: WorkGraphTruthLabel::LinkedOnly,
            mission_id: None,
            work_item_id: None,
            lane: Some(WorkLane::Channel),
            safe_title: format!("{} channel", row.kind.as_str()),
            status_label: row.status.as_str().to_string(),
            evidence_refs: vec![redacted_ref("channel-binding", &row.channel_id)],
            proof_refs: Vec::new(),
            blockers: vec!["channel_is_ambient_door_not_canonical_owner".to_string()],
            control_allowed: false,
            updated_at_ms: row.created_at,
        });
    }

    for mission in &active_missions {
        for link in db.list_mission_links(&mission.mission_id)? {
            match link.link_kind {
                MissionLinkKind::WorkflowRun => {
                    nodes.push(WorkGraphNode {
                        node_ref: redacted_ref("workflow-run", &link.target_ref),
                        kind: WorkGraphNodeKind::WorkflowRun,
                        truth_label: WorkGraphTruthLabel::FridayOwned,
                        mission_id: Some(link.mission_id),
                        work_item_id: link.work_item_id,
                        lane: Some(WorkLane::Workflow),
                        safe_title: "workflow run".to_string(),
                        status_label: "linked_to_mission".to_string(),
                        evidence_refs: vec![redacted_ref("workflow-run", &link.target_ref)],
                        proof_refs: filter_safe_refs(
                            &link.proof_ref.into_iter().collect::<Vec<_>>(),
                        ),
                        blockers: vec!["workflow_run_status_is_not_completion_proof".to_string()],
                        control_allowed: false,
                        updated_at_ms: link.created_at_ms,
                    });
                }
                MissionLinkKind::ProviderSession => {
                    nodes.push(WorkGraphNode {
                        node_ref: redacted_ref("provider-session-link", &link.target_ref),
                        kind: WorkGraphNodeKind::ProviderAppSession,
                        truth_label: WorkGraphTruthLabel::FridayOwned,
                        mission_id: Some(link.mission_id),
                        work_item_id: link.work_item_id,
                        lane: None,
                        safe_title: "provider session link".to_string(),
                        status_label: "mission_evidence_link".to_string(),
                        evidence_refs: vec![redacted_ref(
                            "provider-session-link",
                            &link.target_ref,
                        )],
                        proof_refs: filter_safe_refs(
                            &link.proof_ref.into_iter().collect::<Vec<_>>(),
                        ),
                        blockers: vec![
                            "provider_ack_or_timeline_read_is_not_completion".to_string()
                        ],
                        control_allowed: false,
                        updated_at_ms: link.created_at_ms,
                    });
                }
                _ => {}
            }
        }
    }

    let conflicts = detect_snapshot_conflicts(db, &active_missions, &active_work_items, &nodes)?;
    Ok(GlobalWorkGraphSnapshot {
        generated_at_ms: now_ms,
        nodes,
        conflicts,
        truth_labels: vec![
            WorkGraphTruthLabel::FridayOwned,
            WorkGraphTruthLabel::FridayAdopted,
            WorkGraphTruthLabel::ObservedOnly,
            WorkGraphTruthLabel::LinkedOnly,
            WorkGraphTruthLabel::Unknown,
        ],
        no_go: vec![
            "no_unproven_provider_native_sync_claim".to_string(),
            "no_auto_kill_cleanup_or_control".to_string(),
            "no_raw_commands_provider_ids_channel_ids_private_paths_or_transcripts".to_string(),
            "observed_only_is_not_owned".to_string(),
            "process_exit_or_provider_ack_is_not_done".to_string(),
        ],
    })
}

pub fn propose_work_adoption(
    db: &Db,
    request: AdoptionProposalRequest,
) -> Result<AdoptionProposal, StorageError> {
    let proposal_ref = adoption_proposal_ref(&request.observed_node_ref, &request.mission_id);
    let Some(mission) = db.get_mission(&request.mission_id)? else {
        return Ok(blocked_proposal(
            proposal_ref,
            request,
            "unknown_mission",
            WorkGraphTruthLabel::Unknown,
        ));
    };
    let Some(work_item) = db.get_work_item(&request.work_item_id)? else {
        return Ok(blocked_proposal(
            proposal_ref,
            request,
            "unknown_work_item",
            WorkGraphTruthLabel::Unknown,
        ));
    };
    if work_item.mission_id != mission.mission_id {
        return Ok(blocked_proposal(
            proposal_ref,
            request,
            "work_item_mission_mismatch",
            WorkGraphTruthLabel::Unknown,
        ));
    }

    let snapshot = discover_global_work_graph(db, request.now_ms)?;
    let Some(node) = snapshot
        .nodes
        .iter()
        .find(|node| node.node_ref == request.observed_node_ref)
    else {
        return Ok(blocked_proposal(
            proposal_ref,
            request,
            "observed_node_not_found",
            WorkGraphTruthLabel::Unknown,
        ));
    };

    if node.truth_label == WorkGraphTruthLabel::FridayOwned
        || node.truth_label == WorkGraphTruthLabel::FridayAdopted
    {
        return Ok(blocked_proposal(
            proposal_ref,
            request,
            "node_already_owned_or_adopted",
            node.truth_label,
        ));
    }

    if node.truth_label == WorkGraphTruthLabel::Unknown {
        return Ok(blocked_proposal(
            proposal_ref,
            request,
            "unknown_signal_requires_stronger_metadata_before_adoption",
            node.truth_label,
        ));
    }

    Ok(AdoptionProposal {
        proposal_ref,
        observed_node_ref: node.node_ref.clone(),
        mission_id: mission.mission_id,
        work_item_id: work_item.work_item_id,
        status: AdoptionProposalStatus::Proposed,
        truth_before: node.truth_label,
        proposed_truth_after: WorkGraphTruthLabel::FridayAdopted,
        why_may_belong: vec![
            "external signal has Hub-visible metadata/proof refs".to_string(),
            "operator can attach it to an existing Mission/WorkItem without creating duplicate work".to_string(),
            "adoption records evidence but does not grant process/provider control".to_string(),
        ],
        required_operator_action: "confirm_adoption_with_operator_confirmation_ref".to_string(),
        blockers: node.blockers.clone(),
        proof_requirements: vec![
            "operator_confirmation_ref".to_string(),
            "existing_mission_id".to_string(),
            "existing_work_item_id".to_string(),
        ],
        control_granted: false,
    })
}

pub fn adopt_observed_work(
    db: &Db,
    command: AdoptionCommand,
) -> Result<AdoptionCommandResult, StorageError> {
    let proposal = propose_work_adoption(
        db,
        AdoptionProposalRequest {
            observed_node_ref: command.observed_node_ref.clone(),
            mission_id: command.mission_id.clone(),
            work_item_id: command.work_item_id.clone(),
            now_ms: command.now_ms,
        },
    )?;
    if proposal.status != AdoptionProposalStatus::Proposed {
        return Ok(blocked_adoption(command, proposal.blockers));
    }
    if command.proposal_ref != proposal.proposal_ref {
        return Ok(blocked_adoption(
            command,
            vec!["proposal_ref_mismatch".to_string()],
        ));
    }
    if !command.operator_confirmed {
        return Ok(blocked_adoption(
            command,
            vec!["operator_confirmation_required".to_string()],
        ));
    }
    let Some(operator_ref) = command
        .operator_confirmation_ref
        .as_deref()
        .and_then(safe_ref)
    else {
        return Ok(blocked_adoption(
            command,
            vec!["safe_operator_confirmation_ref_required".to_string()],
        ));
    };

    let work_item = db
        .get_work_item(&command.work_item_id)?
        .ok_or_else(|| StorageError::Unsupported("adoption work item disappeared".into()))?;
    let adoption_ref = adoption_target_ref(&command.observed_node_ref);
    let decision_id = format!(
        "adopt_{}",
        stable_hash(&format!("{}:{}", command.proposal_ref, operator_ref))
    );
    let route_card = RouteDecisionCard {
        decision_id: decision_id.clone(),
        mission_id: command.mission_id.clone(),
        work_item_id: command.work_item_id.clone(),
        selected_lane: work_item.lane,
        selected_provider_or_agent: work_item.target_provider_or_agent.clone(),
        why_this_route: "Operator confirmed adoption of external observed work into an existing Mission/WorkItem.".to_string(),
        considered_options: vec![
            "keep observed-only".to_string(),
            "create a duplicate Mission".to_string(),
            "attach to existing Mission".to_string(),
        ],
        deferred_options: vec!["process/provider control without separate proof".to_string()],
        previous_pitfalls: vec!["observed work is not Friday-owned work".to_string()],
        inheritable_context: vec!["adoption is evidence/linking only".to_string()],
        conflict_refs: proposal.blockers.clone(),
        proof_requirements: proposal.proof_requirements.clone(),
        ownership_claim_ids: work_item.owner_claim_ids.clone(),
        trace_refs: vec![adoption_ref.clone(), operator_ref.clone()],
        action_items: vec![],
        created_at_ms: command.now_ms,
        expires_at_ms: None,
    };
    db.upsert_route_decision(&route_card)?;

    let link_id = format!("mlink_adoption_{}", stable_hash(&adoption_ref));
    db.upsert_mission_link(&MissionLink {
        link_id: link_id.clone(),
        mission_id: command.mission_id.clone(),
        work_item_id: Some(command.work_item_id.clone()),
        link_kind: MissionLinkKind::HandoffArtifact,
        target_ref: adoption_ref.clone(),
        proof_ref: Some(operator_ref),
        created_at_ms: command.now_ms,
    })?;

    Ok(AdoptionCommandResult {
        status: AdoptionCommandStatus::Adopted,
        adoption_ref: Some(adoption_ref),
        mission_id: command.mission_id,
        work_item_id: command.work_item_id,
        truth_label: WorkGraphTruthLabel::FridayAdopted,
        mission_link_ref: Some(format!("friday://mission-link/{link_id}")),
        route_decision_ref: Some(route_card.route_decision_ref()),
        control_granted: false,
        blockers: Vec::new(),
    })
}

pub fn advisor_preflight(
    db: &Db,
    request: AdvisorPreflightRequest,
) -> Result<AdvisorPreflight, StorageError> {
    let snapshot = discover_global_work_graph(db, 0)?;
    if let Some(observed_ref) = request.observed_node_ref.as_deref() {
        if let Some(node) = snapshot.nodes.iter().find(|n| n.node_ref == observed_ref) {
            if !matches!(
                node.truth_label,
                WorkGraphTruthLabel::FridayOwned | WorkGraphTruthLabel::FridayAdopted
            ) {
                return Ok(AdvisorPreflight {
                    recommendation: AdvisorRecommendation::KeepObservedOnly,
                    mission_id: None,
                    work_item_id: None,
                    blockers: vec!["operator_adoption_required_before_dispatch".to_string()],
                    questions: vec![
                        "Should Friday adopt this signal into an existing Mission?".to_string()
                    ],
                    conflict_refs: vec![node.node_ref.clone()],
                    duplicate_mission_id: None,
                    duplicate_work_item_id: None,
                    proof_requirements: vec!["operator_confirmation_ref".to_string()],
                    truth_summary: truth_summary(&snapshot),
                });
            }
        }
    }

    let duplicate_mission = db
        .list_missions_for_conversation(&request.friday_conversation_id)?
        .into_iter()
        .find(|mission| {
            mission.status.is_active_like() && mission.intent == request.candidate_mission_intent
        });

    let mut duplicate_work_item_id = None;
    if let Some(mission) = duplicate_mission.as_ref() {
        duplicate_work_item_id = db
            .list_work_items_for_mission(&mission.mission_id)?
            .into_iter()
            .find(|item| {
                item.is_active_like()
                    && item.lane == request.candidate_lane
                    && item.target_provider_or_agent == request.target_provider_or_agent
            })
            .map(|item| item.work_item_id);
    }

    let mut blocking_conflicts = Vec::new();
    for workspace_ref in &request.workspace_refs {
        if let Some(claim) = db.find_active_workspace_conflict(workspace_ref)? {
            blocking_conflicts.push(redacted_ref("workspace-claim", &claim.claim_id));
        }
    }
    for port in &request.port_bindings {
        if let Some(lease) = db.find_active_port_conflict(port)? {
            blocking_conflicts.push(redacted_ref("process-lease", &lease.lease_id));
        }
    }
    if !blocking_conflicts.is_empty() {
        return Ok(AdvisorPreflight {
            recommendation: AdvisorRecommendation::BlockDueToConflict,
            mission_id: duplicate_mission
                .as_ref()
                .map(|mission| mission.mission_id.clone())
                .or(request.existing_mission_id),
            work_item_id: duplicate_work_item_id,
            blockers: vec!["active_workspace_or_port_conflict".to_string()],
            questions: vec![
                "Resolve or explicitly adopt the existing claim before dispatch.".to_string(),
            ],
            conflict_refs: blocking_conflicts,
            duplicate_mission_id: duplicate_mission.as_ref().map(|m| m.mission_id.clone()),
            duplicate_work_item_id: None,
            proof_requirements: vec!["workspace_or_port_resolution_proof".to_string()],
            truth_summary: truth_summary(&snapshot),
        });
    }

    if let Some(mission) = duplicate_mission {
        return Ok(AdvisorPreflight {
            recommendation: if request.existing_mission_id.as_deref() == Some(&mission.mission_id) {
                AdvisorRecommendation::ContinueExistingMission
            } else {
                AdvisorRecommendation::MergeOrAttachToExistingMission
            },
            mission_id: Some(mission.mission_id.clone()),
            work_item_id: duplicate_work_item_id.clone(),
            blockers: vec!["duplicate_active_mission_before_new_work".to_string()],
            questions: vec![
                "Continue the existing Mission instead of creating duplicate task debt?"
                    .to_string(),
            ],
            conflict_refs: snapshot
                .conflicts
                .iter()
                .filter(|c| c.conflict_kind == WorkGraphConflictKind::DuplicateMission)
                .map(|c| c.conflict_ref.clone())
                .collect(),
            duplicate_mission_id: Some(mission.mission_id),
            duplicate_work_item_id,
            proof_requirements: vec!["operator_route_decision".to_string()],
            truth_summary: truth_summary(&snapshot),
        });
    }

    if friday_core::requires_context_passport(
        request.candidate_lane,
        request.includes_sensitive_context,
    ) {
        return Ok(AdvisorPreflight {
            recommendation: AdvisorRecommendation::RequireContextPassport,
            mission_id: request.existing_mission_id,
            work_item_id: None,
            blockers: vec!["context_passport_required_for_sensitive_external_transfer".to_string()],
            questions: Vec::new(),
            conflict_refs: Vec::new(),
            duplicate_mission_id: None,
            duplicate_work_item_id: None,
            proof_requirements: vec!["context_passport_ref".to_string()],
            truth_summary: truth_summary(&snapshot),
        });
    }

    if request.approval_state == ApprovalState::Required
        || request.risk_level >= friday_core::Risk::High
    {
        return Ok(AdvisorPreflight {
            recommendation: AdvisorRecommendation::RequireOperatorApproval,
            mission_id: request.existing_mission_id,
            work_item_id: None,
            blockers: vec!["operator_approval_required_before_dispatch".to_string()],
            questions: Vec::new(),
            conflict_refs: Vec::new(),
            duplicate_mission_id: None,
            duplicate_work_item_id: None,
            proof_requirements: vec!["approval_receipt_ref".to_string()],
            truth_summary: truth_summary(&snapshot),
        });
    }

    Ok(AdvisorPreflight {
        recommendation: if request.existing_mission_id.is_some() {
            AdvisorRecommendation::Dispatch
        } else {
            AdvisorRecommendation::CreateNewMission
        },
        mission_id: request.existing_mission_id,
        work_item_id: None,
        blockers: Vec::new(),
        questions: Vec::new(),
        conflict_refs: Vec::new(),
        duplicate_mission_id: None,
        duplicate_work_item_id: None,
        proof_requirements: vec![
            "route_decision_card".to_string(),
            "proof_receipt".to_string(),
        ],
        truth_summary: truth_summary(&snapshot),
    })
}

fn detect_snapshot_conflicts(
    db: &Db,
    active_missions: &[friday_core::Mission],
    active_work_items: &[WorkItem],
    nodes: &[WorkGraphNode],
) -> Result<Vec<WorkGraphConflict>, StorageError> {
    let mut conflicts = Vec::new();
    let mut missions_by_intent: BTreeMap<(String, String), Vec<&friday_core::Mission>> =
        BTreeMap::new();
    for mission in active_missions {
        missions_by_intent
            .entry((
                mission.friday_conversation_id.clone(),
                mission.intent.clone(),
            ))
            .or_default()
            .push(mission);
    }
    for ((_, intent), missions) in missions_by_intent {
        if missions.len() > 1 {
            conflicts.push(WorkGraphConflict {
                conflict_ref: redacted_ref("conflict-duplicate-mission", &intent),
                conflict_kind: WorkGraphConflictKind::DuplicateMission,
                severity: WorkGraphConflictSeverity::Block,
                existing_mission_id: missions.first().map(|m| m.mission_id.clone()),
                existing_work_item_id: None,
                node_refs: missions
                    .iter()
                    .map(|m| redacted_ref("mission", &m.mission_id))
                    .collect(),
                summary: "duplicate active Mission intent".to_string(),
                proof_refs: Vec::new(),
            });
        }
    }

    let mut work_by_key: BTreeMap<(String, String, Option<String>), Vec<&WorkItem>> =
        BTreeMap::new();
    for item in active_work_items {
        work_by_key
            .entry((
                item.mission_id.clone(),
                item.lane.as_str().to_string(),
                item.target_provider_or_agent.clone(),
            ))
            .or_default()
            .push(item);
    }
    for ((mission_id, _, _), items) in work_by_key {
        if items.len() > 1 {
            conflicts.push(WorkGraphConflict {
                conflict_ref: redacted_ref("conflict-duplicate-work", &mission_id),
                conflict_kind: WorkGraphConflictKind::DuplicateWorkItem,
                severity: WorkGraphConflictSeverity::Block,
                existing_mission_id: Some(mission_id),
                existing_work_item_id: items.first().map(|item| item.work_item_id.clone()),
                node_refs: items
                    .iter()
                    .map(|item| redacted_ref("work-item", &item.work_item_id))
                    .collect(),
                summary: "duplicate active WorkItem route".to_string(),
                proof_refs: Vec::new(),
            });
        }
    }

    let mut workspace_refs: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for claim in db.list_active_workspace_claims()? {
        workspace_refs
            .entry(claim.workspace_ref)
            .or_default()
            .push(redacted_ref("workspace-claim", &claim.claim_id));
    }
    for (workspace_ref, refs) in workspace_refs {
        if refs.len() > 1 {
            conflicts.push(WorkGraphConflict {
                conflict_ref: redacted_ref("conflict-workspace", &workspace_ref),
                conflict_kind: WorkGraphConflictKind::WorkspaceClaim,
                severity: WorkGraphConflictSeverity::Block,
                existing_mission_id: None,
                existing_work_item_id: None,
                node_refs: refs,
                summary: "active workspace/worktree claim overlap".to_string(),
                proof_refs: Vec::new(),
            });
        }
    }

    let mut ports: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for lease in db.list_active_process_leases()? {
        for port in lease.port_bindings {
            ports
                .entry(port)
                .or_default()
                .push(redacted_ref("process-lease", &lease.lease_id));
        }
    }
    for observation in db.list_process_observations()? {
        if observation.ownership_status != OwnershipStatus::FridayOwnedClaimed {
            for port in observation.port_bindings {
                ports.entry(port).or_default().push(redacted_ref(
                    "process-observation",
                    &observation.observation_id,
                ));
            }
        }
    }
    for (port, refs) in ports {
        if refs.len() > 1 {
            conflicts.push(WorkGraphConflict {
                conflict_ref: redacted_ref("conflict-port", &port),
                conflict_kind: WorkGraphConflictKind::PortLease,
                severity: WorkGraphConflictSeverity::Block,
                existing_mission_id: None,
                existing_work_item_id: None,
                node_refs: refs,
                summary: "active or observed port overlap".to_string(),
                proof_refs: Vec::new(),
            });
        }
    }

    for node in nodes {
        if matches!(
            node.truth_label,
            WorkGraphTruthLabel::ObservedOnly
                | WorkGraphTruthLabel::LinkedOnly
                | WorkGraphTruthLabel::Unknown
        ) {
            conflicts.push(WorkGraphConflict {
                conflict_ref: redacted_ref("conflict-observed", &node.node_ref),
                conflict_kind: WorkGraphConflictKind::UnknownSignal,
                severity: WorkGraphConflictSeverity::Ask,
                existing_mission_id: node.mission_id.clone(),
                existing_work_item_id: node.work_item_id.clone(),
                node_refs: vec![node.node_ref.clone()],
                summary: "external signal is not owned by Friday".to_string(),
                proof_refs: Vec::new(),
            });
        }
    }

    Ok(conflicts)
}

fn adopted_target_links(
    db: &Db,
    active_missions: &[friday_core::Mission],
) -> Result<AdoptedTargetLinks, StorageError> {
    let mut out = BTreeMap::new();
    for mission in active_missions {
        for link in db.list_mission_links(&mission.mission_id)? {
            if link.link_kind == MissionLinkKind::HandoffArtifact
                && link.target_ref.starts_with("friday://adoption-target/")
            {
                out.insert(
                    link.target_ref,
                    (link.mission_id, link.work_item_id, link.proof_ref),
                );
            }
        }
    }
    Ok(out)
}

fn mark_adopted_if_linked(node: &mut WorkGraphNode, adopted_targets: &AdoptedTargetLinks) {
    if let Some((mission_id, work_item_id, proof_ref)) =
        adopted_targets.get(&adoption_target_ref(&node.node_ref))
    {
        node.truth_label = WorkGraphTruthLabel::FridayAdopted;
        node.mission_id = Some(mission_id.clone());
        node.work_item_id = work_item_id.clone();
        node.status_label = "adopted_read_only".to_string();
        node.control_allowed = false;
        node.blockers = vec!["adoption_does_not_grant_control".to_string()];
        if let Some(proof_ref) = proof_ref.as_deref().and_then(safe_ref) {
            node.proof_refs.push(proof_ref);
        }
    }
}

fn process_lease_evidence_refs(lease: &friday_core::ProcessLease) -> Vec<String> {
    let mut refs = vec![
        redacted_ref("process-lease", &lease.lease_id),
        redacted_ref("cwd-ref", &lease.cwd_ref),
    ];
    if let Some(command_ref) = lease.command_ref.as_deref() {
        refs.push(redacted_ref("command-ref", command_ref));
    }
    for port in &lease.port_bindings {
        refs.push(redacted_ref("port-binding", port));
    }
    refs
}

fn process_observation_evidence_refs(observation: &friday_core::ProcessObservation) -> Vec<String> {
    let mut refs = vec![
        redacted_ref("process-observation", &observation.observation_id),
        redacted_ref("cwd-ref", &observation.cwd_ref),
    ];
    if let Some(hash) = observation.command_hash.as_deref() {
        refs.push(redacted_ref("command-hash", hash));
    }
    for port in &observation.port_bindings {
        refs.push(redacted_ref("port-binding", port));
    }
    refs
}

fn claim_truth_label(state: ClaimState) -> WorkGraphTruthLabel {
    match state {
        ClaimState::Active => WorkGraphTruthLabel::FridayOwned,
        ClaimState::PendingAdoption | ClaimState::NeedsOwnerDecision => {
            WorkGraphTruthLabel::ObservedOnly
        }
        ClaimState::Released | ClaimState::Stale | ClaimState::Blocked => {
            WorkGraphTruthLabel::LinkedOnly
        }
    }
}

fn claim_blockers(state: ClaimState) -> Vec<String> {
    match state {
        ClaimState::Active => Vec::new(),
        ClaimState::PendingAdoption => vec!["operator_adoption_pending".to_string()],
        ClaimState::NeedsOwnerDecision => vec!["owner_decision_required".to_string()],
        ClaimState::Released => vec!["released_claim_is_historical".to_string()],
        ClaimState::Stale => vec!["claim_is_stale".to_string()],
        ClaimState::Blocked => vec!["claim_is_blocked".to_string()],
    }
}

fn lease_blockers(state: LeaseState) -> Vec<String> {
    match state {
        LeaseState::Claimed | LeaseState::Running | LeaseState::Healthy => {
            vec!["process_exit_is_not_completion".to_string()]
        }
        LeaseState::NeedsOwnerDecision => vec!["owner_decision_required".to_string()],
        LeaseState::StoppingRequested => vec!["stop_requested_is_not_stopped_proof".to_string()],
        LeaseState::StoppedWithProof => Vec::new(),
        LeaseState::Stale => vec!["lease_is_stale".to_string()],
        LeaseState::Blocked => vec!["lease_is_blocked".to_string()],
    }
}

fn observation_truth_label(status: OwnershipStatus) -> WorkGraphTruthLabel {
    match status {
        OwnershipStatus::FridayOwnedClaimed => WorkGraphTruthLabel::FridayOwned,
        OwnershipStatus::FridayOwnedLaunchd => WorkGraphTruthLabel::LinkedOnly,
        OwnershipStatus::ObservedUnowned
        | OwnershipStatus::UnownedAgentProcess
        | OwnershipStatus::UnownedFridayProcess => WorkGraphTruthLabel::ObservedOnly,
    }
}

fn process_kind_to_node_kind(kind: ProcessKind) -> WorkGraphNodeKind {
    match kind {
        ProcessKind::CodexCli | ProcessKind::CodexAppServer => WorkGraphNodeKind::CodexSession,
        ProcessKind::Claude => WorkGraphNodeKind::ClaudeSession,
        ProcessKind::DevServer | ProcessKind::WorkflowWorker => WorkGraphNodeKind::TerminalSession,
        ProcessKind::OtherObserved => WorkGraphNodeKind::Unknown,
        _ => WorkGraphNodeKind::Process,
    }
}

fn provider_to_node_kind(provider: &str) -> WorkGraphNodeKind {
    match provider {
        "codex" => WorkGraphNodeKind::CodexSession,
        "claude" => WorkGraphNodeKind::ClaudeSession,
        _ => WorkGraphNodeKind::ProviderAppSession,
    }
}

fn provider_to_lane(provider: &str) -> Option<WorkLane> {
    match provider {
        "codex" => Some(WorkLane::Codex),
        "claude" => Some(WorkLane::Claude),
        "deepseek" => Some(WorkLane::DeepSeek),
        _ => None,
    }
}

fn truth_summary(snapshot: &GlobalWorkGraphSnapshot) -> Vec<String> {
    let mut labels = BTreeSet::new();
    for node in &snapshot.nodes {
        labels.insert(node.truth_label.as_str().to_string());
    }
    labels.into_iter().collect()
}

fn blocked_proposal(
    proposal_ref: String,
    request: AdoptionProposalRequest,
    blocker: &str,
    truth_before: WorkGraphTruthLabel,
) -> AdoptionProposal {
    AdoptionProposal {
        proposal_ref,
        observed_node_ref: request.observed_node_ref,
        mission_id: request.mission_id,
        work_item_id: request.work_item_id,
        status: AdoptionProposalStatus::Blocked,
        truth_before,
        proposed_truth_after: WorkGraphTruthLabel::FridayAdopted,
        why_may_belong: Vec::new(),
        required_operator_action: "none".to_string(),
        blockers: vec![blocker.to_string()],
        proof_requirements: vec!["stronger_metadata_or_operator_context".to_string()],
        control_granted: false,
    }
}

fn blocked_adoption(command: AdoptionCommand, blockers: Vec<String>) -> AdoptionCommandResult {
    AdoptionCommandResult {
        status: AdoptionCommandStatus::Blocked,
        adoption_ref: None,
        mission_id: command.mission_id,
        work_item_id: command.work_item_id,
        truth_label: WorkGraphTruthLabel::ObservedOnly,
        mission_link_ref: None,
        route_decision_ref: None,
        control_granted: false,
        blockers,
    }
}

fn adoption_proposal_ref(node_ref: &str, mission_id: &str) -> String {
    format!(
        "friday://adoption-proposal/{}",
        stable_hash(&format!("{node_ref}:{mission_id}"))
    )
}

fn adoption_target_ref(node_ref: &str) -> String {
    format!("friday://adoption-target/{}", stable_hash(node_ref))
}

fn redacted_vec(kind: &str, values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| redacted_ref(kind, value))
        .collect()
}

fn filter_safe_refs(values: &[String]) -> Vec<String> {
    values.iter().filter_map(|value| safe_ref(value)).collect()
}

fn safe_ref(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let allowed_prefix = trimmed.starts_with("friday://")
        || trimmed.starts_with("proof://")
        || trimmed.starts_with("audit://");
    if allowed_prefix && !looks_private(trimmed) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn redacted_ref(kind: &str, raw: &str) -> String {
    format!("friday://{kind}/{}", stable_hash(raw))
}

fn stable_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for b in value.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn looks_private(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("/users/")
        || lower.contains("/private/")
        || lower.contains("bearer")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("provider_native_synced")
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus,
        ProcessLease, ProcessObservation, ProviderSessionLink, Risk, TruthStatus, WorkItem,
        WorkItemStatus, WorkspaceClaim, WorkspaceClaimKind,
    };
    use friday_storage::channel::{ChannelKind, NewChannelBinding};
    use friday_storage::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_DB_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_db(name: &str) -> String {
        let seq = TEMP_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "friday-global-work-{name}-{}-{seq}-{nanos}.sqlite",
                std::process::id()
            ))
            .to_string_lossy()
            .to_string()
    }

    fn conversation() -> FridayConversation {
        FridayConversation {
            friday_conversation_id: "fconv_global_work".into(),
            owner_principal: "operator:jarvis".into(),
            title: "Global work".into(),
            current_focus_summary: "Track work without fake omniscience".into(),
            active_mission_ids: vec!["mission-global".into()],
            surface_thread_ids: Vec::new(),
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: vec!["proof://conversation".into()],
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    fn mission(id: &str, intent: &str) -> Mission {
        Mission {
            mission_id: id.into(),
            friday_conversation_id: "fconv_global_work".into(),
            title: "Global work graph".into(),
            intent: intent.into(),
            status: MissionStatus::Active,
            why_now: "avoid duplicate Codex and workflow work".into(),
            decision_path_summary: "observe, propose, adopt only with operator confirmation".into(),
            considered_options: vec!["secret provider sync".into()],
            deferred_options: vec!["auto cleanup".into()],
            known_pitfalls: vec!["observed does not mean owned".into()],
            handoff_inheritance: vec!["Mission remains canonical".into()],
            work_item_ids: vec!["work-global".into()],
            memory_candidate_refs: vec!["friday://memory/candidate-1".into()],
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://mission".into()],
            created_at_ms: 2,
            updated_at_ms: 2,
        }
    }

    fn judgment() -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "Build global work graph".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: "codex".into(),
            read_first_files: vec!["handoff".into()],
            required_output: "read-only graph and adoption".into(),
            done_criteria: vec!["tests pass".into()],
            red_lines: vec!["no provider native sync claim".into()],
            why_this_route: "Rust Hub owns Mission truth".into(),
            considered_options: vec!["frontend dashboard".into()],
            deferred_options: vec!["provider-native sync".into()],
            previous_pitfalls: vec!["raw ids leaked into UI".into()],
            inheritable_context: vec!["process registry already exists".into()],
            proof_requirements: vec!["cargo test -p friday-hub global_work_graph".into()],
            ownership_claim_ids: vec!["claim-global".into()],
        }
    }

    fn work_item(id: &str, mission_id: &str) -> WorkItem {
        WorkItem {
            work_item_id: id.into(),
            mission_id: mission_id.into(),
            lane: WorkLane::Codex,
            target_provider_or_agent: Some("codex".into()),
            status: WorkItemStatus::ReadyToDispatch,
            owner_claim_ids: vec!["claim-global".into()],
            workspace_refs: vec!["/Users/jarvis/private/friday".into()],
            capability_id: Some("global.work_graph".into()),
            risk_level: Risk::Medium,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["/Users/jarvis/private/raw-input".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["adoption proof".into()],
            proof_receipts: Vec::new(),
            judgment_memory: judgment(),
            created_at_ms: 3,
            updated_at_ms: 3,
        }
    }

    fn seed(db: &Db) {
        db.upsert_friday_conversation(&conversation()).unwrap();
        db.upsert_mission(&mission("mission-global", "build global work graph"))
            .unwrap();
        db.upsert_work_item(&work_item("work-global", "mission-global"))
            .unwrap();
    }

    fn active_claim() -> WorkspaceClaim {
        WorkspaceClaim {
            claim_id: "claim-global".into(),
            mission_id: "mission-global".into(),
            work_item_id: Some("work-global".into()),
            owner_principal: "operator:jarvis".into(),
            owner_agent: "codex".into(),
            workspace_ref: "/Users/jarvis/private/friday".into(),
            claim_kind: WorkspaceClaimKind::Worktree,
            state: ClaimState::Active,
            reason: "active worktree claim".into(),
            safe_release_policy: "operator proof before release".into(),
            proof_requirements: vec!["release proof".into()],
            proof_refs: Vec::new(),
            created_at_ms: 4,
            updated_at_ms: 4,
            released_at_ms: None,
        }
    }

    fn running_lease() -> ProcessLease {
        ProcessLease {
            lease_id: "lease-global".into(),
            claim_id: "claim-global".into(),
            mission_id: "mission-global".into(),
            work_item_id: Some("work-global".into()),
            pid: Some(100),
            process_group_id: Some(100),
            process_kind: ProcessKind::DevServer,
            command_ref: Some("friday://command/redacted".into()),
            command_hash: Some("sha256:command".into()),
            cwd_ref: "/Users/jarvis/private/friday".into(),
            port_bindings: vec!["127.0.0.1:3142".into()],
            started_by_surface_thread_id: None,
            started_by_provider_session_id: None,
            health_check_ref: Some("friday://health/dev-server".into()),
            safe_stop_ref: Some("friday://safe-stop/dev-server".into()),
            last_observed_at_ms: Some(5),
            stale_after_ms: Some(60_000),
            state: LeaseState::Running,
            proof_refs: Vec::new(),
            created_at_ms: 5,
            updated_at_ms: 5,
        }
    }

    fn unowned_observation() -> ProcessObservation {
        ProcessObservation {
            observation_id: "obs-external-codex".into(),
            pid: 200,
            ppid: Some(1),
            process_kind: ProcessKind::CodexCli,
            cwd_ref: "/Users/jarvis/private/other".into(),
            port_bindings: vec!["127.0.0.1:4999".into()],
            command_hash: Some("sha256:external-command".into()),
            observed_at_ms: 6,
            matched_claim_id: None,
            ownership_status: OwnershipStatus::UnownedAgentProcess,
        }
    }

    #[test]
    fn discovery_truth_labels_and_redacts_private_refs() {
        let db = Db::open_hub(&temp_db("discovery")).unwrap();
        seed(&db);
        db.upsert_workspace_claim(&active_claim()).unwrap();
        db.upsert_process_lease(&running_lease()).unwrap();
        db.upsert_process_observation(&unowned_observation())
            .unwrap();
        db.upsert_provider_session_link(&ProviderSessionLink {
            friday_session_id: "provider-session-raw".into(),
            provider: "codex".into(),
            account_key_hash: "hidden-account".into(), // pragma: allowlist secret
            workspace_id: "workspace-secret-id".into(),
            cwd: Some("/Users/jarvis/private/provider".into()),
            external_session_id: Some("provider-external-session".into()),
            external_thread_id: Some("provider-external-thread".into()),
            external_url: Some("https://provider.example/private".into()),
            sync_mode: SyncMode::ProviderNativeSynced,
            capability_snapshot: "turn/start".into(),
            last_provider_seen_at: Some(7),
            last_friday_event_id: Some("event-1".into()),
            truth_label: "native sync claim must be degraded".into(),
        })
        .unwrap();
        channel::register_channel(
            db.conn(),
            &NewChannelBinding {
                channel_id: "telegram-raw-channel-id",
                kind: ChannelKind::Telegram,
                bound_principal_id: "operator:jarvis",
                allowlist: &["raw-telegram-user".to_string()],
                webhook_auth_ref: Some("kc://telegram-secret-ref"),
                created_at: 8,
            },
        )
        .unwrap();

        let snapshot = discover_global_work_graph(&db, 10).unwrap();
        assert!(snapshot
            .truth_labels
            .contains(&WorkGraphTruthLabel::FridayOwned));
        assert!(snapshot
            .truth_labels
            .contains(&WorkGraphTruthLabel::ObservedOnly));
        assert!(snapshot
            .truth_labels
            .contains(&WorkGraphTruthLabel::LinkedOnly));
        assert!(snapshot.nodes.iter().any(|node| {
            node.truth_label == WorkGraphTruthLabel::ObservedOnly && !node.control_allowed
        }));
        let rendered = format!("{snapshot:?}");
        for forbidden in [
            "/Users/jarvis/private",
            "provider-external-session",
            "provider-external-thread",
            "https://provider.example/private",
            "telegram-raw-channel-id",
            "raw-telegram-user",
            "kc://telegram-secret-ref",
            "provider_native_synced",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "global work graph leaked forbidden value {forbidden}: {rendered}"
            );
        }
        assert!(rendered.contains("native_sync_claim_not_used_without_live_proof"));
    }

    #[test]
    fn adoption_requires_operator_confirmation_and_links_without_control() {
        let db = Db::open_hub(&temp_db("adoption")).unwrap();
        seed(&db);
        db.upsert_process_observation(&unowned_observation())
            .unwrap();
        let observed_ref = discover_global_work_graph(&db, 10)
            .unwrap()
            .nodes
            .into_iter()
            .find(|node| node.safe_title == "codex_cli")
            .unwrap()
            .node_ref;
        let proposal = propose_work_adoption(
            &db,
            AdoptionProposalRequest {
                observed_node_ref: observed_ref.clone(),
                mission_id: "mission-global".into(),
                work_item_id: "work-global".into(),
                now_ms: 11,
            },
        )
        .unwrap();
        assert_eq!(proposal.status, AdoptionProposalStatus::Proposed);
        assert!(!proposal.control_granted);

        let blocked = adopt_observed_work(
            &db,
            AdoptionCommand {
                proposal_ref: proposal.proposal_ref.clone(),
                observed_node_ref: observed_ref.clone(),
                mission_id: "mission-global".into(),
                work_item_id: "work-global".into(),
                operator_confirmed: false,
                operator_confirmation_ref: None,
                now_ms: 12,
            },
        )
        .unwrap();
        assert_eq!(blocked.status, AdoptionCommandStatus::Blocked);
        assert!(db.list_mission_links("mission-global").unwrap().is_empty());

        let adopted = adopt_observed_work(
            &db,
            AdoptionCommand {
                proposal_ref: proposal.proposal_ref,
                observed_node_ref: observed_ref.clone(),
                mission_id: "mission-global".into(),
                work_item_id: "work-global".into(),
                operator_confirmed: true,
                operator_confirmation_ref: Some("proof://operator-confirmation/adopt-1".into()),
                now_ms: 13,
            },
        )
        .unwrap();
        assert_eq!(adopted.status, AdoptionCommandStatus::Adopted);
        assert_eq!(adopted.truth_label, WorkGraphTruthLabel::FridayAdopted);
        assert!(!adopted.control_granted);
        assert_eq!(
            db.get_work_item("work-global").unwrap().unwrap().status,
            WorkItemStatus::ReadyToDispatch
        );
        let links = db.list_mission_links("mission-global").unwrap();
        assert_eq!(
            links
                .iter()
                .filter(|link| link.link_kind == MissionLinkKind::HandoffArtifact)
                .count(),
            1
        );

        let adopted_node = discover_global_work_graph(&db, 14)
            .unwrap()
            .nodes
            .into_iter()
            .find(|node| node.node_ref == observed_ref)
            .unwrap();
        assert_eq!(adopted_node.truth_label, WorkGraphTruthLabel::FridayAdopted);
        assert!(!adopted_node.control_allowed);
        assert_eq!(
            adopted_node.blockers,
            vec!["adoption_does_not_grant_control".to_string()]
        );
    }

    #[test]
    fn advisor_preflight_blocks_duplicate_conflict_and_sensitive_transfer() {
        let db = Db::open_hub(&temp_db("advisor")).unwrap();
        seed(&db);
        db.upsert_workspace_claim(&active_claim()).unwrap();
        db.upsert_process_lease(&running_lease()).unwrap();

        let duplicate = advisor_preflight(
            &db,
            AdvisorPreflightRequest {
                friday_conversation_id: "fconv_global_work".into(),
                candidate_mission_intent: "build global work graph".into(),
                existing_mission_id: None,
                candidate_lane: WorkLane::Codex,
                target_provider_or_agent: Some("codex".into()),
                workspace_refs: Vec::new(),
                port_bindings: Vec::new(),
                includes_sensitive_context: false,
                risk_level: Risk::Medium,
                approval_state: ApprovalState::NotRequired,
                observed_node_ref: None,
            },
        )
        .unwrap();
        assert_eq!(
            duplicate.recommendation,
            AdvisorRecommendation::MergeOrAttachToExistingMission
        );
        assert_eq!(
            duplicate.duplicate_mission_id.as_deref(),
            Some("mission-global")
        );
        assert_eq!(
            duplicate.duplicate_work_item_id.as_deref(),
            Some("work-global")
        );

        let conflict = advisor_preflight(
            &db,
            AdvisorPreflightRequest {
                friday_conversation_id: "fconv_global_work".into(),
                candidate_mission_intent: "new work".into(),
                existing_mission_id: None,
                candidate_lane: WorkLane::Codex,
                target_provider_or_agent: Some("codex".into()),
                workspace_refs: vec!["/Users/jarvis/private/friday".into()],
                port_bindings: vec!["127.0.0.1:3142".into()],
                includes_sensitive_context: false,
                risk_level: Risk::Medium,
                approval_state: ApprovalState::NotRequired,
                observed_node_ref: None,
            },
        )
        .unwrap();
        assert_eq!(
            conflict.recommendation,
            AdvisorRecommendation::BlockDueToConflict
        );
        assert!(!conflict.conflict_refs.is_empty());

        let passport = advisor_preflight(
            &db,
            AdvisorPreflightRequest {
                friday_conversation_id: "fconv_global_work".into(),
                candidate_mission_intent: "external sensitive transfer".into(),
                existing_mission_id: None,
                candidate_lane: WorkLane::Claude,
                target_provider_or_agent: Some("claude".into()),
                workspace_refs: Vec::new(),
                port_bindings: Vec::new(),
                includes_sensitive_context: true,
                risk_level: Risk::Medium,
                approval_state: ApprovalState::NotRequired,
                observed_node_ref: None,
            },
        )
        .unwrap();
        assert_eq!(
            passport.recommendation,
            AdvisorRecommendation::RequireContextPassport
        );
    }

    #[test]
    fn advisor_keeps_observed_node_inspect_only_until_adoption() {
        let db = Db::open_hub(&temp_db("advisor-observed")).unwrap();
        seed(&db);
        db.upsert_process_observation(&unowned_observation())
            .unwrap();
        let observed_ref = discover_global_work_graph(&db, 10)
            .unwrap()
            .nodes
            .into_iter()
            .find(|node| node.safe_title == "codex_cli")
            .unwrap()
            .node_ref;

        let preflight = advisor_preflight(
            &db,
            AdvisorPreflightRequest {
                friday_conversation_id: "fconv_global_work".into(),
                candidate_mission_intent: "start from observed codex".into(),
                existing_mission_id: None,
                candidate_lane: WorkLane::Codex,
                target_provider_or_agent: Some("codex".into()),
                workspace_refs: Vec::new(),
                port_bindings: Vec::new(),
                includes_sensitive_context: false,
                risk_level: Risk::Medium,
                approval_state: ApprovalState::NotRequired,
                observed_node_ref: Some(observed_ref),
            },
        )
        .unwrap();
        assert_eq!(
            preflight.recommendation,
            AdvisorRecommendation::KeepObservedOnly
        );
        assert!(preflight
            .blockers
            .contains(&"operator_adoption_required_before_dispatch".to_string()));
    }
}
